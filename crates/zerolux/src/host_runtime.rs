//! The sessions a joined computer runs for its workspace. The kernel decides and keeps the
//! records; this computer starts the harnesses, runs their adapters against the kernel with
//! the session's token, and does what the kernel asks of them.

use std::{collections::HashMap, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use tokio::{
    sync::{Mutex, broadcast, mpsc, watch},
    task::JoinHandle,
};

use crate::{codex::CodexDriver, model::AgentSettings, sessions};

struct Running {
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
    control: crate::codex_settings::CodexSettings,
}

pub struct HostRuntime {
    /// The kernel's address, which the adapters report to.
    url: String,
    /// The Codex daemon to use instead of this computer's own.
    codex: Option<String>,
    /// Started natively, waiting for the kernel to issue the session's token.
    pending: Mutex<HashMap<String, CodexDriver>>,
    running: Mutex<HashMap<String, Running>>,
    /// The kernel's word that a session's chats changed: each adapter reads its inbox again.
    wake: broadcast::Sender<()>,
    /// What this computer tells the kernel on its own.
    notices: mpsc::UnboundedSender<Value>,
    /// Terminals opened in this computer's session folders.
    terminals: Arc<crate::terminals::Terminals>,
    /// Images sent with input, kept where this computer's harnesses read them.
    attachments: std::path::PathBuf,
    /// Where sessions started in a worktree of their own work.
    worktrees: std::path::PathBuf,
    /// The pi and Claude Code runners of this computer's sessions.
    pi: crate::pi_runner::Registry,
    claude: crate::claude_runner::Registry,
    pi_pending: Mutex<HashMap<String, crate::pi_runner::RunnerLink>>,
    /// The integrations of this computer's pi sessions, paired with the kernel.
    pi_links: Mutex<HashMap<String, sessions::PiLink>>,
}

impl HostRuntime {
    pub fn new(
        url: String,
        links: std::path::PathBuf,
        notices: mpsc::UnboundedSender<Value>,
    ) -> Arc<Self> {
        Self::with_codex(url, links, None, notices)
    }

    /// With a Codex daemon of its own choosing, such as a test's.
    pub fn with_codex(
        url: String,
        links: std::path::PathBuf,
        codex: Option<String>,
        notices: mpsc::UnboundedSender<Value>,
    ) -> Arc<Self> {
        Self::with_runners(
            url,
            links,
            codex,
            crate::claude_runner::RunnerProgram::default(),
            notices,
        )
    }

    /// With harness runners of its own choosing, such as a test's.
    pub fn with_runners(
        url: String,
        links: std::path::PathBuf,
        codex: Option<String>,
        program: crate::claude_runner::RunnerProgram,
        notices: mpsc::UnboundedSender<Value>,
    ) -> Arc<Self> {
        Arc::new(Self {
            pi: crate::pi_runner::Registry::new(links.join("pi"), program.clone()),
            claude: crate::claude_runner::Registry::new(links.join("claude"), program),
            pi_pending: Mutex::default(),
            pi_links: Mutex::default(),
            terminals: terminals(notices.clone()),
            attachments: links.with_file_name("attachments"),
            worktrees: links.with_file_name("worktrees"),
            url,
            codex,
            pending: Mutex::default(),
            running: Mutex::default(),
            wake: broadcast::channel(16).0,
            notices,
        })
    }

    pub fn wake(&self) {
        let _ = self.wake.send(());
    }

    pub async fn answer(self: &Arc<Self>, op: &str, params: Value) -> Result<Value> {
        match op {
            "codex.start" => self.codex_start(params).await,
            "codex.resume" => self.codex_resume(params).await,
            "codex.bind" => self.codex_bind(params).await,
            // Codex's own fork of a thread, whole or before a turn: the new thread, waiting.
            "codex.fork" => {
                let thread = params["thread_id"].as_str().context("Name the thread")?;
                let endpoint = self.codex_endpoint().await?;
                let rpc = crate::codex::CodexRpc::connect(&endpoint).await?;
                let mut fork = json!({"threadId": thread});
                if let Some(turn) = params["before"].as_str() {
                    fork["beforeTurnId"] = json!(turn);
                }
                let forked = rpc.request("thread/fork", fork).await?;
                let forked = forked["thread"]["id"]
                    .as_str()
                    .context("Codex did not name the fork")?;
                self.codex_resume(json!({"thread_id": forked,
                    "workspace": params["workspace"]}))
                    .await
            }
            "codex.stop" => {
                let session = params["session_id"].as_str().unwrap_or_default();
                Ok(json!({"stopped": self.stop(session).await}))
            }
            "codex.control" => {
                let session = params["session_id"].as_str().unwrap_or_default();
                let control = self
                    .running
                    .lock()
                    .await
                    .get(session)
                    .filter(|running| !running.task.is_finished())
                    .map(|running| running.control.clone())
                    .context("The session's Codex is not running on this computer")?;
                let mut request = params["request"].clone();
                crate::chat_runtime::localize_images(&self.attachments, session, &mut request)?;
                control.request(&request).await
            }
            "pi.create" => self.pi_create(params).await,
            // pi's own fork of a saved session, opened under a runner here, waiting.
            "pi.fork" => {
                let file = params["file"].as_str().context("Name the session's file")?;
                let workspace = params["workspace"].as_str().context("Choose a folder")?;
                let own = crate::homes::Homes::own();
                let (native, file) = self
                    .pi
                    .fork(file, workspace, params["before"].as_str(), &own)
                    .await?;
                let link = self.pi.open(&native, workspace, &file, &own).await?;
                let target = link.target().await?;
                let pending = uuid::Uuid::new_v4().to_string();
                self.pi_pending.lock().await.insert(pending.clone(), link);
                Ok(
                    json!({"pending": pending, "native_session_id": target.native_session_id,
                    "workspace": target.workspace, "native_locator": target.native_locator}),
                )
            }
            // Claude Code's own fork of a saved session: the new session's ID.
            "claude.fork" => {
                let native = self
                    .claude
                    .fork(
                        params["native"].as_str().context("Name the session")?,
                        params["workspace"].as_str().context("Choose a folder")?,
                        params["before"].as_str(),
                        &crate::homes::Homes::own(),
                    )
                    .await?;
                Ok(json!({"native": native}))
            }
            "pi.bind" => self.pi_bind(params).await,
            "pi.control" => {
                let session = params["session_id"].as_str().unwrap_or_default();
                let mut request = params["request"].clone();
                crate::chat_runtime::localize_images(&self.attachments, session, &mut request)?;
                if let Some(paired) = self.pi_links.lock().await.get(session) {
                    return paired.control(request).await;
                }
                // Linked before this computer's ZeroLux restarted: its integration is still
                // there, at the control the kernel recorded.
                let descriptor = params["descriptor"]
                    .as_str()
                    .context("The session's pi is not linked on this computer")?;
                let record = sessions::descriptor(std::path::Path::new(descriptor)).await?;
                sessions::control(&record, request).await
            }
            "pi.stop" => {
                let session = params["session_id"].as_str().unwrap_or_default();
                if let Some(paired) = self.pi_links.lock().await.remove(session) {
                    paired.shutdown().await?;
                }
                self.pi_link(&params).await?.stop(session).await?;
                Ok(json!({"stopped": true}))
            }
            "claude.launch" => self.claude_launch(params).await,
            "claude.bind" => {
                let link = self.claude_link(&params).await?;
                let executable = self.claude.executable()?;
                link.bind(
                    &self.url,
                    params["token"].as_str().context("Give the token")?,
                    params["session_id"].as_str().context("Name the session")?,
                    &executable,
                    params["resume"] == true,
                )
                .await?;
                Ok(json!({"bound": true}))
            }
            "claude.control" => {
                let link = self.claude_link(&params).await?;
                let given = &params["params"];
                match params["op"].as_str().unwrap_or_default() {
                    "request" => {
                        let mut request = given.clone();
                        let session = request["link_id"].as_str().unwrap_or_default().to_owned();
                        crate::chat_runtime::localize_images(
                            &self.attachments,
                            &session,
                            &mut request,
                        )?;
                        link.request(request).await
                    }
                    "describe" => link.describe().await,
                    "settings" => {
                        let patch: Option<AgentSettings> =
                            serde_json::from_value(given["patch"].clone()).unwrap_or(None);
                        Ok(json!(
                            link.settings(
                                given["session_id"].as_str().unwrap_or_default(),
                                patch.as_ref(),
                                given["check"] == true,
                            )
                            .await?
                        ))
                    }
                    other => bail!("This computer's Claude control does not know `{other}`"),
                }
            }
            "claude.stop" => {
                let session = params["session_id"].as_str().unwrap_or_default();
                self.claude_link(&params).await?.stop(session).await?;
                Ok(json!({"stopped": true}))
            }
            // A new session's folder: the one named, or a new worktree of its repository.
            "session.folder" => Ok(json!({"folder": crate::chat_runtime::session_dir_in(
                &self.worktrees,
                params["workspace"].as_str().context("Choose a folder")?,
                params["worktree"].as_str(),
            )
            .await?})),
            "terminal.open" => {
                let folder = params["folder"].as_str().context("Choose a folder")?;
                let size = |key: &str| params[key].as_u64().unwrap_or(24) as u16;
                Ok(json!(self.terminals.open(
                    params["session_id"].as_str().context("Name the session")?,
                    folder,
                    size("cols"),
                    size("rows"),
                )?))
            }
            "terminal.list" => Ok(json!(
                self.terminals
                    .of(params["session_id"].as_str().unwrap_or_default())
            )),
            "terminal.output" => {
                let id = params["id"].as_str().unwrap_or_default();
                Ok(json!({"terminal": self.terminals.info(id)?,
                    "output": self.terminals.output(id, params["after"].as_u64().unwrap_or(0))?}))
            }
            "terminal.input" => {
                self.terminals.write(
                    params["id"].as_str().unwrap_or_default(),
                    params["data"].as_str().unwrap_or_default(),
                )?;
                Ok(json!({"sent": true}))
            }
            "terminal.resize" => Ok(json!(self.terminals.resize(
                params["id"].as_str().unwrap_or_default(),
                params["cols"].as_u64().unwrap_or(80) as u16,
                params["rows"].as_u64().unwrap_or(24) as u16,
            )?)),
            "terminal.close" => {
                self.terminals
                    .close(params["id"].as_str().unwrap_or_default())?;
                Ok(json!({"closed": true}))
            }
            other => crate::host_ops::answer(other, params).await,
        }
    }

    /// A new pi session in a folder of this computer, waiting for its token.
    async fn pi_create(&self, params: Value) -> Result<Value> {
        let workspace = params["workspace"].as_str().context("Choose a folder")?;
        ensure!(
            std::path::Path::new(workspace).is_dir(),
            "This folder is not on this computer"
        );
        let settings = &params["settings"];
        let initial = AgentSettings {
            model: settings["model"].as_str().map(str::to_owned),
            effort: settings["effort"].as_str().map(str::to_owned),
            ..AgentSettings::default()
        };
        let link = self
            .pi
            .create(workspace, &initial, &crate::homes::Homes::own())
            .await?;
        let target = link.target().await?;
        let pending = uuid::Uuid::new_v4().to_string();
        self.pi_pending.lock().await.insert(pending.clone(), link);
        Ok(
            json!({"pending": pending, "native_session_id": target.native_session_id,
            "workspace": target.workspace, "native_locator": target.native_locator}),
        )
    }

    /// The runner takes the session's token, and its pi integration pairs with the kernel as
    /// it does on the kernel's computer. The locator the kernel keeps for it, as it is here.
    async fn pi_bind(&self, params: Value) -> Result<Value> {
        let pending = params["pending"].as_str().unwrap_or_default();
        let link = self
            .pi_pending
            .lock()
            .await
            .remove(pending)
            .context("The started pi is no longer waiting")?;
        let token = params["token"].as_str().context("Give the token")?;
        let session = params["session_id"].as_str().context("Name the session")?;
        let workspace_id = params["workspace_id"]
            .as_str()
            .context("Name the workspace")?;
        let native = link.native_id().to_owned();
        let pid = link.bind(&self.url, token).await?;
        let description = link.describe().await?;
        let folder = description["workspace"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let durable = crate::pi_runner::recovery_locator(
            &native,
            &folder,
            json!({"session_file":description["session_file"],"profile":description["profile"]}),
        )
        .await?;
        let agent = std::path::Path::new(
            durable["agent_dir"]
                .as_str()
                .context("Missing pi host directory")?,
        );
        let mut actual = sessions::running_pi(agent, &native, pid).await?;
        for key in ["session_file", "profile", "agent_dir"] {
            actual.native_locator[key] = durable[key].clone();
        }
        actual.native_locator["runner"] = json!(link.path);
        actual.native_locator["kind"] = json!("pi-runner");
        let paired =
            sessions::pair_pi(&actual, &self.url, workspace_id, token.to_owned(), false).await?;
        self.pi_links
            .lock()
            .await
            .insert(session.to_owned(), paired);
        Ok(json!({"native_locator": actual.native_locator}))
    }

    async fn pi_link(&self, params: &Value) -> Result<crate::pi_runner::RunnerLink> {
        self.pi
            .find(
                params["native"].as_str().unwrap_or_default(),
                params["workspace"].as_str().unwrap_or_default(),
            )
            .await?
            .context("The session's pi is not running on this computer")
    }

    /// A Claude Code runner for a session the kernel has issued.
    async fn claude_launch(&self, params: Value) -> Result<Value> {
        let workspace = params["workspace"].as_str().context("Choose a folder")?;
        // The folder as this computer names it, as its runner records it.
        let workspace = std::fs::canonicalize(workspace)
            .ok()
            .filter(|folder| folder.is_dir())
            .context("This folder is not on this computer")?
            .to_string_lossy()
            .into_owned();
        let workspace = workspace.as_str();
        let mode: crate::model::ClaudePermissionMode =
            serde_json::from_value(params["mode"].clone()).context("Invalid permission mode")?;
        let settings = &params["settings"];
        let initial = AgentSettings {
            model: settings["model"].as_str().map(str::to_owned),
            effort: settings["effort"].as_str().map(str::to_owned),
            ..AgentSettings::default()
        };
        self.claude
            .launch(
                params["native"].as_str().context("Name the session")?,
                workspace,
                mode,
                params["system_prompt"].as_str(),
                &initial,
                &crate::homes::Homes::own(),
            )
            .await?;
        Ok(json!({"launched": true, "workspace": workspace}))
    }

    async fn claude_link(&self, params: &Value) -> Result<crate::claude_runner::RunnerLink> {
        let mode: crate::model::ClaudePermissionMode =
            serde_json::from_value(params["mode"].clone()).context("Invalid permission mode")?;
        self.claude
            .find(
                params["native"].as_str().unwrap_or_default(),
                params["workspace"].as_str().unwrap_or_default(),
                mode,
            )
            .await?
            .context("The session's Claude Code is not running on this computer")
    }

    async fn codex_endpoint(&self) -> Result<String> {
        match &self.codex {
            Some(endpoint) => Ok(endpoint.clone()),
            None => sessions::ensure_codex_daemon().await,
        }
    }

    async fn park(&self, driver: CodexDriver, endpoint: String) -> Result<Value> {
        let pending = uuid::Uuid::new_v4().to_string();
        let thread = driver.thread_id().to_owned();
        let cwd = driver.settings()["cwd"].clone();
        self.pending.lock().await.insert(pending.clone(), driver);
        Ok(json!({"pending": pending, "thread_id": thread, "endpoint": endpoint, "cwd": cwd}))
    }

    /// A new Codex thread in a folder of this computer, with the settings the kernel chose.
    async fn codex_start(&self, params: Value) -> Result<Value> {
        let workspace = params["workspace"].as_str().context("Choose a folder")?;
        ensure!(
            std::path::Path::new(workspace).is_dir(),
            "This folder is not on this computer"
        );
        let settings = &params["settings"];
        let initial = AgentSettings {
            model: settings["model"].as_str().map(str::to_owned),
            effort: settings["effort"].as_str().map(str::to_owned),
            ..AgentSettings::default()
        };
        let policy = serde_json::from_value(settings["approval_policy"].clone()).unwrap_or(None);
        let sandbox = serde_json::from_value(settings["sandbox"].clone()).unwrap_or(None);
        let endpoint = self.codex_endpoint().await?;
        let driver = CodexDriver::start(&endpoint, workspace, policy, sandbox, &initial).await?;
        self.park(driver, endpoint).await
    }

    /// An existing thread of this computer's Codex, continued.
    async fn codex_resume(&self, params: Value) -> Result<Value> {
        let thread = params["thread_id"].as_str().context("Name the thread")?;
        let workspace = params["workspace"].as_str().context("Choose a folder")?;
        let endpoint = self.codex_endpoint().await?;
        let driver =
            CodexDriver::resume(&endpoint, thread, workspace, || async { Ok(true) }).await?;
        self.park(driver, endpoint).await
    }

    /// The session's adapter runs, reporting to the kernel with the session's token.
    async fn codex_bind(self: &Arc<Self>, params: Value) -> Result<Value> {
        let pending = params["pending"]
            .as_str()
            .context("Name the started thread")?;
        let session = params["session_id"]
            .as_str()
            .context("Name the session")?
            .to_owned();
        let token = params["token"]
            .as_str()
            .context("Give the token")?
            .to_owned();
        let driver = self
            .pending
            .lock()
            .await
            .remove(pending)
            .context("The started thread is no longer waiting")?;
        if self.running.lock().await.contains_key(&session) {
            bail!("This session already runs on this computer");
        }
        let control = driver.settings_control();
        let (stop, mut stopped) = watch::channel(false);
        let (invalidate, invalidations) = mpsc::channel(1);
        let _ = invalidate.try_send(());
        let mut woken = self.wake.subscribe();
        let mut stopping = stopped.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    received = woken.recv() => match received {
                        Ok(()) | Err(broadcast::error::RecvError::Lagged(_)) => {
                            let _ = invalidate.try_send(());
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    },
                    _ = stopping.wait_for(|stopped| *stopped) => break,
                }
            }
        });
        let (url, notices, id) = (self.url.clone(), self.notices.clone(), session.clone());
        let task = tokio::spawn(async move {
            let result = driver
                .run(url, id.clone(), token, invalidations, stopped.clone())
                .await;
            if let Err(error) = result
                && !*stopped.borrow_and_update()
            {
                tracing::warn!(
                    session_id = id,
                    error = format!("{error:#}"),
                    "Codex adapter ended"
                );
                // The kernel marks the session for attention.
                let _ = notices.send(json!({"type":"session.ended","session_id":id,
                    "reason":"The native link needs attention. Uncertain messages have not been resent."}));
            }
        });
        self.running.lock().await.insert(
            session,
            Running {
                stop,
                task,
                control,
            },
        );
        Ok(json!({"bound": true}))
    }

    /// Stops a session's adapter here; true when it was running.
    async fn stop(&self, session: &str) -> bool {
        let Some(running) = self.running.lock().await.remove(session) else {
            return false;
        };
        running.stop.send_replace(true);
        let _ = tokio::time::timeout(Duration::from_secs(10), running.task).await;
        true
    }
}

/// This computer's terminals; what grows in them is told to the kernel, at most every 100 ms
/// per terminal, as the kernel tells its own.
fn terminals(notices: mpsc::UnboundedSender<Value>) -> Arc<crate::terminals::Terminals> {
    let (grown, mut heard) = mpsc::unbounded_channel::<String>();
    let terminals = Arc::new(crate::terminals::Terminals::new(grown));
    let watched = Arc::downgrade(&terminals);
    tokio::spawn(async move {
        while let Some(first) = heard.recv().await {
            let mut ids = std::collections::HashSet::from([first]);
            tokio::time::sleep(Duration::from_millis(100)).await;
            while let Ok(id) = heard.try_recv() {
                ids.insert(id);
            }
            let Some(terminals) = watched.upgrade() else {
                break;
            };
            for id in ids {
                if let Ok(info) = terminals.info(&id) {
                    let _ = notices.send(json!({"type": "terminal.output", "terminal_id": id,
                        "session_id": info.session_id, "end": info.end, "ended": info.ended}));
                }
            }
        }
    });
    terminals
}
