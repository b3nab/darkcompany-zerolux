//! Existing-runtime Codex bridge. This module never launches a Codex process.
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail, ensure};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::{broadcast, mpsc, oneshot, watch},
};
use tokio_tungstenite::{WebSocketStream, tungstenite::Message};
use uuid::Uuid;

use crate::{
    chat_driver::{Delivery, Kernel, MAX_TEXT, prompt, string},
    chat_tools::ChatLink,
    model::{CodexApprovalPolicy, CodexSandbox},
};

const RPC_TIMEOUT: Duration = Duration::from_secs(10);

/// A Codex start ZeroLux asked for that did not end in a linked session: what the owner is
/// told, exactly. Codex never discards or restarts a thread on its behalf.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexStartFailure {
    /// Codex did not answer: whether it started a thread is not known.
    Uncertain,
    /// Codex started this thread, and ZeroLux could not link it; it is live in Codex.
    Unlinked { thread_id: String },
}

impl std::fmt::Display for CodexStartFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Uncertain => f.write_str(
                "Codex did not confirm the new session; whether it started one is uncertain. Look again under Hire before starting another.",
            ),
            Self::Unlinked { thread_id } => write!(
                f,
                "Codex started thread {thread_id} but ZeroLux could not link it; it is live in Codex and can be hired under Hire"
            ),
        }
    }
}

impl std::error::Error for CodexStartFailure {}
const CLOSED: &str = "zerolux/transportClosed";
type Reply = oneshot::Sender<Result<Value>>;

enum Outbound {
    Message(Value),
    Response {
        id: Value,
        result: Value,
        written: oneshot::Sender<Result<bool>>,
    },
}

struct Shared {
    pending: Mutex<HashMap<u64, Reply>>,
    server_requests: Mutex<HashMap<String, Value>>,
    resolved_requests: Mutex<HashSet<String>>,
    events: broadcast::Sender<Value>,
}

/// One initialized JSON-RPC connection; cloning it does not create another writer.
/// Discovery can use `request` and then drop the connection without resuming a thread.
#[derive(Clone)]
pub struct CodexRpc {
    outgoing: mpsc::Sender<Outbound>,
    shared: Arc<Shared>,
    next_id: Arc<AtomicU64>,
    timeout: Duration,
    connection_id: String,
}

impl CodexRpc {
    pub async fn connect(endpoint: &str) -> Result<Self> {
        Self::connect_with_timeout(endpoint, RPC_TIMEOUT).await
    }

    pub async fn connect_with_timeout(endpoint: &str, timeout: Duration) -> Result<Self> {
        let connection = async {
            if let Some(path) = endpoint
                .strip_prefix("unix://")
                .or_else(|| endpoint.starts_with('/').then_some(endpoint))
            {
                #[cfg(unix)]
                {
                    let stream = tokio::net::UnixStream::connect(path)
                        .await
                        .context("Cannot connect to the existing Codex runtime")?;
                    let (socket, _) = tokio_tungstenite::client_async("ws://localhost/", stream)
                        .await
                        .context("Codex WebSocket handshake failed")?;
                    Ok(Self::from_socket(socket, timeout))
                }
                #[cfg(not(unix))]
                {
                    let _ = path;
                    bail!("This Codex runtime uses a Unix socket unavailable on this platform")
                }
            } else {
                let url = reqwest::Url::parse(endpoint)
                    .map_err(|_| anyhow!("Invalid Codex runtime endpoint"))?;
                let local = crate::chat_tools::is_loopback(&url);
                ensure!(
                    url.scheme() == "ws"
                        && local
                        && url.username().is_empty()
                        && url.password().is_none(),
                    "Codex runtime endpoint must be a local WebSocket or Unix socket"
                );
                let (socket, _) = tokio_tungstenite::connect_async(endpoint)
                    .await
                    .map_err(|_| anyhow!("Cannot connect to the existing Codex runtime"))?;
                Ok(Self::from_socket(socket, timeout))
            }
        };
        let rpc: Self = tokio::time::timeout(timeout, connection)
            .await
            .context("Codex connection timed out")??;
        rpc.request("initialize", json!({"clientInfo":{"name":"zerolux","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}})).await?;
        rpc.send(json!({"method":"initialized","params":{}}))
            .await?;
        Ok(rpc)
    }

    fn from_socket<S>(mut socket: WebSocketStream<S>, timeout: Duration) -> Self
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (outgoing, mut incoming) = mpsc::channel::<Outbound>(64);
        let (events, _) = broadcast::channel(512);
        let shared = Arc::new(Shared {
            pending: Mutex::new(HashMap::new()),
            server_requests: Mutex::new(HashMap::new()),
            resolved_requests: Mutex::new(HashSet::new()),
            events,
        });
        let state = shared.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    command = incoming.recv() => match command {
                        Some(Outbound::Message(value)) => {
                            if write_frame(&mut socket, Message::Text(value.to_string().into()), timeout).await.is_err() { break; }
                        }
                        Some(Outbound::Response { id, result, written }) => {
                            // The same request may already have been answered by the native UI.
                            let exists = state.server_requests.lock().unwrap().remove(&id.to_string()).is_some();
                            if !exists { let _ = written.send(Ok(false)); continue; }
                            let sent = write_frame(&mut socket, Message::Text(json!({"id":id,"result":result}).to_string().into()), timeout).await;
                            let failed = sent.is_err();
                            let _ = written.send(sent.map(|_| true).map_err(|_| anyhow!("Codex approval delivery is uncertain")));
                            if failed { break; }
                        }
                        None => { let _ = tokio::time::timeout(timeout, socket.close(None)).await; break; }
                    },
                    frame = socket.next() => {
                        let bytes = match frame {
                            Some(Ok(Message::Text(text))) => text.as_bytes().to_vec(),
                            Some(Ok(Message::Binary(bytes))) => bytes.to_vec(),
                            Some(Ok(Message::Ping(bytes))) => {
                                if write_frame(&mut socket, Message::Pong(bytes), timeout).await.is_err() { break; }
                                continue;
                            }
                            Some(Ok(Message::Pong(_))) => continue,
                            _ => break,
                        };
                        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { break; };
                        if value.get("method").is_none() {
                            if let Some(id) = value["id"].as_u64()
                                && let Some(reply) = state.pending.lock().unwrap().remove(&id) {
                                let result = if value.get("error").is_some() {
                                    Err(anyhow!(Rejected(value["error"]["code"].clone())))
                                } else { Ok(value["result"].clone()) };
                                let _ = reply.send(result);
                            }
                            continue;
                        }
                        if value["method"] == "serverRequest/resolved" {
                            let id = value["params"]["requestId"].to_string();
                            state.server_requests.lock().unwrap().remove(&id);
                            state.resolved_requests.lock().unwrap().insert(id);
                        } else if let Some(id) = value.get("id") {
                            state.resolved_requests.lock().unwrap().remove(&id.to_string());
                            state.server_requests.lock().unwrap().insert(id.to_string(), value.clone());
                        }
                        let _ = state.events.send(value);
                    }
                }
            }
            state.server_requests.lock().unwrap().clear();
            for (_, reply) in state.pending.lock().unwrap().drain() {
                let _ = reply.send(Err(anyhow!(
                    "Codex connection closed; request outcome may be uncertain"
                )));
            }
            let _ = state.events.send(json!({"method":CLOSED}));
        });
        Self {
            outgoing,
            shared,
            next_id: Arc::new(AtomicU64::new(1)),
            timeout,
            connection_id: Uuid::new_v4().to_string(),
        }
    }

    async fn send(&self, value: Value) -> Result<()> {
        tokio::time::timeout(self.timeout, self.outgoing.send(Outbound::Message(value)))
            .await
            .context("Codex send timed out; outcome may be uncertain")?
            .map_err(|_| anyhow!("Codex connection closed"))
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.shared.pending.lock().unwrap().insert(id, tx);
        if let Err(error) = self
            .send(json!({"id":id,"method":method,"params":params}))
            .await
        {
            self.shared.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        let result = tokio::time::timeout(self.timeout, rx).await;
        self.shared.pending.lock().unwrap().remove(&id);
        result
            .context("Codex request timed out; outcome may be uncertain")?
            .context("Codex connection closed")?
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.shared.events.subscribe()
    }

    fn native_request_id(&self, id: &Value) -> String {
        format!("{}:{}", self.connection_id, id)
    }

    fn pending_server_requests(&self) -> Vec<Value> {
        self.shared
            .server_requests
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect()
    }

    fn request_was_resolved(&self, id: &Value) -> bool {
        self.shared
            .resolved_requests
            .lock()
            .unwrap()
            .contains(&id.to_string())
    }

    async fn respond(&self, id: Value, result: Value) -> Result<bool> {
        let (written, rx) = oneshot::channel();
        tokio::time::timeout(
            self.timeout,
            self.outgoing.send(Outbound::Response {
                id,
                result,
                written,
            }),
        )
        .await
        .context("Codex approval delivery is uncertain")?
        .map_err(|_| anyhow!("Codex connection closed"))?;
        tokio::time::timeout(self.timeout, rx)
            .await
            .context("Codex approval delivery is uncertain")?
            .context("Codex approval delivery is uncertain")?
    }
}

