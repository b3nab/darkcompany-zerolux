//! Tasks: a session runs a command in the background, reads its output while it runs, and the
//! task ends on its own or is stopped. Its session's harness is not linked here, so telling
//! it how the task ended is recorded as not delivered.
use std::{sync::Arc, time::Duration};

use reqwest::{Client, Method, StatusCode};
use serde_json::{Value, json};
use zerolux::{
    api,
    chat_runtime::ChatRuntime,
    harness::Harness,
    livekit::{LiveKit, LiveKitConfig},
    model::{HireChatSession, SetOwnerName},
};

#[path = "support/db.rs"]
mod db;

async fn call(
    client: &Client,
    url: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = client.request(method, format!("{url}/api{path}"));
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.unwrap();
    let status = response.status();
    (status, response.json().await.unwrap_or(Value::Null))
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_runs_commands_in_the_background_and_reads_how_they_end() {
    if std::process::Command::new("livekit-server")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("livekit-server not installed: skipped");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let folder = dunce::canonicalize(dir.path()).unwrap();
    let database = db::TestDatabase::new(dir.path().join("kernel.db")).await;
    let store = database.open().await;
    store
        .set_owner_name(SetOwnerName {
            name: "Owner".into(),
        })
        .await
        .unwrap();
    let owner = store.chat_identity(None).await.unwrap();
    let issued = store
        .hire_chat_session(
            &owner,
            HireChatSession {
                name: "Worker".into(),
                actor_id: None,
                harness: Harness::Pi,
                native_session_id: uuid::Uuid::new_v4().to_string(),
                title: "Worker".into(),
                workspace: folder.to_string_lossy().into_owned(),
                native_locator: json!({}),
                resume: false,
            },
        )
        .await
        .unwrap();
    let session = issued.session.id.clone();
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
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let runtime = ChatRuntime::start(
        store.clone(),
        livekit.clone(),
        url.clone(),
        dir.path().join("links"),
    )
    .await
    .unwrap();
    let watcher = tokio::spawn(zerolux::chat_runtime::tasks::watch(Arc::downgrade(
        &runtime,
    )));
    let app = api::router_with_runtime(store.clone(), dir.path().join("web"), runtime.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let client = Client::builder().no_proxy().build().unwrap();

    // A command that prints, waits, and fails, in the session's folder.
    let command = if cfg!(windows) {
        "echo one & ping -n 2 127.0.0.1 > nul & echo two & exit 3"
    } else {
        "pwd; echo one; sleep 1; echo two; exit 3"
    };
    let (status, started) = call(
        &client,
        &url,
        Method::POST,
        &format!("/sessions/{session}/tasks"),
        Some(json!({ "command": command })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{started}");
    let task = started["task"]["id"].as_str().unwrap().to_owned();
    assert_eq!(started["task"]["status"], "running");

    let mut ended = Value::Null;
    for _ in 0..100 {
        let (_, read) = call(&client, &url, Method::GET, &format!("/tasks/{task}"), None).await;
        if read["task"]["status"] != "running" {
            ended = read;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(ended["task"]["status"], "exited", "{ended}");
    assert_eq!(ended["task"]["exit_code"], 3);
    let text = ended["output"]["text"].as_str().unwrap();
    assert!(text.contains("one") && text.contains("two"), "{text}");
    if cfg!(unix) {
        assert!(text.contains(&*folder.to_string_lossy()), "{text}");
    }
    // Read from an offset.
    let next = ended["output"]["next"].as_u64().unwrap();
    let (_, after) = call(
        &client,
        &url,
        Method::GET,
        &format!("/tasks/{task}?after={next}"),
        None,
    )
    .await;
    assert_eq!(after["output"]["text"], "");
    // Its harness is not linked here: telling it is recorded as not delivered.
    for _ in 0..50 {
        let (_, read) = call(&client, &url, Method::GET, &format!("/tasks/{task}"), None).await;
        if read["task"]["error"].is_string() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let (_, listed) = call(
        &client,
        &url,
        Method::GET,
        &format!("/sessions/{session}/tasks"),
        None,
    )
    .await;
    assert_eq!(listed["tasks"][0]["id"], task);
    assert!(listed["tasks"][0]["error"].is_string());

    // A long task is stopped, with what it started.
    let long = if cfg!(windows) {
        "ping -n 60 127.0.0.1"
    } else {
        "sleep 60"
    };
    let (_, started) = call(
        &client,
        &url,
        Method::POST,
        &format!("/sessions/{session}/tasks"),
        Some(json!({ "command": long })),
    )
    .await;
    let long = started["task"]["id"].as_str().unwrap().to_owned();
    let (status, stopped) = call(
        &client,
        &url,
        Method::POST,
        &format!("/tasks/{long}/stop"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{stopped}");
    assert_eq!(stopped["task"]["status"], "stopped");
    let (status, _) = call(
        &client,
        &url,
        Method::POST,
        &format!("/tasks/{long}/stop"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(
        &client,
        &url,
        Method::POST,
        &format!("/sessions/{session}/tasks"),
        Some(json!({ "command": "  " })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    watcher.abort();
    runtime.shutdown().await.unwrap();
    server.abort();
    livekit.shutdown().await.unwrap();
}
