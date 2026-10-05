use std::{
    collections::HashMap,
    process::Stdio,
    sync::{Arc, Mutex},
};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode, Uri},
};
use serde_json::{Value, json};
use tokio::{io::AsyncWriteExt, task::JoinHandle};
use zerolux::chat_tools::{ChatLink, send};

const CONVERSATION: &str = "f50a3c43-f27c-401c-a3d3-9a4260b5c0da";
const MESSAGE: &str = "16b311e7-d2b2-47b0-8ab1-91d2a6a096d8";
const DELIVERY: &str = "0ccf9a48-41d1-4965-88d8-03957c65eef7";
const TOKEN: &str = "fixture-private-bearer-never-output";

#[derive(Default)]
struct KernelState {
    messages: HashMap<String, Value>,
    requests: Vec<Value>,
    revoked: bool,
}

struct Kernel {
    url: String,
    state: Arc<Mutex<KernelState>>,
    task: JoinHandle<()>,
}

impl Kernel {
    async fn new() -> Self {
        let state = Arc::new(Mutex::new(KernelState::default()));
        let app = Router::new().fallback(receive).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self { url, state, task }
    }
}

impl Drop for Kernel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn receive(
    State(state): State<Arc<Mutex<KernelState>>>,
    uri: Uri,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> (StatusCode, Json<Value>) {
    assert_eq!(headers["authorization"], format!("Bearer {TOKEN}"));
    let mut state = state.lock().unwrap();
    state.requests.push(request.clone());
    if uri.path() == format!("/api/chat/deliveries/{DELIVERY}/receipt") {
        return (
            StatusCode::OK,
            Json(json!({"delivery":{"private_extra":TOKEN}})),
        );
    }
    assert_eq!(
        uri.path(),
        format!("/api/conversations/{CONVERSATION}/messages")
    );
    if state.revoked {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error":TOKEN})));
    }
    let id = request["id"].as_str().unwrap().to_owned();
    if let Some(old) = state.messages.get(&id) {
        let same = old["text"] == request["text"]
            && old["reply_to_delivery_id"] == request["reply_to_delivery_id"];
        return (
            if same {
                StatusCode::OK
            } else {
                StatusCode::CONFLICT
            },
            Json(old.clone()),
        );
    }
    let mut message = request;
    message["conversation_id"] = json!(CONVERSATION);
    message["seq"] = json!(state.messages.len() + 1);
    message["author_id"] = json!("273fd496-2b26-46fd-b5aa-4553f6a8fd12");
    message["created_at"] = json!(1);
    message["deliveries"] = json!([]);
    state.messages.insert(id, message.clone());
    // Prove extra server fields are excluded from helper output.
    message["private_extra"] = json!(TOKEN);
    (StatusCode::CREATED, Json(message))
}

fn link(url: &str) -> anyhow::Result<ChatLink> {
    ChatLink::create(
        &std::env::temp_dir().join("zerolux-test-links"),
        url,
        TOKEN,
        &uuid::Uuid::new_v4().to_string(),
    )
}

fn request() -> Value {
    json!({"conversation_id":CONVERSATION,"id":MESSAGE,"text":"Please inspect this result.", "reply_to_delivery_id":null})
}

#[test]
fn descriptor_is_private_and_lives_only_as_long_as_the_link() {
    let link = link("http://127.0.0.1:4310").unwrap();
    let path = link.path().to_owned();
    let parent = path.parent().unwrap().to_owned();
    assert!(std::fs::read_to_string(&path).unwrap().contains(TOKEN));
    assert!(!link.command().unwrap().join(" ").contains(TOKEN));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&parent).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    drop(link);
    assert!(!path.exists());
    assert!(!parent.exists());
}

