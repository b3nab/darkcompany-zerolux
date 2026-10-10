//! Execution-host lifecycle for an entrusted native pi context. No prompts are sent here.
use crate::{
    claude_runner::RunnerProgram,
    sessions::{self, PiDescriptor},
};
use anyhow::{Context, Result, ensure};
use nix::{sys::signal::kill, unistd::Pid};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

pub(crate) struct Registry {
    path: PathBuf,
    program: RunnerProgram,
}
#[derive(Clone)]
pub(crate) struct RunnerLink {
    record: PiDescriptor,
    pub(crate) path: PathBuf,
}

impl Registry {
    pub(crate) fn new(path: PathBuf, program: RunnerProgram) -> Self {
        Self { path, program }
    }
    fn directory(&self) -> Result<()> {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.path)?;
        let info = std::fs::symlink_metadata(&self.path)?;
        ensure!(
            info.is_dir()
                && !info.file_type().is_symlink()
                && info.permissions().mode() & 0o077 == 0,
            "Pi runner registry must be private"
        );
        Ok(())
    }
    pub(crate) async fn find(&self, native: &str, workspace: &str) -> Result<Option<RunnerLink>> {
        self.directory()?;
        let mut entries = tokio::fs::read_dir(&self.path).await?;
        let mut found = None;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let record = sessions::descriptor(&path).await?;
            if record.native_session_id != native {
                continue;
            }
            let pid = record
                .pid
                .filter(|p| *p > 0)
                .context("Pi runner has no process identity")?;
            if kill(Pid::from_raw(pid), None) == Err(nix::errno::Errno::ESRCH) {
                continue;
            }
            ensure!(
                record.workspace == workspace,
                "The pi runner workspace changed"
            );
            let link = RunnerLink { record, path };
            let description = link.describe().await?; // Unreachable is not dead.
            if description["phase"] == "ended" {
                continue;
            }
            ensure!(
                found.is_none(),
                "Several pi hosts claim this native session"
            );
            found = Some(link);
        }
        Ok(found)
    }
    pub(crate) async fn get_or_launch(
        &self,
        native: &str,
        workspace: &str,
        locator: &Value,
    ) -> Result<RunnerLink> {
        if let Some(link) = self.find(native, workspace).await? {
            return Ok(link);
        }
        let file = locator["session_file"]
            .as_str()
            .context("The entrusted pi session has no saved file locator")?;
        let profile = locator["profile"]
            .as_str()
            .context("The entrusted pi launch profile is missing")?;
        let agent_dir = locator["agent_dir"]
            .as_str()
            .context("The pi execution host configuration is missing")?;
        sessions::ensure_pi_stopped(Path::new(agent_dir), native).await?;
        self.launch(workspace, json!({"nativeSessionId":native,"workspace":workspace,"file":file,"profile":profile,"pi":"pi"}), Some(native)).await
    }
    pub(crate) async fn create(&self, workspace: &str) -> Result<RunnerLink> {
        self.launch(
            workspace,
            json!({"workspace":workspace,"pi":"pi","creation":true}),
            None,
        )
        .await
    }
    async fn launch(
        &self,
        workspace: &str,
        mut config: Value,
        native: Option<&str>,
    ) -> Result<RunnerLink> {
        self.directory()?;
        let entry = self
            .program
            .pi_entry
            .as_ref()
            .context("The pi runner is not installed on this execution host")?
            .canonicalize()?;
        config["entry"] = json!(entry);
        let request_id = uuid::Uuid::new_v4().to_string();
        let key = format!(
            "{:x}",
            Sha256::digest(native.unwrap_or(&request_id).as_bytes())
        );
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW)
            .open(self.path.join(format!("{key}.log")))?;
        ensure!(
            log.metadata()?.is_file() && log.metadata()?.permissions().mode() & 0o077 == 0,
            "Pi runner log must be private"
        );
        let mut command = tokio::process::Command::new(&self.program.bun);
        command
            .arg(&entry)
            .current_dir(workspace)
            .env("ZEROLUX_PI_REGISTRY", self.path.canonicalize()?)
            .env("ZEROLUX_PI_CONFIG", config.to_string())
            .env_remove("ZEROLUX_TOKEN")
            .env_remove("ZEROLUX_URL")
            .env_remove("ZEROLUX_PI_RUNNER")
            .env_remove("PI_SESSION_ID")
            .env_remove("PI_SESSION_FILE")
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log))
            .kill_on_drop(false);
        // This independent host, not the kernel, owns native RPC stdin.
        unsafe {
            command.pre_exec(|| {
                nix::unistd::setsid()
                    .map(|_| ())
                    .map_err(std::io::Error::from)
            });
        }
        let mut child = command
            .spawn()
            .context("Could not start the pi execution host")?;
        let ready = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                ensure!(
                    child.try_wait()?.is_none(),
                    "The pi host refused restoration; inspect its private log"
                );
                let link = if let Some(native) = native {
                    self.find(native, workspace).await?
                } else {
                    self.created_host(
                        child.id().context("Pi host lost its process identity")?,
                        workspace,
                    )
                    .await?
                };
                if let Some(link) = link {
                    return Ok::<_, anyhow::Error>(link);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        match ready {
            Ok(Ok(link)) => {
                tokio::spawn(async move {
                    let _ = child.wait().await;
                });
                Ok(link)
            }
            result => {
                // No token has been supplied, so this host cannot have exec'd native pi.
                let _ = child.kill().await;
                let _ = child.wait().await;
                match result {
                    Ok(Err(error)) => Err(error),
                    _ => anyhow::bail!(
                        "Pi host startup was not confirmed; no native input was submitted"
                    ),
                }
            }
        }
    }
    async fn created_host(&self, pid: u32, workspace: &str) -> Result<Option<RunnerLink>> {
        let mut entries = tokio::fs::read_dir(&self.path).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let record = sessions::descriptor(&path).await?;
            if record.pid.and_then(|p| u32::try_from(p).ok()) != Some(pid) {
                continue;
            }
            ensure!(
                record.workspace == workspace,
                "Pi creation workspace changed"
            );
            let link = RunnerLink { record, path };
            let description = link.describe().await?;
            ensure!(
                description["creating"] == true && description["phase"] == "waiting",
                "Pi creation was not prepared by this host"
            );
            return Ok(Some(link));
        }
        Ok(None)
    }
}
impl RunnerLink {
    pub(crate) async fn discard_unstarted(&self) {
        // The host itself refuses this once a native operation could have begun.
        let _ = sessions::control(&self.record, json!({"method":"discard_unstarted"})).await;
    }
    pub(crate) fn native_id(&self) -> &str {
        &self.record.native_session_id
    }
    pub(crate) async fn target(&self) -> Result<sessions::NativeSessionTarget> {
        let description = self.describe().await?;
        Ok(sessions::NativeSessionTarget {
            harness: crate::harness::Harness::Pi,
            native_session_id: self.record.native_session_id.clone(),
            workspace: self.record.workspace.clone(),
            title: "pi".into(),
            native_locator: json!({"kind":"pi-runner","session_file":description["session_file"],"profile":description["profile"],"runner":self.path}),
        })
    }
    pub(crate) async fn describe(&self) -> Result<Value> {
        let value = sessions::control(&self.record, json!({"method":"describe"})).await?;
        ensure!(
            value["instance_id"] == self.record.instance_id
                && value["kind"] == "pi-runner"
                && value["native_session_id"] == self.record.native_session_id
                && value["workspace"] == self.record.workspace,
            "Pi host identity changed"
        );
        Ok(value)
    }
    pub(crate) async fn bind(&self, base: &str, token: &str) -> Result<i32> {
        let reply = sessions::control(&self.record, json!({"method":"bind","base_url":base,"token":token,"native_session_id":self.record.native_session_id,"workspace":self.record.workspace})).await?;
        reply["native_pid"]
            .as_i64()
            .and_then(|p| i32::try_from(p).ok())
            .filter(|p| *p > 0)
            .context("Pi host did not confirm its native process")
    }
    pub(crate) async fn stop(&self, session: &str) -> Result<()> {
        sessions::control(&self.record, json!({"method":"stop","link_id":session})).await?;
        Ok(())
    }
}