async fn write_frame<S>(
    socket: &mut WebSocketStream<S>,
    frame: Message,
    timeout: Duration,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    tokio::time::timeout(timeout, socket.send(frame))
        .await
        .context("Codex write timed out; outcome may be uncertain")?
        .map_err(|_| anyhow!("Codex connection closed; outcome may be uncertain"))
}

/// Codex answered and refused: the request had no effect. Anything else is uncertain.
#[derive(Debug)]
struct Rejected(Value);

impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Codex request rejected (code {})", self.0)
    }
}

impl std::error::Error for Rejected {}

/// What a native thread status says; None when it says nothing about working or waiting.
fn activity(status: &Value) -> Option<&'static str> {
    match status["type"].as_str() {
        Some("active") => Some("working"),
        Some("idle") => Some("idle"),
        _ => None,
    }
}

/// JSON-RPC: the request was not valid for the current state and was not applied.
const INVALID_REQUEST: i64 = -32600;

/// Native request ID of a message that joined a running turn, followed by the turn ID.
const STEERED: &str = "turn:";

#[derive(Default)]
struct TurnState {
    items: Vec<Value>,
}

impl TurnState {
    fn add(&mut self, item: Value) {
        if let Some(existing) = self.items.iter_mut().find(|old| old["id"] == item["id"]) {
            *existing = item;
        } else {
            self.items.push(item);
        }
    }

    fn delivery<'a>(&self, deliveries: &'a HashMap<String, Delivery>) -> Option<&'a Delivery> {
        let mut opener: Option<&Delivery> = None;
        for user in self
            .items
            .iter()
            .filter(|item| item["type"] == "userMessage")
        {
            let id = user["clientId"].as_str()?;
            let delivery = deliveries.get(id)?;
            let first = *opener.get_or_insert(delivery);
            // More than one input is fine, but every message in every envelope must be
            // from this chat. Keep the opener, never the mutable "latest delivery".
            if envelope(deliveries, id)
                .any(|d| d.message.conversation_id != first.message.conversation_id)
            {
                return None;
            }
        }
        opener
    }
}

/// One native input can carry several chat envelopes. Its last delivery is the native
/// client ID; the others name it durably before the native call, including across chats.
fn envelope<'a>(
    deliveries: &'a HashMap<String, Delivery>,
    id: &'a str,
) -> impl Iterator<Item = &'a Delivery> {
    deliveries
        .values()
        .filter(move |d| d.id == id || d.native_request_id.as_deref() == Some(id))
}

struct Approval {
    id: String,
    request: Value,
    dispatched: bool,
}

