//! Execution-host lifecycle for an entrusted native pi context. No prompts are sent here.
use crate::platform::Canonical;
use crate::{
    claude_runner::RunnerProgram,
    platform,
    sessions::{self, PiDescriptor},
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

#[derive(Clone, Copy, Debug, thiserror::Error)]
pub(crate) enum PiFailure {
    #[error("pi could not start with the available runtime.")]
    RuntimeUnavailable,
    #[error("pi did not confirm that this session started.")]
    StartUnconfirmed,
    #[error("pi did not confirm it stopped; the session remains stopped in ZeroLux.")]
    StopUnconfirmed,
}

impl PiFailure {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::RuntimeUnavailable => "pi_runtime_unavailable",
            Self::StartUnconfirmed => "pi_start_unconfirmed",
            Self::StopUnconfirmed => "pi_stop_unconfirmed",
        }
    }

    pub(crate) fn context(self, error: anyhow::Error) -> anyhow::Error {
        if error.downcast_ref::<Self>().is_some() {
            error
        } else {
            error.context(self)
        }
    }
}

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
    pub(crate) async fn catalog(
        &self,
        workspace: &str,
        homes: &crate::homes::Homes,
    ) -> Result<Vec<crate::agent_settings::ModelOption>> {
        let entry = self
            .program
            .pi_entry
            .as_ref()
            .context("The pi runner is not installed on this execution host")?;
        let catalog = entry.with_file_name(
            if entry.extension().is_some_and(|extension| extension == "ts") {
                "catalog.ts"
            } else {
                "catalog.js"
            },
        );
        ensure!(
            catalog.is_file(),
            "The pi model catalog helper is not installed"
        );
        let mut command = platform::command(platform::executable_path("pi"));
        homes
            .apply(&mut command)
            .args(["--no-extensions", "--extension"])
            .arg(catalog)
            .arg("--list-models");
        crate::claude_runner::catalog_output(command, workspace).await
    }
    fn directory(&self) -> Result<()> {
        platform::private_dir(&self.path).context("Pi runner registry must be private")
    }
    /// The host that runs this session now: the one that answers. What a host that is gone
    /// left behind is cleared away.
    pub(crate) async fn find(&self, native: &str, _workspace: &str) -> Result<Option<RunnerLink>> {
        self.directory()?;
        let mut entries = tokio::fs::read_dir(&self.path).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(record) = sessions::descriptor(&path).await else {
                continue;
            };
            if record.native_session_id != native {
                continue;
            }
            let link = RunnerLink { record, path };
            match link.describe().await {
                Ok(description) if description["phase"] != "ended" => return Ok(Some(link)),
                Ok(_) => {}
                Err(_) => {
                    let _ = tokio::fs::remove_file(&link.path).await;
                }
            }
        }
        Ok(None)
    }
    /// The session's host: the one that runs it now, else a new one that starts pi on its
    /// saved file.
    pub(crate) async fn get_or_launch(
        &self,
        native: &str,
        workspace: &str,
        locator: &Value,
    ) -> Result<RunnerLink> {
        if let Some(link) = self.find(native, workspace).await? {
            return Ok(link);
        }
        let homes = crate::homes::Homes::of_locator(locator);
        let file = match locator["session_file"].as_str() {
            Some(file) => file.to_owned(),
            None => saved_file(native, locator, &homes).await?,
        };
        let mut config =
            json!({"nativeSessionId":native,"workspace":workspace,"file":file,"pi":"pi"});
        if let Some(agent_dir) = locator["agent_dir"].as_str() {
            config["agentDir"] = json!(agent_dir);
        }
        if let Some(args) = launch_args(locator).await {
            config["args"] = args;
        }
        self.launch(workspace, config, Some(native), &homes).await
    }
    /// pi's own fork of a saved session, in its folder: all of it, or the path up to one of
    /// its entries. The new session's identity and file.
    pub(crate) async fn fork(
        &self,
        file: &str,
        workspace: &str,
        up_to: Option<&str>,
        homes: &crate::homes::Homes,
    ) -> Result<(String, String)> {
        let entry = self
            .program
            .pi_entry
            .as_ref()
            .context("The pi runner is not installed on this execution host")?;
        let mut command = platform::command(&self.program.bun);
        homes.apply(&mut command).arg(entry).arg("fork").arg(file);
        if let Some(up_to) = up_to {
            command.arg(up_to);
        }
        let output = crate::claude_runner::forked(command, workspace).await?;
        Ok((
            output["native_session_id"]
                .as_str()
                .context("pi did not name the fork")?
                .to_owned(),
            output["file"]
                .as_str()
                .context("pi did not name the fork's file")?
                .to_owned(),
        ))
    }
    /// A saved session the owner opens in ZeroLux, under a host of its own.
    pub(crate) async fn open(
        &self,
        native: &str,
        workspace: &str,
        file: &str,
        homes: &crate::homes::Homes,
    ) -> Result<RunnerLink> {
        if let Some(link) = self.find(native, workspace).await? {
            return Ok(link);
        }
        self.launch(
            workspace,
            json!({"nativeSessionId":native,"workspace":workspace,"file":file,"pi":"pi"}),
            Some(native),
            homes,
        )
        .await
    }
    /// A new pi session, with the person's own pi: the computer's for its person, a guest's own.
    pub(crate) async fn create(
        &self,
        workspace: &str,
        initial: &crate::model::AgentSettings,
        homes: &crate::homes::Homes,
    ) -> Result<RunnerLink> {
        self.launch(
            workspace,
            json!({"workspace":workspace,"pi":"pi","creation":true,"initial":initial.patch_json()}),
            None,
            homes,
        )
        .await
    }
    async fn launch(
        &self,
        workspace: &str,
        mut config: Value,
        native: Option<&str>,
        homes: &crate::homes::Homes,
    ) -> Result<RunnerLink> {
        self.directory()?;
        let entry = self
            .program
            .pi_entry
            .as_ref()
            .context("The pi runner is not installed on this execution host")?
            .canonical()?;
        config["entry"] = json!(entry);
        let request_id = uuid::Uuid::new_v4().to_string();
        let key = format!(
            "{:x}",
            Sha256::digest(native.unwrap_or(&request_id).as_bytes())
        );
        let log_path = self.path.join(format!("{key}.log"));
        let log =
            platform::private(OpenOptions::new().create(true).append(true)).open(&log_path)?;
        let mut command = tokio::process::Command::new(&self.program.bun);
        // A guest's harness, with their folders and accounts: never the computer's.
        homes.apply(&mut command);
        command
            .arg(&entry)
            .current_dir(workspace)
            .env("ZEROLUX_PI_REGISTRY", self.path.canonical()?)
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
        platform::detach(&mut command);
        let mut child = command
            .spawn()
            .context("Could not start the pi execution host")?;
        let ready = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                if child.try_wait()?.is_some() {
                    anyhow::bail!("pi did not start: {}", last_line(&log_path).await);
                }
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
                    _ => anyhow::bail!("pi did not confirm its start"),
                }
            }
        }
    }
    async fn created_host(&self, pid: u32, _workspace: &str) -> Result<Option<RunnerLink>> {
        let mut entries = tokio::fs::read_dir(&self.path).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Ok(record) = sessions::descriptor(&path).await else {
                continue;
            };
            if record.pid.and_then(|p| u32::try_from(p).ok()) != Some(pid) {
                continue;
            }
            let link = RunnerLink { record, path };
            if link.describe().await.is_ok() {
                return Ok(Some(link));
            }
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
            native_locator: json!({"kind":"pi-runner","session_file":description["session_file"],"runner":self.path,
                "model":description["model"]["id"],"effort":description["thinking"]}),
        })
    }
    pub(crate) async fn describe(&self) -> Result<Value> {
        let value = sessions::control(&self.record, json!({"method":"describe"})).await?;
        ensure!(value["kind"] == "pi-runner", "Not a pi host");
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

/// pi's own file of a session whose locator does not name it: the one pi names after it,
/// among its sessions.
async fn saved_file(native: &str, locator: &Value, homes: &crate::homes::Homes) -> Result<String> {
    let agent = match (locator["agent_dir"].as_str(), homes.pi()) {
        (Some(dir), _) => PathBuf::from(dir),
        (None, Some(dir)) => dir,
        (None, None) => sessions::agent_dir()?,
    };
    let mut folders = tokio::fs::read_dir(agent.join("sessions"))
        .await
        .context("pi has no saved sessions here")?;
    while let Some(folder) = folders.next_entry().await? {
        let Ok(mut files) = tokio::fs::read_dir(folder.path()).await else {
            continue;
        };
        while let Some(file) = files.next_entry().await? {
            if file
                .file_name()
                .to_string_lossy()
                .ends_with(&format!("_{native}.jsonl"))
            {
                return Ok(file.path().to_string_lossy().into_owned());
            }
        }
    }
    anyhow::bail!("pi's saved session was not found")
}

/// The native options the session's terminal started it with, to start it with again: as
/// its pi said them, or as a host of an earlier ZeroLux saved them. None for a session of
/// ZeroLux's own.
async fn launch_args(locator: &Value) -> Option<Value> {
    if locator["args"].is_array() {
        return Some(locator["args"].clone());
    }
    let saved = tokio::fs::read(locator["profile"].as_str()?).await.ok()?;
    let profile: Value = serde_json::from_slice(&saved).ok()?;
    profile["args"].is_array().then(|| profile["args"].clone())
}

/// Why a host ended, as the last thing it wrote says.
async fn last_line(log: &Path) -> String {
    let bytes = tokio::fs::read(log).await.unwrap_or_default();
    let text = String::from_utf8_lossy(&bytes);
    text.lines()
        .rev()
        .find(|line| line.starts_with("error: ") || line.starts_with("env: "))
        .or_else(|| text.lines().rev().find(|line| !line.trim().is_empty()))
        .map(|line| line.trim_start_matches("error: ").to_owned())
        .unwrap_or_else(|| "its host ended without a word".into())
}
