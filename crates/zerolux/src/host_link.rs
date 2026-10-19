//! A person's computer joined to the workspace as a host. It has no database: it keeps a
//! channel open to the workspace's kernel, which asks it, over that channel, for what only the
//! computer can do or read, and it tells the kernel what happens there.
//!
//! The kernel sends `{id, op, params}` and the host answers `{id, result}` or `{id, error}`;
//! the host sends `{notice}` on its own.

use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc, oneshot};

type Map<T> = std::sync::Mutex<HashMap<String, T>>;

/// How long the kernel waits for a host's answer.
const ANSWER: Duration = Duration::from_secs(60);
/// What a host secret starts with, so it is never taken for another credential.
pub const SECRET_PREFIX: &str = "zlh_";

type Pending = Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct Link {
    send: mpsc::UnboundedSender<String>,
    pending: Pending,
    /// Which connection this is, so a closing one never removes its replacement.
    generation: u64,
}

/// The hosts connected to this kernel.
#[derive(Default)]
pub struct Links {
    links: Map<Link>,
    next: AtomicU64,
}

impl Links {
    pub async fn online(&self, host: &str) -> bool {
        self.links.lock().expect("links").contains_key(host)
    }

    /// Closes a host's channel: it was removed from the workspace.
    pub async fn disconnect(&self, host: &str) {
        self.links.lock().expect("links").remove(host);
    }

    /// Tells every connected computer that chats changed: their adapters read their inboxes.
    pub fn wake_all(&self) {
        for link in self.links.lock().expect("links").values() {
            let _ = link.send.send(json!({"wake": true}).to_string());
        }
    }

    /// Asks a connected host to do `op`, and waits for its answer.
    pub async fn call(&self, host: &str, op: &str, params: Value) -> Result<Value> {
        let (answer, waiting) = oneshot::channel();
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        {
            let links = self.links.lock().expect("links");
            let link = links
                .get(host)
                .context("That computer is not connected to the workspace right now")?;
            link.pending.lock().expect("pending").insert(id, answer);
            link.send
                .send(json!({"id": id, "op": op, "params": params}).to_string())
                .ok()
                .context("That computer is not connected to the workspace right now")?;
        }
        match tokio::time::timeout(ANSWER, waiting).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(error))) => bail!(crate::store::Error::Invalid(error)),
            Ok(Err(_)) => bail!("That computer disconnected before answering"),
            Err(_) => bail!("That computer did not answer in time"),
        }
    }

    /// Serves one host's connection until it closes: what the kernel asks goes out, answers
    /// come back to whoever asked, and notices go to `notices`.
    /// Returns true when the computer is gone, rather than connected again on another channel.
    pub async fn serve(
        self: Arc<Self>,
        host: String,
        socket: axum::extract::ws::WebSocket,
        notices: mpsc::UnboundedSender<(String, Value)>,
    ) -> bool {
        use axum::extract::ws::Message;
        use futures_util::{SinkExt, StreamExt};
        let (mut sink, mut stream) = socket.split();
        let (send, mut outgoing) = mpsc::unbounded_channel::<String>();
        let pending: Pending = Arc::default();
        let generation = self.next.fetch_add(1, Ordering::Relaxed);
        self.links.lock().expect("links").insert(
            host.clone(),
            Link {
                send,
                pending: pending.clone(),
                generation,
            },
        );
        let writer = tokio::spawn(async move {
            while let Some(text) = outgoing.recv().await {
                if sink.send(Message::Text(text.into())).await.is_err() {
                    return;
                }
            }
            // Disconnected by the kernel: the computer was removed.
            let _ = sink.send(Message::Close(None)).await;
        });
        while let Some(Ok(message)) = stream.next().await {
            let Message::Text(text) = message else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if let Some(notice) = value.get("notice") {
                let _ = notices.send((host.clone(), notice.clone()));
                continue;
            }
            let Some(id) = value["id"].as_u64() else {
                continue;
            };
            let answer = match value.get("error").and_then(Value::as_str) {
                Some(error) => Err(error.to_owned()),
                None => Ok(value["result"].clone()),
            };
            if let Some(waiting) = pending.lock().expect("pending").remove(&id) {
                let _ = waiting.send(answer);
            }
        }
        writer.abort();
        let mut links = self.links.lock().expect("links");
        if links
            .get(&host)
            .is_some_and(|link| link.generation == generation)
        {
            links.remove(&host);
            return true;
        }
        false
    }
}

/// What a joined computer keeps: where the workspace is, and who it is to it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostConfig {
    /// The kernel's address, as `http(s)://host:port`.
    pub url: String,
    pub host_id: String,
    pub secret: String,
}

impl HostConfig {
    pub fn path(data_dir: &std::path::Path) -> std::path::PathBuf {
        data_dir.join("host.json")
    }