/// Owns one subscribed native thread. Tokens are passed only to `run`, never Debug/logged.
pub struct CodexDriver {
    rpc: CodexRpc,
    events: broadcast::Receiver<Value>,
    thread_id: String,
    settings: Value,
    deliveries: HashMap<String, Delivery>,
    turns: HashMap<String, TurnState>,
    settled: HashSet<String>,
    /// The turn Codex is running now, if any: messages join it instead of waiting for its end.
    active_turn: Option<String>,
    /// Chats of the envelopes registered in the active turn, and whether another input
    /// (typed in Codex, or not ours) joined it: the turn is "about" one chat only when every
    /// input belongs to it.
    turn_chats: HashSet<String>,
    turn_private: bool,
    approvals: HashMap<String, Approval>,
}

impl CodexDriver {
    pub async fn attach(endpoint: &str, thread_id: &str) -> Result<Self> {
        let rpc = CodexRpc::connect(endpoint).await?;
        Self::attach_with_rpc(rpc, thread_id).await
    }

    /// Reuses an initialized connection, including for deterministic protocol fixtures.
    pub async fn attach_with_rpc(rpc: CodexRpc, thread_id: &str) -> Result<Self> {
        Self::join_with_rpc::<fn() -> std::future::Ready<Result<bool>>, _>(rpc, thread_id, None)
            .await
    }

    /// A new thread in `workspace`, started by ZeroLux: one `thread/start`, no prompt. Only
    /// what the owner chose is sent; the rest follows the user's Codex configuration.
    pub async fn start(
        endpoint: &str,
        workspace: &str,
        approval_policy: Option<CodexApprovalPolicy>,
        sandbox: Option<CodexSandbox>,
    ) -> Result<Self> {
        let rpc = CodexRpc::connect(endpoint).await?;
        Self::start_with_rpc(rpc, workspace, approval_policy, sandbox).await
    }

    pub async fn start_with_rpc(
        rpc: CodexRpc,
        workspace: &str,
        approval_policy: Option<CodexApprovalPolicy>,
        sandbox: Option<CodexSandbox>,
    ) -> Result<Self> {
        let mut params = json!({"cwd":workspace,"ephemeral":false});
        if let Some(policy) = approval_policy {
            params["approvalPolicy"] = serde_json::to_value(policy)?;
        }
        if let Some(sandbox) = sandbox {
            params["sandbox"] = serde_json::to_value(sandbox)?;
        }
        let events = rpc.subscribe();
        // No answer is no knowledge: the thread may or may not exist in Codex.
        let created = rpc
            .request("thread/start", params)
            .await
            .context(CodexStartFailure::Uncertain)?;
        // From here the thread exists: whatever is wrong, its ID is reported, never lost.
        let thread_id = created["thread"]["id"]
            .as_str()
            .unwrap_or("<unknown>")
            .to_owned();
        (|| {
            ensure!(
                created["thread"]["cwd"] == workspace,
                "Codex started the thread in another folder"
            );
            ensure!(
                created["thread"]["canAcceptDirectInput"] != false
                    && created["thread"]["ephemeral"] != true,
                "The new Codex session cannot receive queued messages"
            );
            Self::attached(rpc, events, created, None)
        })()
        .context(CodexStartFailure::Unlinked { thread_id })
    }

    /// Continues a session ZeroLux already held, live or not (see `resume_with_rpc`).
    pub async fn resume<F, Fut>(
        endpoint: &str,
        thread_id: &str,
        workspace: &str,
        still_wanted: F,
    ) -> Result<Self>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<bool>>,
    {
        let rpc = CodexRpc::connect(endpoint).await?;
        Self::resume_with_rpc(rpc, thread_id, workspace, still_wanted).await
    }

    /// The same session, continued by ZeroLux: a thread the runtime no longer holds (the
    /// daemon restarted, the machine crashed) is loaded again from its persisted history,
    /// with the same identity and in the same workspace. Its turns are not read back into
    /// the kernel. `still_wanted` is asked right before the load: a Stop that arrived
    /// meanwhile means no native work starts.
    pub async fn resume_with_rpc<F, Fut>(
        rpc: CodexRpc,
        thread_id: &str,
        workspace: &str,
        still_wanted: F,
    ) -> Result<Self>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<bool>>,
    {
        Self::join_with_rpc(rpc, thread_id, Some((workspace, still_wanted))).await
    }

    async fn join_with_rpc<F, Fut>(
        rpc: CodexRpc,
        thread_id: &str,
        cold: Option<(&str, F)>,
    ) -> Result<Self>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<bool>>,
    {
        let events = rpc.subscribe();
        let metadata = rpc
            .request(
                "thread/read",
                json!({"threadId":thread_id,"includeTurns":false}),
            )
            .await?;
        ensure!(
            metadata["thread"]["id"] == thread_id,
            "Codex returned a different thread"
        );
        let status = metadata["thread"]["status"]["type"].as_str();
        ensure!(
            matches!(status, Some("active" | "idle"))
                || (cold.is_some() && status == Some("notLoaded")),
            if cold.is_some() {
                "The Codex session cannot be resumed in this state"
            } else {
                "The selected Codex session is not running"
            }
        );
        ensure!(
            metadata["thread"]["canAcceptDirectInput"] != false
                && metadata["thread"]["ephemeral"] != true,
            "The selected Codex session cannot receive queued messages"
        );
        // A live thread is joined as before; a cold one is loaded without its turns, in the
        // workspace it was hired in, and only if nobody stopped it meanwhile.
        let params = match cold {
            Some((workspace, still_wanted)) => {
                ensure!(
                    metadata["thread"]["cwd"] == workspace,
                    "The Codex session's workspace changed; it is not resumed"
                );
                ensure!(
                    still_wanted().await?,
                    "The session was stopped before it was resumed"
                );
                json!({"threadId":thread_id,"excludeTurns":true})
            }
            None => json!({"threadId":thread_id}),
        };
        let settings = rpc.request("thread/resume", params).await?;
        Self::attached(rpc, events, settings, Some(thread_id))
    }

