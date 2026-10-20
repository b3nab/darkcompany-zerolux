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

    // The official extensions ZeroLux brings, here the checkout's: none installed yet.
    let (status, available) = kernel
        .call(Method::GET, "/extensions/available", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{available}");
    let voice = available["extensions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|extension| extension["id"] == "zerolux.voice")
        .expect("the voice extension");
    assert_eq!(voice["installed"], false);
    let (status, _) = kernel
        .call(Method::POST, "/extensions/available/acme.none", None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

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
    // A choice takes one of its options.
    let tone = &changed["extension"]["settings"][2];
    assert_eq!(tone["options"][1]["value"], "warm");
    for (value, expected) in [("loud", StatusCode::BAD_REQUEST), ("warm", StatusCode::OK)] {
        let (status, _) = kernel
            .call(
                Method::PATCH,
                "/extensions/zerolux.notes/settings",
                Some(json!({"tone": value})),
            )
            .await;
        assert_eq!(status, expected, "{value}");
    }

    // Its own folder, inside the kernel's data; an action may say it takes longer.
    let (_, actions) = kernel.call(Method::GET, "/actions", None).await;
    let slow = actions["actions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|action| action["name"] == "folder")
        .unwrap();
    assert_eq!(slow["seconds"], 120);
    let (status, wrote) = kernel
        .call(Method::POST, "/ext/zerolux.notes/folder", Some(json!({})))
        .await;
    assert_eq!(status, StatusCode::OK, "{wrote}");
    let written = std::path::PathBuf::from(wrote["result"]["path"].as_str().unwrap());
    assert!(written.starts_with(dir.path().join("extensions/zerolux.notes")));
    assert_eq!(std::fs::read_to_string(&written).unwrap(), "hello");
    // The new value reached its running part.
    assert_eq!(wrote["result"]["tone"], "warm");

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
    // Removed, Notes takes its folder with it.
    let (status, _) = kernel
        .call(Method::POST, "/extensions/zerolux.notes/disable", None)
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = kernel
        .call(Method::DELETE, "/extensions/zerolux.notes", None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!dir.path().join("extensions/zerolux.notes").exists());

    runtime.shutdown().await.unwrap();
    server.abort();
    livekit.shutdown().await.unwrap();
}

/// A kernel for one test, its runtime and its server.
async fn kernel_for(
    dir: &std::path::Path,
) -> (
    Kernel,
    Arc<ChatRuntime>,
    Arc<LiveKit>,
    tokio::task::JoinHandle<()>,
    db::TestDatabase,
) {
    let database = db::TestDatabase::new(dir.join("kernel.db")).await;
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
            data_dir: dir.join("livekit"),
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
        dir.join("links"),
    )
    .await
    .unwrap();
    let app = api::router_with_runtime(store, dir.join("web"), runtime.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (
        Kernel {
            url,
            client: Client::builder().no_proxy().build().unwrap(),
        },
        runtime,
        livekit,
        server,
        database,
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_extension_runs_and_starts_again_as_its_folder_changes() {
    use zerolux::extensions::scaffold::{Language, create};
    let mut languages = Vec::new();
    for (program, language, main) in [
        ("bun", Language::Typescript, "main.ts"),
        ("uv", Language::Python, "main.py"),
    ] {
        if std::process::Command::new(program)
            .arg("--version")
            .output()
            .is_ok()
        {
            languages.push((language, main));
        }
    }
    if languages.is_empty()
        || std::process::Command::new("livekit-server")
            .arg("--version")
            .output()
            .is_err()
    {
        eprintln!("livekit-server, bun or uv not installed: skipped");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let (kernel, runtime, livekit, server, _database) = kernel_for(dir.path()).await;
    for (language, main) in languages {
        let id = format!("acme.hello-{}", format!("{language:?}").to_lowercase());
        let folder = create(&id, "Hello", language, &dir.path().join(&id)).unwrap();
        let (status, body) = kernel
            .call(
                Method::POST,
                "/extensions/folder",
                Some(json!({"folder": folder})),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["extension"]["dev"], true);
        let (status, said) = kernel
            .call(
                Method::POST,
                &format!("/ext/{id}/hello"),
                Some(json!({"name": "Ada"})),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{said}");
        assert_eq!(said["result"]["text"], "Hello, Ada");
        // Seen as it is; then changed, it starts again once the folder holds still.
        runtime.extensions.reload_changed().await;
        let code = std::fs::read_to_string(folder.join(main)).unwrap();
        std::fs::write(folder.join(main), code.replace("Hello, ", "Ciao, ")).unwrap();
        runtime.extensions.reload_changed().await;
        runtime.extensions.reload_changed().await;
        let (_, said) = kernel
            .call(
                Method::POST,
                &format!("/ext/{id}/hello"),
                Some(json!({"name": "Ada"})),
            )
            .await;
        assert_eq!(said["result"]["text"], "Ciao, Ada", "{said}");
        // Broken, its error is kept; fixed, it runs again.
        std::fs::write(folder.join(main), "this is not code").unwrap();
        runtime.extensions.reload_changed().await;
        runtime.extensions.reload_changed().await;
        let (_, listed) = kernel.call(Method::GET, "/extensions", None).await;
        let found = listed["extensions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|extension| extension["id"] == id.as_str())
            .unwrap()
            .clone();
        assert_eq!(found["enabled"], false, "{found}");
        assert!(found["error"].is_string(), "{found}");
        std::fs::write(folder.join(main), code).unwrap();
        runtime.extensions.reload_changed().await;
        runtime.extensions.reload_changed().await;
        let (_, said) = kernel
            .call(
                Method::POST,
                &format!("/ext/{id}/hello"),
                Some(json!({"name": "Ada"})),
            )
            .await;
        assert_eq!(said["result"]["text"], "Hello, Ada", "{said}");
    }
    runtime.shutdown().await.unwrap();
    server.abort();
    livekit.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_extension_shows_pieces_in_the_clients_spaces() {
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
    let (kernel, runtime, livekit, server, _database) = kernel_for(dir.path()).await;
    let (status, body) = kernel
        .call(
            Method::POST,
            "/extensions/folder",
            Some(json!({"folder": fixture("board")})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let ui = body["extension"]["contributes"]["ui"].as_array().unwrap();
    let spaces: Vec<&str> = ui
        .iter()
        .map(|piece| piece["space"].as_str().unwrap())
        .collect();
    assert_eq!(spaces, ["page", "session", "chat", "settings", "message"]);
    // A described view is the tree its action returns, in the space's context.
    let (_, tree) = kernel
        .call(
            Method::POST,
            "/ext/zerolux.board/board",
            Some(json!({"session_id": "s1"})),
        )
        .await;
    assert_eq!(tree["result"]["type"], "stack", "{tree}");
    assert_eq!(tree["result"]["children"][1]["text"], "s1");
    // A message's piece runs its action on the message.
    let (status, pinned) = kernel
        .call(
            Method::POST,
            "/ext/zerolux.board/pin",
            Some(json!({"conversation_id": "c1", "message_id": "m1"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{pinned}");
    // A view it keeps is updated only if it declared it so.
    let (status, ticked) = kernel
        .call(Method::POST, "/ext/zerolux.board/tick", Some(json!({})))
        .await;
    assert_eq!(status, StatusCode::OK, "{ticked}");
    // Its own page opens under a key, within its `ui/` folder only.
    let (status, opened) = kernel
        .call(
            Method::POST,
            "/extensions/zerolux.board/ui",
            Some(json!({"entry": "ui/index.html"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{opened}");
    let page = opened["url"].as_str().unwrap();
    let response = kernel
        .client
        .get(format!("{}{page}", kernel.url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .starts_with("sandbox")
    );
    assert!(response.text().await.unwrap().contains("tools/call"));
    let style = page.replace("index.html", "style.css");
    let response = kernel
        .client
        .get(format!("{}{style}", kernel.url))
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.headers()["content-type"],
        "text/css; charset=utf-8"
    );
    for wrong in [
        page.replace("index.html", "../main.ts"),
        page.replace("index.html", "%2e%2e/main.ts"),
        page.replace("index.html", "missing.html"),
        "/api/extension-ui/nokey/index.html".to_owned(),
    ] {
        let status = kernel
            .client
            .get(format!("{}{wrong}", kernel.url))
            .send()
            .await
            .unwrap()
            .status();
        assert_ne!(status, StatusCode::OK, "{wrong}");
    }
    let (status, _) = kernel
        .call(
            Method::POST,
            "/extensions/zerolux.board/ui",
            Some(json!({"entry": "ui/other.html"})),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    runtime.shutdown().await.unwrap();
    server.abort();
    livekit.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_owner_works_on_an_extension_from_this_computer() {
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
    let (_kernel, runtime, livekit, server, _database) = kernel_for(dir.path()).await;
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let channel = tokio::spawn({
        let (data, runtime) = (data.clone(), runtime.clone());
        async move { zerolux::local_control::serve(&data, runtime).await }
    });
    let mut client = None;
    for _ in 0..100 {
        if let Ok(connected) = zerolux::local_control::Client::connect(&data).await {
            client = Some(connected);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let mut client = client.expect("the local channel");
    let folder = zerolux::extensions::scaffold::create(
        "acme.local",
        "Local",
        zerolux::extensions::scaffold::Language::Typescript,
        &dir.path().join("local"),
    )
    .unwrap();
    let installed = client
        .ask("extensions.dev", json!({"folder": folder}))
        .await
        .unwrap();
    assert_eq!(installed["id"], "acme.local");
    assert_eq!(installed["dev"], true);
    assert_eq!(installed["enabled"], true, "{installed}");
    let listed = client.ask("extensions.list", json!({})).await.unwrap();
    assert_eq!(listed[0]["id"], "acme.local");
    let log = client
        .ask("extensions.log", json!({"id": "acme.local", "after": 0}))
        .await
        .unwrap();
    assert!(log["end"].is_u64(), "{log}");
    assert!(
        client
            .ask("extensions.log", json!({"id": "../secret"}))
            .await
            .is_err()
    );
    assert!(client.ask("nothing", json!({})).await.is_err());
    // Only this system user may open it.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let endpoint = zerolux::local_control::endpoint_of(&data).unwrap();
        let mode = std::fs::metadata(endpoint).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0);
    }
    channel.abort();
    runtime.shutdown().await.unwrap();
    server.abort();
    livekit.shutdown().await.unwrap();
}

/// The `tally` kernel module of the Rust SDK's examples, built for this computer.
fn tally_module() -> std::path::PathBuf {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let output = std::process::Command::new(cargo)
        .args([
            "build",
            "-p",
            "zerolux-extension",
            "--example",
            "tally",
            "--message-format=json",
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|message| message["target"]["name"] == "tally")
        .flat_map(|message| message["filenames"].as_array().cloned().unwrap_or_default())
        .filter_map(|file| file.as_str().map(std::path::PathBuf::from))
        .find(|file| {
            file.extension()
                .is_some_and(|kind| std::env::consts::DLL_EXTENSION == kind)
        })
        .expect("the tally module")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_kernel_module_is_loaded_while_the_kernel_runs() {
    if std::process::Command::new("livekit-server")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("livekit-server not installed: skipped");
        return;
    }
    let built = tally_module();
    let dir = tempfile::tempdir().unwrap();
    let (kernel, runtime, livekit, server, _database) = kernel_for(dir.path()).await;
    // A package's layout: the module for this computer under `kernel/<platform>/`.
    let folder = dir.path().join("tally");
    let modules = folder
        .join("kernel")
        .join(zerolux::extensions::library::platform());
    std::fs::create_dir_all(&modules).unwrap();
    std::fs::copy(
        &built,
        modules.join(zerolux::extensions::library::file_name("tally")),
    )
    .unwrap();
    std::fs::write(
        folder.join("zerolux-extension.toml"),
        "[extension]\nid = \"zerolux.tally\"\nname = \"Tally\"\nversion = \"0.1.0\"\npublisher = \"zerolux\"\n\n[kernel]\nlibrary = \"tally\"\n",
    )
    .unwrap();
    let (status, installed) = kernel
        .call(
            Method::POST,
            "/extensions/folder",
            Some(json!({"folder": folder})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{installed}");
    assert_eq!(installed["extension"]["parts"], json!(["kernel"]));
    assert_eq!(installed["extension"]["running"], true);
    assert_eq!(
        installed["extension"]["contributes"]["ui"][0]["name"],
        "tally"
    );
    // Its actions run in the kernel, and ask the kernel back: values and events.
    for by in [2, 3] {
        let (status, added) = kernel
            .call(
                Method::POST,
                "/ext/zerolux.tally/add",
                Some(json!({"by": by})),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{added}");
    }
    let (_, total) = kernel
        .call(Method::POST, "/ext/zerolux.tally/total", Some(json!({})))
        .await;
    assert_eq!(total["result"]["text"], "5", "{total}");
    assert!(
        total["result"]["folder"]
            .as_str()
            .unwrap()
            .ends_with("zerolux.tally")
    );
    // Disabled, it is no longer called; enabled again, it runs from where it was.
    let (status, _) = kernel
        .call(Method::POST, "/extensions/zerolux.tally/disable", None)
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = kernel
        .call(Method::POST, "/ext/zerolux.tally/total", Some(json!({})))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = kernel
        .call(Method::POST, "/extensions/zerolux.tally/enable", None)
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, total) = kernel
        .call(Method::POST, "/ext/zerolux.tally/total", Some(json!({})))
        .await;
    assert_eq!(total["result"]["text"], "5", "{total}");
    // A library that is not a module is refused, and says why.
    std::fs::write(
        modules.join(zerolux::extensions::library::file_name("tally")),
        b"not a library",
    )
    .unwrap();
    let (status, refused) = kernel
        .call(
            Method::POST,
            "/extensions/folder",
            Some(json!({"folder": folder})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    runtime.shutdown().await.unwrap();
    server.abort();
    livekit.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn extensions_are_installed_from_an_index_only_as_their_publisher_signed_them() {
    use zerolux::extensions::{library, package};
    if std::process::Command::new("livekit-server")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("livekit-server not installed: skipped");
        return;
    }
    let built = tally_module();
    let dir = tempfile::tempdir().unwrap();
    // A publisher packs its kernel module for this computer and signs it.
    let folder = dir.path().join("tally");
    let modules = folder.join("kernel").join(library::platform());
    std::fs::create_dir_all(&modules).unwrap();
    std::fs::copy(&built, modules.join(library::file_name("tally"))).unwrap();
    std::fs::write(
        folder.join("zerolux-extension.toml"),
        "[extension]\nid = \"zerolux.tally\"\nname = \"Tally\"\nversion = \"1.0.0\"\npublisher = \"zerolux\"\n\n[kernel]\nlibrary = \"tally\"\n",
    )
    .unwrap();
    let key = package::Key::new("zerolux").unwrap();
    let site = dir.path().join("site");
    let packed = package::pack(&folder, &key, &site.join("packages")).unwrap();
    let digest = package::sha256(&std::fs::read(&packed).unwrap());
    // Another key signs a copy that claims to be the same.
    let forged = package::pack(
        &folder,
        &package::Key::new("zerolux").unwrap(),
        &site.join("forged"),
    )
    .unwrap();
    let forged_digest = package::sha256(&std::fs::read(&forged).unwrap());
    let listing = |version: &str, path: &str, sha256: &str| {
        json!({"version": version, "kernel": ">=0.0.1", "parts": ["kernel"],
            "packages": {library::platform(): {"url": path, "sha256": sha256}}})
    };
    std::fs::write(
        site.join("index.json"),
        json!({"name": "Test", "publishers": {"zerolux": {"key": key.public}},
            "extensions": [
                {"id": "zerolux.tally", "name": "Tally", "publisher": "zerolux",
                    "versions": [listing("1.0.0", "packages/zerolux.tally-1.0.0.zlx", &digest),
                        listing("1.0.1", "forged/zerolux.tally-1.0.0.zlx", &forged_digest),
                        listing("1.0.2", "packages/zerolux.tally-1.0.0.zlx", &"0".repeat(64)),
                        {"version": "9.0.0", "kernel": ">=99", "packages": {"any": {"url": "x", "sha256": "x"}}}]},
            ]})
        .to_string(),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let index = format!("http://{}/index.json", listener.local_addr().unwrap());
    let site_server = tokio::spawn(async move {
        axum::serve(
            listener,
            axum::Router::new().fallback_service(tower_http::services::ServeDir::new(site)),
        )
        .await
        .unwrap();
    });
    // SAFETY: set before the kernel reads it, in this test only.
    unsafe { std::env::set_var("ZEROLUX_EXTENSION_INDEXES", &index) };
    let (kernel, runtime, livekit, server, _database) = kernel_for(dir.path()).await;
    let (status, offered) = kernel
        .call(Method::GET, "/extensions/marketplace", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{offered}");
    // The newest version that runs here: 9.0.0 needs another kernel.
    assert_eq!(offered["offers"][0]["id"], "zerolux.tally");
    assert_eq!(offered["offers"][0]["version"], "1.0.2");
    assert_eq!(offered["offers"][0]["parts"], json!(["kernel"]));
    // Not as the index lists it, or not signed by its publisher: refused.
    for version in ["1.0.2", "1.0.1"] {
        let (status, refused) = kernel
            .call(
                Method::POST,
                "/extensions/marketplace/install",
                Some(json!({"index": index, "id": "zerolux.tally", "version": version})),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{version}: {refused}");
    }
    let (status, _) = kernel
        .call(
            Method::POST,
            "/extensions/marketplace/install",
            Some(json!({"index": "http://elsewhere/index.json", "id": "zerolux.tally"})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // As signed: installed, enabled, and run in the kernel.
    let (status, installed) = kernel
        .call(
            Method::POST,
            "/extensions/marketplace/install",
            Some(json!({"index": index, "id": "zerolux.tally", "version": "1.0.0"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{installed}");
    assert_eq!(installed["extension"]["dev"], false);
    assert_eq!(installed["extension"]["running"], true);
    let (status, added) = kernel
        .call(Method::POST, "/ext/zerolux.tally/add", Some(json!({})))
        .await;
    assert_eq!(status, StatusCode::OK, "{added}");
    let (_, offered) = kernel
        .call(Method::GET, "/extensions/marketplace", None)
        .await;
    assert_eq!(offered["offers"][0]["installed"], "1.0.0");
    unsafe { std::env::remove_var("ZEROLUX_EXTENSION_INDEXES") };
    runtime.shutdown().await.unwrap();
    server.abort();
    site_server.abort();
    livekit.shutdown().await.unwrap();
}
