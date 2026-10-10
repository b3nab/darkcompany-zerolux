//! Production pi creation/reconnect path; isolated fake native pi, real extension, no model.
#![cfg(unix)]
use nix::{
    sys::signal::{Signal, kill, killpg},
    unistd::Pid,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{
        fs::{PermissionsExt, symlink},
        net::UnixStream,
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

struct Kernel(Child);
impl Drop for Kernel {
    fn drop(&mut self) {
        let _ = killpg(Pid::from_raw(self.0.id() as i32), Signal::SIGTERM);
        let _ = self.0.wait();
    }
}
struct Diagnostics(PathBuf);
impl Drop for Diagnostics {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            return;
        }
        eprintln!(
            "Fixture kernel: {}",
            fs::read_to_string(self.0.join("kernel.log")).unwrap_or_default()
        );
        if let Ok(files) = fs::read_dir(self.0.join("links/pi")) {
            for file in files.flatten() {
                if file.path().extension().and_then(|x| x.to_str()) == Some("log") {
                    eprintln!(
                        "Fixture host: {}",
                        fs::read_to_string(file.path()).unwrap_or_default()
                    );
                }
            }
        }
    }
}
struct Hosts(PathBuf);
impl Drop for Hosts {
    fn drop(&mut self) {
        let Ok(files) = fs::read_dir(&self.0) else {
            return;
        };
        for file in files.flatten() {
            if file.path().extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(bytes) = fs::read(file.path()) else {
                continue;
            };
            let Ok(d) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            let Some(endpoint) = d["endpoint"].as_str() else {
                continue;
            };
            // Authenticate the fixture's still-live host before touching its process group.
            let Ok(mut socket) = UnixStream::connect(endpoint) else {
                continue;
            };
            let _ = socket.set_read_timeout(Some(Duration::from_secs(1)));
            if writeln!(
                socket,
                "{}",
                json!({"method":"describe","nonce":d["nonce"]})
            )
            .is_err()
            {
                continue;
            }
            let mut line = String::new();
            if BufReader::new(socket).read_line(&mut line).is_err() {
                continue;
            }
            let Ok(reply) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if reply["instance_id"] == d["instance_id"]
                && reply["native_session_id"] == d["native_session_id"]
                && let Some(pid) = d["pid"].as_i64()
            {
                let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGTERM);
            }
        }
    }
}
fn executable(name: &str) -> PathBuf {
    let output = Command::new("/usr/bin/which").arg(name).output().unwrap();
    assert!(
        output.status.success(),
        "Install {name} for isolated integration tests"
    );
    PathBuf::from(String::from_utf8(output.stdout).unwrap().trim())
}
fn script(path: &Path, body: &str) {
    fs::write(path, body).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
fn start(root: &Path, port: u16) -> Kernel {
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("kernel.log"))
        .unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_zerolux"))
        .args(["serve", "--port", &port.to_string(), "--database"])
        .arg(root.join("fixture.db"))
        .arg("--web-dir")
        .arg(root.join("work"))
        .env_clear()
        .env("HOME", root.join("home"))
        .env("TMPDIR", root)
        .env(
            "PATH",
            format!("{}:/usr/bin:/bin", root.join("bin").display()),
        )
        .env("CODEX_HOME", root.join("home/.codex"))
        .env("CLAUDE_CONFIG_DIR", root.join("home/.claude"))
        .current_dir(root.join("work"))
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log))
        .spawn()
        .unwrap();
    Kernel(child)
}
async fn api(client: &reqwest::Client, base: &str, path: &str, body: Option<Value>) -> Value {
    let request = body.map_or_else(
        || client.get(format!("{base}/api{path}")),
        |b| client.post(format!("{base}/api{path}")).json(&b),
    );
    let response = request.send().await.unwrap();
    let status = response.status();
    let text = response.text().await.unwrap();
    assert!(status.is_success(), "{path}: {status}: {text}");
    serde_json::from_str(&text).unwrap()
}
async fn ready(client: &reqwest::Client, base: &str) {
    for _ in 0..200 {
        if client
            .get(format!("{base}/api/health"))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("fixture kernel readiness");
}
fn starts(root: &Path) -> Vec<Value> {
    fs::read_to_string(root.join("home/native-starts.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}
async fn connected(client: &reqwest::Client, base: &str, native: &str) -> Value {
    for _ in 0..200 {
        let list = api(client, base, "/chat/sessions", None).await;
        if let Some(session) = list["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["native_session_id"] == native && s["status"] == "connected")
        {
            return session.clone();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("pi reconnect did not complete");
}

#[tokio::test(flavor = "multi_thread")]
async fn creation_and_both_restart_paths_keep_one_native_identity_without_replaying_input() {
    // macOS sockaddr_un is short; even a canonicalized TMPDIR must fit its socket path.
    let temporary = tempfile::Builder::new()
        .prefix("zpi-")
        .tempdir_in("/tmp")
        .unwrap();
    let root = temporary.path().canonicalize().unwrap();
    for name in ["home", "work", "bin"] {
        fs::create_dir_all(root.join(name)).unwrap();
    }
    for name in ["bun", "livekit-server"] {
        symlink(executable(name), root.join("bin").join(name)).unwrap();
    }
    script(&root.join("bin/claude"), "#!/bin/sh\nprintf '[]\\n'\n");
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../extensions/pi/src/fixtures/rpc-harness.ts")
        .canonicalize()
        .unwrap();
    script(
        &root.join("bin/pi"),
        &format!(
            "#!/bin/sh\nexec '{}' '{}' \"$@\"\n",
            executable("bun").display(),
            fixture.display()
        ),
    );
    let _hosts = Hosts(root.join("links/pi"));
    let _diagnostics = Diagnostics(root.clone());
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let base = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(65))
        .build()
        .unwrap();
    let kernel = start(&root, port);
    ready(&client, &base).await;
    api(
        &client,
        &base,
        "/onboarding/owner",
        Some(json!({"name":"Fixture owner"})),
    )
    .await;
    let invalid = client
        .post(format!("{base}/api/chat/pi-sessions"))
        .json(&json!({"name":"","workspace":"relative"}))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status(), 400);
    assert!(starts(&root).is_empty());
    let created = api(
        &client,
        &base,
        "/chat/pi-sessions",
        Some(json!({"name":"Fixture pi","workspace":root.join("work")})),
    )
    .await;
    let session = &created["session"];
    let native = session["native_session_id"].as_str().unwrap().to_owned();
    let actor = created["actor"]["id"].as_str().unwrap().to_owned();
    let original = starts(&root);
    assert_eq!(original.len(), 1);
    assert_eq!(original[0]["native"], native);
    assert_eq!(original[0]["explicit_model"], false);
    assert!(
        !root.join("home/native-inputs.jsonl").exists(),
        "creation submitted a synthetic prompt"
    );
    let conversation=api(&client,&base,"/conversations",Some(json!({"kind":"dm","title":"Fixture","members":[{"actor_id":actor,"session_id":session["id"]}]}))).await;
    let room = conversation["conversation"]["id"].as_str().unwrap();
    api(
        &client,
        &base,
        &format!("/conversations/{room}/messages"),
        Some(json!({"id":uuid::Uuid::new_v4().to_string(),"text":"Authorized fixture message"})),
    )
    .await;
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let history = api(
            &client,
            &base,
            &format!("/conversations/{room}/messages"),
            None,
        )
        .await;
        if history["messages"].as_array().unwrap().len() == 2 {
            assert_eq!(history["messages"][1]["author_id"], actor);
            break;
        }
        assert!(Instant::now() < deadline, "fixture reply missing");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let inputs = fs::read(root.join("home/native-inputs.jsonl")).unwrap();
    let history = fs::read(original[0]["file"].as_str().unwrap()).unwrap();
    drop(kernel); // Kernel lifetime never owns native RPC stdin.
    assert!(
        kill(
            Pid::from_raw(original[0]["pid"].as_i64().unwrap() as i32),
            None
        )
        .is_ok()
    );
    let kernel = start(&root, port);
    ready(&client, &base).await;
    let rebound = connected(&client, &base, &native).await;
    assert_eq!(rebound["actor_id"], actor);
    assert_eq!(starts(&root), original);
    assert_eq!(
        fs::read(root.join("home/native-inputs.jsonl")).unwrap(),
        inputs
    );
    // Certainly dead native execution: the normal reconnect loop restores the same file.
    kill(
        Pid::from_raw(original[0]["pid"].as_i64().unwrap() as i32),
        Signal::SIGTERM,
    )
    .unwrap();
    for _ in 0..200 {
        if starts(&root).len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let restored = connected(&client, &base, &native).await;
    let resumed = starts(&root);
    assert_eq!(resumed.len(), 2);
    assert_eq!(resumed[1]["native"], native);
    assert_eq!(resumed[1]["file"], original[0]["file"]);
    assert_eq!(resumed[1]["explicit_model"], true);
    assert!(
        fs::read(resumed[1]["file"].as_str().unwrap())
            .unwrap()
            .starts_with(&history)
    );
    assert_eq!(
        fs::read(root.join("home/native-inputs.jsonl")).unwrap(),
        inputs
    );
    api(
        &client,
        &base,
        &format!("/chat/sessions/{}/stop", restored["id"].as_str().unwrap()),
        Some(json!({})),
    )
    .await;
    drop(kernel);
    let _kernel = start(&root, port);
    ready(&client, &base).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(starts(&root).len(), 2, "owner Stop was undone by recovery");
    let resumed = api(
        &client,
        &base,
        &format!("/chat/sessions/{}/resume", restored["id"].as_str().unwrap()),
        Some(json!({})),
    )
    .await;
    assert_eq!(resumed["session"]["native_session_id"], native);
    assert_eq!(resumed["session"]["origin"], "owned");
    assert_eq!(resumed["actor"]["id"], actor);
    assert_eq!(
        resumed["actor"]["created_at"],
        created["actor"]["created_at"]
    );
    assert_eq!(starts(&root).len(), 3);
    assert_eq!(
        fs::read(root.join("home/native-inputs.jsonl")).unwrap(),
        inputs
    );
    api(
        &client,
        &base,
        &format!(
            "/chat/sessions/{}/stop",
            resumed["session"]["id"].as_str().unwrap()
        ),
        Some(json!({})),
    )
    .await;
    // The same saved context is opened by an isolated terminal fixture. Explicit owner
    // takeover closes that terminal cooperatively, then ordinary recovery owns the launch.
    let log = fs::File::create(root.join("terminal.log")).unwrap();
    let mut terminal = Kernel(
        Command::new(root.join("bin/pi"))
            .arg("--session")
            .arg(original[0]["file"].as_str().unwrap())
            .env_clear()
            .env("HOME", root.join("home"))
            .env("TMPDIR", &root)
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", root.join("bin").display()),
            )
            .current_dir(root.join("work"))
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .spawn()
            .unwrap(),
    );
    let mut candidate = None;
    for _ in 0..100 {
        let found = api(&client, &base, "/sessions", None).await;
        candidate = found["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["native_session_id"] == native && s["availability"] == "attachable")
            .cloned();
        if candidate.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let hired = api(
        &client,
        &base,
        "/chat/hire",
        Some(json!({
            "discovered_session_id":candidate.expect("terminal discovery")["id"],
            "name":"", "actor_id":actor
        })),
    )
    .await;
    assert_eq!(hired["session"]["origin"], "attached");
    assert_eq!(starts(&root).len(), 4);
    api(
        &client,
        &base,
        &format!(
            "/chat/sessions/{}/takeover",
            hired["session"]["id"].as_str().unwrap()
        ),
        Some(json!({})),
    )
    .await;
    assert!(terminal.0.wait().unwrap().success());
    let taken = connected(&client, &base, &native).await;
    assert_eq!(taken["actor_id"], actor);
    assert_eq!(taken["origin"], "owned");
    assert_eq!(starts(&root).len(), 5);
    assert_eq!(starts(&root)[4]["file"], original[0]["file"]);
    assert_eq!(
        fs::read(root.join("home/native-inputs.jsonl")).unwrap(),
        inputs
    );
    api(
        &client,
        &base,
        &format!("/chat/sessions/{}/stop", taken["id"].as_str().unwrap()),
        Some(json!({})),
    )
    .await;

    // A native guard failure retains the known identity, rather than minting/retrying another.
    fs::write(root.join("home/no-auth"), "fixture").unwrap();
    let failure = client
        .post(format!("{base}/api/chat/pi-sessions"))
        .json(&json!({"name":"Unavailable auth", "workspace":root.join("work")}))
        .send()
        .await
        .unwrap();
    assert_eq!(failure.status(), 502);
    let failure: Value = failure.json().await.unwrap();
    let failed_starts = starts(&root);
    assert_eq!(failed_starts.len(), 6);
    assert_eq!(failure["native_session_id"], failed_starts[5]["native"]);
    assert!(failure["native_session_id"].is_string());
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(starts(&root).len(), 6);
    assert_eq!(
        fs::read(root.join("home/native-inputs.jsonl")).unwrap(),
        inputs
    );
}