    fn attached(
        rpc: CodexRpc,
        events: broadcast::Receiver<Value>,
        mut settings: Value,
        expected: Option<&str>,
    ) -> Result<Self> {
        let thread_id = string(&settings["thread"], "id")?.to_owned();
        ensure!(
            expected.is_none_or(|id| id == thread_id),
            "Codex returned a different thread"
        );
        settings["thread"]["turns"] = json!([]);
        Ok(Self {
            rpc,
            events,
            thread_id,
            settings,
            deliveries: HashMap::new(),
            turns: HashMap::new(),
            settled: HashSet::new(),
            active_turn: None,
            turn_chats: HashSet::new(),
            turn_private: false,
            approvals: HashMap::new(),
        })
    }

    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }
    pub fn settings(&self) -> &Value {
        &self.settings
    }
    pub fn can_create_context(&self) -> bool {
        context_params(&self.settings).is_ok()
    }

    /// Creates a fresh, idle thread without copying history or submitting a prompt.
    pub async fn create_context(&self) -> Result<Self> {
        let current = self
            .rpc
            .request("thread/resume", json!({"threadId":self.thread_id}))
            .await?;
        let params = context_params(&current)?;
        let events = self.rpc.subscribe();
        let created = self.rpc.request("thread/start", params).await?;
        ensure!(
            created["thread"]["id"] != self.thread_id,
            "Codex did not create a distinct context"
        );
        for field in [
            "cwd",
            "model",
            "modelProvider",
            "serviceTier",
            "approvalPolicy",
            "approvalsReviewer",
            "sandbox",
            "runtimeWorkspaceRoots",
            "reasoningEffort",
        ] {
            ensure!(
                created[field] == current[field],
                "New Codex context did not preserve {field}; no prompt was submitted"
            );
        }
        ensure!(
            created["thread"]["environments"] == current["thread"]["environments"],
            "New Codex context did not preserve environments; no prompt was submitted"
        );
        Self::attached(self.rpc.clone(), events, created, None)
    }

    pub async fn run(
        mut self,
        kernel_url: String,
        links: std::path::PathBuf,
        session_id: String,
        token: String,
        mut changed: mpsc::Receiver<()>,
        mut stop: watch::Receiver<bool>,
    ) -> Result<()> {
        let link = ChatLink::create(
            &links,
            &kernel_url,
            &token,
            &format!("codex:{}", self.thread_id),
        )?;
        let kernel = Kernel::new(kernel_url, session_id, token, link)?;
        let result = async {
            if *stop.borrow() { return Ok(()); }
            kernel.status("connected", None).await?;
            if !self.refresh(&kernel, true, true).await? { return Ok(()); }
            loop {
                tokio::select! {
                    value = stop.changed() => {
                        if value.is_err() || *stop.borrow() { return Ok(()); }
                    }
                    event = self.events.recv() => match event {
                        Ok(event) if event["method"] == CLOSED => bail!("Codex connection closed; pending prompts will not be resent"),
                        Ok(event) => {
                            let method = event["method"].as_str().map(str::to_owned);
                            let ours = event["params"]["threadId"] == self.thread_id;
                            let turn = event["params"]["turn"]["id"].as_str().map(str::to_owned);
                            match method.as_deref() {
                                Some("turn/started") if ours => {
                                    self.active_turn = turn;
                                    self.turn_chats.clear();
                                    self.turn_private = false;
                                    kernel.activity(Some("working"), None).await?;
                                }
                                Some("turn/completed") if ours => {
                                    if self.active_turn == turn {
                                        self.active_turn = None;
                                    }
                                    self.turn_chats.clear();
                                    self.turn_private = false;
                                    kernel.activity(Some("idle"), None).await?;
                                }
                                Some("thread/status/changed")
                                    if ours && event["params"]["status"]["type"].is_string() =>
                                {
                                    let status = activity(&event["params"]["status"]);
                                    let chat = self.turn_conversation();
                                    kernel.activity(status, chat.as_deref()).await?;
                                }
                                _ => {}
                            }
                            let settled = self.settled.len();
                            self.event(&kernel, event).await?;
                            // Starting a turn releases any new input held while its opener
                            // was in the native queue. Reading that opener is not a gate.
                            let turned = matches!(method.as_deref(), Some("turn/started" | "turn/completed")) && ours;
                            if (turned || self.settled.len() != settled)
                                && !self.refresh(&kernel, false, false).await?
                            {
                                return Ok(());
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            self.reconcile(&kernel).await?;
                            if !self.refresh(&kernel, false, true).await? { return Ok(()); }
                        }
                        Err(broadcast::error::RecvError::Closed) => bail!("Codex connection closed"),
                    },
                    notification = changed.recv() => {
                        ensure!(notification.is_some(), "LiveKit adapter notifications stopped");
                        if !self.refresh(&kernel, false, true).await? { return Ok(()); }
                    }
                }
            }
        }.await;
        // Revocation may make an in-flight HTTP call fail before the stop signal is polled.
        // Every exit attempts cancellation, scoped to this link's known native delivery IDs.
        let cancellation = self.cancel_owned().await;
        if result.is_err() || cancellation.is_err() {
            let _ = kernel.status("attention", Some("Codex needs attention. Uncertain messages and decisions have not been resent.")).await;
        }
        cancellation?;
        if *stop.borrow() { Ok(()) } else { result }
    }

    /// `approvals` is false when only the next envelope is due: a native event may still be
    /// on its way, and an approval recorded before it would lack its details.
    async fn refresh(&mut self, kernel: &Kernel, recover: bool, approvals: bool) -> Result<bool> {
        let inbox = kernel.get("/chat/inbox").await?;
        ensure!(
            inbox["session"]["id"] == kernel.session_id,
            "Kernel returned a different chat session"
        );
        if inbox["session"]["status"] == "stopped" {
            return Ok(false);
        }
        let mut pending: Vec<Delivery> =
            serde_json::from_value(inbox["deliveries"].clone()).context("Invalid chat inbox")?;
        pending.retain(|delivery| delivery.session_id == kernel.session_id);
        // The inbox orders arrivals across chats; seq is local to each conversation.
        // Sort only each chat's occupied slots (e.g. timestamp ties), never chats against
        // each other: the main chat's seq 100 can precede the newer side chat's seq 1.
        let order: Vec<_> = pending
            .iter()
            .map(|d| d.message.conversation_id.clone())
            .collect();
        let mut chats: HashMap<String, Vec<Delivery>> = HashMap::new();
        for delivery in pending {
            chats
                .entry(delivery.message.conversation_id.clone())
                .or_default()
                .push(delivery);
        }
        for chat in chats.values_mut() {
            chat.sort_by_key(|d| std::cmp::Reverse(d.message.seq));
        }
        let pending: Vec<_> = order
            .into_iter()
            .map(|chat| chats.get_mut(&chat).unwrap().pop().unwrap())
            .collect();
        for delivery in &pending {
            self.deliveries
                .insert(delivery.id.clone(), delivery.clone());
        }
        if recover {
            self.reconcile(kernel).await?;
        }
        if approvals {
            self.reconcile_approvals(kernel).await?;
            for approval in inbox["approvals"].as_array().into_iter().flatten() {
                self.decision(kernel, approval).await?;
            }
        }
        // Before Codex starts a queued opener there is no turn to steer. Leave arrivals
        // unclaimed until turn/started instead of creating one future turn per notification.
        // Once a turn exists, accepted inputs never block new ones waiting for Read.
        if self.active_turn.is_none()
            && self
                .deliveries
                .values()
                .any(|d| d.status != "stored" && !self.settled.contains(&d.id) && !self.carried(d))
        {
            return Ok(true);
        }
        {
            // Claim the whole snapshot. Consecutive chat runs retain their own envelope,
            // reply command and roster, in sequence order, inside one native input.
            let mut batch = Vec::new();
            for mut delivery in pending
                .into_iter()
                .filter(|d| d.status == "stored" && !self.settled.contains(&d.id))
            {
                let path = format!("/chat/deliveries/{}/dispatch", delivery.id);
                let Some(dispatch) = kernel.post_conflict(&path, json!({})).await? else {
                    continue;
                };
                ensure!(
                    dispatch["delivery"]["id"] == delivery.id,
                    "Kernel dispatched a different delivery"
                );
                delivery.message = serde_json::from_value(dispatch["message"].clone())
                    .context("Invalid dispatch message")?;
                ensure!(
                    delivery.message.text.len() <= MAX_TEXT,
                    "Chat message exceeds the Codex bridge limit"
                );
                delivery.status = "uncertain".into();
                batch.push(delivery);
            }
            let Some(delivery) = batch.last().cloned() else {
                return Ok(true);
            };
            let prompt = batch
                .chunk_by(|a, b| a.message.conversation_id == b.message.conversation_id)
                .map(|run| prompt(run, &inbox, &kernel.link, false))
                .collect::<Result<Vec<_>>>()?
                .join("\n\n");
            for mut carried in batch {
                if carried.id != delivery.id {
                    carried.native_request_id = Some(delivery.id.clone());
                    kernel
                        .receipt(
                            &carried.id,
                            json!({"status":"uncertain","native_request_id":delivery.id}),
                        )
                        .await?;
                }
                self.deliveries.insert(carried.id.clone(), carried);
            }
            let input = json!([{"type":"text","text":prompt}]);
            // A running turn reads the message at its next step. Codex refuses to steer some
            // turns, such as a review: the message then waits in the queue for the turn to end.
            let steered = match &self.active_turn {
                Some(turn) => match self.rpc.request("turn/steer", json!({"threadId":self.thread_id,"expectedTurnId":turn,"clientUserMessageId":delivery.id,"input":input})).await {
                    Ok(steered) => {
                        ensure!(
                            steered["turnId"] == **turn,
                            "Codex steered a different turn; the message was not sent again"
                        );
                        Some(format!("{STEERED}{turn}"))
                    }
                    // Only an invalid request proves that nothing was delivered: the turn ended
                    // or cannot be steered. A lost answer or an internal error may hide an
                    // accepted message: it stays uncertain and is never sent twice.
                    Err(error)
                        if error
                            .downcast_ref::<Rejected>()
                            .is_some_and(|refusal| refusal.0 == INVALID_REQUEST) =>
                    {
                        None
                    }
                    Err(error) => return Err(error),
                },
                None => None,
            };
            let queue_id = match steered {
                Some(steered) => steered,
                None => {
                    let queued = self.rpc.request("thread/queue/add", json!({"threadId":self.thread_id,"clientUserMessageId":delivery.id,"input":input})).await?;
                    ensure!(
                        queued["queuedSubmission"]["clientUserMessageId"] == delivery.id,
                        "Codex returned a different queued message"
                    );
                    string(&queued["queuedSubmission"], "id")?.to_owned()
                }
            };
            self.notified(kernel, &delivery.id, &queue_id).await?;
        }
        Ok(true)
    }

    /// Acceptance applies to every message carried by the native input, not just its ID.
    /// A correlated chat reply can make Read durable before the Notified acknowledgement.
    async fn notified(&mut self, kernel: &Kernel, id: &str, native_id: &str) -> Result<()> {
        // Remember the accepted native ID even if the first receipt fails or is revoked:
        // Stop must still be able to cancel exactly this queue entry/turn.
        if let Some(local) = self.deliveries.get_mut(id) {
            local.native_request_id = Some(native_id.to_owned());
        }
        let mut ids: Vec<_> = envelope(&self.deliveries, id)
            .map(|d| d.id.clone())
            .collect();
        ids.sort_by_key(|carried| (carried == id, self.deliveries[carried].message.seq));
        for carried_id in ids {
            if self.deliveries[&carried_id].status == "read" {
                continue;
            }
            let native = if carried_id == id { native_id } else { id };
            let response = kernel
                .post_conflict(
                    &format!("/chat/deliveries/{carried_id}/receipt"),
                    json!({"status":"notified","native_request_id":native}),
                )
                .await?;
            if response.is_none() {
                // The inbox retains all attempted/unread deliveries, even after Pause/Close.
                // Only absence (Read) reconciles this race; other conflicts remain errors.
                let inbox = kernel.get("/chat/inbox").await?;
                ensure!(
                    inbox["session"]["id"] == kernel.session_id,
                    "Kernel returned a different chat session"
                );
                let pending = inbox["deliveries"]
                    .as_array()
                    .context("Invalid chat inbox")?;
                ensure!(
                    !pending
                        .iter()
                        .any(|d| d["id"] == carried_id && d["status"] != "read"),
                    "Codex delivery receipt conflicted before Read"
                );
                self.registered(kernel, &carried_id).await?;
            } else if let Some(local) = self.deliveries.get_mut(&carried_id) {
                local.native_request_id = Some(native.to_owned());
                local.status = "notified".into();
            }
        }
        Ok(())
    }

    /// Carried by the envelope of another delivery of this link, and settled together with it.
    fn carried(&self, delivery: &Delivery) -> bool {
        delivery
            .native_request_id
            .as_ref()
            .is_some_and(|envelope| self.deliveries.contains_key(envelope))
    }

    async fn reconcile(&mut self, kernel: &Kernel) -> Result<()> {
        let mut held = HashSet::new();
        let mut cursor = Value::Null;
        loop {
            let page = self
                .rpc
                .request(
                    "thread/queue/list",
                    json!({"threadId":self.thread_id,"limit":100,"cursor":cursor}),
                )
                .await?;
            for queued in page["data"].as_array().into_iter().flatten() {
                let Some(id) = queued["clientUserMessageId"].as_str() else {
                    continue;
                };
                held.insert(id.to_owned());
                if self.deliveries.contains_key(id) {
                    self.notified(kernel, id, string(queued, "id")?).await?;
                }
            }
            let next = page["nextCursor"].clone();
            if next.is_null() {
                break;
            }
            ensure!(next != cursor, "Codex queue cursor did not advance");
            cursor = next;
        }
        let history = self
            .rpc
            .request(
                "thread/read",
                json!({"threadId":self.thread_id,"includeTurns":true}),
            )
            .await?;
        ensure!(
            history["thread"]["id"] == self.thread_id,
            "Codex returned a different thread"
        );
        // Events may have been lost: the thread itself says what Codex is doing now.
        self.active_turn = None;
        self.turn_chats.clear();
        self.turn_private = false;
        for turn in history["thread"]["turns"].as_array().into_iter().flatten() {
            if turn["status"] == "inProgress" {
                self.active_turn = turn["id"].as_str().map(str::to_owned);
                // The running turn's inputs so far: ours by their delivery, anything else
                // (typed in Codex, or not ours) makes it nobody's chat.
                for item in turn["items"].as_array().into_iter().flatten() {
                    if item["type"] != "userMessage" {
                        continue;
                    }
                    self.track_input(item);
                }
            }
            held.extend(
                turn["items"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|item| item["clientId"].as_str())
                    .map(str::to_owned),
            );
            self.consume_turn(kernel, turn).await?;
        }
        let chat = self.turn_conversation();
        kernel
            .activity(activity(&history["thread"]["status"]), chat.as_deref())
            .await?;
        // Neither queued nor consumed: Codex no longer holds it, so it cannot block the rest.
        let lost: Vec<_> = self
            .deliveries
            .values()
            .filter(|d| {
                d.status != "stored"
                    && !self.settled.contains(&d.id)
                    && !self.carried(d)
                    && !held.contains(&d.id)
                    // Steered into the turn that is still running: Codex has not reached it yet.
                    && !d.native_request_id.as_deref().is_some_and(|native| {
                        self.active_turn.is_some()
                            && native.strip_prefix(STEERED) == self.active_turn.as_deref()
                    })
            })
            .map(|d| d.id.clone())
            .collect();
        for id in lost {
            kernel.receipt(&id, json!({"status":"uncertain","reason":"Codex no longer holds this message: it left its queue before being read. It was not resent."})).await?;
            for carried in self.deliveries.values_mut() {
                if carried.native_request_id.as_ref() == Some(&id) {
                    self.settled.insert(carried.id.clone());
                }
            }
            self.settled.insert(id);
        }
        Ok(())
    }

    async fn consume_turn(&mut self, kernel: &Kernel, turn: &Value) -> Result<()> {
        let id = string(turn, "id")?.to_owned();
        if turn["itemsView"]
            .as_str()
            .is_some_and(|view| view != "full")
        {
            return Ok(());
        }
        // Native history is inspected only for known delivery IDs, never retained wholesale.
        let related = turn["items"].as_array().into_iter().flatten().any(|item| {
            item["type"] == "userMessage"
                && item["clientId"]
                    .as_str()
                    .is_some_and(|id| self.deliveries.contains_key(id))
        });
        if !related {
            self.turns.remove(&id);
            return Ok(());
        }
        let state = self.turns.entry(id.clone()).or_default();
        for item in turn["items"].as_array().into_iter().flatten() {
            state.add(item.clone());
        }
        self.finish(kernel, &id).await
    }

    async fn event(&mut self, kernel: &Kernel, event: Value) -> Result<()> {
        let params = &event["params"];
        if params["threadId"] != self.thread_id {
            return Ok(());
        }
        if event.get("id").is_some() {
            return self.approval(kernel, event).await;
        }
        match event["method"].as_str() {
            Some("item/started" | "item/completed") => {
                let turn_id = string(params, "turnId")?.to_owned();
                self.turns
                    .entry(turn_id.clone())
                    .or_default()
                    .add(params["item"].clone());
                if params["item"]["type"] == "userMessage" {
                    let ours = params["item"]["clientId"]
                        .as_str()
                        .filter(|id| self.deliveries.contains_key(*id))
                        .map(str::to_owned);
                    if self.active_turn.as_deref() == Some(&turn_id) {
                        self.track_input(&params["item"]);
                        let chat = self.turn_conversation();
                        kernel.activity(Some("working"), chat.as_deref()).await?;
                    }
                    if let Some(id) = ours {
                        self.registered(kernel, &id).await?;
                    }
                }
            }
            Some("turn/completed") => {
                let turn_id = string(&params["turn"], "id")?;
                // Obtain complete native items if the notification only carries a summary.
                if params["turn"]["items"]
                    .as_array()
                    .is_some_and(|items| !items.is_empty())
                    && params["turn"]["itemsView"]
                        .as_str()
                        .is_none_or(|view| view == "full")
                {
                    self.consume_turn(kernel, &params["turn"]).await?;
                } else {
                    let history = self
                        .rpc
                        .request(
                            "thread/read",
                            json!({"threadId":self.thread_id,"includeTurns":true}),
                        )
                        .await?;
                    if let Some(turn) = history["thread"]["turns"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|turn| turn["id"] == turn_id)
                    {
                        self.consume_turn(kernel, turn).await?;
                    }
                }
            }
            Some("serverRequest/resolved") => {
                let native_id = self.rpc.native_request_id(&params["requestId"]);
                if let Some(approval) = self.approvals.remove(&native_id) {
                    kernel.approval_receipt(&approval.id, "resolved").await?;
                }
            }
            Some("thread/settings/updated") => {
                // Refresh settings through resume when creating a new context, not guessed from deltas.
            }
            _ => {}
        }
        Ok(())
    }

    fn track_input(&mut self, item: &Value) {
        match item["clientId"]
            .as_str()
            .filter(|id| self.deliveries.contains_key(*id))
        {
            Some(id) => self
                .turn_chats
                .extend(envelope(&self.deliveries, id).map(|d| d.message.conversation_id.clone())),
            None => self.turn_private = true,
        }
    }

    /// The chat the active turn is about: one chat for every input, else none.
    fn turn_conversation(&self) -> Option<String> {
        if self.turn_private || self.turn_chats.len() != 1 {
            return None;
        }
        self.turn_chats.iter().next().cloned()
    }

    /// Nothing of the turn is published: only which envelopes it registered.
    async fn finish(&mut self, kernel: &Kernel, turn_id: &str) -> Result<()> {
        let related: Vec<_> = self.turns[turn_id]
            .items
            .iter()
            .filter(|item| item["type"] == "userMessage")
            .filter_map(|item| item["clientId"].as_str())
            .filter(|id| self.deliveries.contains_key(*id))
            .map(str::to_owned)
            .collect();
        for id in related {
            self.registered(kernel, &id).await?;
        }
        Ok(())
    }

    /// Codex registered the envelope in a turn: the model has it in front, as a person who
    /// opened the chat, so the envelope is read (the kernel marks what it carried).
    /// Replying stays the agent's own choice; Read never gates further steering.
    async fn registered(&mut self, kernel: &Kernel, id: &str) -> Result<()> {
        if let Some(local) = self.deliveries.get_mut(id)
            && local.status != "read"
        {
            kernel.receipt(id, json!({"status":"read"})).await?;
            local.status = "read".into();
        }
        let carried: Vec<_> = self
            .deliveries
            .values()
            .filter(|d| d.native_request_id.as_deref() == Some(id))
            .map(|d| d.id.clone())
            .collect();
        for id in carried {
            if let Some(local) = self.deliveries.get_mut(&id) {
                local.status = "read".into();
            }
            self.settled.insert(id);
        }
        self.settled.insert(id.to_owned());
        Ok(())
    }

    async fn approval(&mut self, kernel: &Kernel, request: Value) -> Result<()> {
        let params = &request["params"];
        if params["threadId"] != self.thread_id {
            return Ok(());
        }
        let Some(turn_id) = params["turnId"].as_str() else {
            return Ok(());
        };
        let request_id = request.get("id").context("Missing native approval ID")?;
        let native_id = self.rpc.native_request_id(request_id);
        if self.approvals.contains_key(&native_id) {
            return Ok(());
        }
        let Some(state) = self.turns.get(turn_id) else {
            return Ok(());
        };
        let Some(delivery) = state.delivery(&self.deliveries) else {
            if state.items.iter().any(|item| {
                item["type"] == "userMessage"
                    && item["clientId"]
                        .as_str()
                        .is_some_and(|id| self.deliveries.contains_key(id))
            }) {
                kernel.status("attention", Some("Codex requests native input in a turn with private input or several chats. Open the native session to answer; its details were not shared.")).await?;
            }
            return Ok(());
        };
        let method = request["method"].as_str().unwrap_or("");
        if !matches!(
            method,
            "item/commandExecution/requestApproval"
                | "item/fileChange/requestApproval"
                | "item/permissions/requestApproval"
        ) {
            kernel.status("attention", Some("Codex is asking for native input this bridge cannot represent. Open the native session to answer.")).await?;
            return Ok(());
        }
        let id = Uuid::new_v4().to_string();
        let item = state
            .items
            .iter()
            .find(|item| item["id"] == params["itemId"]);
        kernel.post("/chat/approvals", json!({"id":id,"delivery_id":delivery.id,"native_request_id":native_id,"summary":"Codex requests your permission","details":{"method":method,"params":params,"item":item}})).await?;
        self.approvals.insert(
            native_id,
            Approval {
                id,
                request,
                dispatched: false,
            },
        );
        Ok(())
    }

    async fn reconcile_approvals(&mut self, kernel: &Kernel) -> Result<()> {
        for request in self.rpc.pending_server_requests() {
            self.approval(kernel, request).await?;
        }
        let resolved: Vec<_> = self
            .approvals
            .iter()
            .filter(|(_, approval)| self.rpc.request_was_resolved(&approval.request["id"]))
            .map(|(native_id, approval)| (native_id.clone(), approval.id.clone()))
            .collect();
        for (native_id, id) in resolved {
            kernel.approval_receipt(&id, "resolved").await?;
            self.approvals.remove(&native_id);
        }
        Ok(())
    }

    async fn decision(&mut self, kernel: &Kernel, decision: &Value) -> Result<()> {
        let native_id = string(decision, "native_request_id")?;
        let Some(approval) = self.approvals.get_mut(native_id) else {
            if !native_id.starts_with(&format!("{}:", self.rpc.connection_id))
                && matches!(
                    decision["status"].as_str(),
                    Some("pending" | "decided" | "uncertain")
                )
            {
                kernel
                    .approval_receipt(string(decision, "id")?, "resolved")
                    .await?;
            }
            return Ok(());
        };
        if approval.dispatched || decision["status"] != "decided" {
            return Ok(());
        }
        ensure!(decision["id"] == approval.id, "Approval identity changed");
        let result = approval_result(&approval.request, string(decision, "decision")?)?;
        if kernel
            .post_conflict(
                &format!("/chat/approvals/{}/dispatch", approval.id),
                json!({}),
            )
            .await?
            .is_none()
        {
            return Ok(());
        }
        approval.dispatched = true;
        let sent = self
            .rpc
            .respond(approval.request["id"].clone(), result)
            .await?;
        // JSON-RPC responses have no acknowledgement. Keep uncertain until native resolution.
        if !sent {
            kernel.approval_receipt(&approval.id, "resolved").await?;
        }
        Ok(())
    }

    async fn cancel_owned(&self) -> Result<()> {
        let owned: HashSet<_> = self
            .deliveries
            .iter()
            // A read message may still have its turn running: Stop must find that turn too.
            .filter(|(_, delivery)| delivery.status != "stored" && !self.carried(delivery))
            .map(|(id, _)| id.as_str())
            .collect();
        if owned.is_empty() {
            return Ok(());
        }
        let mut turns = HashSet::new();
        let mut consumed = HashSet::new();
        let mut failed = false;
        // A queued item can become a turn just before Stop. Read native state once so deleting
        // an already-consumed queue entry cannot be mistaken for stopping its running turn.
        match self
            .rpc
            .request(
                "thread/read",
                json!({"threadId":self.thread_id,"includeTurns":true}),
            )
            .await
        {
            Ok(history) if history["thread"]["id"] == self.thread_id => {
                for turn in history["thread"]["turns"].as_array().into_iter().flatten() {
                    let items: Vec<_> = turn["items"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|item| item["type"] == "userMessage")
                        .collect();
                    let related: Vec<_> = items
                        .iter()
                        .filter_map(|item| item["clientId"].as_str())
                        .filter(|id| owned.contains(id))
                        .collect();
                    consumed.extend(related.iter().map(|id| (*id).to_owned()));
                    if turn["status"] == "inProgress" && !related.is_empty() {
                        // Every input of the turn belongs to the chat: nothing private is lost.
                        if items.len() == related.len()
                            && let Some(id) = turn["id"].as_str()
                        {
                            turns.insert(id.to_owned());
                        } else {
                            failed = true;
                        } // Mixed private input must not be interrupted.
                    }
                }
            }
            _ => failed = true,
        }
        for (id, delivery) in &self.deliveries {
            if owned.contains(id.as_str()) && !consumed.contains(id) && !self.settled.contains(id) {
                let Some(queue_id) = &delivery.native_request_id else {
                    failed = true;
                    continue;
                };
                if let Some(turn) = queue_id.strip_prefix(STEERED) {
                    // An accepted steer is pending input of this turn, not a queue entry.
                    // Its cancellation is covered by interrupt only if native history proved
                    // the turn contains solely our input. Mixed/private turns stay untouched.
                    if !turns.contains(turn) {
                        failed = true;
                    }
                    continue;
                }
                if !self
                    .rpc
                    .request(
                        "thread/queue/delete",
                        json!({"threadId":self.thread_id,"queuedSubmissionId":queue_id}),
                    )
                    .await
                    .is_ok_and(|result| result["deleted"] == true)
                {
                    failed = true;
                }
            }
        }
        for turn_id in turns {
            if self
                .rpc
                .request(
                    "turn/interrupt",
                    json!({"threadId":self.thread_id,"turnId":turn_id}),
                )
                .await
                .is_err()
            {
                failed = true;
            }
        }
        ensure!(
            !failed,
            "Codex link stopped, but cancellation of its native work could not be confirmed"
        );
        Ok(())
    }
}

