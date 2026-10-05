//! Real kernel + LiveKit + pi extension, with a deterministic fake native host (NO model).
//! Every process gets a temporary HOME and its own process group; personal sessions are untouched.
#![cfg(unix)]

use nix::{
    sys::signal::{Signal, killpg},
    unistd::Pid,
};
use serde_json::{Value, json};
use std::os::unix::process::CommandExt;
use std::{
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use tokio::io::{AsyncBufReadExt, BufReader};

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let group = Pid::from_raw(self.0.id() as i32);
        let _ = killpg(group, Signal::SIGTERM);
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline {
            if self.0.try_wait().ok().flatten().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        // Also reap fixture-owned descendants if a panic prevented orderly shutdown.
        let _ = killpg(group, Signal::SIGKILL);
        let _ = self.0.wait();
    }
}
fn isolated(command: &mut Command, home: &Path, workspace: &Path, path: &std::ffi::OsStr) {
    command
        .env_clear()
        .env("PATH", path)
        .env("HOME", home)
        .env("PI_CODING_AGENT_DIR", home.join(".pi/agent"))
        .env("CODEX_HOME", home.join(".codex"))
        .env("TMPDIR", home)
        .current_dir(workspace)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
}
async fn api(client: &reqwest::Client, base: &str, path: &str, body: Option<Value>) -> Value {
    let request = if let Some(body) = body {
        client.post(format!("{base}/api{path}")).json(&body)
    } else {
        client.get(format!("{base}/api{path}"))
    };
    let response = request.send().await.expect("fixture HTTP response");
    let status = response.status();
    let text = response.text().await.unwrap();
    assert!(status.is_success(), "{path}: {status}: {text}");
    serde_json::from_str(&text).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn gui_hire_livekit_wake_and_reply_with_a_fake_pi_host() {
    if !Command::new("livekit-server")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success())
        || !Command::new("bun")
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success())
    {
        eprintln!("livekit-server/Bun unavailable: deterministic pi integration skipped");
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let workspace = root.path().join("work");
    let bin = root.path().join("bin");
    for dir in [&home, &workspace, &bin] {
        std::fs::create_dir_all(dir).unwrap();
    }
    // Even the Claude metadata probe is a fixture, never the user's installed CLI.
    let claude = bin.join("claude");
    std::fs::write(&claude, "#!/bin/sh\nprintf '[]\\n'\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = std::env::join_paths(std::iter::once(bin).chain(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    )))
    .unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../extensions/pi/src/fixtures/chat-harness.ts")
        .canonicalize()
        .unwrap();
    let mut command = Command::new("bun");
    command.arg(fixture);
    isolated(&mut command, &home, &workspace, &path);
    command.stdout(Stdio::piped());
    let mut native = Process(command.spawn().unwrap());
    // Convert the owned pipe to Tokio without ever reading a personal/native transcript.
    let stdout = native.0.stdout.take().unwrap();
    use std::os::fd::{FromRawFd, IntoRawFd};
    let file = unsafe { std::fs::File::from_raw_fd(stdout.into_raw_fd()) };
    let mut lines = BufReader::new(tokio::fs::File::from_std(file)).lines();
    let ready = tokio::time::timeout(Duration::from_secs(15), lines.next_line())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ready.as_deref(), Some("READY"));
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let base = format!("http://127.0.0.1:{port}");
    let mut command = Command::new(env!("CARGO_BIN_EXE_zerolux"));
    command
        .args(["serve", "--port", &port.to_string(), "--database"])
        .arg(root.path().join("fixture.db"))
        .arg("--web-dir")
        .arg(&workspace);
    isolated(&mut command, &home, &workspace, &path);
    let _kernel = Process(command.spawn().unwrap());
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(65))
        .build()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if client
            .get(format!("{base}/api/health"))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            break;
        }
        assert!(Instant::now() < deadline, "fixture kernel did not start");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    api(
        &client,
        &base,
        "/onboarding/owner",
        Some(json!({"name":"Fixture owner"})),
    )
    .await;
    let discovery = api(&client, &base, "/sessions", None).await;
    let pi = discovery["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["harness"] == "pi" && s["availability"] == "attachable")
        .expect("live fixture discovered");
    assert!(!discovery.to_string().contains("nonce"));
    let hired = api(
        &client,
        &base,
        "/chat/hire",
        Some(json!({"discovered_session_id":pi["id"],"name":"Fixture pi"})),
    )
    .await;
    let actor = hired["actor"]["id"].as_str().unwrap();
    let session = hired["session"]["id"].as_str().unwrap();
    let conversation = api(&client, &base, "/conversations", Some(json!({"kind":"dm","title":"Deterministic integration","members":[{"actor_id":actor,"session_id":session}]}))).await;
    let room = conversation["conversation"]["id"].as_str().unwrap();
    let message = api(&client, &base, &format!("/conversations/{room}/messages"), Some(json!({
        "id":uuid::Uuid::new_v4().to_string(),"text":"Fixture request; do not invoke a real model."}))).await;
    assert!(message["reply_to_delivery_id"].is_null());
    let deadline = Instant::now() + Duration::from_secs(20);
    let history = loop {
        let history = api(
            &client,
            &base,
            &format!("/conversations/{room}/messages"),
            None,
        )
        .await;
        if history["messages"].as_array().unwrap().len() == 2 {
            break history;
        }
        assert!(
            Instant::now() < deadline,
            "fixture did not receive/reply through LiveKit: {history}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(history["messages"][1]["author_id"], actor);
    assert_eq!(
        history["messages"][1]["text"],
        "Deterministic pi response; no model was called."
    );
    assert!(history["messages"][1]["reply_to_delivery_id"].is_string());
    assert!(!history.to_string().contains("FIXTURE_PRIVATE_THINKING"));
    nix::sys::signal::kill(Pid::from_raw(native.0.id() as i32), Signal::SIGUSR1).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let sessions = api(&client, &base, "/chat/sessions", None).await;
        if sessions["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"] == session && s["status"] == "attention")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "native off must update the kernel"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    api(
        &client,
        &base,
        &format!("/chat/sessions/{session}/stop"),
        Some(json!({})),
    )
    .await;
    assert!(
        native.0.try_wait().unwrap().is_none(),
        "Stop must not kill the native pi host"
    );
}
