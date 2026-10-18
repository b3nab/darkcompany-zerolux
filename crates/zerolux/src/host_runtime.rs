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
}

impl HostRuntime {
    pub fn new(url: String, notices: mpsc::UnboundedSender<Value>) -> Arc<Self> {
        Self::with_codex(url, None, notices)
    }

    /// With a Codex daemon of its own choosing, such as a test's.
    pub fn with_codex(
        url: String,
        codex: Option<String>,
        notices: mpsc::UnboundedSender<Value>,
    ) -> Arc<Self> {
        Arc::new(Self {
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
                control.request(&params["request"]).await
            }
            other => crate::host_ops::answer(other, params).await,
        }
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