/// Host-only durable metadata. Nothing from this profile's private CLI args leaves the host.
pub(crate) async fn recovery_locator(native: &str, workspace: &str, saved: Value) -> Result<Value> {
    if saved["session_file"].is_string() && saved["profile"].is_string() {
        let locator = profile_locator(
            Path::new(saved["profile"].as_str().unwrap()),
            native,
            workspace,
        )
        .await?;
        ensure!(
            locator["session_file"] == saved["session_file"],
            "The entrusted pi history locator changed; no other file was selected"
        );
        return Ok(locator);
    }
    let root = sessions::agent_dir()?.join("zerolux-profiles");
    let mut entries = tokio::fs::read_dir(root)
        .await
        .context("The entrusted pi execution profile has not been captured")?;
    let mut found = None;
    while let Some(entry) = entries.next_entry().await? {
        if entry.path().extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let path = entry.path();
        let value = private_profile(&path).await?;
        if value["nativeSessionId"] == native && value["workspace"] == workspace {
            ensure!(
                found.is_none(),
                "Several native profiles claim this pi session"
            );
            found = Some(profile_locator(&path, native, workspace).await?);
        }
    }
    found.context("The entrusted pi execution profile is missing; no defaults were substituted")
}
async fn private_profile(path: &Path) -> Result<Value> {
    let info = tokio::fs::symlink_metadata(path).await?;
    ensure!(
        info.is_file()
            && !info.file_type().is_symlink()
            && info.len() <= 64 * 1024
            && info.permissions().mode() & 0o077 == 0,
        "Pi profile must be a bounded private file"
    );
    Ok(serde_json::from_slice(&tokio::fs::read(path).await?)?)
}
async fn profile_locator(path: &Path, native: &str, workspace: &str) -> Result<Value> {
    let value = private_profile(path).await?;
    ensure!(
        value["version"] == 1
            && value["nativeSessionId"] == native
            && value["workspace"] == workspace
            && value["unavailable"].is_null(),
        "The saved pi launch profile cannot be restored without native verification"
    );
    let file = value["file"].as_str().context("Missing native pi file")?;
    let agent_dir = value["agentDir"]
        .as_str()
        .context("Missing native pi configuration directory")?;
    ensure!(
        Path::new(file).is_absolute() && Path::new(agent_dir).is_absolute(),
        "Pi native paths must be absolute"
    );
    Ok(
        json!({"session_file":file,"profile":path,"agent_dir":agent_dir,"pid":value["lastPid"],"cold":true}),
    )
}