    pub fn load(data_dir: &std::path::Path) -> Result<Self> {
        let bytes = std::fs::read(Self::path(data_dir))
            .context("This computer has not joined a workspace; run `zerolux host join` first")?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    pub fn save(&self, data_dir: &std::path::Path) -> Result<()> {
        std::fs::create_dir_all(data_dir)?;
        let path = Self::path(data_dir);
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        options
            .open(path)?
            .write_all(serde_json::to_string_pretty(self)?.as_bytes())?;
        Ok(())
    }
}

/// Joins this computer to a workspace with the one-time code its person made there.
pub async fn join(url: &str, code: &str, name: &str, data_dir: &std::path::Path) -> Result<()> {
    let url = url.trim_end_matches('/').to_owned();
    let reply: Value = reqwest::Client::builder()
        .no_proxy()
        .build()?
        .post(format!("{url}/api/hosts/join"))
        .json(&json!({"code": code, "name": name}))
        .send()
        .await
        .context("The workspace's kernel cannot be reached")?
        .error_for_status()
        .context("The workspace refused the code; make a new one")?
        .json()
        .await?;
    HostConfig {
        url,
        host_id: reply["host_id"]
            .as_str()
            .context("The kernel did not name this host")?
            .to_owned(),
        secret: reply["secret"]
            .as_str()
            .context("The kernel did not answer a secret")?
            .to_owned(),
    }
    .save(data_dir)
}

/// Keeps this computer connected to its workspace, answering what the kernel asks, and
/// connects again after a break.
pub async fn run(
    config: HostConfig,
    data_dir: &std::path::Path,
    stop: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    let (tell, told) = mpsc::unbounded_channel();
    let host =
        crate::host_runtime::HostRuntime::new(config.url.clone(), data_dir.join("links"), tell);
    run_with(config, stop, host, told).await
}

/// Where a computer's connection to its workspace is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum HostLinkState {
    Connecting,
    Connected,
    /// The connection broke or could not be made, and is tried again.
    Reconnecting {
        error: String,
    },
}

/// The same, with a host runtime of the caller's.
pub async fn run_with(
    config: HostConfig,
    stop: tokio::sync::watch::Receiver<bool>,
    host: Arc<crate::host_runtime::HostRuntime>,
    told: mpsc::UnboundedReceiver<Value>,
) -> Result<()> {
    let (state, _) = tokio::sync::watch::channel(HostLinkState::Connecting);
    run_reporting(config, stop, host, told, state).await
}

/// The same, telling `state` where the connection is as it changes.
pub async fn run_reporting(
    config: HostConfig,
    mut stop: tokio::sync::watch::Receiver<bool>,
    host: Arc<crate::host_runtime::HostRuntime>,
    mut told: mpsc::UnboundedReceiver<Value>,
    state: tokio::sync::watch::Sender<HostLinkState>,
) -> Result<()> {
    state.send_replace(HostLinkState::Connecting);
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
    let mut wait = Duration::from_secs(1);
    loop {
        let address = format!("{}/api/hosts/channel", config.url.replacen("http", "ws", 1));
        let mut request = address.into_client_request()?;
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {}", config.secret).parse()?,
        );
        match tokio_tungstenite::connect_async(request).await {
            Ok((socket, _)) => {
                tracing::info!(url = config.url, "Connected to the workspace");
                state.send_replace(HostLinkState::Connected);
                wait = Duration::from_secs(1);
                let (sink, mut stream) = socket.split();
                let sink = Arc::new(Mutex::new(sink));
                loop {
                    tokio::select! {
                        _ = stop.changed() => return Ok(()),
                        notice = told.recv() => {
                            let Some(notice) = notice else { continue };
                            let notice = json!({"notice": notice}).to_string();
                            let _ = sink.lock().await.send(Message::Text(notice.into())).await;
                        }
                        message = stream.next() => {
                            let Some(Ok(message)) = message else { break };
                            let Message::Text(text) = message else { continue };
                            let Ok(request) = serde_json::from_str::<Value>(&text) else { continue };
                            if request.get("wake").is_some() {
                                host.wake();
                                continue;
                            }
                            let (sink, host) = (sink.clone(), host.clone());
                            tokio::spawn(async move {
                                let op = request["op"].as_str().unwrap_or_default().to_owned();
                                let reply = match host.answer(&op, request["params"].clone()).await {
                                    Ok(result) => json!({"id": request["id"], "result": result}),
                                    Err(error) => json!({"id": request["id"], "error": format!("{error:#}")}),
                                };
                                let _ = sink.lock().await.send(Message::Text(reply.to_string().into())).await;
                            });
                        }
                    }
                }
                tracing::warn!("The workspace's kernel closed the connection");
                state.send_replace(HostLinkState::Reconnecting {
                    error: "The workspace's kernel closed the connection".into(),
                });
            }
            // Its secret is no longer the workspace's: trying again would never connect.
            Err(tokio_tungstenite::tungstenite::Error::Http(response))
                if response.status() == 401 =>
            {
                bail!(
                    "This computer was removed from the workspace; join it again with a new code"
                );
            }
            Err(error) => {
                tracing::warn!(error = %error, "The workspace's kernel cannot be reached");
                state.send_replace(HostLinkState::Reconnecting {
                    error: format!("The workspace's kernel cannot be reached: {error}"),
                });
            }
        }
        tokio::select! {
            _ = stop.changed() => return Ok(()),
            _ = tokio::time::sleep(wait) => {}
        }
        wait = (wait * 2).min(Duration::from_secs(60));
    }
}
