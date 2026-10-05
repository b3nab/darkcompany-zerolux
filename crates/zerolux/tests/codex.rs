#![cfg(unix)]

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::IntoResponse,
};
use serde_json::{Value, json};
use tokio::{
    sync::{Notify, broadcast, mpsc, watch},
    task::JoinHandle,
};
use zerolux::codex::{CodexDriver, CodexRpc};

#[path = "support/codex_runtime.rs"]
mod codex_runtime;
use codex_runtime::{Runtime, THREAD};
const SESSION: &str = "chat-session";
const DELIVERY: &str = "51d6a6dc-4c02-4794-adc5-cf4cb470b8c7";
const CONVERSATION: &str = "29c8494c-e8da-44ec-8dbb-e5d54a680380";
const PEER: &str = "c6bbbf46-61e0-4f0b-87b5-8d162c943846";

fn delivery(status: &str) -> Value {
    json!({"id":DELIVERY,"session_id":SESSION,"status":status,"message":{"id":"incoming-message","conversation_id":CONVERSATION,"author_id":PEER,"seq":1,"text":"Please check the fixture."}})
}

fn conversations() -> Value {
    json!([{"id":CONVERSATION,"kind":"group","title":"Fixture chat","members":[
        {"actor_id":"owner","name":"Owner","kind":"human","session_id":null},
        {"actor_id":PEER,"name":"Peer","kind":"agent","session_id":"peer-session"},
        {"actor_id":"codex","name":"Codex","kind":"agent","session_id":SESSION}
    ]}])
}

#[derive(Default)]
struct KernelState {
    deliveries: Vec<Value>,
    conversations: Value,
    approvals: Vec<Value>,
    replies: Vec<Value>,
    calls: Vec<(String, Value)>,
    inbox_reads: usize,
    session_status: String,
    activity: Option<String>,
    activity_conversation: Option<String>,
    revoked: bool,
    hold_inbox: bool,
    inbox_blocked: bool,
    reject_dispatch: Option<(String, StatusCode)>,
    reply_before_notified: bool,
}

#[derive(Clone)]
struct HttpState {
    state: Arc<Mutex<KernelState>>,
    notify: Arc<Notify>,
    inbox_gate: Arc<Notify>,
}

struct KernelFixture {
    url: String,
    state: Arc<Mutex<KernelState>>,
    notify: Arc<Notify>,
    inbox_gate: Arc<Notify>,
    task: JoinHandle<()>,
}

impl KernelFixture {
    async fn new(status: &str) -> Self {
        let state = Arc::new(Mutex::new(KernelState {
            deliveries: vec![delivery(status)],
            conversations: conversations(),
            session_status: "connecting".into(),
            ..Default::default()
        }));
        let notify = Arc::new(Notify::new());
        let inbox_gate = Arc::new(Notify::new());
        let app = Router::new().fallback(http).with_state(HttpState {
            state: state.clone(),
            notify: notify.clone(),
            inbox_gate: inbox_gate.clone(),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            url,
            state,
            notify,
            inbox_gate,
            task,
        }
    }

    async fn wait(&self, predicate: impl Fn(&KernelState) -> bool) {
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
        .expect("kernel fixture did not reach expected state");
    }

    fn decide(&self, index: usize, decision: &str) {
        let mut state = self.state.lock().unwrap();
        state.approvals[index]["status"] = json!("decided");
        state.approvals[index]["decision"] = json!(decision);
    }
}

impl Drop for KernelFixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn http(
    State(state): State<HttpState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let released = state.inbox_gate.notified();
    let blocked = {
        let mut data = state.state.lock().unwrap();
        let blocked = uri.path() == "/api/chat/inbox" && data.hold_inbox;
        if blocked {
            data.inbox_blocked = true;
        }
        blocked
    };
    if blocked {
        state.notify.notify_waiters();
        released.await;
    }
    assert_eq!(
        headers.get("authorization").and_then(|v| v.to_str().ok()),
        Some("Bearer fixture-secret")
    );
    let value: Value = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).unwrap()
    };
    let result = {
        let mut data = state.state.lock().unwrap();
        data.calls.push((uri.path().to_owned(), value.clone()));
        kernel_response(&mut data, &method, uri.path(), value)
    };
    state.notify.notify_waiters();
    (result.0, Json(result.1))
}

fn kernel_response(
    data: &mut KernelState,
    method: &Method,
    path: &str,
    value: Value,
) -> (StatusCode, Value) {
    let ok = StatusCode::OK;
    if data.revoked {
        return (StatusCode::UNAUTHORIZED, json!({"error":"revoked"}));
    }
    if method == Method::GET && path == "/api/chat/inbox" {
        data.inbox_reads += 1;
        return (
            ok,
            json!({"session":{"id":SESSION,"status":data.session_status},"conversations":data.conversations,"deliveries":data.deliveries.iter().filter(|d| d["status"] != "read").collect::<Vec<_>>(),"approvals":data.approvals}),
        );
    }
    if path == format!("/api/chat/sessions/{SESSION}/activity") {
        data.activity = value["activity"].as_str().map(str::to_owned);
        data.activity_conversation = value["conversation_id"].as_str().map(str::to_owned);
        return (ok, json!({"session":{"id":SESSION}}));
    }
    if path == format!("/api/chat/sessions/{SESSION}/status") {
        data.session_status = value["status"].as_str().unwrap().into();
        return (ok, json!({"session":{"id":SESSION}}));
    }
    let target = path
        .strip_prefix("/api/chat/deliveries/")
        .and_then(|rest| rest.split_once('/'))
        .and_then(|(id, action)| {
            let index = data.deliveries.iter().position(|d| d["id"] == id)?;
            Some((index, action.to_owned()))
        });
    if let Some((index, action)) = target {
        if action == "dispatch"
            && let Some((id, status)) = &data.reject_dispatch
            && data.deliveries[index]["id"] == *id
        {
            return (*status, json!({}));
        }
        if action == "receipt" && value["status"] == "notified" && data.reply_before_notified {
            data.reply_before_notified = false;
            let id = data.deliveries[index]["id"].clone();
            for delivery in &mut data.deliveries {
                if delivery["id"] == id || delivery["native_request_id"] == id {
                    delivery["status"] = json!("read");
                }
            }
        }
        let delivery = &mut data.deliveries[index];
        if action == "dispatch" {
            if delivery["status"] != "stored" {
                return (StatusCode::CONFLICT, json!({}));
            }
            delivery["status"] = json!("uncertain");
            return (
                ok,
                json!({"delivery":delivery,"message":delivery["message"]}),
            );
        }
        if action == "receipt" {
            if (delivery["status"] == "read" && value["status"] != "read")
                || (!delivery["native_request_id"].is_null()
                    && !value["native_request_id"].is_null()
                    && delivery["native_request_id"] != value["native_request_id"])
            {
                return (StatusCode::CONFLICT, json!({}));
            }
            delivery["status"] = value["status"].clone();
            delivery["reason"] = value["reason"].clone();
            if !value["native_request_id"].is_null() {
                delivery["native_request_id"] = value["native_request_id"].clone();
            }
            let delivery = delivery.clone();
            // As the kernel: reading an envelope reads what it carried.
            if value["status"] == "read" {
                for carried in data
                    .deliveries
                    .iter_mut()
                    .filter(|d| d["native_request_id"] == delivery["id"] && d["status"] != "read")
                {
                    carried["status"] = json!("read");
                }
            }
            return (ok, json!({"delivery":delivery}));
        }
    }
    if path == format!("/api/conversations/{CONVERSATION}/messages") {
        if let Some(old) = data.replies.iter().find(|old| {
            old["id"] == value["id"]
                || (!value["reply_to_delivery_id"].is_null()
                    && old["reply_to_delivery_id"] == value["reply_to_delivery_id"])
        }) {
            return (
                if ["id", "text", "reply_to_delivery_id"]
                    .iter()
                    .all(|field| old[field] == value[field])
                {
                    ok
                } else {
                    StatusCode::CONFLICT
                },
                old.clone(),
            );
        }
        let mut message = value;
        message["conversation_id"] = json!(CONVERSATION);
        message["author_id"] = json!("codex");
        message["seq"] = json!(data.replies.len() + 2);
        message["created_at"] = json!(1);
        message["deliveries"] = json!([]);
        data.replies.push(message.clone());
        return (StatusCode::CREATED, message);
    }
    if path == "/api/chat/approvals" {
        let mut approval = value;
        approval["status"] = json!("pending");
        approval["decision"] = Value::Null;
        data.approvals.push(approval.clone());
        return (StatusCode::CREATED, json!({"approval":approval}));
    }
    for approval in &mut data.approvals {
        if path
            == format!(
                "/api/chat/approvals/{}/dispatch",
                approval["id"].as_str().unwrap()
            )
        {
            if approval["status"] != "decided" {
                return (StatusCode::CONFLICT, json!({}));
            }
            approval["status"] = json!("uncertain");
            return (ok, json!({"approval":approval}));
        }
        if path
            == format!(
                "/api/chat/approvals/{}/receipt",
                approval["id"].as_str().unwrap()
            )
        {
            approval["status"] = value["status"].clone();
            return (ok, json!({"approval":approval}));
        }
    }
    panic!("unexpected kernel request: {method} {path}");
}

