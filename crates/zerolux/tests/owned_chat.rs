#![cfg(unix)]

use nix::{
    sys::signal::{Signal, kill, killpg},
    unistd::Pid,
};
use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use std::{os::unix::fs::PermissionsExt, path::PathBuf, sync::Arc, time::Duration};
use zerolux::{
    api,
    chat_runtime::ChatRuntime,
    claude_runner::RunnerProgram,
    harness::Harness,
    livekit::{LiveKit, LiveKitConfig},
    model::{ChatSessionStatus, HireChatSession, SendChatMessage, SetOwnerName},
    store::Store,
};

struct Fixture {
    dir: tempfile::TempDir,
    program: RunnerProgram,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        let root = dir.path();
        for folder in ["home", "tmp", "workspace"] {
            std::fs::create_dir(root.join(folder)).unwrap();
        }
        let bun = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|path| path.join("bun"))
            .find(|path| path.is_file())
            .unwrap()
            .canonicalize()
            .unwrap();
        let wrapper = root.join("bun-fixture");
        std::fs::write(&wrapper, format!("#!/bin/sh\nexec /usr/bin/env -i HOME=\"{}\" TMPDIR=\"{}\" PATH=/usr/bin:/bin ZEROLUX_RUNNER_REGISTRY=\"$ZEROLUX_RUNNER_REGISTRY\" ZEROLUX_NATIVE_SESSION=\"$ZEROLUX_NATIVE_SESSION\" ZEROLUX_WORKSPACE=\"$ZEROLUX_WORKSPACE\" ZEROLUX_PERMISSION_MODE=\"$ZEROLUX_PERMISSION_MODE\" \"{}\" \"$@\"\n", root.join("home").display(), root.join("tmp").display(), bun.display())).unwrap();
        let claude = root.join("claude-fixture");
        std::fs::write(&claude, "#!/bin/sh\nprintf '%s\\n' '[]'\n").unwrap();
        for file in [&wrapper, &claude] {
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let program = RunnerProgram {
            bun: wrapper,
            entry: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../extensions/claude/src/fixtures/owned-harness.ts"),
            kernel_executable: Some(env!("CARGO_BIN_EXE_zerolux").into()),
            claude_cli: claude,
            pi_entry: None,
            sdk_executable: None,
        };
        Self { dir, program }
    }
    fn trace(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.path().join("workspace/runner-trace.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }
    async fn wait_trace(&self, predicate: impl Fn(&[Value]) -> bool) -> Vec<Value> {
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let rows = self.trace();
                if predicate(&rows) {
                    return rows;
                }
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("Trace did not reach expected state: {:?}", self.trace()))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if std::thread::panicking() {
            eprintln!("Runner trace: {:?}", self.trace());
        }
        // These detached process groups were created only by this fixture's runner launches.
        if let Ok(entries) = std::fs::read_dir(self.dir.path().join("links/claude")) {
            for entry in entries.flatten() {
                if entry.path().extension().and_then(|v| v.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(bytes) = std::fs::read(entry.path())
                    && let Ok(record) = serde_json::from_slice::<Value>(&bytes)
                    && let Some(pid) = record["pid"].as_i64()
                {
                    let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);
                }
            }
        }
    }
}

