//! Explicit launch and private process control for ZeroLux-owned Claude sessions.
//! Chat data uses the runner's existing HTTP/LiveKit bridge, never this socket.
use std::{
    fs::{File, OpenOptions},
    os::unix::{fs::OpenOptionsExt, fs::PermissionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use nix::{sys::signal::kill, unistd::Pid};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

use crate::model::{AgentSettings, ClaudePermissionMode as PermissionMode};

mod execution;
#[cfg(test)]
mod tests;

/// Fixed local executable/entrypoint, supplied by the host, never by an API/chat payload.
/// Embedders and deterministic subprocess fixtures may select their own installed entrypoint.
#[derive(Clone)]
pub struct RunnerProgram {
    pub bun: PathBuf,
    pub entry: PathBuf,
    pub kernel_executable: Option<PathBuf>,
    pub claude_cli: PathBuf,
    /// Native pi lifecycle host, supplied by the same execution host.
    pub pi_entry: Option<PathBuf>,
    /// An embedder may use an installed Claude binary instead of the SDK's packaged binary.
    pub sdk_executable: Option<PathBuf>,
}
impl Default for RunnerProgram {
    fn default() -> Self {
        Self {
            bun: "bun".into(),
            entry: Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../extensions/claude/src/runner.ts"),
            kernel_executable: None,
            claude_cli: "claude".into(),
            pi_entry: Some(
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../../extensions/pi/src/runner.ts"),
            ),
            sdk_executable: None,
        }
    }
}

pub(crate) struct Registry {
    path: PathBuf,
    program: RunnerProgram,
}

// No Debug/Serialize: the descriptor includes a private control credential.
#[derive(Clone, Deserialize)]
struct Descriptor {
    version: u32,
    kind: String,
    instance_id: String,
    endpoint: String,
    nonce: String,
    pid: i32,
    native_session_id: String,
    workspace: String,
    permission_mode: PermissionMode,
}
#[derive(Clone)]
pub(crate) struct RunnerLink {
    record: Descriptor,
    registry: PathBuf,
    pub(crate) bound: bool,
}

fn private_file(path: &Path, create: bool) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(create)
        .truncate(false)
        .append(create)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.permissions().mode() & 0o077 == 0,
        "Runner file is not a private regular file"
    );
    Ok(file)
}

/// A lease is a liveness constraint, not identity evidence. Its inode is never replaced.
fn leased(registry: &Path, native_id: &str) -> Result<bool> {
    let path = registry.join(format!("{native_id}.lock"));
    let file = match private_file(&path, false) {
        Ok(file) => file,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(false);
        }
        Err(error) => return Err(error),
    };
    match file.try_lock_exclusive() {
        Ok(()) => Ok(false), // Closing this new open releases only our probe's lock.
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(true),
        Err(error) => Err(error.into()),
    }
}