fn user(id: &str, client: Option<&str>) -> Value {
    json!({"type":"userMessage","id":id,"clientId":client,"content":[{"type":"text","text":"fixture"}]})
}
fn assistant(id: &str, text: &str, phase: &str) -> Value {
    json!({"type":"agentMessage","id":id,"text":text,"phase":phase})
}
fn item(turn: &str, item: Value) -> Value {
    json!({"method":"item/completed","params":{"threadId":THREAD,"turnId":turn,"item":item}})
}
fn completed(turn: &str, items: Vec<Value>) -> Value {
    json!({"method":"turn/completed","params":{"threadId":THREAD,"turn":{"id":turn,"status":"completed","itemsView":"full","items":items}}})
}

async fn run(
    runtime: &Runtime,
    kernel: &KernelFixture,
) -> (
    mpsc::Sender<()>,
    watch::Sender<bool>,
    JoinHandle<anyhow::Result<()>>,
) {
    let driver = CodexDriver::attach(&runtime.endpoint, THREAD)
        .await
        .unwrap();
    let (changed, rx) = mpsc::channel(16);
    let (stop, stop_rx) = watch::channel(false);
    let task = tokio::spawn(driver.run(
        kernel.url.clone(),
        std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()),
        SESSION.into(),
        "fixture-secret".into(),
        rx,
        stop_rx,
    ));
    (changed, stop, task)
}

async fn finish(stop: watch::Sender<bool>, task: JoinHandle<anyhow::Result<()>>) {
    stop.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn discovery_is_read_only_and_attach_preserves_native_settings() {
    let runtime = Runtime::new_in(std::path::Path::new("/fixture")).await;
    let rpc = CodexRpc::connect(&runtime.endpoint).await.unwrap();
    assert_eq!(
        rpc.request("thread/list", json!({"limit":100}))
            .await
            .unwrap()["data"][0]["id"],
        THREAD
    );
    assert_eq!(runtime.count("thread/resume"), 0);
    let driver = CodexDriver::attach_with_rpc(rpc, THREAD).await.unwrap();
    assert_eq!(driver.thread_id(), THREAD);
    let state = runtime.state.lock().unwrap();
    assert_eq!(
        state
            .requests
            .iter()
            .find(|r| r["method"] == "thread/resume")
            .unwrap()["params"],
        json!({"threadId":THREAD})
    );
    assert!(state.requests.iter().all(|r| !matches!(
        r["method"].as_str(),
        Some("thread/start" | "turn/start" | "thread/queue/add")
    )));
}

#[tokio::test]
async fn waiting_messages_share_one_envelope_and_one_turn() {
    const EARLIER: &str = "0b5a0a53-7b5a-4b0c-9d5e-3a3f6f2c1d11";
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("stored").await;
    {
        let mut state = kernel.state.lock().unwrap();
        let mut earlier = delivery("stored");
        earlier["id"] = json!(EARLIER);
        earlier["message"]["seq"] = json!(0);
        earlier["message"]["author_id"] = json!("owner");
        earlier["message"]["text"] = json!("Sent first.");
        state.deliveries.insert(0, earlier);
    }
    let (_changed, stop, task) = run(&runtime, &kernel).await;
    runtime.wait(|s| s.queue.len() == 1).await;
    kernel
        .wait(|s| s.deliveries[1]["status"] == "notified")
        .await;
    assert_eq!(runtime.count("thread/queue/add"), 1);
    {
        let state = runtime.state.lock().unwrap();
        assert_eq!(state.queue[0]["clientUserMessageId"], DELIVERY);
        let prompt = state
            .requests
            .iter()
            .find(|r| r["method"] == "thread/queue/add")
            .unwrap()["params"]["input"][0]["text"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(prompt.starts_with("[ZeroLux] 2 new messages, oldest first, in "));
        assert!(prompt.ends_with(
            "\"Owner\" (human) [message incoming-message]:\n> Sent first.\n\"Peer\" (agent) [message incoming-message]:\n> Please check the fixture."
        ));
    }
    {
        let state = kernel.state.lock().unwrap();
        assert_eq!(state.deliveries[0]["status"], "notified");
        assert_eq!(state.deliveries[0]["native_request_id"], DELIVERY);
    }
    runtime.emit(completed(
        "batch",
        vec![
            user("ours", Some(DELIVERY)),
            assistant("answer", "One answer for both", "final_answer"),
        ],
    ));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        kernel.state.lock().unwrap().deliveries[1]["status"],
        "read",
        "carried by the registered envelope, so read with it"
    );
    assert!(
        kernel.state.lock().unwrap().replies.is_empty(),
        "replies are explicit"
    );
    assert_eq!(
        kernel.state.lock().unwrap().activity.as_deref(),
        Some("idle")
    );
    // The envelope is settled: nothing it carried is queued again.
    assert_eq!(runtime.count("thread/queue/add"), 1);
    finish(stop, task).await;
}

#[tokio::test]
async fn a_message_joins_the_running_turn_instead_of_waiting_for_its_end() {
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("read").await;
    let (changed, stop, task) = run(&runtime, &kernel).await;
    kernel.wait(|s| s.activity.as_deref() == Some("idle")).await;
    runtime.emit(json!({"method":"turn/started","params":{"threadId":THREAD,"turn":{"id":"long-work","status":"inProgress","items":[]}}}));
    kernel
        .wait(|s| s.activity.as_deref() == Some("working"))
        .await;
    kernel.state.lock().unwrap().deliveries[0]["status"] = json!("stored");
    changed.send(()).await.unwrap();
    kernel
        .wait(|s| s.deliveries[0]["status"] == "notified")
        .await;
    {
        let state = runtime.state.lock().unwrap();
        let steer = state
            .requests
            .iter()
            .find(|r| r["method"] == "turn/steer")
            .unwrap();
        assert_eq!(steer["params"]["expectedTurnId"], "long-work");
        assert_eq!(steer["params"]["clientUserMessageId"], DELIVERY);
        assert!(
            state.queue.is_empty(),
            "nothing waits for the end of the turn"
        );
    }
    assert_eq!(
        kernel.state.lock().unwrap().deliveries[0]["native_request_id"],
        "turn:long-work"
    );
    runtime.emit(item("long-work", user("steered", Some(DELIVERY))));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        kernel.state.lock().unwrap().deliveries[0]["status"],
        "read",
        "registered in a turn: in front of the model, so read"
    );
    // Stop leaves a turn that holds private work alone.
    stop.send_replace(true);
    let _ = tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap();
    assert_eq!(runtime.count("turn/interrupt"), 0);
}

