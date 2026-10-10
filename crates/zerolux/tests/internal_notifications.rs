#![cfg(unix)]
//! Native adapters must not need a WebRTC connection to their own kernel.
use serde_json::{Value, json};
use std::sync::Arc;
use zerolux::{
    api,
    chat_runtime::ChatRuntime,
    codex::CodexDriver,
    harness::Harness,
    livekit::{LiveKit, LiveKitConfig},
    model::*,
    store::Store,
};

#[allow(dead_code)]
#[path = "support/codex_runtime.rs"]
mod native;

#[tokio::test(flavor = "multi_thread")]
async fn native_backlog_and_later_messages_arrive_when_livekit_is_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("chat.db")).await.unwrap();
    store
        .set_owner_name(SetOwnerName {
            name: "Fixture owner".into(),
        })
        .await
        .unwrap();
    let owner = store.chat_identity(None).await.unwrap();
    let unavailable = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let unavailable_url = format!("ws://{}", unavailable.local_addr().unwrap());
    let requested = Arc::new(tokio::sync::Notify::new());
    let reached = requested.clone();
    let (release, waiting) = tokio::sync::watch::channel(false);
    let unavailable_task = tokio::spawn(async move {
        axum::serve(
            unavailable,
            axum::Router::new().fallback(move || {
                let requested = reached.clone();
                let mut waiting = waiting.clone();
                async move {
                    requested.notify_one();
                    let _ = waiting.wait_for(|ready| *ready).await;
                    axum::http::StatusCode::SERVICE_UNAVAILABLE
                }
            }),
        )
        .await
        .unwrap();
    });
    let livekit = Arc::new(
        LiveKit::start(LiveKitConfig {
            url: Some(unavailable_url),
            api_key: Some("fixture".into()),
            api_secret: Some("fixture-not-a-secret".into()),
            data_dir: dir.path().join("livekit"),
        })
        .await
        .unwrap(),
    );
    let http = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", http.local_addr().unwrap());
    let runtime = ChatRuntime::start(
        store.clone(),
        livekit,
        base.clone(),
        dir.path().join("links"),
    )
    .await
    .unwrap();
    let app = api::router_with_runtime(store.clone(), dir.path().join("web"), runtime.clone());
    let serving = tokio::spawn(async move {
        axum::serve(
            http,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let harness = native::Runtime::new_in(dir.path()).await;
    let issued = store
        .hire_chat_session(
            &owner,
            HireChatSession {
                name: "Fixture agent".into(),
                actor_id: None,
                harness: Harness::Codex,
                native_session_id: native::THREAD.into(),
                title: "Fixture".into(),
                workspace: dir.path().to_string_lossy().into_owned(),
                native_locator: json!({}),
                resume: false,
            },
        )
        .await
        .unwrap();
    let mut chats = Vec::new();
    for title in ["Backlog", "After connection"] {
        chats.push(
            store
                .create_conversation(
                    &owner,
                    CreateConversation {
                        kind: "group".into(),
                        title: title.into(),
                        members: vec![ConversationMemberInput {
                            actor_id: issued.actor.id.clone(),
                            session_id: Some(issued.session.id.clone()),
                        }],
                    },
                )
                .await
                .unwrap(),
        );
    }
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let post = |chat: String, text: &'static str| {
        let client = client.clone();
        let base = base.clone();
        async move {
            client
                .post(format!("{base}/api/conversations/{chat}/messages"))
                .json(&json!({"id":uuid::Uuid::new_v4().to_string(),"text":text}))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()
        }
    };
    post(chats[0].id.clone(), "before native adapter starts").await;
    // The publisher is blocked in LiveKit I/O, not merely between retries.
    tokio::time::timeout(std::time::Duration::from_secs(3), requested.notified())
        .await
        .unwrap();
    let driver = CodexDriver::attach(&harness.endpoint, native::THREAD)
        .await
        .unwrap();
    runtime
        .connect_codex(driver, &issued.session, issued.token)
        .await
        .unwrap();
    eprintln!("waiting for initial backlog");
    harness.wait(|state| state.queue.len() == 1).await;
    // Codex deliberately queues only one opener until a native turn starts.
    harness.emit(json!({"method":"turn/started","params":{"threadId":native::THREAD,"turn":{"id":"fixture-turn"}}}));
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let sessions = store.chat_sessions(&owner).await.unwrap();
            if sessions
                .iter()
                .any(|s| s.id == issued.session.id && s.activity.as_deref() == Some("working"))
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    post(chats[1].id.clone(), "after native adapter starts").await;
    harness
        .wait(|state| state.requests.iter().any(|r| r["method"] == "turn/steer"))
        .await;
    assert_eq!(harness.count("thread/queue/add"), 1);
    assert_eq!(harness.count("turn/steer"), 1);
    let requests = serde_json::to_string(&harness.state.lock().unwrap().requests).unwrap();
    assert!(requests.contains("before native adapter starts"));
    assert!(requests.contains("after native adapter starts"));
    // Shutdown releases kernel links without cancelling the fake native work.
    release.send_replace(true);
    runtime.shutdown().await.unwrap();
    assert_eq!(harness.count("turn/interrupt"), 0);
    assert_eq!(harness.count("thread/queue/delete"), 0);
    serving.abort();
    unavailable_task.abort();
}
