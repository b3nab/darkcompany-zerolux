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
        std::fs::write(&wrapper, format!("#!/bin/sh\nexec /usr/bin/env -i HOME=\"{}\" TMPDIR=\"{}\" PATH=/usr/bin:/bin ZEROLUX_RUNNER_REGISTRY=\"$ZEROLUX_RUNNER_REGISTRY\" ZEROLUX_NATIVE_SESSION=\"$ZEROLUX_NATIVE_SESSION\" ZEROLUX_WORKSPACE=\"$ZEROLUX_WORKSPACE\" ZEROLUX_PERMISSION_MODE=\"$ZEROLUX_PERMISSION_MODE\" ZEROLUX_INITIAL_SETTINGS=\"$ZEROLUX_INITIAL_SETTINGS\" ZEROLUX_CLAUDE_MANAGED=\"$ZEROLUX_CLAUDE_MANAGED\" ${{ZEROLUX_SYSTEM_PROMPT:+ZEROLUX_SYSTEM_PROMPT=$ZEROLUX_SYSTEM_PROMPT}} \"{}\" \"$@\"\n", root.join("home").display(), root.join("tmp").display(), bun.display())).unwrap();
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
async fn native_settings_are_confirmed_at_start_and_changed_without_new_input() {
    let fixture = Fixture::new();
    let kernel = Kernel::start(&fixture, 0).await;
    let started = kernel
        .api(
            "/sessions",
            Some(json!({"harness":"claude-code",
                "name":"Configured fixture", "workspace":fixture.dir.path().join("workspace"),
                "model":"native-alternate", "effort":"medium", "permission_mode":"plan"
            })),
        )
        .await;
    let actor = started["actor"]["id"].as_str().unwrap();
    let session = started["session"]["id"].as_str().unwrap();
    // The session's settings are its harness's, confirmed at start.
    let path = format!("/sessions/{session}/settings");
    let view = kernel.api(&path, None).await;
    assert_eq!(view["values"]["model"], "native-alternate");
    assert_eq!(view["values"]["effort"], "medium");
    assert_eq!(view["values"]["permission_mode"], "plan");
    assert_eq!(view["models"][0]["value"], "native-default");
    assert_eq!(view["models"][1]["efforts"], json!(["medium", "high"]));
    assert!(!view.to_string().contains("must-not-be-published"));
    let patch = |body: Value| {
        kernel
            .client
            .patch(format!("{}/api{path}", kernel.url))
            .json(&body)
            .send()
    };
    let changed: Value =
        patch(json!({"model":"native-default", "effort":"low", "permission_mode":"auto"}))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
    assert_eq!(changed["values"]["model"], "native-default");
    assert_eq!(changed["values"]["effort"], "low");
    assert_eq!(changed["values"]["permission_mode"], "auto");
    let traces = fixture.trace();
    assert_eq!(count(&traces, "start"), 1);
    assert_eq!(count(&traces, "input"), 0);
    let mutations = count(&traces, "settings");
    let rejected = patch(json!({"effort":"invented"})).await.unwrap();
    assert!(!rejected.status().is_success());
    assert_eq!(count(&fixture.trace(), "settings"), mutations);
    // The agent's settings are its new sessions' defaults; its running sessions keep theirs.
    let defaults = format!("/actors/{actor}/settings");
    let agent = kernel
        .api(
            &defaults,
            Some(json!({"model":"native-default", "effort":"low", "permission_mode":"auto"})),
        )
        .await;
    assert_eq!(agent["actor"]["model"], "native-default");
    assert_eq!(count(&fixture.trace(), "settings"), mutations);
    let next = kernel.api("/sessions", Some(json!({"harness":"claude-code","name":"", "actor_id":actor, "workspace":fixture.dir.path().join("workspace")}))).await;
    let start = |trace: Vec<Value>| {
        trace
            .into_iter()
            .rev()
            .find(|e| e["event"] == "start")
            .unwrap()
    };
    let launched = start(fixture.trace());
    assert_eq!(launched["model"], "native-default");
    assert_eq!(launched["effort"], "low");
    assert_eq!(launched["mode"], "auto");
    assert_eq!(count(&fixture.trace(), "input"), 0);
    let different = kernel.api("/sessions", Some(json!({"harness":"claude-code",
        "name":"", "actor_id":actor, "workspace":fixture.dir.path().join("workspace"), "model":"native-alternate"
    }))).await;
    let launched = start(fixture.trace());
    assert_eq!(launched["model"], "native-alternate");
    assert!(
        launched["effort"].is_null(),
        "A new model without an effort override must not inherit the previous model's effort"
    );
    for id in [
        session,
        next["session"]["id"].as_str().unwrap(),
        different["session"]["id"].as_str().unwrap(),
    ] {
        kernel
            .api(&format!("/sessions/{id}/stop"), Some(json!({})))
            .await;
    }
    let resumed = kernel
        .api(&format!("/sessions/{session}/resume"), Some(json!({})))
        .await;
    let traces = fixture.trace();
    let restored = traces
        .iter()
        .rev()
        .find(|row| row["event"] == "start")
        .unwrap();
    assert_eq!(
        restored["mode"], "auto",
        "Resume keeps the live permission change, not the original plan mode"
    );
    assert_eq!(restored["resume"], true);
    assert_eq!(count(&traces, "input"), 0);
    kernel
        .api(
            &format!(
                "/sessions/{}/stop",
                resumed["session"]["id"].as_str().unwrap()
            ),
            Some(json!({})),
        )
        .await;
    kernel.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn managed_claude_bootstrap_lifecycle() {
    let fixture = Fixture::new();
    let kernel = Kernel::start(&fixture, 0).await;
    let workspace = fixture.dir.path().join("workspace");
    for input in [
        json!({"name":"Fixture","workspace":"relative"}),
        json!({"name":"Fixture","workspace":workspace,"permission_mode":"bypassPermissions"}),
    ] {
        let response = kernel
            .client
            .post(format!("{}/api/sessions", kernel.url))
            .json(&input)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    assert!(fixture.trace().is_empty());
    let created = kernel
        .api(
            "/sessions",
            Some(json!({"harness":"claude-code",
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
    assert!(trace[0]["model"].is_null());
    assert!(trace[0]["effort"].is_null());
    assert_eq!(trace[0]["hooks"], false);
    assert_eq!(
        trace[0]["system_prompt"],
        json!({"type":"preset","preset":"claude_code"})
    );
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
    std::fs::write(workspace.join("legacy-description"), "fixture").unwrap();
    kernel.shutdown().await;
    assert_eq!(
        count(&fixture.trace(), "close"),
        0,
        "Kernel shutdown is not Stop"
    );
    assert!(kill(Pid::from_raw(pid), None).is_ok());

    let kernel = Kernel::start(&fixture, port).await;
    let sessions = kernel
        .wait("/sessions", |v| {
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
        {"actor_id":actor,"session_id":session}, {"actor_id":peer.actor.as_ref().unwrap().id,"session_id":peer.session.id}
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
        .post(format!("{}/api/sessions", kernel.url))
        .bearer_auth(&peer.token)
        .json(&json!({"harness":"claude-code","name":"Denied","workspace":workspace}))
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
        .api(&format!("/sessions/{session}/stop"), Some(json!({})))
        .await;
    assert_eq!(stopped["session"]["status"], "stopped");
    assert!(
        stopped["session"]["attention_reason"].is_null(),
        "Owned Stop confirms native exit: {stopped}"
    );
    assert_eq!(count(&fixture.trace(), "close"), 1);
    std::fs::remove_file(workspace.join("legacy-description")).unwrap();
    // Exercise an existing bootstrap session's old lease format during explicit Resume.
    let lease = fixture
        .dir
        .path()
        .join(format!("links/claude/{}.lock", native.as_str().unwrap()));
    let record: Value = serde_json::from_slice(&std::fs::read(&lease).unwrap()).unwrap();
    tokio::time::timeout(Duration::from_secs(60), async {
        while kill(Pid::from_raw(pid), None) != Err(nix::errno::Errno::ESRCH) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    std::fs::write(
        &lease,
        serde_json::to_vec(&json!({"pid":pid,"instance_id":record["instanceId"]})).unwrap(),
    )
    .unwrap();
    let resumed = kernel
        .api(&format!("/sessions/{session}/resume"), Some(json!({})))
        .await;
    assert_eq!(resumed["session"]["native_session_id"], native);
    assert_eq!(resumed["actor"]["id"], actor);
    assert_eq!(
        resumed["session"]["id"], session,
        "Resume continues the same session"
    );
    let trace = fixture.wait_trace(|rows| count(rows, "start") == 2).await;
    let last = trace.iter().rev().find(|v| v["event"] == "start").unwrap();
    assert_eq!(last["mode"], "plan");
    assert_eq!(last["resume"], true);
    assert_eq!(
        count(&trace, "input"),
        2,
        "Resume does not replay consumed input"
    );
    let next = resumed["session"]["id"].as_str().unwrap();
    // Crash the fixture host AND its child, then resume their saved native identity.
    let record: Value = serde_json::from_slice(&std::fs::read(&lease).unwrap()).unwrap();
    let host_pid = last["pid"].as_i64().unwrap() as i32;
    let child_pid = record["nativePid"].as_i64().unwrap() as i32;
    killpg(Pid::from_raw(host_pid), Signal::SIGKILL).unwrap();
    tokio::time::timeout(Duration::from_secs(60), async {
        while [host_pid, child_pid]
            .iter()
            .any(|pid| kill(Pid::from_raw(*pid), None) != Err(nix::errno::Errno::ESRCH))
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    kernel.shutdown().await;
    let kernel = Kernel::start(&fixture, port).await;
    let sessions = kernel
        .wait("/sessions", |v| {
            v["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["native_session_id"] == native && s["status"] == "connected")
        })
        .await;
    let restored = sessions["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["native_session_id"] == native && s["status"] == "connected")
        .unwrap();
    assert_eq!(restored["actor_id"], actor);
    assert_eq!(
        restored["id"], next,
        "a restored crash continues the same session"
    );
    let restored = restored["id"].as_str().unwrap();
    let trace = fixture.wait_trace(|rows| count(rows, "start") == 3).await;
    let start = trace.iter().rev().find(|v| v["event"] == "start").unwrap();
    assert_eq!(start["resume"], true);
    assert_eq!(start["mode"], "plan");
    assert_eq!(start["model"], "native-default");
    assert_eq!(start["effort"], "high");
    assert_eq!(count(&trace, "input"), 2);
    let stopped = kernel
        .api(&format!("/sessions/{restored}/stop"), Some(json!({})))
        .await;
    assert!(stopped["session"]["attention_reason"].is_null());
    kernel.shutdown().await;
    let kernel = Kernel::start(&fixture, port).await;
    assert_eq!(
        count(&fixture.trace(), "start"),
        3,
        "Stop remains stopped after restart"
    );
    kernel.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_native_crash_is_restored_without_replay_or_duplicate_processes() {
    let fixture = Fixture::new();
    let kernel = Kernel::start(&fixture, 0).await;
    let created = kernel.api("/sessions", Some(json!({"harness":"claude-code",
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
    let record: Value = serde_json::from_slice(
        &std::fs::read(
            fixture
                .dir
                .path()
                .join(format!("links/claude/{}.lock", native.as_str().unwrap())),
        )
        .unwrap(),
    )
    .unwrap();
    let pid = record["nativePid"].as_i64().unwrap() as i32;
    // Kill ONLY this fixture's native child.
    kill(Pid::from_raw(pid), Signal::SIGKILL).unwrap();
    kernel
        .wait("/sessions", |v| {
            v["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["id"] == session && s["status"] == "attention")
        })
        .await;
    // Starting the kernel alone restores the same saved native session.
    kernel.shutdown().await;
    let kernel = Kernel::start(&fixture, 0).await;
    let sessions = kernel
        .wait("/sessions", |v| {
            v["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| &s["native_session_id"] == native && s["status"] == "connected")
        })
        .await;
    let resumed = sessions["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| &s["native_session_id"] == native && s["status"] == "connected")
        .unwrap();
    assert_eq!(resumed["actor_id"], actor);
    let trace = fixture.wait_trace(|rows| count(rows, "start") == 2).await;
    let start = trace
        .iter()
        .rev()
        .find(|row| row["event"] == "start")
        .unwrap();
    assert_eq!(start["mode"], "acceptEdits");
    assert_eq!(start["resume"], true);
    let next = resumed["id"].as_str().unwrap();
    kernel.runtime.as_ref().unwrap().reconnect().await.unwrap();
    assert_eq!(count(&fixture.trace(), "start"), 2);
    let history = kernel.api(&messages, None).await;
    let waiting = history["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == waiting_id)
        .unwrap();
    // The successor may answer prior input, but must never dispatch it again.
    assert_eq!(waiting["deliveries"][0]["session_id"], next);
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
        .api(&format!("/sessions/{next}/stop"), Some(json!({})))
        .await;
    assert!(stopped["session"]["attention_reason"].is_null());
    kernel.shutdown().await;
    let kernel = Kernel::start(&fixture, 0).await;
    kernel.runtime.as_ref().unwrap().reconnect().await.unwrap();
    assert_eq!(
        count(&fixture.trace(), "start"),
        2,
        "Owner Stop forbids automatic restoration"
    );
    let sessions = kernel.api("/sessions", None).await;
    assert!(
        sessions["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| &s["native_session_id"] == native)
            .all(|s| s["status"] == "stopped")
    );
    kernel.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dead_host_and_free_lease_do_not_confirm_stop_of_its_live_native_child() {
    let fixture = Fixture::new();
    let workspace = fixture.dir.path().join("workspace");
    std::fs::write(workspace.join("keep-native"), "fixture").unwrap();
    let kernel = Kernel::start(&fixture, 0).await;
    let created = kernel
        .api(
            "/sessions",
            Some(json!({"harness":"claude-code",
                "name":"Orphan fixture", "workspace":workspace, "permission_mode":"default"
            })),
        )
        .await;
    let session = created["session"]["id"].as_str().unwrap();
    let native_pid: i32 = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if let Ok(text) = std::fs::read_to_string(workspace.join("native-ready"))
                && let Ok(pid) = text.parse()
            {
                break pid;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let host_pid = fixture
        .trace()
        .iter()
        .find(|row| row["event"] == "start")
        .unwrap()["pid"]
        .as_i64()
        .unwrap() as i32;
    // Kill ONLY this fake helper, not its group. The fixture child ignores EOF.
    kill(Pid::from_raw(host_pid), Signal::SIGKILL).unwrap();
    tokio::time::timeout(Duration::from_secs(60), async {
        while kill(Pid::from_raw(host_pid), None) != Err(nix::errno::Errno::ESRCH) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(kill(Pid::from_raw(native_pid), None).is_ok());
    kernel.shutdown().await;
    let kernel = Kernel::start(&fixture, 0).await; // No tracked adapter; cold restore must refuse.
    assert_eq!(count(&fixture.trace(), "start"), 1);
    assert!(kill(Pid::from_raw(native_pid), None).is_ok());
    let response = kernel
        .client
        .post(format!("{}/api/sessions/{session}/stop", kernel.url))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let state = kernel.api("/sessions", None).await;
    let stopped = state["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == session)
        .unwrap();
    assert!(
        kill(Pid::from_raw(native_pid), None).is_ok(),
        "The orphan must remain untouched"
    );
    assert_eq!(count(&fixture.trace(), "start"), 1);
    kernel.shutdown().await;
    // Fixture Drop closes only the detached process group this fixture created.
    assert_eq!(
        status,
        StatusCode::SERVICE_UNAVAILABLE,
        "Native cancellation is uncertain"
    );
    assert_eq!(stopped["status"], "stopped", "Owner Stop remains durable");
    assert!(
        stopped["attention_reason"]
            .as_str()
            .unwrap()
            .contains("Native cancellation was not confirmed")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_explicit_sdk_executable_must_be_an_absolute_existing_file_before_any_spawn() {
    // The desktop names the installed Claude Code explicitly. A missing or relative path is
    // refused before Bun or the runner start, so nothing is launched and nothing is leased.
    for executable in [
        PathBuf::from("/tmp/zerolux-fixture-no-such-claude"),
        PathBuf::from("claude"),
    ] {
        let mut fixture = Fixture::new();
        fixture.program.sdk_executable = Some(executable);
        let kernel = Kernel::start(&fixture, 0).await;
        let workspace = fixture.dir.path().join("workspace");
        let response = kernel
            .client
            .post(format!("{}/api/sessions", kernel.url))
            .json(
                &json!({"harness":"claude-code","name":"Fixture Claude", "workspace":workspace, "permission_mode":"plan"}),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        // No runner trace: the refusal happened before the spawn. The session the owner asked
        // for is recorded as needing attention, never as connected.
        assert!(fixture.trace().is_empty());
        let sessions = kernel.api("/sessions", None).await;
        let sessions = sessions["sessions"].as_array().unwrap();
        assert!(
            sessions.iter().all(|s| s["status"] == "attention"
                && s["origin"] == "owned"
                && s["activity"].is_null()),
            "{sessions:?}"
        );
        kernel.shutdown().await;
    }
}