/// Nothing has registered the first envelope yet. New messages must already be waiting
/// inside the native turn, not held by the bridge until another model step reads it.
#[tokio::test]
async fn later_bursts_join_the_running_turn_before_the_first_envelope_is_read() {
    const SECOND: &str = "5d2f1c0e-6a3b-4f7d-8e9a-1b2c3d4e5f60";
    const THIRD: &str = "6d2f1c0e-6a3b-4f7d-8e9a-1b2c3d4e5f60";
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("stored").await;
    runtime.state.lock().unwrap().history.push(json!({
        "id":"running","status":"inProgress","itemsView":"full","items":[]
    }));
    let (changed, stop, task) = run(&runtime, &kernel).await;
    kernel
        .wait(|s| s.deliveries[0]["status"] == "notified")
        .await;
    for (index, id) in [SECOND, THIRD].into_iter().enumerate() {
        let mut later = delivery("stored");
        later["id"] = json!(id);
        later["message"]["seq"] = json!(index + 2);
        later["message"]["text"] = json!(format!("Arrival {}", index + 2));
        kernel.state.lock().unwrap().deliveries.push(later);
        changed.send(()).await.unwrap();
        kernel
            .wait(|s| s.deliveries[index + 1]["status"] == "notified")
            .await;
    }
    {
        let state = runtime.state.lock().unwrap();
        let steers: Vec<_> = state
            .requests
            .iter()
            .filter(|r| r["method"] == "turn/steer")
            .collect();
        assert_eq!(steers.len(), 3);
        assert_eq!(
            steers
                .iter()
                .map(|r| r["params"]["clientUserMessageId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![DELIVERY, SECOND, THIRD]
        );
        assert!(
            steers
                .iter()
                .all(|r| r["params"]["expectedTurnId"] == "running")
        );
        assert!(state.queue.is_empty());
    }
    assert!(
        kernel
            .state
            .lock()
            .unwrap()
            .deliveries
            .iter()
            .all(|d| d["status"] == "notified")
    );
    for (index, id) in [DELIVERY, SECOND, THIRD].into_iter().enumerate() {
        runtime.emit(item("running", user(&format!("input-{index}"), Some(id))));
    }
    kernel
        .wait(|s| s.deliveries.iter().all(|d| d["status"] == "read"))
        .await;
    changed.send(()).await.unwrap();
    finish(stop, task).await;
    assert_eq!(
        runtime.count("turn/steer"),
        3,
        "receipts never replay input"
    );
}

#[tokio::test]
async fn waiting_chats_share_one_native_input_with_ordered_scoped_envelopes() {
    const SIDE: &str = "b249db30-8d8e-4efb-9ed5-c48a23c2ca1e";
    const SECOND: &str = "5d2f1c0e-6a3b-4f7d-8e9a-1b2c3d4e5f60";
    const THIRD: &str = "6d2f1c0e-6a3b-4f7d-8e9a-1b2c3d4e5f60";
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("stored").await;
    {
        let mut state = kernel.state.lock().unwrap();
        let mut side = state.conversations[0].clone();
        side["id"] = json!(SIDE);
        side["title"] = json!("Side");
        state.conversations.as_array_mut().unwrap().push(side);
        state.deliveries[0]["message"]["seq"] = json!(100);
        // Inbox order is chronological across chats; sequence numbers belong to each chat.
        for (id, chat, seq) in [(SECOND, SIDE, 1), (THIRD, CONVERSATION, 101)] {
            let mut next = delivery("stored");
            next["id"] = json!(id);
            next["message"]["conversation_id"] = json!(chat);
            next["message"]["id"] = json!(format!("message-{seq}"));
            next["message"]["seq"] = json!(seq);
            next["message"]["text"] = json!(format!("Message {seq}"));
            state.deliveries.push(next);
        }
    }
    let (_changed, stop, task) = run(&runtime, &kernel).await;
    kernel
        .wait(|s| s.deliveries[2]["status"] == "notified")
        .await;
    {
        let state = runtime.state.lock().unwrap();
        assert_eq!(state.queue.len(), 1);
        let input = &state.queue[0];
        assert_eq!(input["clientUserMessageId"], THIRD);
        let text = input["input"][0]["text"].as_str().unwrap();
        let first = text
            .find(&format!(" --to {CONVERSATION} --reply {DELIVERY}"))
            .unwrap();
        let second = text
            .find(&format!(" --to {SIDE} --reply {SECOND}"))
            .unwrap();
        let third = text
            .find(&format!(" --to {CONVERSATION} --reply {THIRD}"))
            .unwrap();
        assert!(first < second && second < third);
        assert_eq!(
            text.matches("Your terminal answer stays private").count(),
            3
        );
        assert_eq!(text.matches("\"Peer\" (agent)").count(), 3);
    }
    runtime.emit(json!({"method":"turn/started","params":{"threadId":THREAD,"turn":{"id":"mixed","status":"inProgress","items":[]}}}));
    runtime.emit(item("mixed", user("snapshot", Some(THIRD))));
    kernel
        .wait(|s| s.deliveries.iter().all(|d| d["status"] == "read"))
        .await;
    assert!(
        kernel.state.lock().unwrap().activity_conversation.is_none(),
        "the anchor chat is not the whole envelope"
    );
    runtime.emit(json!({"id":930,"method":"item/commandExecution/requestApproval","params":{"threadId":THREAD,"turnId":"mixed","itemId":"tool","command":"PRIVATE_REQUEST_DETAILS","availableDecisions":["accept","decline"]}}));
    kernel.wait(|s| s.session_status == "attention").await;
    assert!(
        kernel.state.lock().unwrap().approvals.is_empty(),
        "a mixed-chat request stays native"
    );
    assert!(
        !kernel
            .state
            .lock()
            .unwrap()
            .calls
            .iter()
            .any(|(_, value)| value.to_string().contains("PRIVATE_REQUEST_DETAILS"))
    );
    finish(stop, task).await;
    assert_eq!(runtime.count("thread/queue/add"), 1);
}

#[tokio::test]
async fn approvals_after_multiple_same_chat_inputs_keep_the_turn_opener() {
    const SECOND: &str = "5d2f1c0e-6a3b-4f7d-8e9a-1b2c3d4e5f60";
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("stored").await;
    let (changed, stop, task) = run(&runtime, &kernel).await;
    kernel
        .wait(|s| s.deliveries[0]["status"] == "notified")
        .await;
    runtime.emit(json!({"method":"turn/started","params":{"threadId":THREAD,"turn":{"id":"same-chat","status":"inProgress","items":[]}}}));
    runtime.emit(item("same-chat", user("opener", Some(DELIVERY))));
    kernel.wait(|s| s.deliveries[0]["status"] == "read").await;
    let mut later = delivery("stored");
    later["id"] = json!(SECOND);
    later["message"]["seq"] = json!(2);
    kernel.state.lock().unwrap().deliveries.push(later);
    changed.send(()).await.unwrap();
    kernel
        .wait(|s| s.deliveries[1]["status"] == "notified")
        .await;
    runtime.emit(item("same-chat", user("later", Some(SECOND))));
    kernel.wait(|s| s.deliveries[1]["status"] == "read").await;
    runtime.emit(json!({"id":940,"method":"item/commandExecution/requestApproval","params":{"threadId":THREAD,"turnId":"same-chat","itemId":"tool","command":"fixture","availableDecisions":["accept","decline"]}}));
    kernel.wait(|s| s.approvals.len() == 1).await;
    assert_eq!(
        kernel.state.lock().unwrap().approvals[0]["delivery_id"],
        DELIVERY
    );
    assert_eq!(
        kernel
            .state
            .lock()
            .unwrap()
            .activity_conversation
            .as_deref(),
        Some(CONVERSATION)
    );
    kernel.decide(0, "deny");
    changed.send(()).await.unwrap();
    runtime
        .wait(|s| {
            s.requests
                .iter()
                .any(|r| r["id"] == 940 && r["result"]["decision"] == "decline")
        })
        .await;
    finish(stop, task).await;
}

#[tokio::test]
async fn arrivals_behind_a_queued_opener_are_steered_on_start_without_waiting_for_read() {
    const SECOND: &str = "5d2f1c0e-6a3b-4f7d-8e9a-1b2c3d4e5f60";
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("stored").await;
    let (changed, stop, task) = run(&runtime, &kernel).await;
    kernel
        .wait(|s| s.deliveries[0]["status"] == "notified")
        .await;
    let mut later = delivery("stored");
    later["id"] = json!(SECOND);
    later["message"]["seq"] = json!(2);
    kernel.state.lock().unwrap().deliveries.push(later);
    changed.send(()).await.unwrap();
    kernel.wait(|s| s.inbox_reads >= 2).await;
    assert_eq!(
        kernel.state.lock().unwrap().deliveries[1]["status"],
        "stored"
    );
    assert_eq!(runtime.count("thread/queue/add"), 1);
    runtime.emit(json!({"method":"turn/started","params":{"threadId":THREAD,"turn":{"id":"starting","status":"inProgress","items":[]}}}));
    kernel
        .wait(|s| s.deliveries[1]["status"] == "notified")
        .await;
    assert_eq!(
        kernel.state.lock().unwrap().deliveries[0]["status"],
        "notified"
    );
    assert_eq!(runtime.count("turn/steer"), 1);
    runtime.emit(item("starting", user("first", Some(DELIVERY))));
    runtime.emit(item("starting", user("second", Some(SECOND))));
    kernel
        .wait(|s| s.deliveries.iter().all(|d| d["status"] == "read"))
        .await;
    finish(stop, task).await;
}

#[tokio::test]
async fn a_mixed_chat_native_input_recovers_read_and_activity_without_replay() {
    const SIDE: &str = "b249db30-8d8e-4efb-9ed5-c48a23c2ca1e";
    const SECOND: &str = "5d2f1c0e-6a3b-4f7d-8e9a-1b2c3d4e5f60";
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("uncertain").await;
    {
        let mut state = kernel.state.lock().unwrap();
        state.deliveries[0]["native_request_id"] = json!(SECOND);
        let mut anchor = delivery("uncertain");
        anchor["id"] = json!(SECOND);
        anchor["message"]["conversation_id"] = json!(SIDE);
        anchor["message"]["seq"] = json!(2);
        state.deliveries.push(anchor);
    }
    runtime.state.lock().unwrap().history.push(json!({
        "id":"recovered","status":"inProgress","itemsView":"full","items":[user("snapshot", Some(SECOND))]
    }));
    let (_changed, stop, task) = run(&runtime, &kernel).await;
    kernel
        .wait(|s| s.deliveries.iter().all(|d| d["status"] == "read"))
        .await;
    assert!(kernel.state.lock().unwrap().activity_conversation.is_none());
    runtime.emit(json!({"id":950,"method":"item/commandExecution/requestApproval","params":{"threadId":THREAD,"turnId":"recovered","itemId":"tool","command":"PRIVATE_RECOVERED_DETAILS","availableDecisions":["accept","decline"]}}));
    kernel.wait(|s| s.session_status == "attention").await;
    assert!(kernel.state.lock().unwrap().approvals.is_empty());
    assert!(
        !kernel
            .state
            .lock()
            .unwrap()
            .calls
            .iter()
            .any(|(_, body)| body.to_string().contains("PRIVATE_RECOVERED_DETAILS"))
    );
    finish(stop, task).await;
    assert_eq!(runtime.count("turn/steer"), 0);
    assert_eq!(runtime.count("thread/queue/add"), 0);
}

#[tokio::test]
async fn only_successfully_claimed_input_is_sent_and_revocation_never_sends_a_partial_batch() {
    const SECOND: &str = "5d2f1c0e-6a3b-4f7d-8e9a-1b2c3d4e5f60";
    for status in [
        StatusCode::CONFLICT,
        StatusCode::UNAUTHORIZED,
        StatusCode::FORBIDDEN,
    ] {
        let runtime = Runtime::new().await;
        let kernel = KernelFixture::new("stored").await;
        {
            let mut state = kernel.state.lock().unwrap();
            let mut later = delivery("stored");
            later["id"] = json!(SECOND);
            later["message"]["seq"] = json!(2);
            later["message"]["text"] = json!("UNCLAIMED_TEXT");
            state.deliveries.push(later);
            state.reject_dispatch = Some((SECOND.into(), status));
        }
        let (_changed, stop, task) = run(&runtime, &kernel).await;
        if status == StatusCode::CONFLICT {
            kernel
                .wait(|s| s.deliveries[0]["status"] == "notified")
                .await;
            assert_eq!(runtime.count("thread/queue/add"), 1);
            assert!(
                !runtime.state.lock().unwrap().queue[0]
                    .to_string()
                    .contains("UNCLAIMED_TEXT")
            );
            finish(stop, task).await;
        } else {
            assert!(
                tokio::time::timeout(Duration::from_secs(3), task)
                    .await
                    .unwrap()
                    .unwrap()
                    .is_err()
            );
            assert_eq!(runtime.count("thread/queue/add"), 0);
            assert_eq!(runtime.count("turn/steer"), 0);
            assert_eq!(
                kernel.state.lock().unwrap().deliveries[0]["status"],
                "uncertain"
            );
        }
        assert_eq!(
            kernel.state.lock().unwrap().deliveries[1]["status"],
            "stored"
        );
    }
}

#[tokio::test]
async fn a_correlated_reply_before_notified_is_reconciled_as_read_not_attention() {
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("stored").await;
    kernel.state.lock().unwrap().reply_before_notified = true;
    let (_changed, stop, task) = run(&runtime, &kernel).await;
    kernel
        .wait(|s| {
            s.calls
                .iter()
                .any(|(path, body)| path.ends_with("/receipt") && body["status"] == "read")
        })
        .await;
    assert_eq!(kernel.state.lock().unwrap().deliveries[0]["status"], "read");
    assert_eq!(kernel.state.lock().unwrap().session_status, "connected");
    finish(stop, task).await;
    assert_eq!(runtime.count("thread/queue/add"), 1);
}

#[tokio::test]
async fn activity_follows_the_native_status_even_without_turn_events() {
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("read").await;
    let (_changed, stop, task) = run(&runtime, &kernel).await;
    kernel.wait(|s| s.activity.as_deref() == Some("idle")).await;
    let status = |kind: &str| json!({"method":"thread/status/changed","params":{"threadId":THREAD,"status":{"type":kind,"activeFlags":[]}}});
    runtime.emit(status("active"));
    kernel
        .wait(|s| s.activity.as_deref() == Some("working"))
        .await;
    runtime.emit(status("idle"));
    kernel.wait(|s| s.activity.as_deref() == Some("idle")).await;
    runtime.emit(status("systemError"));
    kernel.wait(|s| s.activity.is_none()).await;
    finish(stop, task).await;
}

#[tokio::test]
async fn only_a_certain_refusal_sends_a_steered_message_to_the_queue() {
    for (steer, queued) in [("refuse", 1), ("internal", 0), ("drop", 0)] {
        let runtime = Runtime::new().await;
        runtime.state.lock().unwrap().steer = Some(steer);
        let kernel = KernelFixture::new("read").await;
        let (changed, _stop, task) = run(&runtime, &kernel).await;
        kernel.wait(|s| s.activity.as_deref() == Some("idle")).await;
        runtime.emit(json!({"method":"turn/started","params":{"threadId":THREAD,"turn":{"id":"review","status":"inProgress","items":[]}}}));
        kernel
            .wait(|s| s.activity.as_deref() == Some("working"))
            .await;
        kernel.state.lock().unwrap().deliveries[0]["status"] = json!("stored");
        changed.send(()).await.unwrap();
        if queued == 1 {
            kernel
                .wait(|s| s.deliveries[0]["status"] == "notified")
                .await;
            task.abort();
        } else {
            // The answer never comes: the delivery stays uncertain and is not sent again.
            let result = tokio::time::timeout(Duration::from_secs(30), task)
                .await
                .unwrap()
                .unwrap();
            assert!(result.is_err());
            assert_eq!(
                kernel.state.lock().unwrap().deliveries[0]["status"],
                "uncertain"
            );
        }
        assert_eq!(runtime.count("turn/steer"), 1);
        assert_eq!(runtime.count("thread/queue/add"), queued, "{steer}");
    }
}

#[tokio::test]
async fn stop_interrupts_a_turn_that_holds_only_envelopes_of_the_chat() {
    const SECOND: &str = "5d2f1c0e-6a3b-4f7d-8e9a-1b2c3d4e5f60";
    for (private, interrupts) in [(false, 1), (true, 0)] {
        let runtime = Runtime::new().await;
        let kernel = KernelFixture::new("stored").await;
        let (changed, stop, task) = run(&runtime, &kernel).await;
        runtime.wait(|s| s.queue.len() == 1).await;
        runtime.emit(json!({"method":"turn/started","params":{"threadId":THREAD,"turn":{"id":"chat","status":"inProgress","items":[]}}}));
        let first = user("first", Some(DELIVERY));
        runtime.emit(item("chat", first.clone()));
        kernel
            .wait(|s| s.activity.as_deref() == Some("working"))
            .await;
        {
            let mut state = kernel.state.lock().unwrap();
            let mut later = delivery("stored");
            later["id"] = json!(SECOND);
            later["message"]["seq"] = json!(2);
            state.deliveries.push(later);
        }
        changed.send(()).await.unwrap();
        kernel
            .wait(|s| s.deliveries[1]["status"] == "notified")
            .await;
        assert_eq!(
            runtime.count("turn/steer"),
            1,
            "the second envelope joins the turn"
        );
        let mut items = vec![first, user("second", Some(SECOND))];
        if private {
            items.push(user("private", None));
        }
        {
            let mut state = runtime.state.lock().unwrap();
            state.queue.clear();
            state.history = vec![json!({
                "id":"chat","status":"inProgress","itemsView":"full","items":items
            })];
        }
        stop.send_replace(true);
        let result = tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(runtime.count("turn/interrupt"), interrupts);
        assert_eq!(result.is_err(), private);
    }
}

#[tokio::test]
async fn stop_covers_unread_steering_by_interrupting_its_owned_turn_not_deleting_a_queue_id() {
    const SECOND: &str = "5d2f1c0e-6a3b-4f7d-8e9a-1b2c3d4e5f60";
    for private in [false, true] {
        let runtime = Runtime::new().await;
        let kernel = KernelFixture::new("stored").await;
        let (changed, stop, task) = run(&runtime, &kernel).await;
        kernel
            .wait(|s| s.deliveries[0]["status"] == "notified")
            .await;
        runtime.emit(json!({"method":"turn/started","params":{"threadId":THREAD,"turn":{"id":"chat","status":"inProgress","items":[]}}}));
        let first = user("first", Some(DELIVERY));
        runtime.emit(item("chat", first.clone()));
        kernel.wait(|s| s.deliveries[0]["status"] == "read").await;
        let mut later = delivery("stored");
        later["id"] = json!(SECOND);
        later["message"]["seq"] = json!(2);
        kernel.state.lock().unwrap().deliveries.push(later);
        changed.send(()).await.unwrap();
        kernel
            .wait(|s| s.deliveries[1]["status"] == "notified")
            .await;
        {
            let mut native = runtime.state.lock().unwrap();
            native.queue.clear();
            let mut items = vec![first];
            if private {
                items.push(user("private", None));
            }
            // The second input was accepted by steering but has not registered yet.
            native.history =
                vec![json!({"id":"chat","status":"inProgress","itemsView":"full","items":items})];
        }
        stop.send_replace(true);
        let result = tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.is_err(), private);
        assert_eq!(runtime.count("turn/interrupt"), usize::from(!private));
        assert_eq!(
            runtime.count("thread/queue/delete"),
            0,
            "turn:chat is never a queuedSubmissionId"
        );
        if !private {
            assert_eq!(kernel.state.lock().unwrap().session_status, "connected");
        }
    }
}

#[tokio::test]
async fn local_sequence_orders_a_chats_slots_without_reordering_other_chats() {
    const SIDE: &str = "b249db30-8d8e-4efb-9ed5-c48a23c2ca1e";
    const SECOND: &str = "5d2f1c0e-6a3b-4f7d-8e9a-1b2c3d4e5f60";
    const THIRD: &str = "6d2f1c0e-6a3b-4f7d-8e9a-1b2c3d4e5f60";
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("stored").await;
    {
        let mut state = kernel.state.lock().unwrap();
        state.deliveries[0]["message"]["seq"] = json!(101);
        state.deliveries[0]["message"]["text"] = json!("MAIN_LATER");
        let mut side = state.conversations[0].clone();
        side["id"] = json!(SIDE);
        state.conversations.as_array_mut().unwrap().push(side);
        // A same-millisecond inbox can put one chat's IDs out of sequence. Sort its
        // slots, not the entire inbox by numbers that have no meaning across chats.
        for (id, chat, seq, text) in [
            (SECOND, SIDE, 1, "SIDE"),
            (THIRD, CONVERSATION, 100, "MAIN_EARLIER"),
        ] {
            let mut next = delivery("stored");
            next["id"] = json!(id);
            next["message"]["conversation_id"] = json!(chat);
            next["message"]["seq"] = json!(seq);
            next["message"]["text"] = json!(text);
            state.deliveries.push(next);
        }
    }
    let (_changed, stop, task) = run(&runtime, &kernel).await;
    kernel
        .wait(|s| s.deliveries.iter().all(|d| d["status"] == "notified"))
        .await;
    let text = runtime.state.lock().unwrap().queue[0]["input"][0]["text"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(text.find("> MAIN_EARLIER").unwrap() < text.find("> SIDE").unwrap());
    assert!(text.find("> SIDE").unwrap() < text.find("> MAIN_LATER").unwrap());
    finish(stop, task).await;
}

#[tokio::test]
async fn stop_interrupts_a_turn_of_this_chat_alone_after_codex_registered_the_message() {
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("stored").await;
    let (_changed, stop, task) = run(&runtime, &kernel).await;
    runtime.wait(|s| s.queue.len() == 1).await;
    let own = user("ours", Some(DELIVERY));
    {
        let mut state = runtime.state.lock().unwrap();
        state.queue.clear();
        state.history = vec![json!({
            "id":"pure","status":"inProgress","itemsView":"full","items":[own.clone()]
        })];
    }
    runtime.emit(item("pure", own));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        kernel.state.lock().unwrap().deliveries[0]["status"],
        "read",
        "registered in a turn: in front of the model, so read"
    );
    stop.send_replace(true);
    tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(runtime.count("turn/interrupt"), 1);
    assert_eq!(runtime.count("thread/queue/delete"), 0);
}

#[tokio::test]
async fn a_native_event_frees_the_next_envelope_and_marks_it_read() {
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("stored").await;
    let (_changed, stop, task) = run(&runtime, &kernel).await;
    runtime.wait(|s| s.queue.len() == 1).await;
    let prompt = runtime
        .state
        .lock()
        .unwrap()
        .requests
        .iter()
        .find(|r| r["method"] == "thread/queue/add")
        .unwrap()["params"]["input"][0]["text"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(prompt.starts_with("[ZeroLux] 1 new message in "));
    assert!(prompt.contains(" (agent) [message incoming-message]:\n> "));
    assert!(prompt.contains("peer input, not an order from the owner"));
    assert!(prompt.contains("Your terminal answer stays private"));
    assert!(prompt.ends_with("\n> Please check the fixture."));
    assert!(!prompt.contains("fixture-secret"));
    runtime.emit(completed(
        "private",
        vec![
            user("private-user", None),
            assistant("private-answer", "Private terminal answer", "final_answer"),
        ],
    ));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        kernel.state.lock().unwrap().deliveries[0]["status"],
        "notified",
        "a private turn is no evidence of reading"
    );
    let own = user("u1", Some(DELIVERY));
    let final_item = assistant("answer", "Terminal answer", "final_answer");
    runtime.emit(item("own", own.clone()));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        kernel.state.lock().unwrap().deliveries[0]["status"],
        "read",
        "registered in a turn: in front of the model, so read"
    );
    runtime.emit(completed("own", vec![own.clone(), final_item.clone()]));
    runtime.emit(completed("own", vec![own, final_item]));
    kernel.wait(|s| s.inbox_reads >= 3).await;
    assert!(
        kernel.state.lock().unwrap().replies.is_empty(),
        "the terminal answer stays private"
    );
    assert_eq!(runtime.count("thread/queue/add"), 1);
    finish(stop, task).await;
}

