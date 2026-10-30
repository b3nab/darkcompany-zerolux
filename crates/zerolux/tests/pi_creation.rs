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
#[path = "support/owner.rs"]
mod owner;

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
        .args(owner::auth_entry_args())
        .env_clear()
        .env("HOME", root.join("home"))
        .env("TMPDIR", root)
        .env(
            "PATH",
            format!(
                "{}:{}:/usr/bin:/bin",
                root.join("bin").display(),
                owner::bun_dir().display()
            ),
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
        let list = api(client, base, "/sessions", None).await;
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
        .join("../../harnesses/pi/src/fixtures/rpc-harness.ts")
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
    let base = owner::workspace(&base, &root).await;
    let client = owner::client(&base, Duration::from_secs(65)).await;
    let invalid = client
        .post(format!("{base}/api/sessions"))
        .json(&json!({"harness":"pi","name":"","workspace":"relative"}))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status(), 400);
    assert!(starts(&root).is_empty());
    let created = api(
        &client,
        &base,
        "/sessions",
        Some(json!({"harness":"pi","name":"Fixture pi","workspace":root.join("work")})),
    )
    .await;
    let session = &created["session"];
    let native = session["native_session_id"].as_str().unwrap().to_owned();
    let actor = created["actor"]["id"].as_str().unwrap().to_owned();
    let original = starts(&root);
    assert_eq!(original.len(), 1);
    assert_eq!(original[0]["native"], native);
    assert_eq!(original[0]["explicit_model"], false);
    // The session's settings are its harness's, read and changed through it.
    let settings_path = format!("/sessions/{}/settings", session["id"].as_str().unwrap());
    let settings = api(&client, &base, &settings_path, None).await;
    assert_eq!(settings["values"]["model"], "fixture/native-model");
    assert_eq!(settings["values"]["effort"], "high");
    assert_eq!(settings["models"].as_array().unwrap().len(), 2);
    let response = client
        .patch(format!("{base}/api{settings_path}"))
        .json(&json!({"model":"fixture/native-alternate", "effort":"low"}))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let changed: Value = response.json().await.unwrap();
    assert_eq!(changed["values"]["model"], "fixture/native-alternate");
    assert_eq!(changed["values"]["effort"], "low");
    // The agent's own settings are what its new sessions start with, the owner's to set.
    assert_eq!(created["actor"]["model"], Value::Null);
    assert_eq!(
        starts(&root).len(),
        1,
        "A live setting does not restart native pi"
    );
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
    assert_eq!(resumed[1]["model"], "fixture/native-alternate");
    assert_eq!(resumed[1]["effort"], "low");
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
        &format!("/sessions/{}/stop", restored["id"].as_str().unwrap()),
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
        &format!("/sessions/{}/resume", restored["id"].as_str().unwrap()),
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
            "/sessions/{}/stop",
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
        let found = api(&client, &base, "/sessions/discover", None).await;
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
        "/sessions/attach",
        Some(json!({
            "discovered_session_id":candidate.expect("terminal discovery")["id"],
            "name":"", "actor_id":actor
        })),
    )
    .await;
    assert_eq!(hired["session"]["origin"], "attached");
    assert_eq!(starts(&root).len(), 4);
    // The terminal accepts a takeover only once idle and in sync with its kernel: right
    // after Hire its link may still be syncing, so the owner's request is repeated until
    // the terminal is ready, never forced.
    let hired_id = hired["session"]["id"].as_str().unwrap();
    connected(&client, &base, &native).await;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let response = client
            .post(format!("{base}/api/sessions/{hired_id}/takeover"))
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        if status.is_success() {
            break;
        }
        assert!(
            status == 400 && Instant::now() < deadline,
            "takeover: {status}: {text}"
        );
        // Preflight refusal leaves the live terminal attached. Once takeover starts,
        // the kernel records attention before asking it to exit: never retry that intent.
        let current = api(&client, &base, &format!("/sessions/{hired_id}"), None).await;
        assert_eq!(current["session"]["status"], "connected", "{text}");
        assert_eq!(current["session"]["origin"], "attached");
        assert_eq!(current["session"]["native_session_id"], native);
        assert!(terminal.0.try_wait().unwrap().is_none());
        assert_eq!(starts(&root).len(), 4);
        assert_eq!(
            fs::read(root.join("home/native-inputs.jsonl")).unwrap(),
            inputs
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
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
        &format!("/sessions/{}/stop", taken["id"].as_str().unwrap()),
        Some(json!({})),
    )
    .await;

    let configured = api(&client, &base, "/sessions", Some(json!({"harness":"pi",
        "name":"", "actor_id":actor, "workspace":root.join("work"), "model":"fixture/native-model", "effort":"medium"
    }))).await;
    assert_ne!(configured["session"]["native_session_id"], native);
    assert_eq!(configured["actor"]["id"], actor);
    assert_eq!(starts(&root)[5]["model"], "fixture/native-model");
    assert_eq!(starts(&root)[5]["effort"], "medium");
    assert_eq!(
        fs::read(root.join("home/native-inputs.jsonl")).unwrap(),
        inputs
    );
    api(
        &client,
        &base,
        &format!(
            "/sessions/{}/stop",
            configured["session"]["id"].as_str().unwrap()
        ),
        Some(json!({})),
    )
    .await;

    // A native guard failure retains the known identity, rather than minting/retrying another.
    fs::write(root.join("home/no-auth"), "fixture").unwrap();
    let failure = client
        .post(format!("{base}/api/sessions"))
        .json(&json!({"harness":"pi","name":"Unavailable auth", "workspace":root.join("work")}))
        .send()
        .await
        .unwrap();
    assert_eq!(failure.status(), 502);
    let failure: Value = failure.json().await.unwrap();
    let failed_starts = starts(&root);
    assert_eq!(failed_starts.len(), 7);
    assert_eq!(failure["native_session_id"], failed_starts[6]["native"]);
    assert!(failure["native_session_id"].is_string());
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(starts(&root).len(), 7);
    assert_eq!(
        fs::read(root.join("home/native-inputs.jsonl")).unwrap(),
        inputs
    );
}

