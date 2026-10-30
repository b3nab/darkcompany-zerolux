//! Terminal-origin Claude recovery through real discovery/hire/reconnect, with fake native
//! processes and history. No real Claude executable, model, credentials or personal session.
#![cfg(unix)]

use nix::{
    sys::signal::{Signal, killpg},
    unistd::Pid,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
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
    time::Duration,
};

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = killpg(Pid::from_raw(self.0.id() as i32), Signal::SIGTERM);
        }
        let _ = self.0.wait();
    }
}
struct Terminal {
    process: Process,
    socket: PathBuf,
}
impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.process.0.kill();
        let _ = self.process.0.wait();
        let _ = fs::remove_file(&self.socket);
    }
}
struct Hosts(PathBuf);
impl Drop for Hosts {
    fn drop(&mut self) {
        let Ok(entries) = fs::read_dir(&self.0) else {
            return;
        };
        for entry in entries.flatten() {
            if entry.path().extension().and_then(|v| v.to_str()) != Some("json") {
                continue;
            }
            let Ok(bytes) = fs::read(entry.path()) else {
                continue;
            };
            let Ok(d) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            let Some(endpoint) = d["endpoint"].as_str() else {
                continue;
            };
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
    std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
        .unwrap_or_else(|| panic!("Install {name} for isolated integration tests"))
        .canonicalize()
        .unwrap()
}
fn script(path: &Path, body: &str) {
    fs::write(path, body).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
fn isolated(command: &mut Command, root: &Path) {
    command
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
        .stdin(Stdio::null());
}
fn start(root: &Path, port: u16) -> Process {
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("kernel.log"))
        .unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_zerolux"));
    command
        .args(["serve", "--port", &port.to_string(), "--database"])
        .arg(root.join("fixture.db"))
        .arg("--web-dir")
        .arg(root.join("work"))
        .args(owner::auth_entry_args());
    isolated(&mut command, root);
    Process(
        command
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .spawn()
            .unwrap(),
    )
}
async fn ready(client: &reqwest::Client, base: &str) {
    for _ in 0..400 {
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
    panic!("Fixture kernel did not start");
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
async fn wait(
    client: &reqwest::Client,
    base: &str,
    path: &str,
    predicate: impl Fn(&Value) -> bool,
) -> Value {
    tokio::time::timeout(Duration::from_secs(35), async {
        loop {
            let value = api(client, base, path, None).await;
            if predicate(&value) {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("Fixture state did not settle at {path}"))
}
async fn until(predicate: impl Fn() -> bool) {
    for _ in 0..400 {
        if predicate() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("Fixture process did not reach the expected state");
}
fn trace(root: &Path) -> Vec<Value> {
    fs::read_to_string(root.join("work/runner-trace.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn entrusted_terminal_is_resumed_after_exit_without_changing_context() {
    let temporary = tempfile::Builder::new()
        .prefix("zct-")
        .tempdir_in("/tmp")
        .unwrap();
    let root = temporary.path().canonicalize().unwrap();
    for dir in ["bin", "home", "work"] {
        fs::create_dir(root.join(dir)).unwrap();
    }
    let bun = executable("bun");
    symlink(
        executable("livekit-server"),
        root.join("bin/livekit-server"),
    )
    .unwrap();
    script(&root.join("bin/codex"), "#!/bin/sh\nexit 1\n");
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../harnesses/claude/src/fixtures")
        .canonicalize()
        .unwrap();
    script(
        &root.join("bin/bun"),
        &format!(
            "#!/bin/sh\ncase \"$1\" in */harnesses/claude/src/runner.ts) shift; exec \"{}\" \"{}\" \"$@\" ;; *) exec \"{}\" \"$@\" ;; esac\n",
            bun.display(),
            fixtures.join("owned-harness.ts").display(),
            bun.display()
        ),
    );
    let native = uuid::Uuid::new_v4().to_string();
    let workspace = root.join("work");
    let mut command = Command::new(&bun);
    command
        .arg(fixtures.join("terminal-harness.ts"))
        .arg(&workspace)
        .arg(&native);
    isolated(&mut command, &root);
    let child = command
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let pid = child.id();
    let mut terminal = Terminal {
        process: Process(child),
        socket: format!("/tmp/cc-socks/{pid}.sock").into(),
    };
    until(|| workspace.join("terminal-ready").is_file()).await;
    script(
        &root.join("bin/claude"),
        &format!(
            "#!/bin/sh\nprintf '%s\\n' '{}'\n",
            json!([
                {"sessionId":native,"cwd":workspace,"pid":pid,"kind":"interactive","name":"Terminal fixture"}
            ])
        ),
    );
    let _hosts = Hosts(root.join("links/claude"));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let base = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(75))
        .build()
        .unwrap();
    let kernel = start(&root, port);
    ready(&client, &base).await;
    let base = owner::workspace(&base, &root).await;
    let client = owner::client(&base, Duration::from_secs(75)).await;
    let discovered = api(&client, &base, "/sessions/discover", None).await;
    let candidate = discovered["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["native_session_id"] == native && s["availability"] == "attachable")
        .unwrap();
    let hired = api(
        &client,
        &base,
        "/sessions/attach",
        Some(json!({"discovered_session_id":candidate["id"],"name":"Entrusted Claude"})),
    )
    .await;
    let original = hired["session"]["id"].as_str().unwrap();
    let actor = hired["actor"]["id"].as_str().unwrap();
    assert_eq!(hired["session"]["origin"], "attached");
    assert!(
        trace(&root).is_empty(),
        "Hire must not launch a managed session"
    );
    assert!(!root.join(format!("links/claude/{native}.lock")).exists());
    let chat = api(&client, &base, "/conversations", Some(json!({"kind":"dm","title":"Terminal continuity","members":[{"actor_id":actor,"session_id":original}]}))).await;
    let messages = format!(
        "/conversations/{}/messages",
        chat["conversation"]["id"].as_str().unwrap()
    );
    api(&client, &base, &messages, Some(json!({"id":uuid::Uuid::new_v4().to_string(),"text":"Input delivered in the terminal."}))).await;
    wait(&client, &base, &messages, |v| {
        v["messages"][0]["deliveries"][0]["status"] == "read"
    })
    .await;
    assert!(trace(&root).is_empty());
    let history = root.join(format!(
        "home/.claude/projects/terminal-fixture/{native}.jsonl"
    ));
    let before = fs::read(&history).unwrap();
    let history_hash = format!("{:x}", Sha256::digest(&before));
    terminal.process.0.kill().unwrap();
    terminal.process.0.wait().unwrap();
    assert!(
        terminal.socket.exists(),
        "Leave a stale native inbox, as a terminal crash can"
    );
    // No Resume call, manual relink or kernel restart: the production reconnect loop acts.
    // The same session continues, now through the owned runner.
    let sessions = wait(&client, &base, "/sessions", |v| {
        v["sessions"].as_array().unwrap().iter().any(|s| {
            s["native_session_id"] == native && s["origin"] == "owned" && s["status"] == "connected"
        })
    })
    .await;
    let resumed = sessions["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["status"] == "connected")
        .unwrap();
    let id = resumed["id"].as_str().unwrap();
    assert_eq!(id, original, "one session per native context");
    assert_eq!(resumed["native_session_id"], native);
    assert_eq!(resumed["actor_id"], actor);
    assert_eq!(resumed["workspace"], workspace.to_str().unwrap());
    assert_eq!(resumed["origin"], "owned");
    until(|| trace(&root).iter().any(|r| r["event"] == "start")).await;
    let rows = trace(&root);
    let starts: Vec<_> = rows.iter().filter(|r| r["event"] == "start").collect();
    assert_eq!(starts.len(), 1);
    assert_eq!(starts[0]["resume"], true);
    assert_eq!(
        starts[0]["mode"], "auto",
        "Recovery must preserve the native terminal's mode"
    );
    assert_eq!(starts[0]["session"], native);
    assert_eq!(starts[0]["history"], history_hash);
    assert!(
        !rows.iter().any(|r| r["event"] == "input"),
        "No startup prompt or old-input replay"
    );
    assert_eq!(fs::read(&history).unwrap(), before);
    let messages_now = api(&client, &base, &messages, None).await;
    assert_eq!(
        messages_now["messages"][0]["deliveries"][0]["status"],
        "read"
    );
    api(&client, &base, &messages, Some(json!({"id":uuid::Uuid::new_v4().to_string(),"text":"Fresh input after terminal closure."}))).await;
    let approvals = wait(&client, &base, "/chat/approvals", |v| {
        v["approvals"].as_array().is_some_and(|a| !a.is_empty())
    })
    .await;
    api(
        &client,
        &base,
        &format!(
            "/chat/approvals/{}/decision",
            approvals["approvals"][0]["id"].as_str().unwrap()
        ),
        Some(json!({"decision":"allow"})),
    )
    .await;
    wait(&client, &base, &messages, |v| {
        v["messages"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|r| r["text"] == "Fixture operation done."))
    })
    .await;
    let stopped = api(
        &client,
        &base,
        &format!("/sessions/{id}/stop"),
        Some(json!({})),
    )
    .await;
    assert!(stopped["session"]["attention_reason"].is_null());
    drop(kernel);
    let _kernel = start(&root, port);
    ready(&client, &base).await;
    // Longer than the server's reconnect interval: explicit Stop stays stopped.
    tokio::time::sleep(Duration::from_secs(11)).await;
    let sessions = api(&client, &base, "/sessions", None).await;
    assert!(
        sessions["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["status"] == "stopped")
    );
    assert_eq!(
        trace(&root)
            .iter()
            .filter(|r| r["event"] == "start")
            .count(),
        1
    );
}