fn context_params(settings: &Value) -> Result<Value> {
    let profile = settings["activePermissionProfile"]["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .context("This Codex session does not expose a reusable permission profile")?;
    for field in [
        "cwd",
        "model",
        "modelProvider",
        "approvalPolicy",
        "approvalsReviewer",
        "sandbox",
    ] {
        ensure!(
            !settings[field].is_null(),
            "Codex context settings are incomplete"
        );
    }
    let mut params = json!({"permissions":profile,"ephemeral":false});
    if settings["thread"]["environments"].is_array() {
        params["environments"] = settings["thread"]["environments"].clone();
    }
    for field in [
        "cwd",
        "model",
        "modelProvider",
        "serviceTier",
        "approvalPolicy",
        "approvalsReviewer",
        "runtimeWorkspaceRoots",
    ] {
        if let Some(value) = settings.get(field) {
            params[field] = value.clone();
        }
    }
    if let Some(effort) = settings["reasoningEffort"].as_str() {
        params["config"] = json!({"model_reasoning_effort":effort});
    }
    Ok(params)
}

fn approval_result(request: &Value, decision: &str) -> Result<Value> {
    ensure!(
        matches!(decision, "allow" | "deny"),
        "Unknown approval decision"
    );
    if request["method"] == "item/permissions/requestApproval" {
        return Ok(
            json!({"permissions":if decision == "allow" { request["params"]["permissions"].clone() } else { json!({}) },"scope":"turn"}),
        );
    }
    let native = if decision == "allow" {
        "accept"
    } else {
        "decline"
    };
    if let Some(available) = request["params"]["availableDecisions"].as_array() {
        ensure!(
            available.iter().any(|choice| choice == native),
            "Codex did not offer this approval decision"
        );
    }
    Ok(json!({"decision":native}))
}
