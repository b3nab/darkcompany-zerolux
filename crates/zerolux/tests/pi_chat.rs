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

/// A fixture pi host, started once; kernels come and go around it.
struct Host {
    root: tempfile::TempDir,
    home: std::path::PathBuf,
    workspace: std::path::PathBuf,
    path: std::ffi::OsString,
    native: Process,
}

async fn fixture_host() -> Option<Host> {
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
        return None;
    }
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let workspace = root.path().join("work");
    let bin = root.path().join("bin");
    for dir in [&home, &workspace, &bin] {
        std::fs::create_dir_all(dir).unwrap();
    }
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
    let stdout = native.0.stdout.take().unwrap();
    use std::os::fd::{FromRawFd, IntoRawFd};
    let file = unsafe { std::fs::File::from_raw_fd(stdout.into_raw_fd()) };
    let mut lines = BufReader::new(tokio::fs::File::from_std(file)).lines();
    let ready = tokio::time::timeout(Duration::from_secs(15), lines.next_line())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ready.as_deref(), Some("READY"));
    Some(Host {
        root,
        home,
        workspace,
        path,
        native,
    })
}

/// One kernel over its own database; dropping it ends the process like a crash would.
struct Kernel {
    base: String,
    /// Held for the process group: dropping it ends the kernel.
    _process: Process,
}

async fn kernel(host: &Host, database: &Path, port: u16) -> Kernel {
    let base = format!("http://127.0.0.1:{port}");
    let mut command = Command::new(env!("CARGO_BIN_EXE_zerolux"));
    command
        .args(["serve", "--port", &port.to_string(), "--database"])
        .arg(database)
        .arg("--web-dir")
        .arg(&host.workspace);
    isolated(&mut command, &host.home, &host.workspace, &host.path);
    let process = Process(command.spawn().unwrap());
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
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
    Kernel {
        base,
        _process: process,
    }
}

fn free_port() -> u16 {
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    port
}

async fn session_status(client: &reqwest::Client, base: &str, session: &str) -> String {
    let sessions = api(client, base, "/chat/sessions", None).await;
    sessions["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == session)
        .map(|s| s["status"].as_str().unwrap().to_owned())
        .unwrap_or_default()
}

async fn wait_status(client: &reqwest::Client, base: &str, session: &str, expected: &str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let status = session_status(client, base, session).await;
        if status == expected {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "session {session} at {base} is {status:?}, expected {expected:?}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn hire_pi(client: &reqwest::Client, base: &str) -> (String, String) {
    api(
        client,
        base,
        "/onboarding/owner",
        Some(json!({"name":"Fixture owner"})),
    )
    .await;
    let discovery = api(client, base, "/sessions", None).await;
    let pi = discovery["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["harness"] == "pi" && s["availability"] == "attachable")
        .expect("live fixture discovered as attachable");
    let hired = api(
        client,
        base,
        "/chat/hire",
        Some(json!({"discovered_session_id":pi["id"],"name":"Fixture pi"})),
    )
    .await;
    (
        hired["actor"]["id"].as_str().unwrap().to_owned(),
        hired["session"]["id"].as_str().unwrap().to_owned(),
    )
}

/// One message in one workspace's chat: the pi fixture must answer it there, and only there.
async fn round_trip(client: &reqwest::Client, base: &str, actor: &str, session: &str, title: &str) {
    let conversation = api(
        client,
        base,
        "/conversations",
        Some(
            json!({"kind":"dm","title":title,"members":[{"actor_id":actor,"session_id":session}]}),
        ),
    )
    .await;
    let room = conversation["conversation"]["id"].as_str().unwrap();
    api(client, base, &format!("/conversations/{room}/messages"), Some(json!({
        "id":uuid::Uuid::new_v4().to_string(),"text":"Fixture request; do not invoke a real model."}))).await;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let history = api(
            client,
            base,
            &format!("/conversations/{room}/messages"),
            None,
        )
        .await;
        if history["messages"].as_array().unwrap().len() == 2 {
            assert_eq!(history["messages"][1]["author_id"], actor);
            assert!(history["messages"][1]["reply_to_delivery_id"].is_string());
            return;
        }
        assert!(Instant::now() < deadline, "no reply in {title}: {history}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn one_pi_session_works_in_two_workspaces_and_a_kernel_restart_keeps_both() {
    let Some(mut host) = fixture_host().await else {
        return;
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(65))
        .build()
        .unwrap();
    let (db_a, db_b) = (host.root.path().join("a.db"), host.root.path().join("b.db"));
    let port_a = free_port();
    // Workspace A hires the pi session; workspace B hires the very same one while A holds it.
    let a = kernel(&host, &db_a, port_a).await;
    let (actor_a, session_a) = hire_pi(&client, &a.base).await;
    wait_status(&client, &a.base, &session_a, "connected").await;
    let b = kernel(&host, &db_b, free_port()).await;
    let (actor_b, session_b) = hire_pi(&client, &b.base).await;
    wait_status(&client, &b.base, &session_b, "connected").await;
    assert_eq!(
        session_status(&client, &a.base, &session_a).await,
        "connected"
    );
    // Each workspace talks to the agent in its own chats; replies land where they were asked.
    round_trip(&client, &a.base, &actor_a, &session_a, "Workspace A").await;
    round_trip(&client, &b.base, &actor_b, &session_b, "Workspace B").await;
    // A restarts: it relinks its own link; B's link is untouched and still answers.
    drop(a);
    let a = kernel(&host, &db_a, port_a).await;
    let relinked = {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let sessions = api(&client, &a.base, "/chat/sessions", None).await;
            let connected = sessions["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|s| s["status"] == "connected")
                .map(|s| s["id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>();
            if connected.len() == 1 {
                break connected[0].clone();
            }
            assert!(Instant::now() < deadline, "A did not relink: {sessions}");
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    };
    assert_eq!(
        session_status(&client, &b.base, &session_b).await,
        "connected"
    );
    round_trip(
        &client,
        &b.base,
        &actor_b,
        &session_b,
        "Workspace B after A restarted",
    )
    .await;
    round_trip(
        &client,
        &a.base,
        &actor_a,
        &relinked,
        "Workspace A relinked",
    )
    .await;
    // A goes away for good: B keeps its agent, and the native host is never killed.
    drop(a);
    round_trip(&client, &b.base, &actor_b, &session_b, "Workspace B alone").await;
    drop(b);
    assert!(host.native.0.try_wait().unwrap().is_none());
}
