//! Extensions with process parts, written with the TypeScript SDK: installed from a folder,
//! enabled with their dependencies, their actions run for people and agents, their extension
//! points called through the contract their owner opened, their events heard and their
//! triggers run, their settings and secrets kept.
use std::sync::Arc;

use reqwest::{Client, Method, StatusCode};
use serde_json::{Value, json};
use zerolux::{
    api,
    chat_runtime::ChatRuntime,
    livekit::{LiveKit, LiveKitConfig},
    model::SetOwnerName,
};

#[path = "support/db.rs"]
mod db;

fn fixture(name: &str) -> String {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/extensions")
        .join(name)
        .to_string_lossy()
        .into_owned()
}

struct Kernel {
    url: String,
    client: Client,
}

impl Kernel {
    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut request = self
            .client
            .request(method, format!("{}/api{path}", self.url));
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        let status = response.status();
        (status, response.json().await.unwrap_or(Value::Null))
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn extensions_bring_actions_points_events_triggers_and_settings() {
    for program in ["livekit-server", "bun"] {
        if std::process::Command::new(program)
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("{program} not installed: skipped");
            return;
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let database = db::TestDatabase::new(dir.path().join("kernel.db")).await;
    let store = database.open().await;
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
    let app = api::router_with_runtime(store.clone(), dir.path().join("web"), runtime.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let kernel = Kernel {
        url,
        client: Client::builder().no_proxy().build().unwrap(),
    };

    // An extension that depends on another is not enabled before it.
    let (status, body) = kernel
        .call(
            Method::POST,
            "/extensions/folder",
            Some(json!({"folder": fixture("memory")})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        body["error"].as_str().unwrap().contains("zerolux.notes"),
        "{body}"
    );
    let (status, body) = kernel.call(Method::GET, "/extensions", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["extensions"][0]["enabled"], false);
    assert!(body["extensions"][0]["error"].is_string());

    // Installed from its folder and enabled: what it brings, as its process says.
    let (status, notes) = kernel
        .call(
            Method::POST,
            "/extensions/folder",
            Some(json!({"folder": fixture("notes")})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{notes}");
    let notes = &notes["extension"];
    assert_eq!(notes["enabled"], true);
    assert_eq!(notes["running"], true);
    assert_eq!(notes["parts"], json!(["process"]));
    assert_eq!(notes["contributes"]["points"][0]["name"], "stores");
    assert_eq!(notes["settings"][0]["key"], "store");
    assert_eq!(notes["settings"][0]["value"], "memory");
    let (status, memory) = kernel
        .call(Method::POST, "/extensions/memory/enable", None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{memory}");
    let (status, memory) = kernel
        .call(Method::POST, "/extensions/zerolux.memory/enable", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{memory}");
    assert_eq!(memory["extension"]["error"], Value::Null);

    // Actions, for people and agents alike.
    let (_, actions) = kernel.call(Method::GET, "/actions", None).await;
    let names: Vec<_> = actions["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|action| {
            format!(
                "{}/{}",
                action["extension"].as_str().unwrap(),
                action["name"].as_str().unwrap()
            )
        })
        .collect();
    assert!(
        names.contains(&"zerolux.notes/save".to_owned()),
        "{names:?}"
    );
    // The input is checked against its schema before the extension sees it.
    let (status, refused) = kernel
        .call(
            Method::POST,
            "/ext/zerolux.notes/save",
            Some(json!({"key": "a", "text": ""})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    // Saved through the store Memory implements, on the point Notes opened.
    let (status, saved) = kernel
        .call(
            Method::POST,
            "/ext/zerolux.notes/save",
            Some(json!({"key": "a", "text": "Hello"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["result"]["store"], "memory");
    assert!(saved["result"]["by"].is_string(), "the person who ran it");
    let (_, read) = kernel
        .call(
            Method::POST,
            "/ext/zerolux.notes/read",
            Some(json!({"key": "a"})),
        )
        .await;
    assert_eq!(read["result"]["text"], "Hello");
    // Its event was heard, and the trigger on it ran.
    let mut tally = Value::Null;
    for _ in 0..100 {
        tally = kernel
            .call(Method::POST, "/ext/zerolux.memory/tally", Some(json!({})))
            .await
            .1;
        if tally["result"]["heard"] == 1 && tally["result"]["counted"] == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(tally["result"], json!({"heard": 1, "counted": 1}));

    // Settings and secrets: a secret is never shown, its parts read it.
    let (_, secret) = kernel
        .call(Method::POST, "/ext/zerolux.notes/secret", Some(json!({})))
        .await;
    assert_eq!(secret["result"]["token"], false);
    let (status, changed) = kernel
        .call(
            Method::PATCH,
            "/extensions/zerolux.notes/settings",
            Some(json!({"token": "fixture-secret"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    assert!(!changed.to_string().contains("fixture-secret"));
    assert_eq!(changed["extension"]["settings"][1]["set"], true);
    let (_, secret) = kernel
        .call(Method::POST, "/ext/zerolux.notes/secret", Some(json!({})))
        .await;
    assert_eq!(secret["result"]["token"], true);
    let (status, _) = kernel
        .call(
            Method::PATCH,
            "/extensions/zerolux.notes/settings",
            Some(json!({"unknown": 1})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Notes cannot be disabled while Memory depends on it; disabled, Memory's actions go.
    let (status, _) = kernel
        .call(Method::POST, "/extensions/zerolux.notes/disable", None)
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = kernel
        .call(Method::POST, "/extensions/zerolux.memory/disable", None)
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = kernel
        .call(Method::POST, "/ext/zerolux.memory/tally", Some(json!({})))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // A note can no longer be saved: nobody implements its store.
    let (status, body) = kernel
        .call(
            Method::POST,
            "/ext/zerolux.notes/save",
            Some(json!({"key": "b", "text": "Hi"})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    // Removed once disabled.
    let (status, _) = kernel
        .call(Method::DELETE, "/extensions/zerolux.memory", None)
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, listed) = kernel.call(Method::GET, "/extensions", None).await;
    assert_eq!(listed["extensions"].as_array().unwrap().len(), 1);

    runtime.shutdown().await.unwrap();
    server.abort();
    livekit.shutdown().await.unwrap();
}
