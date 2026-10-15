use super::*;
use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, Mutex};
use tokio::{net::TcpListener, task::JoinHandle};
use tokio_tungstenite::tungstenite::Message;

struct Fixture {
    control: CodexSettings,
    calls: Arc<Mutex<Vec<Value>>>,
    server: JoinHandle<()>,
    observer: JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
        self.observer.abort();
    }
}
impl Fixture {
    async fn new(active: bool, ignore: bool, turn_status: &'static str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}", listener.local_addr().unwrap());
        let calls = Arc::new(Mutex::new(Vec::new()));
        let recorded = calls.clone();
        let initial = json!({"model":"one", "reasoningEffort":"low", "approvalPolicy":"on-request", "sandbox":{"type":"workspaceWrite","writableRoots":["/fixture/extra"],"networkAccess":true}});
        let mut native = initial.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(Message::Text(frame))) = socket.next().await {
                let request: Value = serde_json::from_str(&frame).unwrap();
                recorded.lock().unwrap().push(request.clone());
                let Some(id) = request.get("id") else {
                    continue;
                };
                let result = match request["method"].as_str().unwrap() {
                    "initialize" => json!({"userAgent":"fixture"}),
                    "model/list" if request["params"]["cursor"].is_null() => {
                        json!({"data":[{"model":"one","displayName":"First native choice","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"}]}],"nextCursor":"next"})
                    }
                    "model/list" => {
                        json!({"data":[{"model":"two","displayName":"Second native choice","supportedReasoningEfforts":[{"reasoningEffort":"high"}]}],"nextCursor":null})
                    }
                    "thread/settings/update" => {
                        if !ignore {
                            for (key, field) in [
                                ("model", "model"),
                                ("effort", "reasoningEffort"),
                                ("approvalPolicy", "approvalPolicy"),
                                ("sandboxPolicy", "sandbox"),
                            ] {
                                if let Some(value) = request["params"].get(key) {
                                    native[field] = value.clone();
                                }
                            }
                        }
                        let notice = json!({"method":"thread/settings/updated","params":{"threadId":"thread","threadSettings":{"model":native["model"],"effort":native["reasoningEffort"],"approvalPolicy":native["approvalPolicy"],"sandboxPolicy":native["sandbox"]}}});
                        // Confirmation can arrive before the RPC response.
                        socket
                            .send(Message::Text(notice.to_string().into()))
                            .await
                            .unwrap();
                        json!({})
                    }
                    "turn/settings/update" => json!({"status":turn_status}),
                    "turn/interrupt" => json!({}),
                    other => panic!("Unexpected native method: {other}"),
                };
                if socket
                    .send(Message::Text(
                        json!({"id":id,"result":result}).to_string().into(),
                    ))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        let rpc = CodexRpc::connect(&endpoint).await.unwrap();
        let mut events = rpc.subscribe();
        let control = CodexSettings {
            rpc,
            thread_id: "thread".into(),
            state: watch::channel(initial).0,
            turn: watch::channel(active.then(|| "turn".to_owned())).0,
            ready: watch::channel(true).0,
        };
        let observing = control.clone();
        let observer = tokio::spawn(async move {
            while let Ok(event) = events.recv().await {
                observing.observe(&event);
            }
        });
        Self {
            control,
            calls,
            server,
            observer,
        }
    }
    fn calls(&self, method: &str) -> Vec<Value> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call["method"] == method)
            .cloned()
            .collect()
    }
}

#[tokio::test]
async fn native_catalog_and_confirmed_settings_change_without_starting_or_resuming_work() {
    let f = Fixture::new(false, false, "applied").await;
    let before = f.control.read().await.unwrap();
    assert_eq!(before.models.len(), 2);
    assert_eq!(before.models[1].label, "Second native choice");
    assert_eq!(before.models[1].efforts, ["high"]);
    let patch = AgentSettings {
        model: Some("two".into()),
        effort: Some("high".into()),
        approval_policy: Some("never".into()),
        sandbox: Some("read-only".into()),
        ..AgentSettings::default()
    };
    let after = f.control.apply(&patch, false).await.unwrap();
    after.confirm(&patch).unwrap();
    assert_eq!(f.calls("thread/settings/update").len(), 1);
    assert!(f.calls("turn/settings/update").is_empty());
    assert!(f.calls("turn/start").is_empty());
    assert!(f.calls("thread/resume").is_empty());
}

#[tokio::test]
async fn live_turn_changes_are_targeted_and_permissions_wait_until_idle() {
    for status in ["applied", "targetUnavailable"] {
        let f = Fixture::new(true, false, status).await;
        let forbidden = AgentSettings {
            approval_policy: Some("never".into()),
            ..AgentSettings::default()
        };
        assert!(f.control.apply(&forbidden, false).await.is_err());
        assert!(f.calls("thread/settings/update").is_empty());
        let patch = AgentSettings {
            model: Some("two".into()),
            effort: Some("high".into()),
            ..AgentSettings::default()
        };
        f.control.apply(&patch, true).await.unwrap();
        assert!(
            f.calls("thread/settings/update").is_empty(),
            "Preflight is read-only"
        );
        f.control
            .apply(&patch, false)
            .await
            .unwrap()
            .confirm(&patch)
            .unwrap();
        assert_eq!(
            f.calls("turn/settings/update")[0]["params"],
            json!({"threadId":"thread","turnId":"turn","model":"two","effort":"high"})
        );
        assert!(
            f.calls("turn/start").is_empty(),
            "An ended target is never replaced or replayed"
        );
    }
}

#[tokio::test]
async fn an_unchanged_sandbox_does_not_reset_native_roots_or_network_policy() {
    let f = Fixture::new(false, false, "applied").await;
    let patch = AgentSettings {
        sandbox: Some("workspace-write".into()),
        effort: Some("high".into()),
        ..AgentSettings::default()
    };
    f.control.apply(&patch, false).await.unwrap();
    assert!(
        f.calls("thread/settings/update")[0]["params"]
            .get("sandboxPolicy")
            .is_none()
    );
    assert_eq!(f.control.state.borrow()["sandbox"]["networkAccess"], true);
    assert_eq!(
        f.control.state.borrow()["sandbox"]["writableRoots"],
        json!(["/fixture/extra"])
    );
}

#[tokio::test]
async fn an_acknowledgement_or_unrelated_notice_is_not_confirmation_and_is_never_retried() {
    let f = Fixture::new(false, true, "applied").await;
    let patch = AgentSettings {
        model: Some("two".into()),
        ..AgentSettings::default()
    };
    let error = f.control.apply(&patch, false).await.unwrap_err();
    assert!(error.to_string().contains("not confirmed"));
    assert_eq!(f.calls("thread/settings/update").len(), 1);
    assert_eq!(f.control.values().model.as_deref(), Some("one"));
}

#[tokio::test]
async fn interrupt_stops_only_the_running_turn() {
    let idle = Fixture::new(false, false, "applied").await;
    assert!(!idle.control.interrupt().await.unwrap());
    assert!(idle.calls("turn/interrupt").is_empty());
    let busy = Fixture::new(true, false, "applied").await;
    assert!(busy.control.interrupt().await.unwrap());
    let calls = busy.calls("turn/interrupt");
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0]["params"],
        json!({"threadId":"thread","turnId":"turn"})
    );
    assert!(busy.calls("turn/start").is_empty());
}
