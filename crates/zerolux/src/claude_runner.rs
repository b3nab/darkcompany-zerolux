//! Explicit launch and private process control for ZeroLux-owned Claude sessions.
//! Chat data uses the runner's existing HTTP/LiveKit bridge, never this socket.
use crate::platform::Canonical;
use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant, UNIX_EPOCH},
};

use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub use crate::platform::executable;
use crate::{
    model::{AgentSettings, ClaudePermissionMode as PermissionMode},
    platform,
};

#[cfg(all(test, unix))]
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
    /// The runners a release carries, or a checkout's.
    fn default() -> Self {
        crate::platform::carried().map_or_else(Self::checkout, Self::bundled)
    }
}

impl RunnerProgram {
    /// A checkout's runners, run from source.
    fn checkout() -> Self {
        Self {
            bun: executable("bun"),
            entry: Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../harnesses/claude/src/runner.ts"),
            kernel_executable: None,
            claude_cli: platform::executable_path("claude"),
            pi_entry: Some(
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../../harnesses/pi/src/runner.ts"),
            ),
            sdk_executable: Some(platform::executable_path("claude")),
        }
    }
}

impl RunnerProgram {
    /// The runners a package carries in `resources`: Claude Code's and pi's, with the installed
    /// `claude` in place of the SDK's own binary, which no package includes.
    pub fn bundled(resources: &Path) -> Self {
        Self {
            entry: resources.join("claude/runner.js"),
            pi_entry: Some(resources.join("pi/runner.js")),
            sdk_executable: Some(platform::executable_path("claude")),
            ..Self::checkout()
        }
    }
}

pub(crate) struct Registry {
    path: PathBuf,
    program: RunnerProgram,
    catalogs: tokio::sync::Mutex<Vec<Catalog>>,
    target: Option<Value>,
}

struct Catalog {
    workspace: String,
    home: Option<PathBuf>,
    revision: Option<String>,
    at: Instant,
    models: Vec<crate::agent_settings::ModelOption>,
}

// No Debug/Serialize: the descriptor includes a private control credential.
#[derive(Clone, Deserialize)]
struct Descriptor {
    kind: String,
    instance_id: String,
    endpoint: String,
    nonce: String,
    native_session_id: String,
    workspace: String,
}
#[derive(Clone)]
pub(crate) struct RunnerLink {
    record: Descriptor,
    pub(crate) bound: bool,
}

fn private_file(path: &Path, create: bool) -> Result<File> {
    let file = platform::private(
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(create)
            .truncate(false)
            .append(create),
    )
    .open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && platform::is_private(&metadata),
        "Runner file is not a private regular file"
    );
    Ok(file)
}

impl Registry {
    pub(crate) fn new(path: PathBuf, program: RunnerProgram) -> Self {
        let target = program.entry.canonical().ok().and_then(|entry| {
            crate::integration_code::revision(&entry)
                .ok()
                .map(|revision| json!({"entry":entry,"revision":revision}))
        });
        Self {
            path,
            program,
            catalogs: tokio::sync::Mutex::default(),
            target,
        }
    }

    /// This execution host's activated immutable release, never a path from an API payload.
    pub(crate) fn target(&self) -> Result<Value> {
        self.target
            .clone()
            .context("The installed Claude integration could not be verified")
    }

    /// The installed native executable, independently of the helper's code revision.
    pub(crate) fn native_revision(&self) -> Result<Option<String>> {
        let Some(executable) = &self.program.sdk_executable else {
            return Ok(None);
        };
        let path = executable
            .canonical()
            .context("Claude Code is not installed")?;
        let metadata = std::fs::metadata(&path)?;
        ensure!(
            metadata.is_file() && metadata.len() > 0,
            "Claude Code is not installed"
        );
        Ok(Some(serde_json::to_string(&[
            path.to_string_lossy().into_owned(),
            metadata.len().to_string(),
            metadata
                .modified()?
                .duration_since(UNIX_EPOCH)?
                .as_millis()
                .to_string(),
        ])?))
    }