/// A pi session on a person's computer joined to the workspace: that computer starts pi under
/// its own runner, with its own pi, and the runner's integration links to the kernel.
#[tokio::test(flavor = "multi_thread")]
async fn a_pi_session_runs_on_a_joined_computer() {
    let temporary = tempfile::Builder::new()
        .prefix("zph-")
        .tempdir_in("/tmp")
        .unwrap();
    let root = temporary.path().canonicalize().unwrap();
    for name in ["home", "laptop", "work", "bin"] {
        fs::create_dir_all(root.join(name)).unwrap();
    }
    for name in ["bun", "livekit-server"] {
        symlink(executable(name), root.join("bin").join(name)).unwrap();
    }
    script(&root.join("bin/claude"), "#!/bin/sh\nprintf '[]\\n'\n");
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../harnesses/pi/src/fixtures/rpc-harness.ts")
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
    let _hosts = Hosts(root.join("joined/links/pi"));
    let _diagnostics = Diagnostics(root.clone());
    let _joined = Diagnostics(root.join("joined"));
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let base = format!("http://127.0.0.1:{port}");
    let plain = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(65))
        .build()
        .unwrap();
    let _kernel = start(&root, port);
    ready(&plain, &base).await;
    let base = owner::workspace(&base, &root).await;
    let client = owner::client(&base, Duration::from_secs(65)).await;
    let linked = api(&client, &base, "/hosts/link", Some(json!({}))).await;
    let host = linked["host"]["id"].as_str().unwrap().to_owned();
    // The computer runs as its own user would: its own home, its own pi.
    let computer = |args: &[&str]| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_zerolux"));
        command
            .arg("host")
            .arg("--data-dir")
            .arg(root.join("joined"))
            .args(args)
            .env_clear()
            .env("HOME", root.join("laptop"))
            .env("TMPDIR", &root)
            .env(
                "PATH",
                format!(
                    "{}:{}:/usr/bin:/bin",
                    root.join("bin").display(),
                    owner::bun_dir().display()
                ),
            )
            .current_dir(root.join("work"))
            .process_group(0)
            .stdin(Stdio::null());
        command
    };
    let joined = computer(&["join", &base, linked["code"].as_str().unwrap()])
        .output()
        .unwrap();
    assert!(joined.status.success(), "{joined:?}");
    let log = fs::File::create(root.join("joined.log")).unwrap();
    let _running = Kernel(
        computer(&["run"])
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .spawn()
            .unwrap(),
    );
    let mut online = false;
    for _ in 0..200 {
        let hosts = api(&client, &base, "/hosts", None).await;
        if hosts["hosts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|h| h["id"] == host && h["online"] == true)
        {
            online = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        online,
        "{}",
        fs::read_to_string(root.join("joined.log")).unwrap()
    );
    let created = api(
        &client,
        &base,
        "/sessions",
        Some(json!({"harness":"pi","workspace":root.join("work"),"host":host})),
    )
    .await;
    let native = created["session"]["native_session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(created["session"]["host_id"], host);
    // Started with the computer's own pi, not the kernel's.
    assert!(starts(&root).is_empty());
    assert_eq!(
        fs::read_to_string(root.join("laptop/native-starts.jsonl"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    let session = connected(&client, &base, &native).await;
    let id = session["id"].as_str().unwrap();
    // Its record is read on the computer, where pi keeps it.
    let events = api(&client, &base, &format!("/sessions/{id}/events"), None).await;
    assert!(events["events"].is_array(), "{events}");
    // A fork is made there by pi and opened there.
    let forked = client
        .post(format!("{base}/api/sessions/{id}/fork"))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    let status = forked.status();
    let forked: Value = forked.json().await.unwrap();
    assert!(status.is_success(), "{forked}");
    assert_eq!(forked["session"]["host_id"], host);
    // Its controls reach its integration there, also after that computer's ZeroLux restarts.
    let interrupted = api(
        &client,
        &base,
        &format!("/sessions/{id}/interrupt"),
        Some(json!({})),
    )
    .await;
    assert_eq!(interrupted["interrupted"], false, "{interrupted}");
    drop(_running);
    let log = fs::OpenOptions::new()
        .append(true)
        .open(root.join("joined.log"))
        .unwrap();
    let _running = Kernel(
        computer(&["run"])
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .spawn()
            .unwrap(),
    );
    let mut again = Value::Null;
    for _ in 0..200 {
        let answer = client
            .post(format!("{base}/api/sessions/{id}/interrupt"))
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        if answer.status().is_success() {
            again = answer.json().await.unwrap();
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(again["interrupted"], false, "{again}");
    api(
        &client,
        &base,
        &format!("/sessions/{id}/stop"),
        Some(json!({})),
    )
    .await;
}