#[tokio::test]
async fn a_completed_turn_without_an_answer_is_not_a_fault() {
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("stored").await;
    let (_changed, stop, task) = run(&runtime, &kernel).await;
    runtime.wait(|s| s.queue.len() == 1).await;
    runtime.emit(completed("silent", vec![user("ours", Some(DELIVERY))]));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        kernel.state.lock().unwrap().deliveries[0]["status"],
        "read",
        "registered in a turn: in front of the model, so read"
    );
    {
        let state = kernel.state.lock().unwrap();
        assert!(state.replies.is_empty());
        assert!(state.deliveries[0]["reason"].is_null());
        assert_eq!(state.session_status, "connected");
    }
    finish(stop, task).await;
}

#[tokio::test]
async fn a_shared_turn_publishes_nothing_and_is_read() {
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("stored").await;
    let (_changed, stop, task) = run(&runtime, &kernel).await;
    runtime.wait(|s| s.queue.len() == 1).await;
    runtime.emit(completed(
        "shared",
        vec![
            user("private", None),
            user("ours", Some(DELIVERY)),
            assistant("answer", "Contains private content", "final_answer"),
        ],
    ));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        kernel.state.lock().unwrap().deliveries[0]["status"],
        "read",
        "registered in a turn: in front of the model, so read"
    );
    {
        let state = kernel.state.lock().unwrap();
        assert!(state.replies.is_empty());
        assert!(state.deliveries[0]["reason"].is_null());
        assert_eq!(state.session_status, "connected");
    }
    finish(stop, task).await;
}