    /// Initialization metadata from the installed harness; no session or model turn.
    pub(crate) async fn catalog(
        &self,
        workspace: &str,
        homes: &crate::homes::Homes,
    ) -> Result<Vec<crate::agent_settings::ModelOption>> {
        let workspace = crate::chat_runtime::workspace_dir(workspace)?;
        let revision = self.native_revision()?;
        let home = homes.root().map(Path::to_path_buf);
        let mut catalogs = self.catalogs.lock().await;
        catalogs.retain(|entry| entry.at.elapsed() < Duration::from_secs(30));
        if let Some(entry) = catalogs.iter().find(|entry| {
            entry.workspace == workspace && entry.home == home && entry.revision == revision
        }) {
            return Ok(entry.models.clone());
        }
        let mut command = platform::command(&self.program.bun);
        homes
            .apply(&mut command)
            .arg(&self.program.entry)
            .arg("catalog")
            .env_remove("ZEROLUX_CLAUDE_EXECUTABLE")
            .current_dir(&workspace)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        if let Some(executable) = &self.program.sdk_executable {
            command.env("ZEROLUX_CLAUDE_EXECUTABLE", executable);
        }
        let models = catalog_output(command, &workspace).await?;
        if catalogs.len() == 16 {
            catalogs.remove(0);
        }
        catalogs.push(Catalog {
            workspace,
            home,
            revision,
            at: Instant::now(),
            models: models.clone(),
        });
        Ok(models)
    }
    fn prepare_directory(&self) -> Result<()> {
        platform::private_dir(&self.path).context("Runner registry must be a private directory")
    }

    pub(crate) async fn find(
        &self,
        native_id: &str,
        workspace: &str,
        mode: PermissionMode,
    ) -> Result<Option<RunnerLink>> {
        self.find_with_mode(native_id, workspace, Some(mode)).await
    }

    pub(crate) async fn find_with_mode(
        &self,
        native_id: &str,
        workspace: &str,
        mode: Option<PermissionMode>,
    ) -> Result<Option<RunnerLink>> {
        uuid::Uuid::parse_str(native_id).context("Invalid Claude native session ID")?;
        self.prepare_directory()?;
        let mut entries = tokio::fs::read_dir(&self.path).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Ok(metadata) = tokio::fs::symlink_metadata(&path).await else {
                continue;
            };
            if !metadata.is_file() || !platform::is_private(&metadata) {
                continue;
            }
            let Ok(bytes) = tokio::fs::read(&path).await else {
                continue;
            };
            let Ok(record) = serde_json::from_slice::<Descriptor>(&bytes) else {
                continue;
            };
            if record.native_session_id != native_id
                || record.kind != "claude-runner"
                || record.workspace != workspace
            {
                continue;
            }
            let mut link = RunnerLink {
                record,
                bound: false,
            };
            // The runner of this session is the one that answers; what one that is gone
            // left behind is cleared away.
            match link.describe().await {
                Ok(description) => {
                    ensure!(
                        mode.is_none_or(|m| description["permission_mode"] == m.name()),
                        "The running Claude session's permission mode changed"
                    );
                    link.bound = description["bound"] == true;
                    return Ok(Some(link));
                }
                Err(error)
                    if error.downcast_ref::<std::io::Error>().is_some_and(|e| {
                        matches!(
                            e.kind(),
                            std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
                        )
                    }) =>
                {
                    let _ = tokio::fs::remove_file(&path).await;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(None)
    }

    /// Starts a runner after the caller has verified that the native session is not live.
    /// Claude Code's own fork of a saved session, in its folder: all of it, or up to one of
    /// its messages. The new session's ID.
    pub(crate) async fn fork(
        &self,
        native: &str,
        workspace: &str,
        up_to: Option<&str>,
        homes: &crate::homes::Homes,
    ) -> Result<String> {
        let mut command = platform::command(&self.program.bun);
        homes
            .apply(&mut command)
            .arg(&self.program.entry)
            .arg("fork")
            .arg(native);
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
        homes: &crate::homes::Homes,
    ) -> Result<RunnerLink> {
        // The one that runs it already, when there is one.
        if let Some(link) = self.find(native_id, workspace, mode).await? {
            return Ok(link);
        }
        if let Some(executable) = &self.program.sdk_executable {
            ensure!(
                executable.is_absolute() && executable.is_file(),
                "Claude Code is not installed: install it and restart ZeroLux"
            );
        }
        let log = private_file(&self.path.join(format!("{native_id}.log")), true)?;
        let mut command = tokio::process::Command::new(&self.program.bun);
        // A guest's harness, with their folders and accounts: never the computer's.
        homes.apply(&mut command);
        command
            .arg(
                self.program
                    .entry
                    .canonical()
                    .context("Claude runner entrypoint is unavailable")?,
            )
            .current_dir(workspace)
            .env("ZEROLUX_RUNNER_REGISTRY", self.path.canonical()?)
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
        platform::detach(&mut command);
        let mut child = command
            .spawn()
            .context("Could not start the owned Claude runner")?;
        let ready = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                ensure!(
                    child.try_wait()?.is_none(),
                    "The Claude runner stopped while starting; see its log"
                );
                if let Some(link) = self.find(native_id, workspace, mode).await? {
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
                    _ => anyhow::bail!("The Claude runner did not start"),
                }
            }
        }
    }

