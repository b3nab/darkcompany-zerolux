use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tempfile::TempDir;
use tokio::{
    net::UnixListener,
    sync::{Notify, broadcast},
    task::{JoinHandle, JoinSet},
};
use tokio_tungstenite::tungstenite::Message;
pub(crate) const THREAD: &str = "native-thread";

pub(crate) fn settings() -> Value {
    json!({"thread":{"id":THREAD,"sessionId":THREAD,"status":{"type":"idle"},"canAcceptDirectInput":true,"ephemeral":false,"environments":[],"turns":[]},"cwd":"/fixture","model":"fixture-model","modelProvider":"fixture","serviceTier":null,"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite","writableRoots":["/fixture"],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false},"activePermissionProfile":{"id":":workspace"},"runtimeWorkspaceRoots":["/fixture"],"reasoningEffort":"medium"})
}

#[derive(Default)]
pub(crate) struct NativeState {
    pub(crate) requests: Vec<Value>,
    pub(crate) queue: Vec<Value>,
    pub(crate) history: Vec<Value>,
    pub(crate) drop_queue_ack: bool,
    pub(crate) drop_cancel_ack: bool,
    /// "refuse" and "internal" answer turn/steer with an error; "drop" loses the answer.
    pub(crate) steer: Option<&'static str>,
    cwd: Option<String>,
}

pub(crate) struct Runtime {
    _dir: TempDir,
    pub(crate) endpoint: String,
    pub(crate) state: Arc<Mutex<NativeState>>,
    events: broadcast::Sender<Value>,
    notify: Arc<Notify>,
    task: JoinHandle<()>,
}

impl Runtime {
    pub(crate) async fn new() -> Self {
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        let path = dir.path().join("codex.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let state = Arc::new(Mutex::new(NativeState::default()));
        let (events, _) = broadcast::channel::<Value>(128);
        let notify = Arc::new(Notify::new());
        let server_state = state.clone();
        let server_events = events.clone();
        let server_notify = notify.clone();
        let task = tokio::spawn(async move {
            let mut clients = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (stream, _) = accepted.unwrap();
                        let mut events = server_events.subscribe();
                        let state = server_state.clone();
                        let notify = server_notify.clone();
                        clients.spawn(async move {
                            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                            loop {
                                tokio::select! {
                                    event = events.recv() => {
                                        let Ok(event) = event else { break; };
                                        if socket.send(Message::Text(event.to_string().into())).await.is_err() { break; }
                                    }
                                    frame = socket.next() => {
                                        let Some(Ok(Message::Text(text))) = frame else { break; };
                                        let value: Value = serde_json::from_str(&text).unwrap();
                                        let result = {
                                            let mut state = state.lock().unwrap();
                                            state.requests.push(value.clone());
                                            native_response(&mut state, &value)
                                        };
                                        notify.notify_waiters();
                                        let Some(result) = result else { continue; };
                                        let answer = if result.get("refused").is_some() {
                                            json!({"id":value["id"],"error":{"code":result["refused"],"message":"fixture refusal"}})
                                        } else {
                                            json!({"id":value["id"],"result":result})
                                        };
                                        if socket.send(Message::Text(answer.to_string().into())).await.is_err() { break; }
                                    }
                                }
                            }
                        });
                    }
                    _ = clients.join_next(), if !clients.is_empty() => {}
                }
            }
        });
        Self {
            _dir: dir,
            endpoint: format!("unix://{}", path.display()),
            state,
            events,
            notify,
            task,
        }
    }

    pub(crate) async fn new_in(cwd: &std::path::Path) -> Self {
        let runtime = Self::new().await;
        runtime.state.lock().unwrap().cwd = Some(cwd.to_str().unwrap().into());
        runtime
    }

    pub(crate) fn emit(&self, event: Value) {
        self.events.send(event).unwrap();
    }

    pub(crate) async fn wait(&self, predicate: impl Fn(&NativeState) -> bool) {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let changed = self.notify.notified();
                if predicate(&self.state.lock().unwrap()) {
                    return;
                }
                changed.await;
            }
        })
        .await
        .expect("native fixture did not reach expected state");
    }

    pub(crate) fn count(&self, method: &str) -> usize {
        self.state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|request| request["method"] == method)
            .count()
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn native_response(state: &mut NativeState, request: &Value) -> Option<Value> {
    let method = request["method"].as_str()?;
    request.get("id")?;
    if state.drop_cancel_ack && matches!(method, "thread/queue/delete" | "turn/interrupt") {
        return None;
    }
    let mut current = settings();
    if let Some(cwd) = &state.cwd {
        current["cwd"] = json!(cwd);
        current["thread"]["cwd"] = json!(cwd);
        current["runtimeWorkspaceRoots"] = json!([cwd]);
        current["sandbox"]["writableRoots"] = json!([cwd]);
    }
    Some(match method {
        "initialize" => json!({"userAgent":"fixture/0.159.0"}),
        "thread/read" => {
            let mut thread = current["thread"].clone();
            if request["params"]["includeTurns"] == true {
                thread["turns"] = json!(state.history);
            }
            json!({"thread":thread})
        }
        "thread/list" => json!({"data":[current["thread"]],"nextCursor":null}),
        "thread/loaded/list" => json!({"data":[THREAD],"nextCursor":null}),
        "thread/resume" => current,
        "thread/start" => {
            let mut value = current;
            value["thread"]["id"] = json!("new-context");
            value["thread"]["sessionId"] = json!("new-context");
            value
        }
        "thread/queue/list" => json!({"data":state.queue,"nextCursor":null}),
        "thread/queue/add" => {
            let queued = json!({"id":format!("queue-{}",state.queue.len()+1),"clientUserMessageId":request["params"]["clientUserMessageId"],"input":request["params"]["input"]});
            state.queue.push(queued.clone());
            if state.drop_queue_ack {
                return None;
            }
            json!({"queuedSubmission":queued})
        }
        "thread/queue/delete" => {
            let before = state.queue.len();
            state
                .queue
                .retain(|queued| queued["id"] != request["params"]["queuedSubmissionId"]);
            json!({"deleted":state.queue.len() != before})
        }
        "turn/steer" => match state.steer {
            Some("refuse") => json!({"refused":-32600}),
            Some("internal") => json!({"refused":-32603}),
            Some(_) => return None,
            None => json!({"turnId":request["params"]["expectedTurnId"]}),
        },
        "turn/interrupt" => json!({}),
        other => panic!("unexpected native method: {other}"),
    })
}