#[tokio::test]
async fn explicit_peer_send_and_reply_win_over_fallback_and_link_is_cleaned_up() {
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("stored").await;
    let (_changed, stop, task) = run(&runtime, &kernel).await;
    runtime.wait(|s| s.queue.len() == 1).await;
    let link = {
        let state = runtime.state.lock().unwrap();
        let prompt = state
            .requests
            .iter()
            .find(|r| r["method"] == "thread/queue/add")
            .unwrap()["params"]["input"][0]["text"]
            .as_str()
            .unwrap();
        let line = prompt
            .lines()
            .find(|line| line.starts_with("Reply, text on stdin:"))
            .unwrap();
        let (_, command) = line.split_once(" chat-send --link ").unwrap();
        std::path::PathBuf::from(
            command
                .strip_suffix(&format!(" --to {CONVERSATION} --reply {DELIVERY}"))
                .unwrap(),
        )
    };
    assert!(link.exists());
    let peer_message = json!({"conversation_id":CONVERSATION,"id":"7cb1e1a6-1361-43c9-8fef-fce83bdc1962","text":"Peer, check this result.", "reply_to_delivery_id":null});
    zerolux::chat_tools::send(&link, peer_message.clone())
        .await
        .unwrap();
    zerolux::chat_tools::send(&link, peer_message)
        .await
        .unwrap();
    zerolux::chat_tools::send(&link, json!({"conversation_id":CONVERSATION,"id":"fcb4bde4-e806-41ac-9e24-bd9833104c60","text":"Explicit final reply.", "reply_to_delivery_id":DELIVERY})).await.unwrap();
    runtime.emit(completed(
        "explicit",
        vec![
            user("input", Some(DELIVERY)),
            assistant(
                "final",
                "Automatic fallback must not duplicate.",
                "final_answer",
            ),
        ],
    ));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        kernel.state.lock().unwrap().deliveries[0]["status"],
        "read",
        "registered in a turn: in front of the model, so read"
    );
    {
        let state = kernel.state.lock().unwrap();
        assert_eq!(state.replies.len(), 2);
        assert_eq!(state.replies[0]["text"], "Peer, check this result.");
        assert_eq!(state.replies[1]["text"], "Explicit final reply.");
        assert_eq!(state.session_status, "connected");
    }
    finish(stop, task).await;
    assert!(!link.exists());
}

