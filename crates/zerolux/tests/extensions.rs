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
        .unwrap_or_else(|error| {
            let log = std::fs::read_to_string(dir.join("livekit/livekit.log"))
                .unwrap_or_else(|error| format!("Could not read LiveKit log: {error}"));
            panic!("Start fixture LiveKit: {error:#}\n{log}");
        }),
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
    assert_eq!(
        spaces,
        ["page", "page", "session", "chat", "settings", "message"]
    );
    // Its own interface, run inside the apps, is one of its parts.
    assert_eq!(body["extension"]["parts"], json!(["process", "interface"]));
    let (status, script) = kernel
        .call(
            Method::POST,
            "/extensions/zerolux.board/ui",
            Some(json!({"entry": "ui/native/cards.js"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{script}");
    let code = kernel
        .client
        .get(format!("{}{}", kernel.url, script["url"].as_str().unwrap()))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(
        code.starts_with("globalThis.__zeroluxModule(\"ui/native/cards.js\""),
        "{code}"
    );
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
    // Sandboxed, with the kernel's origin named: WebKit matches `'self'` against the frame's own.
    let policy = response.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(
        policy.starts_with("sandbox allow-scripts allow-forms"),
        "{policy}"
    );
    assert!(
        policy.contains(&format!("default-src {}", kernel.url)),
        "{policy}"
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
    built_module(&["-p", "zerolux-extension", "--example", "tally"], "tally")
}

/// A kernel module built for this computer by Cargo, as `args` say.
fn built_module(args: &[&str], target: &str) -> std::path::PathBuf {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let output = std::process::Command::new(cargo)
        .arg("build")
        .args(args)
        .arg("--message-format=json")
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
        .filter(|message| message["target"]["name"] == target)
        .flat_map(|message| message["filenames"].as_array().cloned().unwrap_or_default())
        .filter_map(|file| file.as_str().map(std::path::PathBuf::from))
        .find(|file| {
            file.extension()
                .is_some_and(|kind| std::env::consts::DLL_EXTENSION == kind)
        })
        .expect("the kernel module")
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
    #[cfg(target_os = "macos")]
    let completion = std::env::var_os("ZEROLUX_TEST_HARDENED_MODULE").map(std::path::PathBuf::from);
    #[cfg(target_os = "macos")]
    if completion.is_none() {
        // Exercise the real loader under the desktop's signing policy, without changing the
        // executable Cargo built. The child runs this same behavior test exactly once.
        let signed = tempfile::tempdir().unwrap();
        let executable = signed.path().join("extensions");
        std::fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        let entitlements = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/desktop/src-tauri/Entitlements.plist");
        let output = std::process::Command::new("codesign")
            .args([
                "--force",
                "--sign",
                "-",
                "--options",
                "runtime",
                "--entitlements",
            ])
            .arg(entitlements)
            .arg(&executable)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let completed = signed.path().join("completed");
        let output = std::process::Command::new(executable)
            .args([
                "--exact",
                "a_kernel_module_is_loaded_while_the_kernel_runs",
                "--nocapture",
            ])
            .env("ZEROLUX_TEST_HARDENED_MODULE", &completed)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        // A successful process with no matching test must not count as a passing regression.
        assert!(completed.is_file());
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
    let library = modules.join(zerolux::extensions::library::file_name("tally"));
    std::fs::copy(&built, &library).unwrap();
    #[cfg(target_os = "macos")]
    {
        // Third-party code has no shared Apple Team ID, even when its package is trusted.
        let output = std::process::Command::new("codesign")
            .args(["--force", "--sign", "-"])
            .arg(&library)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
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
    // Bootstrap failures stay visible until the next successful start, including those of
    // a dependent that could not start while its dependency was unavailable.
    let dependent = dir.path().join("dependent");
    let dependent_modules = dependent
        .join("kernel")
        .join(zerolux::extensions::library::platform());
    std::fs::create_dir_all(&dependent_modules).unwrap();
    std::fs::copy(
        &library,
        dependent_modules.join(zerolux::extensions::library::file_name("tally")),
    )
    .unwrap();
    std::fs::write(
        dependent.join("zerolux-extension.toml"),
        "[extension]\nid = \"zerolux.dependent\"\nname = \"Dependent\"\nversion = \"0.1.0\"\npublisher = \"zerolux\"\n\n[kernel]\nlibrary = \"tally\"\n\n[dependencies]\n\"zerolux.tally\" = \"^0.1\"\n",
    )
    .unwrap();
    let (status, installed) = kernel
        .call(
            Method::POST,
            "/extensions/folder",
            Some(json!({"folder": dependent})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{installed}");
    runtime.extensions.shutdown().await;
    // The loader maps its own copy; this original file is not mapped, including on Windows.
    let unavailable = library.with_extension("unavailable");
    std::fs::rename(&library, &unavailable).unwrap();
    for restored in [false, true] {
        if restored {
            std::fs::rename(&unavailable, &library).unwrap();
        }
        runtime.extensions.start_enabled().await;
        let (status, listed) = kernel.call(Method::GET, "/extensions", None).await;
        assert_eq!(status, StatusCode::OK, "{listed}");
        for id in ["zerolux.tally", "zerolux.dependent"] {
            let found = listed["extensions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|extension| extension["id"] == id)
                .unwrap();
            assert_eq!(found["enabled"], true, "{found}");
            assert_eq!(found["running"], restored, "{found}");
            assert!(found["proposed_by"].is_null(), "{found}");
            if restored {
                assert!(found["error"].is_null(), "{found}");
            } else {
                assert!(found["error"].is_string(), "{found}");
            }
        }
    }
    let (status, total) = kernel
        .call(Method::POST, "/ext/zerolux.tally/total", Some(json!({})))
        .await;
    assert_eq!(status, StatusCode::OK, "{total}");
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
    #[cfg(target_os = "macos")]
    std::fs::write(completion.unwrap(), b"").unwrap();
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
        "[extension]\nid = \"zerolux.tally\"\nname = \"Tally\"\nversion = \"1.0.0\"\npublisher = \"zerolux\"\nicon = \"icon.png\"\ncategories = [\"data-analytics\"]\n\n[kernel]\nlibrary = \"tally\"\n",
    )
    .unwrap();
    // What it shows: an icon, 512 pixels square, and a README.
    let mut icon = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    icon.extend(512u32.to_be_bytes());
    icon.extend(512u32.to_be_bytes());
    icon.extend([8, 6, 0, 0, 0]);
    std::fs::write(folder.join("icon.png"), &icon).unwrap();
    std::fs::write(folder.join("README.md"), "# Tally\n\nCounts.").unwrap();
    let key = package::Key::new("zerolux").unwrap();
    let site = dir.path().join("site");
    let packed = package::pack(&folder, &key, &site.join("packages")).unwrap();
    let card_file = package::card_beside(&folder, &site.join("cards")).unwrap();
    let mut card: Value = serde_json::from_slice(&std::fs::read(&card_file).unwrap()).unwrap();
    for asset in ["icon", "readme"] {
        let name = card[asset]["name"].as_str().unwrap().to_owned();
        card[asset]["url"] = json!(format!("cards/zerolux.tally-1.0.0.card/{name}"));
    }
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
                        {"version": "1.0.2", "kernel": ">=0.0.1", "parts": ["kernel"], "card": card,
                            "packages": {library::platform(): {"url": "packages/zerolux.tally-1.0.0.zlx", "sha256": "0".repeat(64)}}},
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
    assert_eq!(
        offered["marketplaces"],
        json!([{"index": index, "name": "Test"}])
    );
    // The newest version that runs here: 9.0.0 needs another kernel.
    assert_eq!(offered["offers"][0]["id"], "zerolux.tally");
    assert_eq!(offered["offers"][0]["version"], "1.0.2");
    assert_eq!(offered["offers"][0]["parts"], json!(["kernel"]));
    // Its card, each file given by the kernel, as its digest says.
    let shown = &offered["offers"][0]["card"];
    assert_eq!(shown["categories"], json!(["data-analytics"]), "{offered}");
    let fetch = |address: String| {
        let client = kernel.client.clone();
        let url = format!("{}{address}", kernel.url);
        async move { client.get(url).send().await.unwrap() }
    };
    let got = fetch(shown["icon"]["url"].as_str().unwrap().to_owned()).await;
    assert_eq!(got.status(), StatusCode::OK);
    assert_eq!(got.headers()["content-type"], "image/png");
    assert!(
        got.headers()["cache-control"]
            .to_str()
            .unwrap()
            .contains("immutable")
    );
    assert_eq!(got.bytes().await.unwrap().to_vec(), icon);
    // In ranges too, as players ask for a video.
    let part = kernel
        .client
        .get(format!(
            "{}{}",
            kernel.url,
            shown["icon"]["url"].as_str().unwrap()
        ))
        .header("range", "bytes=0-7")
        .send()
        .await
        .unwrap();
    assert_eq!(part.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(part.bytes().await.unwrap().to_vec(), icon[..8]);
    // Changed at the index, it is not given.
    std::fs::write(
        dir.path()
            .join("site/cards/zerolux.tally-1.0.0.card/README.md"),
        "# Changed",
    )
    .unwrap();
    let refused = fetch(shown["readme"]["url"].as_str().unwrap().to_owned()).await;
    assert_ne!(refused.status(), StatusCode::OK);
    let unknown = fetch(format!("/api/extensions/assets/{}", "a".repeat(64))).await;
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
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
    // Installed, its card is read from its package.
    let readme = installed["extension"]["card"]["readme"]["url"]
        .as_str()
        .unwrap()
        .to_owned();
    let got = fetch(readme).await;
    assert_eq!(got.status(), StatusCode::OK);
    assert_eq!(got.text().await.unwrap(), "# Tally\n\nCounts.");
    let (status, added) = kernel
        .call(Method::POST, "/ext/zerolux.tally/add", Some(json!({})))
        .await;
    assert_eq!(status, StatusCode::OK, "{added}");
    let (_, offered) = kernel
        .call(Method::GET, "/extensions/marketplace", None)
        .await;
    assert_eq!(offered["offers"][0]["installed"], "1.0.0");
    // The index offers 1.0.2's package, not the one installed.
    assert_eq!(offered["offers"][0]["current"], false, "{offered}");
    // Updating everything tries 1.0.2, which its index does not list as it is: it says why,
    // and 1.0.0 goes on running.
    let (status, update) = kernel
        .call(
            Method::POST,
            "/extensions/marketplace/update",
            Some(json!({})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{update}");
    assert_eq!(update["updated"], json!([]), "{update}");
    assert_eq!(update["failed"][0]["id"], "zerolux.tally", "{update}");
    assert!(update["failed"][0]["error"].is_string());
    let (_, offered) = kernel
        .call(Method::GET, "/extensions/marketplace", None)
        .await;
    assert_eq!(offered["offers"][0]["installed"], "1.0.0");
    let (status, _) = kernel
        .call(Method::POST, "/ext/zerolux.tally/add", Some(json!({})))
        .await;
    assert_eq!(status, StatusCode::OK);
    // Only those named are updated.
    let (_, update) = kernel
        .call(
            Method::POST,
            "/extensions/marketplace/update",
            Some(json!({"ids": ["zerolux.other"]})),
        )
        .await;
    assert_eq!(update, json!({"updated": [], "failed": []}));
    unsafe { std::env::remove_var("ZEROLUX_EXTENSION_INDEXES") };
    runtime.shutdown().await.unwrap();
    server.abort();
    site_server.abort();
    livekit.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn storage_shows_each_location_live_and_changes_files_where_they_are() {
    use zerolux::extensions::library;
    if std::process::Command::new("livekit-server")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("livekit-server not installed: skipped");
        return;
    }
    let built = built_module(&["-p", "zerolux-storage", "--lib"], "zerolux_storage");
    let dir = tempfile::tempdir().unwrap();
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../marketplace/storage");
    let folder = dir.path().join("storage-extension");
    let modules = folder.join("kernel").join(library::platform());
    std::fs::create_dir_all(&modules).unwrap();
    std::fs::copy(
        source.join("zerolux-extension.toml"),
        folder.join("zerolux-extension.toml"),
    )
    .unwrap();
    std::fs::copy(&built, modules.join(library::file_name("zerolux_storage"))).unwrap();
    let (kernel, runtime, livekit, server, _database) = kernel_for(dir.path()).await;
    let (status, installed) = kernel
        .call(
            Method::POST,
            "/extensions/folder",
            Some(json!({"folder": folder})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{installed}");
    let storage = |action: &'static str, input: Value| {
        let kernel = &kernel;
        async move {
            kernel
                .call(
                    Method::POST,
                    &format!("/ext/zerolux.storage/{action}"),
                    Some(input),
                )
                .await
        }
    };
    let names = |listed: &Value| -> Vec<String> {
        listed["result"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap().to_owned())
            .collect()
    };

    // ZeroLux's own location is there from the start, for whoever has no other.
    let (_, locations) = storage("locations", json!({})).await;
    let own = &locations["result"]["locations"][0];
    assert_eq!(own["name"], "ZeroLux", "{locations}");
    assert_eq!(own["default"], true);
    // It is the workspace's storage area, with what its people and agents keep there.
    assert_eq!(
        own["config"]["path"],
        json!(dir.path().join("storage")),
        "{locations}"
    );
    let own = own["id"].as_str().unwrap().to_owned();
    let (_, providers) = storage("providers", json!({})).await;
    assert_eq!(providers["result"]["providers"][0]["provider"], "folder");

    // An agent's text, written at a path and read back.
    let (status, written) = storage(
        "write",
        json!({"path": "plans/q4/notes.md", "text": "# Q4"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{written}");
    let (_, read) = storage(
        "read",
        json!({"location": own, "path": "plans/q4/notes.md"}),
    )
    .await;
    assert_eq!(read["result"]["text"], "# Q4", "{read}");

    // A person's upload, shared in a chat, and downloaded as it was.
    let bytes: Vec<u8> = (0..300_000u32).map(|n| (n % 251) as u8).collect();
    let input = serde_json::to_string(&json!({"conversation_id": "c1"})).unwrap();
    let uploaded: Value = kernel
        .client
        .post(format!(
            "{}/api/ext/zerolux.storage/upload/file",
            kernel.url
        ))
        .query(&[("input", input.as_str()), ("name", "photo.png")])
        .header("content-type", "image/png")
        .body(bytes.clone())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let photo = uploaded["result"]["id"]
        .as_str()
        .expect("shared")
        .to_owned();
    assert_eq!(uploaded["result"]["size"], 300_000, "{uploaded}");
    assert_eq!(uploaded["result"]["conversation_id"], "c1");
    assert_eq!(uploaded["result"]["path"], "Chats/photo.png");
    let download = |input: Value| {
        let kernel = &kernel;
        async move {
            let input = serde_json::to_string(&input).unwrap();
            kernel
                .client
                .get(format!("{}/api/ext/zerolux.storage/download", kernel.url))
                .query(&[("input", input.as_str())])
                .send()
                .await
                .unwrap()
        }
    };
    let response = download(json!({"id": photo})).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "image/png");
    assert_eq!(response.bytes().await.unwrap().to_vec(), bytes);
    let incoming = dir.path().join("extensions/zerolux.storage/.incoming");
    assert_eq!(std::fs::read_dir(&incoming).unwrap().count(), 0);
    let (_, in_chat) = storage("files", json!({"conversation_id": "c1"})).await;
    assert_eq!(
        in_chat["result"]["files"][0]["name"], "photo.png",
        "{in_chat}"
    );
    // The same name again is not overwritten.
    let again: Value = kernel
        .client
        .post(format!(
            "{}/api/ext/zerolux.storage/upload/file",
            kernel.url
        ))
        .query(&[("input", input.as_str()), ("name", "photo.png")])
        .body(vec![1u8, 2, 3])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(again["result"]["path"], "Chats/photo (2).png", "{again}");

    // A folder of this computer, as another location: what it holds shows as it is, and
    // what changes there shows at once, with nothing copied.
    let outside = dir.path().join("work");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("existing.txt"), "there before").unwrap();
    let (status, added) = storage(
        "add_location",
        json!({"name": "Work", "provider": "folder", "config": {"path": outside}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{added}");
    let work = added["result"]["location"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (_, listed) = storage("list", json!({"location": "Work"})).await;
    assert_eq!(names(&listed), ["existing.txt"]);
    std::fs::write(outside.join("later.txt"), "written elsewhere").unwrap();
    let (_, listed) = storage("list", json!({"location": work})).await;
    assert_eq!(names(&listed), ["existing.txt", "later.txt"]);
    // Never outside it.
    let (status, _) = storage("list", json!({"location": work, "path": "../.."})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Across locations: a folder copied with what it holds, a shared file moved and still
    // shared, then renamed.
    let (status, copied) = storage(
        "copy",
        json!({"location": own, "path": "plans", "to_location": work, "to": ""}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{copied}");
    assert_eq!(
        std::fs::read_to_string(outside.join("plans/q4/notes.md")).unwrap(),
        "# Q4"
    );
    let (status, moved) = storage(
        "move",
        json!({"location": own, "path": "Chats/photo.png", "to_location": work, "to": "pictures"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert!(outside.join("pictures/photo.png").is_file());
    let response = download(json!({"id": photo})).await;
    assert_eq!(response.bytes().await.unwrap().to_vec(), bytes);
    storage(
        "rename",
        json!({"location": work, "path": "pictures", "name": "photos"}),
    )
    .await;
    let response = download(json!({"id": photo})).await;
    assert_eq!(response.status(), StatusCode::OK, "the share follows");
    let (_, found) = storage("search", json!({"query": "NOTES"})).await;
    assert_eq!(
        found["result"]["entries"].as_array().unwrap().len(),
        2,
        "{found}"
    );
    let (status, _) = storage(
        "move",
        json!({"location": work, "path": "plans", "to": "plans/q4"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Deleted where it is; a location removed from ZeroLux keeps its files.
    storage("delete", json!({"location": work, "path": "plans"})).await;
    assert!(!outside.join("plans").exists());
    let (status, _) = storage("remove_location", json!({"id": work})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(outside.join("existing.txt").is_file());
    let (status, _) = storage("remove_location", json!({"id": own})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, in_chat) = storage("files", json!({"conversation_id": "c1"})).await;
    assert_eq!(
        in_chat["result"]["files"].as_array().unwrap().len(),
        1,
        "{in_chat}"
    );

    // Another extension's provider: a location of it asks the person to sign in, and is
    // ready once the service sent them back.
    if std::process::Command::new("bun")
        .arg("--version")
        .output()
        .is_ok()
    {
        let (status, body) = kernel
            .call(
                Method::POST,
                "/extensions/folder",
                Some(json!({"folder": fixture("disk")})),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (_, providers) = storage("providers", json!({})).await;
        assert_eq!(
            providers["result"]["providers"][1]["title"], "Disk",
            "{providers}"
        );
        let (service, _) = token_service().await;
        let (status, added) = storage(
            "add_location",
            json!({"name": "Disk", "provider": "disk", "config": {"service": service}}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{added}");
        let disk = added["result"]["location"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let address =
            reqwest::Url::parse(added["result"]["sign_in"]["url"].as_str().unwrap()).unwrap();
        let state = address
            .query_pairs()
            .find(|(key, _)| key == "state")
            .unwrap()
            .1
            .into_owned();
        let (_, locations) = storage("locations", json!({})).await;
        let signed_in = |locations: &Value| {
            locations["result"]["locations"]
                .as_array()
                .unwrap()
                .iter()
                .find(|location| location["id"] == disk.as_str())
                .unwrap_or_else(|| panic!("Added location {disk} disappeared: {locations}"))
                ["signed_in"]
                .clone()
        };
        assert_eq!(signed_in(&locations), false);
        kernel
            .client
            .get(format!(
                "{}/api/extensions/oauth/callback?state={state}&code=code-1",
                kernel.url
            ))
            .send()
            .await
            .unwrap();
        let mut ready = Value::Null;
        for _ in 0..100 {
            let (_, locations) = storage("locations", json!({})).await;
            ready = signed_in(&locations);
            if ready == true {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert_eq!(ready, true);
        // Files go there and come back through its provider.
        let (status, written) = storage(
            "write",
            json!({"location": "Disk", "path": "hello.txt", "text": "hi"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{written}");
        let (_, read) = storage("read", json!({"location": disk, "path": "hello.txt"})).await;
        assert_eq!(read["result"]["text"], "hi", "{read}");
        // A provider without renames: a copy under the new name, then the old goes.
        storage(
            "rename",
            json!({"location": disk, "path": "hello.txt", "name": "hey.txt"}),
        )
        .await;
        let (_, listed) = storage("list", json!({"location": disk})).await;
        assert_eq!(names(&listed), ["hey.txt"]);
        // Only a location's own provider says it signed in.
        let (status, _) = storage("signed_in", json!({"location": disk, "ok": false})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    runtime.shutdown().await.unwrap();
    server.abort();
    livekit.shutdown().await.unwrap();
}

/// One of ZeroLux's kernel modules in `marketplace/`, built and laid out as its package would be.
fn official_module(
    dir: &std::path::Path,
    name: &str,
    package: &str,
    library: &str,
) -> std::path::PathBuf {
    use zerolux::extensions::library as libraries;
    let built = built_module(&["-p", package, "--lib"], library);
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../marketplace")
        .join(name);
    let folder = dir.join(name);
    let modules = folder.join("kernel").join(libraries::platform());
    std::fs::create_dir_all(&modules).unwrap();
    std::fs::copy(
        source.join("zerolux-extension.toml"),
        folder.join("zerolux-extension.toml"),
    )
    .unwrap();
    std::fs::copy(&built, modules.join(libraries::file_name(library))).unwrap();
    folder
}

#[tokio::test(flavor = "multi_thread")]
async fn projects_keep_tasks_here_or_in_a_tracker() {
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
    let folder = official_module(
        dir.path(),
        "projects",
        "zerolux-projects",
        "zerolux_projects",
    );
    let (kernel, runtime, livekit, server, _database) = kernel_for(dir.path()).await;
    let run = |action: &'static str, input: Value| {
        let kernel = &kernel;
        async move {
            kernel
                .call(
                    Method::POST,
                    &format!("/ext/zerolux.projects/{action}"),
                    Some(input),
                )
                .await
        }
    };
    let (status, installed) = kernel
        .call(
            Method::POST,
            "/extensions/folder",
            Some(json!({"folder": folder})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{installed}");
    // A project kept here: its tasks numbered by its key, assigned, moved and commented.
    let (status, project) = run("create_project", json!({"name": "ZeroLux", "key": "zl"})).await;
    assert_eq!(status, StatusCode::OK, "{project}");
    let project = project["result"]["id"].as_str().unwrap().to_owned();
    let (status, _) = run("create_project", json!({"name": "Again", "key": "ZL"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, task) = run(
        "create_task",
        json!({"project_id": project, "title": "Release 0.0.1", "priority": "high", "assignee": "agent-1"}),
    )
    .await;
    assert_eq!(task["result"]["key"], "ZL-1", "{task}");
    assert_eq!(task["result"]["status"], "backlog");
    let task = task["result"]["id"].as_str().unwrap().to_owned();
    let (status, moved) = run("update_task", json!({"id": task, "status": "in_progress"})).await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(moved["result"]["priority"], "high");
    let (status, _) = run("update_task", json!({"id": task, "status": "lost"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    run("comment", json!({"id": task, "text": "On it"})).await;
    let (_, read) = run("task", json!({"id": task})).await;
    assert_eq!(read["result"]["comments"][0]["text"], "On it", "{read}");
    let (_, mine) = run(
        "tasks",
        json!({"assignee": "agent-1", "status": "in_progress"}),
    )
    .await;
    assert_eq!(mine["result"]["tasks"].as_array().unwrap().len(), 1);
    // Given to an agent, the agent is told in its running session; with none, it says why.
    let (_, workspace) = kernel.call(Method::GET, "/workspace", None).await;
    let owner = workspace["actors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|actor| actor["kind"] == "human")
        .unwrap()["id"]
        .clone();
    let agent: Value = kernel
        .client
        .post(format!("{}/api/actors", kernel.url))
        .json(&json!({"name": "Ada", "owner_id": owner, "harness": "pi"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let (status, given) = run("update_task", json!({"id": task, "assignee": agent["id"]})).await;
    assert_eq!(status, StatusCode::OK, "{given} {agent}");
    assert!(given["result"]["told"]["error"].is_string(), "{given}");
    // A tracker's workspace as a source: its projects and tasks read live from it, and
    // changed there; only the agent ZeroLux gives a task is kept here.
    let (status, tracker) = kernel
        .call(
            Method::POST,
            "/extensions/folder",
            Some(json!({"folder": fixture("tracker")})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{tracker}");
    let (status, refused) = run(
        "add_source",
        json!({"name": "Fake", "tracker": "fake", "config": {"workspace": "acme", "token": "wrong"}}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    let (status, added) = run(
        "add_source",
        json!({"name": "Fake", "tracker": "fake", "config": {"workspace": "acme", "token": "right"}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{added}");
    assert_eq!(added["result"]["source"]["account"], "ana@example.com");
    let source = added["result"]["source"]["id"].as_str().unwrap().to_owned();
    let (_, sources) = run("sources", json!({})).await;
    assert_eq!(
        sources["result"]["sources"].as_array().unwrap().len(),
        2,
        "{sources}"
    );
    let (_, projects) = run("projects", json!({"source": "Fake"})).await;
    let tracked = projects["result"]["projects"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(tracked, format!("{source}:ENG"));
    let (_, listed) = run("tasks", json!({"project_id": tracked})).await;
    assert_eq!(
        listed["result"]["tasks"][0]["title"], "Set up CI",
        "{listed}"
    );
    assert_eq!(listed["result"]["tasks"][0]["people"], json!(["Ana"]));
    // People are given a tracker's tasks there; an agent here.
    let (status, _) = run(
        "create_task",
        json!({"project_id": tracked, "title": "Ship", "assignee": owner}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, shipped) = run(
        "create_task",
        json!({"project_id": tracked, "title": "Ship", "assignee": agent["id"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{shipped}");
    assert_eq!(shipped["result"]["key"], "ENG-2");
    assert_eq!(shipped["result"]["assignee"], agent["id"]);
    assert!(shipped["result"]["told"]["error"].is_string(), "{shipped}");
    let shipped = shipped["result"]["id"].as_str().unwrap().to_owned();
    run("update_task", json!({"id": shipped, "status": "done"})).await;
    run("comment", json!({"id": shipped, "text": "Shipped"})).await;
    let (_, seen) = kernel
        .call(Method::POST, "/ext/zerolux.tracker/seen", Some(json!({})))
        .await;
    let remote = &seen["result"]["tasks"][1];
    assert_eq!(remote["status"], "done", "{seen}");
    assert_eq!(remote["comments"], json!(["Shipped"]));
    assert!(
        remote.get("assignee").is_none(),
        "the agent stays in ZeroLux"
    );
    let (_, read) = run("task", json!({"id": shipped})).await;
    assert_eq!(read["result"]["comments"][0]["author"], "Ana", "{read}");
    // The agent's work in every source: here and in the tracker.
    let (_, theirs) = run("tasks", json!({"assignee": agent["id"]})).await;
    let keys: Vec<&str> = theirs["result"]["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|task| task["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys.len(), 2, "{theirs}");
    assert!(keys.contains(&"ZL-1") && keys.contains(&"ENG-2"));
    // Deleted in the tracker by someone there: gone from the agent's work.
    kernel
        .call(
            Method::POST,
            "/ext/zerolux.tracker/drop",
            Some(json!({"id": "t2"})),
        )
        .await;
    let (_, theirs) = run("tasks", json!({"assignee": agent["id"]})).await;
    assert_eq!(
        theirs["result"]["tasks"].as_array().unwrap().len(),
        1,
        "{theirs}"
    );
    // Removed from ZeroLux, nothing goes in the tracker.
    let (status, _) = run("remove_source", json!({"id": source})).await;
    assert_eq!(status, StatusCode::OK);
    let (_, seen) = kernel
        .call(Method::POST, "/ext/zerolux.tracker/seen", Some(json!({})))
        .await;
    assert_eq!(seen["result"]["tasks"].as_array().unwrap().len(), 1);
    runtime.shutdown().await.unwrap();
    server.abort();
    livekit.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_proposes_an_extension_and_the_owner_enables_it() {
    use zerolux::extensions::scaffold::{Language, create};
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
    let (kernel, runtime, livekit, server, database) = kernel_for(dir.path()).await;
    let store = database.open().await;
    let owner = store.chat_identity(None).await.unwrap();
    let issued = store
        .hire_chat_session(
            &owner,
            zerolux::model::HireChatSession {
                name: "Builder".into(),
                actor_id: None,
                harness: zerolux::harness::Harness::Pi,
                native_session_id: uuid::Uuid::new_v4().to_string(),
                title: "Builder".into(),
                workspace: dir.path().to_string_lossy().into_owned(),
                native_locator: json!({}),
                resume: false,
            },
        )
        .await
        .unwrap();
    let as_agent = |method: Method, path: &str, body: Option<Value>| {
        let request = kernel
            .client
            .request(method, format!("{}/api{path}", kernel.url))
            .bearer_auth(&issued.token);
        async move {
            let request = match body {
                Some(body) => request.json(&body),
                None => request,
            };
            let response = request.send().await.unwrap();
            let status = response.status();
            (
                status,
                response.json::<Value>().await.unwrap_or(Value::Null),
            )
        }
    };
    // The agent writes an extension and proposes it: kept, not run.
    let folder = create(
        "acme.helper",
        "Helper",
        Language::Typescript,
        &dir.path().join("helper"),
    )
    .unwrap();
    let (status, proposed) = as_agent(
        Method::POST,
        "/extensions/folder",
        Some(json!({"folder": folder})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{proposed}");
    assert_eq!(proposed["extension"]["enabled"], false);
    assert_eq!(proposed["extension"]["running"], false);
    assert!(
        proposed["extension"]["proposed_by"].is_string(),
        "{proposed}"
    );
    // It cannot enable it itself, nor run what it has not.
    let (status, _) = as_agent(Method::POST, "/extensions/acme.helper/enable", None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = kernel
        .call(Method::POST, "/ext/acme.helper/hello", Some(json!({})))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // The owner enables it: it runs, and is the owner's.
    let (status, enabled) = kernel
        .call(Method::POST, "/extensions/acme.helper/enable", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{enabled}");
    assert_eq!(enabled["extension"]["running"], true);
    assert!(enabled["extension"]["proposed_by"].is_null());
    let (_, said) = kernel
        .call(
            Method::POST,
            "/ext/acme.helper/hello",
            Some(json!({"name": "Ada"})),
        )
        .await;
    assert_eq!(said["result"]["text"], "Hello, Ada");
    // Now the owner's, the agent cannot replace it.
    let (status, _) = as_agent(
        Method::POST,
        "/extensions/folder",
        Some(json!({"folder": folder})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    runtime.shutdown().await.unwrap();
    server.abort();
    livekit.shutdown().await.unwrap();
}

/// A service to sign in to, as OAuth's token endpoint: a code for tokens that expire at once,
/// then a refresh token for lasting ones. What it was sent, form by form.
async fn token_service() -> (String, Arc<std::sync::Mutex<Vec<Value>>>) {
    use axum::{Form, Json, Router, routing::post};
    let sent: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
    let app = Router::new().route(
        "/token",
        post({
            let sent = sent.clone();
            move |Form(form): Form<std::collections::HashMap<String, String>>| {
                let sent = sent.clone();
                async move {
                    sent.lock().unwrap().push(json!(form));
                    Json(match form["grant_type"].as_str() {
                        "authorization_code" if form["code"] == "code-1" => json!({
                            "access_token": "access-1", "refresh_token": "refresh-1",
                            "expires_in": 1, "token_type": "Bearer"}),
                        "refresh_token" if form["refresh_token"] == "refresh-1" => {
                            json!({"access_token": "access-2", "expires_in": 3600})
                        }
                        _ => json!({"error": "invalid_grant"}),
                    })
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, sent)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_comes_back_to_the_kernel_and_reaches_the_workspace_that_started_it() {
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
    let server = zerolux::server::Server::start(zerolux::server::ServerOptions {
        address: "127.0.0.1:0".parse().unwrap(),
        expose: None,
        data_dir: dir.path().join("first"),
        database: zerolux::db::Location::Sqlite(dir.path().join("first/zerolux.db")),
        initial_workspace_name: None,
        web_dir: dir.path().join("web"),
        livekit: Some(LiveKitConfig {
            url: None,
            api_key: None,
            api_secret: None,
            data_dir: dir.path().join("livekit"),
        }),
        public: None,
        runner: None,
        auth: None,
    })
    .await
    .unwrap();
    let second = server
        .handle()
        .add_workspace(zerolux::server::WorkspaceOptions::in_folder(
            dir.path().join("second"),
            None,
        ))
        .await
        .unwrap();
    let client = Client::builder().no_proxy().build().unwrap();
    let kernel = Kernel {
        url: server.handle().workspace_url(&second.id),
        client: client.clone(),
    };
    let (status, body) = kernel
        .call(
            Method::POST,
            "/onboarding/owner",
            Some(json!({"name": "Owner"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = kernel
        .call(
            Method::POST,
            "/extensions/folder",
            Some(json!({"folder": fixture("account")})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (service, sent) = token_service().await;
    let (status, started) = kernel
        .call(
            Method::POST,
            "/ext/zerolux.account/connect",
            Some(json!({"service": service})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{started}");
    let address = reqwest::Url::parse(started["result"]["url"].as_str().unwrap()).unwrap();
    let query: std::collections::HashMap<_, _> = address.query_pairs().into_owned().collect();
    // One address for every workspace: the kernel's own.
    let callback = format!("{}/api/extensions/oauth/callback", server.url());
    assert_eq!(query["redirect_uri"], callback);
    let page = client
        .get(format!("{callback}?state={}&code=code-1", query["state"]))
        .send()
        .await
        .unwrap();
    assert_eq!(page.status(), StatusCode::OK);
    let exchanged = sent.lock().unwrap().clone();
    assert_eq!(exchanged.len(), 1);
    assert_eq!(exchanged[0]["grant_type"], "authorization_code");
    server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_extension_keeps_secrets_and_signs_in_to_another_service() {
    // Inspect the persisted value directly on either backend, including SQLite's WAL.
    async fn stored_secret(database: &db::TestDatabase, key: &str) -> String {
        use sea_orm::{ConnectionTrait, Statement};
        let store = database.open().await;
        let db = store.db();
        let raw: String = db
            .query_one_raw(Statement::from_sql_and_values(
                db.get_database_backend(),
                "SELECT value_json FROM extension_values WHERE extension_id = $1 AND kind = 'secret' AND key = $2",
                ["zerolux.account".into(), key.into()],
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get_by_index(0)
            .unwrap();
        let sealed: String = serde_json::from_str(&raw).expect("a secret is stored sealed");
        assert!(sealed.starts_with("sealed:v1:"));
        sealed
    }

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
    let (kernel, runtime, livekit, server, database) = kernel_for(dir.path()).await;
    let (status, body) = kernel
        .call(
            Method::POST,
            "/extensions/folder",
            Some(json!({"folder": fixture("account")})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let run = |action: &'static str, input: Value| {
        let kernel = &kernel;
        async move {
            kernel
                .call(
                    Method::POST,
                    &format!("/ext/zerolux.account/{action}"),
                    Some(input),
                )
                .await
        }
    };

    // As many secrets as it needs, kept encrypted.
    let (_, kept) = run("remember", json!({"name": "work", "key": "key-of-work"})).await;
    assert_eq!(kept["result"]["names"], json!(["key:work"]), "{kept}");
    run("remember", json!({"name": "home", "key": "key-of-home"})).await;
    let (_, recalled) = run("recall", json!({"name": "home"})).await;
    assert_eq!(recalled["result"], json!({"kept": true, "length": 11}));
    let (_, left) = run("forget", json!({"name": "home"})).await;
    assert_eq!(left["result"]["names"], json!(["key:work"]));
    let stored = stored_secret(&database, "vault/key:work").await;
    assert!(
        !stored.contains("key-of-work"),
        "secrets are not kept in the clear"
    );

    // A sign-in: the person opens the service's page, which sends them back to the kernel.
    let (service, sent) = token_service().await;
    let (status, started) = run("connect", json!({"service": service})).await;
    assert_eq!(status, StatusCode::OK, "{started}");
    let address = reqwest::Url::parse(started["result"]["url"].as_str().unwrap()).unwrap();
    assert!(
        address
            .as_str()
            .starts_with(&format!("{service}/authorize"))
    );
    let query: std::collections::HashMap<_, _> = address.query_pairs().into_owned().collect();
    assert_eq!(
        query["redirect_uri"],
        format!("{}/api/extensions/oauth/callback", kernel.url)
    );
    assert_eq!(query["scope"], "read write");
    assert_eq!(query["access_type"], "offline");
    let back = |state: &str, code: &str| {
        let client = kernel.client.clone();
        let url = format!(
            "{}/api/extensions/oauth/callback?state={state}&code={code}",
            kernel.url
        );
        async move { client.get(url).send().await.unwrap() }
    };
    let page = back(&query["state"], "code-1").await;
    assert_eq!(page.status(), StatusCode::OK);
    let exchanged = sent.lock().unwrap()[0].clone();
    assert_eq!(exchanged["redirect_uri"], query["redirect_uri"].as_str());
    assert_eq!(exchanged["client_secret"], "client-secret");
    assert!(exchanged["code_verifier"].as_str().unwrap().len() >= 43);
    // Once only.
    let again = back(&query["state"], "code-1").await;
    assert_eq!(again.status(), StatusCode::OK);
    assert_eq!(
        sent.lock().unwrap().len(),
        1,
        "the code is exchanged only once"
    );
    // The extension heard of it.
    let mut heard = Value::Null;
    for _ in 0..100 {
        heard = run("heard", json!({})).await.1["result"]["heard"].clone();
        if !heard.is_null() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(heard, json!({"secret": "account:main", "ok": true}));
    // The token expired at once: it is renewed, and the renewal kept.
    let (_, token) = run("token", json!({})).await;
    assert_eq!(token["result"]["access_token"], "access-2", "{token}");
    let (_, token) = run("token", json!({})).await;
    assert_eq!(token["result"]["access_token"], "access-2");
    assert_eq!(sent.lock().unwrap().len(), 2, "renewed once");
    let stored = stored_secret(&database, "vault/account:main").await;
    assert!(!stored.contains("refresh-1") && !stored.contains("access-2"));
    drop(database);
    runtime.shutdown().await.unwrap();
    server.abort();
    livekit.shutdown().await.unwrap();
}
