#![cfg(unix)]
//! One test, its own process: it points CODEX_HOME and PATH at fixtures. A Codex session
//! ZeroLux held is continued after a kernel restart, by the same thread, even when the Codex
//! runtime lost it; a Stop by the owner ends that.
use std::{os::unix::fs::PermissionsExt, sync::Arc, time::Duration};

use serde_json::json;
use zerolux::{
    api,
    chat_runtime::ChatRuntime,
    livekit::{LiveKit, LiveKitConfig},
    model::{
        ConversationMemberInput, CreateCodexSession, CreateConversation, HireChatSession,
        SendChatMessage, SetOwnerName,
    },
    store::Store,
};

/// A kernel over HTTP, as the Codex driver needs one to read its inbox: the runtime learns
/// its own address before serving. `port` 0 the first time; the same port on a restart.
async fn kernel(
    store: &Store,
    livekit: &Arc<LiveKit>,
    links: std::path::PathBuf,
    port: u16,
) -> (Arc<ChatRuntime>, tokio::task::JoinHandle<()>, u16) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let runtime = ChatRuntime::start(
        store.clone(),
        livekit.clone(),
        format!("http://127.0.0.1:{port}"),
        links,
    )
    .await
    .unwrap();
    let app = api::router_with_runtime(store.clone(), std::env::temp_dir(), runtime.clone());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    (runtime, server, port)
}

// The shared fixture offers more than this one test uses.
#[allow(dead_code)]
#[path = "support/codex_runtime.rs"]
mod codex_runtime;
use codex_runtime::{Runtime, STARTED, THREAD};

fn installed() -> bool {
    std::process::Command::new("livekit-server")
        .arg("--version")
        .output()
        .is_ok()
}