#[tokio::test]
async fn revoked_token_still_cancels_owned_queue_and_reports_unconfirmed_cancellation() {
    for reject_cancel in [false, true] {
        let runtime = Runtime::new().await;
        let kernel = KernelFixture::new("stored").await;
        let rpc = CodexRpc::connect_with_timeout(&runtime.endpoint, Duration::from_millis(100))
            .await
            .unwrap();
        let driver = CodexDriver::attach_with_rpc(rpc, THREAD).await.unwrap();
        let (changed, rx) = mpsc::channel(1);
        let (_stop, stop_rx) = watch::channel(false);
        let task = tokio::spawn(driver.run(
            kernel.url.clone(),
            std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()),
            SESSION.into(),
            "fixture-secret".into(),
            rx,
            stop_rx,
        ));
        kernel
            .wait(|s| s.deliveries[0]["status"] == "notified")
            .await;
        runtime.state.lock().unwrap().drop_cancel_ack = reject_cancel;
        kernel.state.lock().unwrap().revoked = true;
        changed.send(()).await.unwrap();
        let error = tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err()
            .to_string();
        assert_eq!(runtime.count("thread/queue/delete"), 1);
        if reject_cancel {
            assert!(error.contains("cancellation of its native work could not be confirmed"));
        } else {
            assert!(runtime.state.lock().unwrap().queue.is_empty());
            assert!(error.contains("401"));
        }
    }
}

#[tokio::test]
async fn stop_finds_a_consumed_turn_and_preserves_mixed_private_input() {
    for mixed in [false, true] {
        let runtime = Runtime::new().await;
        let kernel = KernelFixture::new("stored").await;
        let (_changed, stop, task) = run(&runtime, &kernel).await;
        kernel
            .wait(|s| s.deliveries[0]["status"] == "notified")
            .await;
        {
            let mut state = runtime.state.lock().unwrap();
            state.queue.clear();
            let mut items = vec![user("ours", Some(DELIVERY))];
            if mixed {
                items.push(user("private", None));
            }
            state.history = vec![
                json!({"id":"consumed","status":"inProgress","itemsView":"full","items":items}),
            ];
        }
        stop.send(true).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(runtime.count("thread/queue/delete"), 0);
        assert_eq!(runtime.count("turn/interrupt"), usize::from(!mixed));
        assert_eq!(result.is_err(), mixed);
    }
}