struct Kernel {
    store: Store,
    url: String,
    client: Client,
    livekit: Arc<LiveKit>,
    runtime: Option<Arc<ChatRuntime>>,
    server: tokio::task::JoinHandle<()>,
}
impl Kernel {
    async fn start(fixture: &Fixture, port: u16) -> Self {
        let root = fixture.dir.path();
        let store = Store::open(&root.join("chat.db")).await.unwrap();
        store
            .set_owner_name(SetOwnerName {
                name: "Owner".into(),
            })
            .await
            .unwrap();
        let livekit = Arc::new(
            LiveKit::start(LiveKitConfig {
                url: None,
                api_key: None,
                api_secret: None,
                data_dir: root.join("livekit"),
            })
            .await
            .unwrap(),
        );
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let runtime = ChatRuntime::start_with_runner(
            store.clone(),
            livekit.clone(),
            url.clone(),
            root.join("links"),
            fixture.program.clone(),
        )
        .await
        .unwrap();
        let app = api::router_with_runtime(store.clone(), root.join("web"), runtime.clone());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        runtime.reconnect().await.unwrap();
        Self {
            store,
            url,
            client: Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(75))
                .build()
                .unwrap(),
            livekit,
            runtime: Some(runtime),
            server,
        }
    }
    async fn api(&self, path: &str, body: Option<Value>) -> Value {
        let url = format!("{}/api{path}", self.url);
        let response = match body {
            Some(body) => self.client.post(url).json(&body).send().await,
            None => self.client.get(url).send().await,
        }
        .unwrap();
        let status = response.status();
        let body: Value = response.json().await.unwrap();
        assert!(status.is_success(), "{path}: {status} {body}");
        body
    }
    async fn wait(&self, path: &str, predicate: impl Fn(&Value) -> bool) -> Value {
        tokio::time::timeout(Duration::from_secs(25), async {
            loop {
                let data = self.api(path, None).await;
                if predicate(&data) {
                    return data;
                }
                tokio::time::sleep(Duration::from_millis(80)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("HTTP state did not settle at {path}"))
    }
    async fn shutdown(mut self) {
        self.runtime.take().unwrap().shutdown().await.unwrap();
        self.server.abort();
        let _ = (&mut self.server).await;
        self.livekit.shutdown().await.unwrap();
    }
}
impl Drop for Kernel {
    fn drop(&mut self) {
        self.server.abort();
        if let Some(runtime) = self.runtime.take() {
            tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current().block_on(async {
                    let _ = runtime.shutdown().await;
                    let _ = self.livekit.shutdown().await;
                })
            });
        }
    }
}
fn count(rows: &[Value], event: &str) -> usize {
    rows.iter().filter(|row| row["event"] == event).count()
}