impl Registry {
    pub(crate) fn new(path: PathBuf, program: RunnerProgram) -> Self {
        Self { path, program }
    }
    fn prepare_directory(&self) -> Result<()> {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.path)?;
        let metadata = std::fs::symlink_metadata(&self.path)?;
        ensure!(
            metadata.is_dir()
                && !metadata.file_type().is_symlink()
                && metadata.permissions().mode() & 0o077 == 0,
            "Runner registry must be a private directory"
        );
        Ok(())
    }

    pub(crate) async fn find(
        &self,
        native_id: &str,
        workspace: &str,
        mode: PermissionMode,
    ) -> Result<Option<RunnerLink>> {
        Uuid::parse_str(native_id).context("Invalid owned native session ID")?;
        self.prepare_directory()?;
        let mut found = None;
        let mut entries = tokio::fs::read_dir(&self.path).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let metadata = tokio::fs::symlink_metadata(&path).await?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() > 64 * 1024
                || metadata.permissions().mode() & 0o077 != 0
            {
                continue;
            }
            let Ok(record) = serde_json::from_slice::<Descriptor>(&tokio::fs::read(&path).await?)
            else {
                continue;
            };
            if record.native_session_id != native_id {
                continue;
            }
            ensure!(
                record.pid > 0,
                "The Claude runner has no valid process identity"
            );
            if kill(Pid::from_raw(record.pid), None) == Err(nix::errno::Errno::ESRCH) {
                continue;
            }
            ensure!(
                record.version == 1
                    && record.kind == "claude-runner"
                    && Uuid::parse_str(&record.instance_id).is_ok()
                    && record.nonce.len() == 64
                    && record.nonce.bytes().all(|b| b.is_ascii_hexdigit())
                    && Path::new(&record.endpoint).is_absolute(),
                "Invalid owned runner descriptor"
            );
            let mut link = RunnerLink {
                record,
                registry: self.path.clone(),
                bound: false,
            };
            // A failed control request is not evidence that this live claimant ended.
            // Even a free helper lease or an empty native catalogue cannot erase it.
            let description = link.describe().await.context(
                "The live Claude runner could not be verified; no replacement was started",
            )?;
            ensure!(
                link.record.workspace == workspace && link.record.permission_mode == mode,
                "The owned session's workspace or permission mode changed"
            );
            ensure!(
                leased(&self.path, native_id)?,
                "Runner has no exclusive session lease"
            );
            link.bound = description["bound"] == true;
            ensure!(
                found.is_none(),
                "Several live runners claim this native session"
            );
            found = Some(link);
        }
        Ok(found)
    }

    /// Starts a runner after the caller has verified that the native session is not live.
    /// Claude Code's own fork of a saved session, in its folder: all of it, or up to one of
    /// its messages. The new session's ID.
    pub(crate) async fn fork(
        &self,
        native: &str,
        workspace: &str,
        up_to: Option<&str>,
    ) -> Result<String> {
        let mut command = tokio::process::Command::new(&self.program.bun);
        command.arg(&self.program.entry).arg("fork").arg(native);
        if let Some(up_to) = up_to {
            command.arg(up_to);
        }
        let output = forked(command, workspace).await?;
        output["session_id"]
            .as_str()
            .map(str::to_owned)
            .context("Claude Code did not name the fork")
    }

    pub(crate) async fn launch(
        &self,
        native_id: &str,
        workspace: &str,
        mode: PermissionMode,
        system_prompt: Option<&str>,
        initial: &AgentSettings,
    ) -> Result<RunnerLink> {
        ensure!(
            self.find(native_id, workspace, mode).await?.is_none(),
            "This owned session already has a live runner"
        );
        ensure!(
            !leased(&self.path, native_id)?,
            "An owned runner holds this session but could not be verified"
        );
        if let Some(executable) = &self.program.sdk_executable {
            ensure!(
                executable.is_absolute() && executable.is_file(),
                "Claude Code executable was not found. Install Claude Code and restart ZeroLux with its directory on PATH."
            );
        }
        let log = private_file(&self.path.join(format!("{native_id}.log")), true)?;
        let mut command = tokio::process::Command::new(&self.program.bun);
        command
            .arg(
                self.program
                    .entry
                    .canonicalize()
                    .context("Claude runner entrypoint is unavailable")?,
            )
            .current_dir(workspace)
            .env("ZEROLUX_RUNNER_REGISTRY", self.path.canonicalize()?)
            .env("ZEROLUX_NATIVE_SESSION", native_id)
            .env("ZEROLUX_WORKSPACE", workspace)
            .env("ZEROLUX_PERMISSION_MODE", mode.name())
            .env("ZEROLUX_INITIAL_SETTINGS", initial.patch_json().to_string())
            .env_remove("ZEROLUX_SYSTEM_PROMPT")
            .env("ZEROLUX_CLAUDE_MANAGED", "1")
            .env_remove("ZEROLUX_CLAUDE_EXECUTABLE")
            .env_remove("ZEROLUX_TOKEN")
            .env_remove("ZEROLUX_URL")
            .env_remove("PI_SESSION_ID")
            .env_remove("PI_SESSION_FILE")
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log))
            .kill_on_drop(false);
        if let Some(executable) = &self.program.sdk_executable {
            command.env("ZEROLUX_CLAUDE_EXECUTABLE", executable);
        }
        // Use Claude's native resume with the preset selected at creation.
        if let Some(system_prompt) = system_prompt {
            command.env("ZEROLUX_SYSTEM_PROMPT", system_prompt);
        }
        // Detached, with no terminal streams: stopping the kernel does not stop the runner.
        // setsid is an async-signal-safe syscall; no allocation or application code runs here.
        unsafe {
            command.pre_exec(|| {
                nix::unistd::setsid()
                    .map(|_| ())
                    .map_err(std::io::Error::from)
            });
        }
        let mut child = command
            .spawn()
            .context("Could not start the owned Claude runner")?;
        let ready = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                ensure!(
                    child.try_wait()?.is_none(),
                    "Owned Claude runner exited before becoming ready; inspect its private log"
                );
                if let Some(link) = self.find(native_id, workspace, mode).await? {
                    // Setting an env flag is not negotiation: an old asset can ignore it.
                    // Warm attachment may keep a legacy host; a NEW launch must prove its
                    // own guarded, unbound waiting host before any token/bind is sent.
                    ensure!(
                        child.id() == Some(link.record.pid as u32),
                        "A different Claude runner claimed this launch; no bind was sent"
                    );
                    let state = link.describe().await?;
                    ensure!(
                        state["native_guard"] == 1
                            && state["bound"] == false
                            && state["native_phase"] == "waiting"
                            && state.get("native_pid") == Some(&Value::Null),
                        "The new Claude runner did not confirm the native ownership protocol; no bind was sent"
                    );
                    return Ok::<_, anyhow::Error>(link);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        match ready {
            Ok(Ok(link)) => {
                // Reap on exit if this kernel survives it; never kill on kernel shutdown.
                tokio::spawn(async move {
                    let _ = child.wait().await;
                });
                Ok(link)
            }
            other => {
                // This newly launched process has never been bound and received no token/input.
                let _ = child.kill().await;
                let _ = child.wait().await;
                match other {
                    Ok(Err(error)) => Err(error),
                    _ => anyhow::bail!(
                        "Owned Claude runner did not become ready; no input was submitted"
                    ),
                }
            }
        }
    }

    pub(crate) async fn check_native_stopped(
        &self,
        native_id: &str,
        workspace: &str,
    ) -> Result<()> {
        execution::verify_exit(
            &self.path,
            native_id,
            workspace,
            execution::Purpose::Restore,
        )?;
        self.check_not_running(native_id).await
    }

    /// An entrusted terminal has no ZeroLux execution lease. Its saved process must end
    /// before the first managed host can resume its native conversation.
    pub(crate) async fn check_terminal_stopped(&self, native_id: &str, pid: i32) -> Result<()> {
        ensure!(
            pid > 0 && kill(Pid::from_raw(pid), None) == Err(nix::errno::Errno::ESRCH),
            "The entrusted Claude terminal is still running"
        );
        self.check_not_running(native_id).await
    }

    async fn check_not_running(&self, native_id: &str) -> Result<()> {
        let mut child = tokio::process::Command::new(&self.program.claude_cli)
            .args(["agents", "--json"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("Claude session discovery is required before Resume")?;
        tokio::time::timeout(Duration::from_secs(10), async move {
            let mut bytes = Vec::new();
            child
                .stdout
                .take()
                .context("Missing Claude metadata output")?
                .take(4 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .await?;
            ensure!(
                bytes.len() <= 4 * 1024 * 1024 && child.wait().await?.success(),
                "Claude metadata command failed"
            );
            let value: Value = serde_json::from_slice(&bytes)?;
            let sessions = value
                .as_array()
                .context("Invalid Claude session metadata")?;
            let running = sessions.iter().any(|session| {
                session["sessionId"] == native_id
                    && session["pid"]
                        .as_i64()
                        .and_then(|pid| i32::try_from(pid).ok())
                        .filter(|pid| *pid > 0)
                        .is_none_or(|pid| {
                            kill(Pid::from_raw(pid), None) != Err(nix::errno::Errno::ESRCH)
                        })
            });
            ensure!(
                !running,
                "Claude Code is already running this session; close it before Resume"
            );
            Ok::<_, anyhow::Error>(())
        })
        .await
        .context("Claude session discovery timed out")?
    }

    pub(crate) fn executable(&self) -> Result<PathBuf> {
        self.program
            .kernel_executable
            .clone()
            .map_or_else(std::env::current_exe, Ok)?
            .canonicalize()
            .context("Kernel executable is unavailable")
    }

    pub(crate) fn check_native_exit(&self, native_id: &str, workspace: &str) -> Result<()> {
        Uuid::parse_str(native_id)?;
        execution::verify_exit(
            &self.path,
            native_id,
            workspace,
            execution::Purpose::Stop(None),
        )
    }

    pub(crate) fn is_leased(&self, native_id: &str) -> Result<bool> {
        Uuid::parse_str(native_id)?;
        leased(&self.path, native_id)
    }
}

impl RunnerLink {
    pub(crate) async fn request(&self, mut request: Value) -> Result<Value> {
        request["nonce"] = json!(self.record.nonce);
        let deadline = if matches!(
            request["method"].as_str(),
            Some("bind" | "prepare" | "update_commit")
        ) {
            60
        } else {
            5
        };
        tokio::time::timeout(Duration::from_secs(deadline), async {
            let mut socket = tokio::net::UnixStream::connect(&self.record.endpoint).await?;
            socket.write_all(format!("{request}\n").as_bytes()).await?;
            let mut bytes = Vec::new();
            let limit = if request["method"] == "settings" {
                2 * 1024 * 1024
            } else {
                64 * 1024
            };
            socket.take(limit + 1).read_to_end(&mut bytes).await?;
            ensure!(
                bytes.len() as u64 <= limit,
                "Runner control response too large"
            );
            let response: Value = serde_json::from_slice(&bytes)?;
            ensure!(response["ok"] == true, "Runner control request was refused");
            Ok(response)
        })
        .await
        .context("Runner control timed out; native input was not retried")?
    }
    pub(crate) async fn describe(&self) -> Result<Value> {
        let value = self.request(json!({"method":"describe"})).await?;
        ensure!(
            value["instance_id"] == self.record.instance_id
                && value["kind"] == "claude-runner"
                && value["native_session_id"] == self.record.native_session_id
                && value["workspace"] == self.record.workspace
                && value["permission_mode"] == self.record.permission_mode.name()
                && value["bound"].is_boolean(),
            "The owned runner identity changed"
        );
        Ok(value)
    }
    pub(crate) async fn settings(
        &self,
        session_id: &str,
        patch: Option<&crate::model::AgentSettings>,
        check: bool,
    ) -> Result<crate::agent_settings::NativeSettings> {
        let description = self.describe().await?;
        ensure!(
            description["capabilities"]
                .as_array()
                .is_some_and(|values| values.iter().any(|value| value == "agent-settings-v1")),
            "The Claude runner needs an update before its settings can be controlled"
        );
        let mut request = json!({"method":"settings","link_id":session_id,"check":check});
        if let Some(patch) = patch {
            request["values"] = patch.patch_json();
        }
        let result = self.request(request).await?;
        Ok(serde_json::from_value(result["settings"].clone())?)
    }

    pub(crate) async fn check_bind(&self) -> Result<()> {
        // A live host (including older ones) keeps its query across prepare/bind itself.
        // Authenticate its identity; do not require new metadata to reattach that query.
        self.describe().await?;
        Ok(())
    }
    pub(crate) async fn prepare(&self, session_id: &str) -> Result<()> {
        self.request(json!({"method":"prepare","link_id":session_id}))
            .await?;
        Ok(())
    }
    pub(crate) async fn bind(
        &self,
        base: &str,
        token: &str,
        session_id: &str,
        executable: &Path,
        resume: bool,
    ) -> Result<()> {
        self.check_bind().await?;
        let result = self.request(json!({"method":"bind","native_session_id":self.record.native_session_id,
            "workspace":self.record.workspace,"base_url":base,"token":token,"executable":executable,"resume":resume})).await?;
        ensure!(
            result["link_id"] == session_id,
            "Runner bound a different ZeroLux session"
        );
        Ok(())
    }
    pub(crate) async fn stop(&self, session_id: &str) -> Result<()> {
        self.request(json!({"method":"stop","link_id":session_id}))
            .await?;
        tokio::time::timeout(Duration::from_secs(3), async {
            while leased(&self.registry, &self.record.native_session_id)? {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Ok::<_, anyhow::Error>(())
        })
        .await
        .context("The owned runner has not confirmed its exit")??;
        execution::verify_exit(
            &self.registry,
            &self.record.native_session_id,
            &self.record.workspace,
            execution::Purpose::Stop(Some(&self.record.instance_id)),
        )
    }
}

/// A runner's `fork` in a session's folder, bounded: what it printed, or why it failed.
pub(crate) async fn forked(
    mut command: tokio::process::Command,
    workspace: &str,
) -> Result<serde_json::Value> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        command
            .current_dir(workspace)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .context("The fork timed out")??;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        anyhow::bail!(if message.is_empty() {
            "The fork failed".into()
        } else {
            message
        });
    }
    let line = String::from_utf8_lossy(&output.stdout)
        .lines()
        .rev()
        .find(|line| line.starts_with('{'))
        .unwrap_or_default()
        .to_owned();
    Ok(serde_json::from_str(&line)?)
}