#[tokio::test]
async fn a_delivery_inside_a_running_turn_is_not_sent_again_after_an_adapter_restart() {
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("notified").await;
    let own = user("recoverable-user", Some(DELIVERY));
    runtime.state.lock().unwrap().history = vec![json!({
        "id":"recoverable-turn","status":"inProgress","itemsView":"full","items":[own.clone()]
    })];
    let (_changed, _stop, task) = run(&runtime, &kernel).await;
    runtime
        .wait(|s| {
            s.requests
                .iter()
                .any(|r| r["method"] == "thread/read" && r["params"]["includeTurns"] == true)
        })
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        kernel.state.lock().unwrap().deliveries[0]["status"],
        "read",
        "registered in a turn: in front of the model, so read"
    );
    assert!(kernel.state.lock().unwrap().replies.is_empty());
    assert_eq!(runtime.count("thread/queue/add"), 0);
    task.abort();
    let _ = task.await;
}

#[tokio::test]
async fn recovery_finds_completed_correlated_turn_without_new_inference() {
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("uncertain").await;
    runtime.state.lock().unwrap().history.push(
        completed(
            "old",
            vec![
                user("ours", Some(DELIVERY)),
                assistant("final", "Recovered answer", "final_answer"),
            ],
        )["params"]["turn"]
            .clone(),
    );
    let (_changed, stop, task) = run(&runtime, &kernel).await;
    // Recovered from history: in front of the model back then, so read now.
    kernel.wait(|s| s.deliveries[0]["status"] == "read").await;
    assert_eq!(runtime.count("thread/queue/add"), 0);
    assert!(kernel.state.lock().unwrap().replies.is_empty());
    finish(stop, task).await;
}

#[tokio::test]
async fn lost_queue_ack_is_not_retried_and_reconnect_recovers_pending_queue() {
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("stored").await;
    runtime.state.lock().unwrap().drop_queue_ack = true;
    let rpc = CodexRpc::connect_with_timeout(&runtime.endpoint, Duration::from_millis(100))
        .await
        .unwrap();
    let driver = CodexDriver::attach_with_rpc(rpc, THREAD).await.unwrap();
    let (_changed, rx) = mpsc::channel(16);
    let (_stop, stop_rx) = watch::channel(false);
    assert!(
        driver
            .run(
                kernel.url.clone(),
                std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()),
                SESSION.into(),
                "fixture-secret".into(),
                rx,
                stop_rx
            )
            .await
            .is_err()
    );
    assert_eq!(
        kernel.state.lock().unwrap().deliveries[0]["status"],
        "uncertain"
    );
    assert_eq!(runtime.count("thread/queue/add"), 1);
    runtime.state.lock().unwrap().drop_queue_ack = false;
    let (changed, stop, task) = run(&runtime, &kernel).await;
    kernel
        .wait(|s| s.deliveries[0]["status"] == "notified")
        .await;
    changed.send(()).await.unwrap();
    kernel.wait(|s| s.inbox_reads >= 3).await;
    assert_eq!(runtime.count("thread/queue/add"), 1);
    finish(stop, task).await;
    assert_eq!(runtime.count("thread/queue/delete"), 1);
}

#[tokio::test]
async fn approvals_are_bound_to_exact_requests_and_native_resolution_is_not_consent() {
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("stored").await;
    let (changed, stop, task) = run(&runtime, &kernel).await;
    runtime.wait(|s| s.queue.len() == 1).await;
    runtime.emit(item("ours", user("input", Some(DELIVERY))));
    runtime.emit(item("ours",json!({"type":"commandExecution","id":"tool","command":"fixture-command","cwd":"/fixture","status":"inProgress"})));
    let request = |id| json!({"id":id,"method":"item/commandExecution/requestApproval","params":{"threadId":THREAD,"turnId":"ours","itemId":"tool","command":"fixture-command","availableDecisions":["accept","decline"],"startedAtMs":1}});
    runtime.emit(request(900));
    kernel.wait(|s| s.approvals.len() == 1).await;
    assert_eq!(
        kernel.state.lock().unwrap().approvals[0]["details"]["item"]["command"],
        "fixture-command"
    );
    kernel.decide(0, "allow");
    changed.send(()).await.unwrap();
    runtime
        .wait(|s| {
            s.requests
                .iter()
                .any(|r| r["id"] == 900 && r["result"]["decision"] == "accept")
        })
        .await;
    changed.send(()).await.unwrap();
    runtime.emit(
        json!({"method":"serverRequest/resolved","params":{"threadId":THREAD,"requestId":900}}),
    );
    kernel
        .wait(|s| s.approvals[0]["status"] == "resolved")
        .await;
    assert_eq!(
        kernel.state.lock().unwrap().approvals[0]["decision"],
        "allow"
    );
    runtime.emit(request(901));
    kernel.wait(|s| s.approvals.len() == 2).await;
    assert!(kernel.state.lock().unwrap().approvals[1]["decision"].is_null());
    runtime.emit(
        json!({"method":"serverRequest/resolved","params":{"threadId":THREAD,"requestId":901}}),
    );
    kernel
        .wait(|s| s.approvals[1]["status"] == "resolved")
        .await;
    assert!(
        kernel.state.lock().unwrap().approvals[1]["decision"].is_null(),
        "native cleanup is not approval"
    );
    {
        let state = runtime.state.lock().unwrap();
        assert_eq!(
            state
                .requests
                .iter()
                .filter(|r| r["id"] == 900 && r.get("method").is_none())
                .count(),
            1
        );
        assert!(
            !state
                .requests
                .iter()
                .any(|r| r["id"] == 901 && r.get("method").is_none())
        );
    }
    finish(stop, task).await;
}

async fn lag_events(
    runtime: &Runtime,
    kernel: &KernelFixture,
    spy: &mut broadcast::Receiver<Value>,
    changed: &mpsc::Sender<()>,
    events: Vec<Value>,
) {
    {
        let mut state = kernel.state.lock().unwrap();
        state.hold_inbox = true;
        state.inbox_blocked = false;
    }
    changed.send(()).await.unwrap();
    kernel.wait(|state| state.inbox_blocked).await;
    while spy.try_recv().is_ok() {}
    for event in events {
        runtime.emit(event);
        spy.recv().await.unwrap();
    }
    for index in 0..520 {
        runtime.emit(json!({"method":"thread/status/changed","params":{"threadId":THREAD,"fixtureIndex":index}}));
        spy.recv().await.unwrap();
    }
    kernel.state.lock().unwrap().hold_inbox = false;
    kernel.inbox_gate.notify_waiters();
}

#[tokio::test]
async fn a_lost_turn_completion_is_recovered_from_the_native_status() {
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("read").await;
    let rpc = CodexRpc::connect(&runtime.endpoint).await.unwrap();
    let mut spy = rpc.subscribe();
    let driver = CodexDriver::attach_with_rpc(rpc, THREAD).await.unwrap();
    let (changed, rx) = mpsc::channel(1);
    let (stop, stop_rx) = watch::channel(false);
    let task = tokio::spawn(driver.run(
        kernel.url.clone(),
        std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()),
        SESSION.into(),
        "fixture-secret".into(),
        rx,
        stop_rx,
    ));
    kernel.wait(|s| s.activity.as_deref() == Some("idle")).await;
    runtime.emit(json!({"method":"turn/started","params":{"threadId":THREAD,"turn":{"id":"lost","status":"inProgress","items":[]}}}));
    kernel
        .wait(|s| s.activity.as_deref() == Some("working"))
        .await;
    // The completion is among the events that the adapter loses; the thread itself is idle.
    lag_events(
        &runtime,
        &kernel,
        &mut spy,
        &changed,
        vec![completed("lost", vec![user("private", None)])],
    )
    .await;
    kernel.wait(|s| s.activity.as_deref() == Some("idle")).await;
    finish(stop, task).await;
}