#[tokio::test(flavor = "multi_thread")]
async fn owned_claude_keeps_its_query_and_pending_approval_across_kernel_restart() {
    let fixture = Fixture::new();
    let kernel = Kernel::start(&fixture, 0).await;
    let workspace = fixture.dir.path().join("workspace");
    for input in [
        json!({"name":"Fixture","workspace":"relative"}),
        json!({"name":"Fixture","workspace":workspace,"permission_mode":"bypassPermissions"}),
    ] {
        let response = kernel
            .client
            .post(format!("{}/api/chat/claude-sessions", kernel.url))
            .json(&input)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    assert!(fixture.trace().is_empty());
    let created = kernel
        .api(
            "/chat/claude-sessions",
            Some(json!({
                "name":"Fixture Claude", "workspace":workspace, "permission_mode":"plan"
            })),
        )
        .await;
    let session = created["session"]["id"].as_str().unwrap().to_owned();
    let actor = created["actor"]["id"].as_str().unwrap().to_owned();
    let native = created["session"]["native_session_id"].clone();
    assert_eq!(created["session"]["origin"], "owned");
    assert!(!created.to_string().contains("native_locator"));
    assert!(!created.to_string().contains("token"));
    let trace = fixture.wait_trace(|rows| count(rows, "start") == 1).await;
    let pid = trace[0]["pid"].as_i64().unwrap() as i32;
    assert_eq!(trace[0]["mode"], "plan");
    assert_eq!(trace[0]["resume"], false);
    let chat = kernel.api("/conversations", Some(json!({"kind":"dm", "title":"Fixture", "members":[{"actor_id":actor,"session_id":session}]}))).await;
    let chat = chat["conversation"]["id"].as_str().unwrap();
    let messages = format!("/conversations/{chat}/messages");
    kernel
        .api(
            &messages,
            Some(
                json!({"id":uuid::Uuid::new_v4().to_string(),"text":"Run the fixture operation."}),
            ),
        )
        .await;
    let approvals = kernel
        .wait("/chat/approvals", |value| {
            value["approvals"].as_array().is_some_and(|v| v.len() == 1)
        })
        .await;
    let approval = approvals["approvals"][0]["id"].as_str().unwrap().to_owned();
    assert_eq!(approvals["approvals"][0]["status"], "pending");
    let port = reqwest::Url::parse(&kernel.url).unwrap().port().unwrap();
    kernel.shutdown().await;
    assert_eq!(
        count(&fixture.trace(), "close"),
        0,
        "Kernel shutdown is not Stop"
    );
    assert!(kill(Pid::from_raw(pid), None).is_ok());

    let kernel = Kernel::start(&fixture, port).await;
    let sessions = kernel
        .wait("/chat/sessions", |v| {
            v["sessions"]
                .as_array()
                .is_some_and(|rows| rows.len() == 1 && rows[0]["status"] == "connected")
        })
        .await;
    assert_eq!(sessions["sessions"][0]["id"], session);
    assert_eq!(sessions["sessions"][0]["actor_id"], actor);
    assert_eq!(sessions["sessions"][0]["native_session_id"], native);
    assert_eq!(count(&fixture.trace(), "start"), 1);
    assert!(kill(Pid::from_raw(pid), None).is_ok());
    let approvals = kernel.api("/chat/approvals", None).await;
    assert_eq!(approvals["approvals"][0]["id"], approval);
    assert_eq!(approvals["approvals"][0]["status"], "pending");
    kernel
        .api(
            &format!("/chat/approvals/{approval}/decision"),
            Some(json!({"decision":"allow"})),
        )
        .await;
    let history = kernel
        .wait(&messages, |value| {
            value["messages"]
                .as_array()
                .is_some_and(|rows| rows.len() == 2)
        })
        .await;
    assert_eq!(history["messages"][1]["text"], "Fixture operation done.");
    assert!(history["messages"][1]["reply_to_delivery_id"].is_string());
    let trace = fixture.wait_trace(|rows| count(rows, "reply") == 1).await;
    assert_eq!(count(&trace, "permission"), 1);
    assert_eq!(count(&trace, "input"), 1);
    kernel
        .wait("/chat/approvals", |v| {
            v["approvals"]
                .as_array()
                .unwrap()
                .iter()
                .all(|a| a["id"] != approval || a["status"] == "delivered")
        })
        .await;

    // A peer's message reaches the inbox tool, not the SDK's owner-message stream.
    let owner = kernel.store.chat_identity(None).await.unwrap();
    let peer = kernel
        .store
        .hire_chat_session(
            &owner,
            HireChatSession {
                name: "Fixture peer".into(),
                actor_id: None,
                harness: Harness::Pi,
                native_session_id: "fixture-peer".into(),
                title: "Peer".into(),
                workspace: workspace.to_string_lossy().into_owned(),
                native_locator: json!({}),
                resume: false,
            },
        )
        .await
        .unwrap();
    kernel
        .store
        .set_chat_session_status(
            &owner,
            &peer.session.id,
            ChatSessionStatus {
                status: "connected".into(),
                reason: None,
            },
        )
        .await
        .unwrap();
    let peer_identity = kernel.store.chat_identity(Some(&peer.token)).await.unwrap();
    let team = kernel.api("/conversations", Some(json!({"kind":"group", "title":"Fixture peers", "members":[
        {"actor_id":actor,"session_id":session}, {"actor_id":peer.actor.id,"session_id":peer.session.id}
    ]}))).await;
    let team = team["conversation"]["id"].as_str().unwrap();
    kernel
        .store
        .send_chat_message(
            &peer_identity,
            team,
            SendChatMessage {
                id: uuid::Uuid::new_v4().to_string(),
                text: "Fixture peer input, never owner input.".into(),
                reply_to_delivery_id: None,
            },
        )
        .await
        .unwrap();
    kernel.runtime.as_ref().unwrap().changed();
    let trace = fixture.wait_trace(|rows| count(rows, "inbox") == 1).await;
    assert_eq!(
        trace
            .iter()
            .filter(|row| row["event"] == "input" && row["kind"] == "owner")
            .count(),
        1
    );
    let response = kernel
        .client
        .post(format!("{}/api/chat/claude-sessions", kernel.url))
        .bearer_auth(&peer.token)
        .json(&json!({"name":"Denied","workspace":workspace}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    kernel
        .store
        .stop_chat_session(&owner, &peer.session.id)
        .await
        .unwrap();

    let stopped = kernel
        .api(&format!("/chat/sessions/{session}/stop"), Some(json!({})))
        .await;
    assert_eq!(stopped["session"]["status"], "stopped");
    assert!(
        stopped["session"]["attention_reason"].is_null(),
        "Owned Stop confirms native exit: {stopped}"
    );
    assert_eq!(count(&fixture.trace(), "close"), 1);
    let resumed = kernel
        .api(&format!("/chat/sessions/{session}/resume"), Some(json!({})))
        .await;
    assert_eq!(resumed["session"]["native_session_id"], native);
    assert_eq!(resumed["actor"]["id"], actor);
    assert_ne!(resumed["session"]["id"], session);
    let trace = fixture.wait_trace(|rows| count(rows, "start") == 2).await;
    let last = trace.iter().rev().find(|v| v["event"] == "start").unwrap();
    assert_eq!(last["mode"], "plan");
    assert_eq!(last["resume"], true);
    assert_eq!(
        count(&trace, "input"),
        2,
        "Resume does not replay consumed input"
    );
    kernel
        .api(&format!("/chat/sessions/{session}/stop"), Some(json!({})))
        .await;
    assert_eq!(
        count(&fixture.trace(), "close"),
        1,
        "Repeating Stop on the predecessor does not stop its successor"
    );
    let next = resumed["session"]["id"].as_str().unwrap();
    let stopped = kernel
        .api(&format!("/chat/sessions/{next}/stop"), Some(json!({})))
        .await;
    assert!(stopped["session"]["attention_reason"].is_null());
    kernel.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dead_runner_is_not_restarted_automatically_and_resume_never_replays_attempted_input() {
    let fixture = Fixture::new();
    let kernel = Kernel::start(&fixture, 0).await;
    let created = kernel.api("/chat/claude-sessions", Some(json!({
        "name":"Fixture Claude", "workspace":fixture.dir.path().join("workspace"), "permission_mode":"acceptEdits"
    }))).await;
    let session = created["session"]["id"].as_str().unwrap();
    let actor = created["actor"]["id"].as_str().unwrap();
    let native = &created["session"]["native_session_id"];
    let chat = kernel.api("/conversations", Some(json!({"kind":"dm","title":"Fixture","members":[{"actor_id":actor,"session_id":session}]}))).await;
    let chat = chat["conversation"]["id"].as_str().unwrap();
    let messages = format!("/conversations/{chat}/messages");
    kernel
        .api(
            &messages,
            Some(json!({"id":uuid::Uuid::new_v4().to_string(),"text":"First fixture request."})),
        )
        .await;
    let approvals = kernel
        .wait("/chat/approvals", |v| {
            v["approvals"]
                .as_array()
                .is_some_and(|rows| rows.len() == 1)
        })
        .await;
    let approval = approvals["approvals"][0]["id"].as_str().unwrap();
    let waiting_id = uuid::Uuid::new_v4().to_string();
    kernel
        .api(
            &messages,
            Some(json!({"id":waiting_id,"text":"Already handed to the runner, not yet consumed."})),
        )
        .await;
    kernel
        .wait(&messages, |v| {
            v["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["id"] == waiting_id && m["deliveries"][0]["status"] == "notified")
        })
        .await;
    let trace = fixture.trace();
    assert_eq!(count(&trace, "input"), 1);
    let pid = trace[0]["pid"].as_i64().unwrap() as i32;
    killpg(Pid::from_raw(pid), Signal::SIGKILL).unwrap();
    kernel
        .wait("/chat/sessions", |v| {
            v["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["id"] == session && s["status"] == "attention")
        })
        .await;
    kernel.runtime.as_ref().unwrap().reconnect().await.unwrap();
    assert_eq!(count(&fixture.trace(), "start"), 1);
    let resumed = kernel
        .api(&format!("/chat/sessions/{session}/resume"), Some(json!({})))
        .await;
    assert_eq!(&resumed["session"]["native_session_id"], native);
    assert_eq!(resumed["actor"]["id"], actor);
    let trace = fixture.wait_trace(|rows| count(rows, "start") == 2).await;
    let start = trace
        .iter()
        .rev()
        .find(|row| row["event"] == "start")
        .unwrap();
    assert_eq!(start["mode"], "acceptEdits");
    assert_eq!(start["resume"], true);
    let next = resumed["session"]["id"].as_str().unwrap();
    let history = kernel.api(&messages, None).await;
    let waiting = history["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == waiting_id)
        .unwrap();
    assert_eq!(waiting["deliveries"][0]["session_id"], session);
    assert_ne!(waiting["deliveries"][0]["status"], "stored");
    let approvals = kernel.api("/chat/approvals", None).await;
    assert!(
        approvals["approvals"]
            .as_array()
            .unwrap()
            .iter()
            .all(|a| a["id"] != approval || a["status"] == "resolved")
    );
    assert_eq!(count(&fixture.trace(), "input"), 1);
    let stopped = kernel
        .api(&format!("/chat/sessions/{next}/stop"), Some(json!({})))
        .await;
    assert!(stopped["session"]["attention_reason"].is_null());
    kernel.shutdown().await;
}