#[tokio::test]
async fn explicit_recipient_and_reply_correlation_survive_idempotent_sends() {
    let kernel = Kernel::new().await;
    let link = link(&kernel.url).unwrap();
    let mut request = request();
    request["reply_to_delivery_id"] = json!(DELIVERY);
    let first = send(link.path(), request.clone()).await.unwrap();
    let repeated = send(link.path(), request.clone()).await.unwrap();
    assert_eq!(first, repeated);
    assert_eq!(first["reply_to_delivery_id"], DELIVERY);
    assert!(!first.to_string().contains(TOKEN));
    assert_eq!(kernel.state.lock().unwrap().messages.len(), 1);
    request["text"] = json!("Different text for the same ID");
    assert!(send(link.path(), request).await.is_err());
    assert_eq!(kernel.state.lock().unwrap().messages.len(), 1);
}

/// Receipts belong to the harness driver: the helper offers no way to send one.
#[tokio::test]
async fn the_helper_sends_no_receipt() {
    let kernel = Kernel::new().await;
    let link = link(&kernel.url).unwrap();
    assert!(
        send(link.path(), json!({"read_delivery_id":DELIVERY}))
            .await
            .is_err()
    );
    let state = kernel.state.lock().unwrap();
    assert!(state.requests.is_empty());
    assert!(state.messages.is_empty());
}

#[tokio::test]
async fn sender_cannot_be_overridden_and_revocation_does_not_leak_or_retry() {
    let kernel = Kernel::new().await;
    let link = link(&kernel.url).unwrap();
    let mut spoof = request();
    spoof["author_id"] = json!(TOKEN);
    let error = send(link.path(), spoof).await.unwrap_err().to_string();
    assert!(!error.contains(TOKEN));
    assert!(kernel.state.lock().unwrap().requests.is_empty());
    kernel.state.lock().unwrap().revoked = true;
    let error = send(link.path(), request()).await.unwrap_err().to_string();
    assert_eq!(error, "Chat link was revoked or expired");
    assert_eq!(kernel.state.lock().unwrap().requests.len(), 1);
    let path = link.path().to_owned();
    drop(link);
    assert!(send(&path, request()).await.is_err());
    assert_eq!(kernel.state.lock().unwrap().requests.len(), 1);
}

#[tokio::test]
async fn cli_waits_for_a_restarting_kernel_at_the_same_link_path() {
    let kernel = Kernel::new().await;
    let links = tempfile::tempdir().unwrap();
    let create = || ChatLink::create(links.path(), &kernel.url, TOKEN, "claude-code:fixture");
    let path = create().unwrap().path().to_owned();
    assert!(!path.exists(), "a stopped kernel leaves no credential");
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_zerolux"))
        .args(["chat-send", "--link"])
        .arg(&path)
        .args(["--to", CONVERSATION, "--id", MESSAGE])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"Sent while the kernel restarts.")
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    assert!(kernel.state.lock().unwrap().requests.is_empty());
    let relinked = create().unwrap();
    assert_eq!(relinked.path(), path);
    let output = child.wait_with_output().await.unwrap();
    assert!(output.status.success());
    assert_eq!(kernel.state.lock().unwrap().messages.len(), 1);
}

#[tokio::test]
async fn cli_sends_stdin_text_and_outputs_only_the_public_message() {
    let kernel = Kernel::new().await;
    let link = link(&kernel.url).unwrap();
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_zerolux"))
        .args(["chat-send", "--link"])
        .arg(link.path())
        .args(["--to", CONVERSATION, "--id", MESSAGE])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"Plain text, no JSON.\n")
        .await
        .unwrap();
    let output = child.wait_with_output().await.unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let message: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(message["id"], MESSAGE);
    assert_eq!(message["text"], "Plain text, no JSON.");
    assert!(!String::from_utf8_lossy(&output.stdout).contains(TOKEN));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(TOKEN));
}

#[test]
fn link_rejects_remote_or_redirectable_kernel_origins() {
    for url in [
        "http://127.0.0.1:4310",
        "http://[::1]:4310",
        "http://localhost:4310",
    ] {
        assert!(link(url).is_ok());
    }
    for url in [
        "https://example.com",
        "http://example.com",
        "http://user:secret@127.0.0.1",
        "http://127.0.0.1/other",
        "http://127.0.0.1?token=secret",
    ] {
        assert!(link(url).is_err());
    }
}