async fn wait_for(store: &Store, predicate: impl Fn(&[zerolux::model::ChatSession]) -> bool) {
    let owner = store.chat_identity(None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if predicate(&store.chat_sessions(&owner).await.unwrap()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("expected session state");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_codex_session_zerolux_held_is_continued_after_a_restart_by_the_same_thread() {
    if !installed() {
        eprintln!("livekit-server not installed: skipped");
        return;
    }
    // Short paths: a Unix socket path is limited to about 100 bytes on macOS.
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let workspace = dir.path().join("work");
    std::fs::create_dir_all(&workspace).unwrap();
    // As ZeroLux records it: canonical (`/tmp` is a link on macOS).
    let workspace = std::fs::canonicalize(&workspace).unwrap();
    // The fixture runtime stands in for the Codex daemon, at the control socket Codex uses.
    let runtime = Runtime::new_in(&workspace).await;
    let socket = runtime.endpoint.trim_start_matches("unix://").to_owned();
    let codex_home = dir.path().join("codex");
    std::fs::create_dir_all(codex_home.join("app-server-control")).unwrap();
    std::os::unix::fs::symlink(
        &socket,
        codex_home.join("app-server-control/app-server-control.sock"),
    )
    .unwrap();
    // No real harness: `claude` lists nothing, `codex` must never be asked to start a daemon.
    let bin = dir.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("claude"), "#!/bin/sh\nprintf '[]\\n'\n").unwrap();
    std::fs::write(bin.join("codex"), "#!/bin/sh\nexit 7\n").unwrap();
    for name in ["claude", "codex"] {
        std::fs::set_permissions(bin.join(name), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let path = std::env::join_paths(std::iter::once(bin).chain(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    )))
    .unwrap();
    // SAFETY: this test binary holds one test; nothing else reads the variables concurrently.
    unsafe {
        std::env::set_var("CODEX_HOME", &codex_home);
        std::env::set_var("CLAUDE_CONFIG_DIR", dir.path().join("claude"));
        std::env::set_var("PI_CODING_AGENT_DIR", dir.path().join("pi"));
        std::env::set_var("PATH", path);
    }
    let store = Store::open(&dir.path().join("chat.db")).await.unwrap();
    store
        .set_owner_name(SetOwnerName {
            name: "Owner".into(),
        })
        .await
        .unwrap();
    let owner = store.chat_identity(None).await.unwrap();
    let livekit = Arc::new(
        LiveKit::start(LiveKitConfig {
            url: None,
            api_key: None,
            api_secret: None,
            data_dir: dir.path().join("livekit"),
        })
        .await
        .unwrap(),
    );
    let (chat_runtime, server, port) = kernel(&store, &livekit, dir.path().join("links"), 0).await;

    // Hired while live: the ordinary path, no cold resume.
    let discovered = zerolux::sessions::discover_sessions().await;
    let candidate = discovered
        .sessions
        .iter()
        .find(|s| s.harness == zerolux::harness::Harness::Codex && s.availability == "attachable")
        .unwrap_or_else(|| {
            panic!(
                "fixture thread discovered as attachable: {:?}",
                discovered
                    .sessions
                    .iter()
                    .map(|s| (s.harness, s.availability.clone(), s.reason.clone()))
                    .collect::<Vec<_>>()
            )
        });
    let (actor, first) = chat_runtime
        .hire(&owner, &candidate.id, "cedar", None)
        .await
        .unwrap();
    wait_for(&store, |sessions| {
        sessions
            .iter()
            .any(|s| s.id == first.id && s.status == "connected")
    })
    .await;
    assert_eq!(runtime.count("thread/resume"), 1);
    let cold_resumes = |runtime: &Runtime| {
        runtime
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|r| r["method"] == "thread/resume" && r["params"]["excludeTurns"] == true)
            .count()
    };
    assert_eq!(cold_resumes(&runtime), 0);

    let actor = actor.id;
    // The owner's chat with the agent; what is sent there is the agent's input.
    let dm = store
        .create_conversation(
            &owner,
            CreateConversation {
                kind: "dm".into(),
                title: "cedar".into(),
                members: vec![ConversationMemberInput {
                    actor_id: actor.clone(),
                    session_id: Some(first.id.clone()),
                }],
            },
        )
        .await
        .unwrap();
    let send = |text: &str| {
        let store = store.clone();
        let owner = owner.clone();
        let dm = dm.id.clone();
        let text = text.to_owned();
        async move {
            store
                .send_chat_message(
                    &owner,
                    &dm,
                    SendChatMessage {
                        id: uuid::Uuid::new_v4().to_string(),
                        text,
                        reply_to_delivery_id: None,
                    },
                )
                .await
                .unwrap()
        }
    };
    let queued = |runtime: &Runtime| -> Vec<String> {
        runtime
            .state
            .lock()
            .unwrap()
            .queue
            .iter()
            .map(|q| q["input"].to_string())
            .collect()
    };

    // The kernel stops; a message arrives for the agent meanwhile, stored and never
    // attempted. The Codex runtime loses the thread too (its daemon came back, or the
    // machine crashed). The next kernel continues the session, by the same thread, once,
    // and delivers that message then: stored work is dispatched, never replayed.
    chat_runtime.shutdown().await.unwrap();
    server.abort();
    let _ = server.await;
    send("Stored while the kernel was down.").await;
    runtime.state.lock().unwrap().unloaded = true;
    let (chat_runtime, server, _) = kernel(&store, &livekit, dir.path().join("links"), port).await;
    chat_runtime.reconnect().await.unwrap();
    wait_for(&store, |sessions| {
        sessions.iter().any(|s| {
            s.native_session_id == THREAD && s.stopped_at.is_none() && s.status == "connected"
        })
    })
    .await;
    assert_eq!(
        cold_resumes(&runtime),
        1,
        "one cold resume, by the same thread"
    );
    assert!(!runtime.state.lock().unwrap().unloaded);
    let live: Vec<_> = store
        .chat_sessions(&owner)
        .await
        .unwrap()
        .into_iter()
        .filter(|s| s.stopped_at.is_none())
        .collect();
    assert_eq!(live.len(), 1, "one live link, never two");
    assert_eq!(live[0].native_session_id, THREAD);
    runtime.wait(|s| s.queue.len() == 1).await;
    assert!(queued(&runtime)[0].contains("Stored while the kernel was down."));
    assert_eq!(runtime.count("turn/start"), 0);
    // Another pass changes nothing: a connected session is not resumed again.
    chat_runtime.reconnect().await.unwrap();
    assert_eq!(cold_resumes(&runtime), 1);
    assert_eq!(runtime.count("thread/queue/add"), 1);

    // Stopped by the owner, as the API does it: the store records the decision, the runtime
    // ends the link. The next kernel leaves it stopped, thread unloaded.
    let current = live[0].id.clone();
    store.stop_chat_session(&owner, &current).await.unwrap();
    chat_runtime.stop_session(&current).await.unwrap();
    chat_runtime.shutdown().await.unwrap();
    server.abort();
    let _ = server.await;
    runtime.state.lock().unwrap().unloaded = true;
    let (chat_runtime, server, _) = kernel(&store, &livekit, dir.path().join("links"), port).await;
    chat_runtime.reconnect().await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        cold_resumes(&runtime),
        1,
        "a stopped session is not resumed"
    );
    assert!(runtime.state.lock().unwrap().unloaded);
    assert!(
        store
            .chat_sessions(&owner)
            .await
            .unwrap()
            .iter()
            .all(|s| s.stopped_at.is_some())
    );

    // Hired again while live, by the same actor. Then an input whose native acknowledgement
    // is lost: ZeroLux cannot know whether Codex took it. The next kernel continues the
    // session and reconciles that input from Codex's own queue; it is never resent.
    runtime.state.lock().unwrap().unloaded = false;
    let (_, second) = chat_runtime
        .hire(&owner, &candidate.id, "cedar", Some(actor.clone()))
        .await
        .unwrap();
    wait_for(&store, |sessions| {
        sessions
            .iter()
            .any(|s| s.id == second.id && s.status == "connected")
    })
    .await;
    runtime.state.lock().unwrap().drop_queue_ack = true;
    send("Uncertain: the acknowledgement is lost.").await;
    chat_runtime.changed();
    wait_for(&store, |sessions| {
        sessions
            .iter()
            .any(|s| s.id == second.id && s.status == "attention")
    })
    .await;
    assert_eq!(runtime.count("thread/queue/add"), 2);
    let uncertain = |store: &Store| {
        let store = store.clone();
        let owner = owner.clone();
        let dm = dm.id.clone();
        async move {
            store
                .chat_messages(&owner, &dm, 0, 100)
                .await
                .unwrap()
                .messages
                .into_iter()
                .filter(|m| m.text.starts_with("Uncertain"))
                .flat_map(|m| m.deliveries)
                .map(|d| d.status)
                .collect::<Vec<_>>()
        }
    };
    assert_eq!(uncertain(&store).await, ["uncertain"]);
    runtime.state.lock().unwrap().drop_queue_ack = false;
    chat_runtime.shutdown().await.unwrap();
    server.abort();
    let _ = server.await;
    runtime.state.lock().unwrap().unloaded = true;
    let (chat_runtime, server, _) = kernel(&store, &livekit, dir.path().join("links"), port).await;
    chat_runtime.reconnect().await.unwrap();
    wait_for(&store, |sessions| {
        sessions.iter().any(|s| {
            s.native_session_id == THREAD && s.stopped_at.is_none() && s.status == "connected"
        })
    })
    .await;
    assert_eq!(cold_resumes(&runtime), 2);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        runtime.count("thread/queue/add"),
        2,
        "uncertain input is not resent"
    );
    // Found in Codex's own queue after the resume: confirmed from there, not resent.
    assert_eq!(uncertain(&store).await, ["notified"]);

    // Codex asks for permission twice in the turn that took that input. The owner decides
    // one while the kernel is down; the other is still pending. Those requests belong to a
    // Codex runtime that is gone: the next kernel resolves both without answering anything,
    // and the decision is kept on record, never sent to a request it was not asked for.
    let delivery = store
        .chat_messages(&owner, &dm.id, 0, 100)
        .await
        .unwrap()
        .messages
        .into_iter()
        .find(|m| m.text.starts_with("Uncertain"))
        .unwrap()
        .deliveries[0]
        .id
        .clone();
    let item = |item: serde_json::Value| json!({"method":"item/completed","params":{"threadId":THREAD,"turnId":"ours","item":item}});
    runtime.emit(item(json!({"type":"userMessage","id":"input","clientId":delivery,"content":[{"type":"text","text":"fixture"}]})));
    runtime.emit(item(json!({"type":"commandExecution","id":"tool","command":"fixture-command","cwd":workspace.to_str().unwrap(),"status":"inProgress"})));
    let request = |id: u64| json!({"id":id,"method":"item/commandExecution/requestApproval","params":{"threadId":THREAD,"turnId":"ours","itemId":"tool","command":"fixture-command","availableDecisions":["accept","decline"],"startedAtMs":1}});
    runtime.emit(request(900));
    runtime.emit(request(901));
    tokio::time::timeout(Duration::from_secs(20), async {
        while store.chat_approvals(&owner).await.unwrap().len() < 2 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("two pending approvals");
    chat_runtime.shutdown().await.unwrap();
    server.abort();
    let _ = server.await;
    let approvals = store.chat_approvals(&owner).await.unwrap();
    assert!(approvals.iter().all(|a| a.status == "pending"));
    let decided = approvals
        .iter()
        .find(|a| a.native_request_id.ends_with(":900"))
        .unwrap()
        .id
        .clone();
    store
        .decide_chat_approval(&owner, &decided, "allow")
        .await
        .unwrap();
    runtime.state.lock().unwrap().unloaded = true;
    let (chat_runtime, server, _) = kernel(&store, &livekit, dir.path().join("links"), port).await;
    chat_runtime.reconnect().await.unwrap();
    wait_for(&store, |sessions| {
        sessions.iter().any(|s| {
            s.native_session_id == THREAD && s.stopped_at.is_none() && s.status == "connected"
        })
    })
    .await;
    assert_eq!(cold_resumes(&runtime), 3);
    tokio::time::timeout(Duration::from_secs(20), async {
        while !store
            .chat_approvals(&owner)
            .await
            .unwrap()
            .iter()
            .all(|a| a.status == "resolved")
        {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("approvals of the lost runtime resolved");
    let approvals = store.chat_approvals(&owner).await.unwrap();
    assert_eq!(approvals.len(), 2);
    assert_eq!(
        approvals
            .iter()
            .find(|a| a.id == decided)
            .unwrap()
            .decision
            .as_deref(),
        Some("allow"),
        "the owner's decision stays on record"
    );
    assert!(
        !runtime.state.lock().unwrap().requests.iter().any(|r| {
            (r["id"] == 900 || r["id"] == 901)
                && (r.get("result").is_some() || r.get("error").is_some())
        }),
        "no decision is answered to a request of a runtime that is gone"
    );
    assert_eq!(runtime.count("thread/queue/add"), 2);
    assert_eq!(runtime.count("turn/start"), 0);

    // A session started by ZeroLux: everything is checked before the one thread/start, no
    // prompt follows, and it is a session like a hired one, restored the same way.
    assert_eq!(runtime.count("thread/start"), 0);
    let create = |workspace: &str, actor_id: Option<String>| CreateCodexSession {
        name: "cedar".into(),
        actor_id,
        workspace: workspace.into(),
        approval_policy: None,
        sandbox: None,
    };
    for (invalid, actor_id) in [
        ("work", None),
        (dir.path().join("missing").to_str().unwrap(), None),
        (workspace.to_str().unwrap(), Some("not-an-actor".to_owned())),
    ] {
        assert!(
            chat_runtime
                .create_codex(&owner, create(invalid, actor_id))
                .await
                .is_err()
        );
    }
    // Over HTTP the same: an invalid body, or anyone but the owner, is refused before Codex
    // is asked anything.
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{port}/api/chat/codex-sessions");
    for body in [
        json!({"name":"cedar","workspace":"relative"}),
        json!({"name":"cedar","workspace":workspace,"approval_policy":"yolo"}),
        json!({"name":"cedar","workspace":workspace,"sandbox":"full"}),
    ] {
        let response = client.post(&url).json(&body).send().await.unwrap();
        assert_eq!(
            response.status(),
            reqwest::StatusCode::BAD_REQUEST,
            "{body}"
        );
    }
    let peer = store
        .hire_chat_session(
            &owner,
            HireChatSession {
                name: "Fixture peer".into(),
                actor_id: None,
                harness: zerolux::harness::Harness::Pi,
                native_session_id: "fixture-peer".into(),
                title: "Peer".into(),
                workspace: workspace.to_string_lossy().into_owned(),
                native_locator: json!({}),
                resume: false,
            },
        )
        .await
        .unwrap();
    let response = client
        .post(&url)
        .bearer_auth(&peer.token)
        .json(&json!({"name":"cedar","workspace":workspace}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
    store
        .stop_chat_session(&owner, &peer.session.id)
        .await
        .unwrap();
    assert_eq!(
        runtime.count("thread/start"),
        0,
        "nothing native before validation"
    );
    // Codex started a thread but its answer was lost: the owner is told it is uncertain,
    // and ZeroLux does not start another.
    runtime.state.lock().unwrap().drop_start_ack = true;
    let response = client
        .post(&url)
        .json(&json!({"name":"cedar","workspace":workspace}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::BAD_GATEWAY);
    let body: serde_json::Value = response.json().await.unwrap();
    assert!(
        body["error"].as_str().unwrap().contains("uncertain"),
        "{body}"
    );
    assert!(body["thread_id"].is_null());
    assert_eq!(runtime.count("thread/start"), 1, "never a second start");
    runtime.state.lock().unwrap().drop_start_ack = false;
    // Codex answered with a thread ZeroLux cannot link (here: in another folder): the owner
    // is told which thread, and it is neither discarded nor started again.
    let other = dir.path().join("other");
    std::fs::create_dir_all(&other).unwrap();
    let response = client
        .post(&url)
        .json(&json!({"name":"cedar","workspace":other}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::BAD_GATEWAY);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["thread_id"], STARTED, "{body}");
    assert!(body["error"].as_str().unwrap().contains(STARTED), "{body}");
    assert_eq!(runtime.count("thread/start"), 2);
    assert!(
        store
            .chat_sessions(&owner)
            .await
            .unwrap()
            .iter()
            .all(|s| s.native_session_id != STARTED),
        "no session row for a thread that was not linked"
    );
    let (_, created) = chat_runtime
        .create_codex(
            &owner,
            create(workspace.to_str().unwrap(), Some(actor.clone())),
        )
        .await
        .unwrap();
    assert_eq!(created.native_session_id, STARTED);
    assert_eq!(created.harness, "codex");
    wait_for(&store, |sessions| {
        sessions
            .iter()
            .any(|s| s.id == created.id && s.status == "connected")
    })
    .await;
    assert_eq!(runtime.count("thread/start"), 3, "one start per creation");
    assert_eq!(runtime.count("turn/start"), 0);
    assert_eq!(runtime.count("thread/queue/add"), 2);
    // Lost with the rest and continued by the same thread, with the hired one.
    chat_runtime.shutdown().await.unwrap();
    server.abort();
    let _ = server.await;
    runtime.state.lock().unwrap().unloaded = true;
    let (chat_runtime, server, _) = kernel(&store, &livekit, dir.path().join("links"), port).await;
    chat_runtime.reconnect().await.unwrap();
    wait_for(&store, |sessions| {
        let live: Vec<_> = sessions
            .iter()
            .filter(|s| s.stopped_at.is_none() && s.harness == "codex")
            .collect();
        live.len() == 2 && live.iter().all(|s| s.status == "connected")
    })
    .await;
    assert_eq!(cold_resumes(&runtime), 5);
    assert_eq!(
        runtime.count("thread/start"),
        3,
        "recovery never starts a thread"
    );
    chat_runtime.shutdown().await.unwrap();
    server.abort();
    livekit.shutdown().await.unwrap();
}