    pub(crate) fn executable(&self) -> Result<PathBuf> {
        self.program
            .kernel_executable
            .clone()
            .map_or_else(std::env::current_exe, Ok)?
            .canonical()
            .context("Kernel executable is unavailable")
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
        } else if request["method"] == "settings" {
            // setModel may validate a new ID against the provider before confirming it.
            45
        } else {
            5
        };
        tokio::time::timeout(Duration::from_secs(deadline), async {
            let mut socket = platform::Local::connect(&self.record.endpoint).await?;
            socket.write_all(format!("{request}\n").as_bytes()).await?;
            let mut bytes = Vec::new();
            socket.read_to_end(&mut bytes).await?;
            let response: Value = serde_json::from_slice(&bytes)?;
            ensure!(
                response["ok"] == true,
                "{}",
                response["error"]
                    .as_str()
                    .unwrap_or("Runner control request was refused")
            );
            Ok(response)
        })
        .await
        .context("Runner control timed out; native input was not retried")?
    }
    pub(crate) async fn describe(&self) -> Result<Value> {
        let value = self.request(json!({"method":"describe"})).await?;
        ensure!(
            value["kind"] == "claude-runner"
                && value["instance_id"] == self.record.instance_id
                && value["native_session_id"] == self.record.native_session_id
                && value["workspace"] == self.record.workspace,
            "The Claude runner no longer serves this session"
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
            "Update the Claude runner to change its settings"
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
        // The runner acknowledges Stop after closing its own Claude process. Never send a
        // signal to a process number read from an old descriptor.
        self.request(json!({"method":"stop","link_id":session_id}))
            .await?;
        Ok(())
    }
}

/// Metadata from an isolated native catalog command, bounded by size and duration.
pub(crate) async fn catalog_output(
    mut command: tokio::process::Command,
    workspace: &str,
) -> Result<Vec<crate::agent_settings::ModelOption>> {
    use tokio::io::AsyncReadExt;
    let workspace = crate::chat_runtime::workspace_dir(workspace)?;
    let mut child = command
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    tokio::time::timeout(Duration::from_secs(45), async {
        let mut output = Vec::new();
        child
            .stdout
            .take()
            .context("Missing catalog output")?
            .read_to_end(&mut output)
            .await?;
        ensure!(
            child.wait().await?.success(),
            "The harness could not load its model catalog"
        );
        let text = std::str::from_utf8(&output)?;
        let line = text
            .lines()
            .rev()
            .find_map(|line| line.strip_prefix("ZEROLUX_MODEL_CATALOG="))
            .or_else(|| text.lines().last())
            .unwrap_or_default();
        serde_json::from_str(line).context("The harness returned an invalid model catalog")
    })
    .await
    .context("The harness did not return its model catalog in time")?
}

/// A runner's `fork` in a session's folder, bounded: what it printed, or why it failed.
pub(crate) async fn forked(
    mut command: tokio::process::Command,
    workspace: &str,
) -> Result<serde_json::Value> {
    platform::isolate_descriptors(command.as_std_mut());
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