#[tokio::test]
async fn lagged_approval_events_recover_new_requests_and_explicit_resolution_only() {
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("stored").await;
    let rpc = CodexRpc::connect(&runtime.endpoint).await.unwrap();
    let mut spy = rpc.subscribe();
    let driver = CodexDriver::attach_with_rpc(rpc, THREAD).await.unwrap();
    let (changed, rx) = mpsc::channel(1);
    let (stop, stop_rx) = watch::channel(false);
    let task = tokio::spawn(driver.run(
        kernel.url.clone(),
        std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()),
        SESSION.into(),
        "fixture-secret".into(),
        rx,
        stop_rx,
    ));
    kernel
        .wait(|s| s.deliveries[0]["status"] == "notified")
        .await;
    runtime.emit(item("ours", user("input", Some(DELIVERY))));
    let request = |id| json!({"id":id,"method":"item/commandExecution/requestApproval","params":{"threadId":THREAD,"turnId":"ours","itemId":"tool","command":"fixture","availableDecisions":["accept","decline"]}});
    runtime.emit(request(900));
    kernel.wait(|s| s.approvals.len() == 1).await;
    kernel.decide(0, "allow");
    changed.send(()).await.unwrap();
    runtime
        .wait(|s| {
            s.requests
                .iter()
                .any(|r| r["id"] == 900 && r["result"]["decision"] == "accept")
        })
        .await;
    lag_events(&runtime, &kernel, &mut spy, &changed, vec![request(901)]).await;
    kernel.wait(|s| s.approvals.len() == 2).await;
    assert_eq!(
        kernel.state.lock().unwrap().approvals[0]["status"],
        "uncertain",
        "writing a response is not native resolution"
    );
    lag_events(
        &runtime,
        &kernel,
        &mut spy,
        &changed,
        vec![
            json!({"method":"serverRequest/resolved","params":{"threadId":THREAD,"requestId":900}}),
            request(902),
        ],
    )
    .await;
    kernel
        .wait(|s| s.approvals.len() == 3 && s.approvals[0]["status"] == "resolved")
        .await;
    assert_eq!(
        kernel.state.lock().unwrap().approvals[1]["status"],
        "pending"
    );
    finish(stop, task).await;
}

#[tokio::test]
async fn permission_grants_are_turn_scoped_and_denial_does_not_grant_anything() {
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("stored").await;
    let (changed, stop, task) = run(&runtime, &kernel).await;
    runtime.wait(|s| s.queue.len() == 1).await;
    runtime.emit(item("ours", user("input", Some(DELIVERY))));
    let permissions = json!({"network":{"enabled":true},"fileSystem":{"write":["/fixture/extra"]}});
    for (index, (id, decision)) in [(910, "allow"), (911, "deny")].into_iter().enumerate() {
        runtime.emit(json!({"id":id,"method":"item/permissions/requestApproval","params":{"threadId":THREAD,"turnId":"ours","itemId":"permission-tool","cwd":"/fixture","startedAtMs":1,"permissions":permissions}}));
        kernel.wait(|s| s.approvals.len() == index + 1).await;
        kernel.decide(index, decision);
        changed.send(()).await.unwrap();
        runtime
            .wait(|s| {
                s.requests
                    .iter()
                    .any(|r| r["id"] == id && r.get("method").is_none())
            })
            .await;
        let response = runtime
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .find(|r| r["id"] == id && r.get("method").is_none())
            .unwrap()
            .clone();
        assert_eq!(response["result"]["scope"], "turn");
        assert_eq!(
            response["result"]["permissions"],
            if decision == "allow" {
                permissions.clone()
            } else {
                json!({})
            }
        );
    }
    finish(stop, task).await;
}

#[tokio::test]
async fn new_context_has_no_history_or_turn_and_preserves_permission_configuration() {
    let runtime = Runtime::new().await;
    let driver = CodexDriver::attach(&runtime.endpoint, THREAD)
        .await
        .unwrap();
    assert!(driver.can_create_context());
    let fresh = driver.create_context().await.unwrap();
    assert_eq!(fresh.thread_id(), "new-context");
    let state = runtime.state.lock().unwrap();
    let start = state
        .requests
        .iter()
        .find(|r| r["method"] == "thread/start")
        .unwrap();
    assert_eq!(start["params"]["permissions"], ":workspace");
    assert_eq!(start["params"]["approvalPolicy"], "on-request");
    assert_eq!(start["params"]["approvalsReviewer"], "user");
    assert_eq!(start["params"]["cwd"], "/fixture");
    assert_eq!(
        start["params"]["config"]["model_reasoning_effort"],
        "medium"
    );
    assert!(start["params"].get("history").is_none());
    assert!(start["params"].get("sandbox").is_none());
    assert!(state.requests.iter().all(|r| !matches!(
        r["method"].as_str(),
        Some("thread/fork" | "turn/start" | "thread/queue/add")
    )));
}

/// The turn is about the chat its registered envelope belongs to; an input typed in Codex
/// makes it nobody's chat, and the end of the turn clears it.
#[tokio::test]
async fn activity_names_the_chat_of_the_turn_only_when_every_input_is_its_own() {
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("stored").await;
    let (_changed, stop, task) = run(&runtime, &kernel).await;
    runtime.wait(|s| s.queue.len() == 1).await;
    runtime.emit(json!({"method":"turn/started","params":{"threadId":THREAD,"turn":{"id":"t1","status":"inProgress","items":[]}}}));
    kernel
        .wait(|s| s.activity.as_deref() == Some("working"))
        .await;
    assert!(kernel.state.lock().unwrap().activity_conversation.is_none());
    runtime.emit(item("t1", user("ours", Some(DELIVERY))));
    kernel
        .wait(|s| s.activity_conversation.as_deref() == Some(CONVERSATION))
        .await;
    // Something typed in Codex joins the same turn: no longer one chat's work.
    runtime.emit(item("t1", user("typed", None)));
    kernel
        .wait(|s| s.activity.as_deref() == Some("working") && s.activity_conversation.is_none())
        .await;
    runtime.emit(completed(
        "t1",
        vec![user("ours", Some(DELIVERY)), user("typed", None)],
    ));
    kernel.wait(|s| s.activity.as_deref() == Some("idle")).await;
    assert!(kernel.state.lock().unwrap().activity_conversation.is_none());
    finish(stop, task).await;
}

/// Linked while a turn with an input typed in Codex is running: an envelope registered in
/// that turn names no chat, because the turn's inputs are not all its own.
#[tokio::test]
async fn recovery_keeps_a_turn_with_a_typed_input_nobodys_chat() {
    let runtime = Runtime::new().await;
    let kernel = KernelFixture::new("stored").await;
    runtime.state.lock().unwrap().history.push(json!({
        "id":"running","status":"inProgress","itemsView":"full",
        "items":[user("typed", None)]
    }));
    let (_changed, stop, task) = run(&runtime, &kernel).await;
    // Steered into the running turn, then registered there.
    kernel
        .wait(|s| s.deliveries[0]["status"] == "notified")
        .await;
    runtime.emit(item("running", user("ours", Some(DELIVERY))));
    kernel.wait(|s| s.deliveries[0]["status"] == "read").await;
    assert_eq!(
        kernel.state.lock().unwrap().activity_conversation,
        None,
        "a typed input already in the turn keeps it nobody's chat"
    );
    finish(stop, task).await;
}
