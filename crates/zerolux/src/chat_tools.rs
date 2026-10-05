//! Explicit chat sending for existing harnesses. No model work, polling, or native-history export.
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, anyhow, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

const MAX_REQUEST: u64 = 1024 * 1024;
const MAX_DESCRIPTOR: u64 = 16 * 1024;
const WAIT_FOR_KERNEL: Duration = Duration::from_secs(60);

/// The link lasts until this handle is dropped. Its path stays the same across restarts.
pub struct ChatLink {
    path: PathBuf,
}

impl Drop for ChatLink {
    fn drop(&mut self) {
        if let Some(directory) = self.path.parent() {
            let _ = fs::remove_dir_all(directory);
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Descriptor {
    base_url: String,
    token: String,
}

impl ChatLink {
    /// `links` is the kernel's private directory of links. `native_session` names the harness
    /// and its native session, e.g. `claude-code:<id>`.
    pub fn create(links: &Path, base_url: &str, token: &str, native_session: &str) -> Result<Self> {
        validate_url(base_url)?;
        ensure!(
            !token.is_empty() && token.len() <= 4096,
            "Invalid chat credential"
        );
        let name = format!("{:x}", Sha256::digest(native_session.as_bytes()));
        let directory = links.join(&name[..16]);
        // A link left by a kernel that did not stop cleanly holds a revoked credential.
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(links)
            .and_then(|()| fs::create_dir(&directory))
            .map_err(|_| anyhow!("Cannot create private chat link directory"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for private in [links, &directory] {
                fs::set_permissions(private, fs::Permissions::from_mode(0o700))
                    .map_err(|_| anyhow!("Cannot protect chat link directory"))?;
            }
        }
        let path = directory.join("link.json");
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(&path)
            .map_err(|_| anyhow!("Cannot create private chat link"))?;
        serde_json::to_writer(
            file,
            &Descriptor {
                base_url: base_url.trim_end_matches('/').into(),
                token: token.into(),
            },
        )
        .map_err(|_| anyhow!("Cannot write private chat link"))?;
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A fixed argv vector, never a shell command assembled from chat text.
    pub fn command(&self) -> Result<Vec<String>> {
        let executable =
            std::env::current_exe().map_err(|_| anyhow!("Cannot locate ZeroLux executable"))?;
        Ok(vec![
            executable
                .to_str()
                .ok_or_else(|| anyhow!("ZeroLux executable path is not UTF-8"))?
                .into(),
            "chat-send".into(),
            "--link".into(),
            self.path
                .to_str()
                .ok_or_else(|| anyhow!("Chat link path is not UTF-8"))?
                .into(),
        ])
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SendRequest {
    conversation_id: String,
    id: String,
    text: String,
    reply_to_delivery_id: Option<String>,
}

fn validate_url(base_url: &str) -> Result<()> {
    let url = reqwest::Url::parse(base_url).map_err(|_| anyhow!("Invalid chat kernel URL"))?;
    ensure!(
        url.scheme() == "http"
            && is_loopback(&url)
            && url.username().is_empty()
            && url.password().is_none()
            && matches!(url.path(), "" | "/")
            && url.query().is_none()
            && url.fragment().is_none(),
        "Chat kernel URL must be a local HTTP origin"
    );
    Ok(())
}

pub(crate) fn is_loopback(url: &reqwest::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain("localhost")) => true,
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    }
}

/// The kernel is down or has not relinked this session yet. Repeating the request is safe.
#[derive(Debug)]
struct Unreachable(&'static str);

impl std::fmt::Display for Unreachable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for Unreachable {}

fn descriptor(path: &Path) -> Result<Descriptor> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| Unreachable("Chat link is no longer available"))?;
    ensure!(metadata.file_type().is_file(), "Invalid private chat link");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "Chat link permissions are not private"
        );
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| anyhow!("Chat link is no longer available"))?
        .take(MAX_DESCRIPTOR + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| anyhow!("Cannot read private chat link"))?;
    ensure!(
        bytes.len() as u64 <= MAX_DESCRIPTOR,
        "Invalid private chat link"
    );
    let descriptor: Descriptor =
        serde_json::from_slice(&bytes).map_err(|_| anyhow!("Invalid private chat link"))?;
    validate_url(&descriptor.base_url)?;
    ensure!(
        !descriptor.token.is_empty() && descriptor.token.len() <= 4096,
        "Invalid chat credential"
    );
    Ok(descriptor)
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()?)
}

/// The helper sends a structured message as this link's actor. Receipts are never sent here:
/// the harness driver reads them from native evidence.
/// No automatic retry: callers may repeat the same message ID after an ambiguous HTTP result.
pub async fn send(link: &Path, request: Value) -> Result<Value> {
    let request: SendRequest =
        serde_json::from_value(request).map_err(|_| anyhow!("Invalid chat-send request"))?;
    for id in std::iter::once(&request.id)
        .chain(std::iter::once(&request.conversation_id))
        .chain(request.reply_to_delivery_id.iter())
    {
        ensure!(Uuid::parse_str(id).is_ok(), "Chat IDs must be UUIDs");
    }
    ensure!(
        !request.text.trim().is_empty() && request.text.len() <= 64 * 1024,
        "Chat text must contain 1 to 65536 UTF-8 bytes"
    );
    let descriptor = descriptor(link)?;
    let response = client()?
        .post(format!("{}/api/conversations/{}/messages", descriptor.base_url, request.conversation_id))
        .bearer_auth(&descriptor.token)
        .json(&json!({"id":request.id,"text":request.text,"reply_to_delivery_id":request.reply_to_delivery_id}))
        .send().await.map_err(|_| Unreachable("Chat send outcome is uncertain; use the same message ID when checking or retrying"))?;
    let status = response.status();
    ensure!(
        status != reqwest::StatusCode::UNAUTHORIZED,
        "Chat link was revoked or expired"
    );
    ensure!(
        status.is_success(),
        "Chat message was not accepted ({status})"
    );
    // Deserialize only the public message schema; never print a raw server error or extra fields.
    let message: crate::model::ChatMessage = response
        .json()
        .await
        .map_err(|_| anyhow!("Invalid chat message response; delivery outcome may be uncertain"))?;
    ensure!(
        message.id == request.id && message.conversation_id == request.conversation_id,
        "Kernel returned a different chat message"
    );
    serde_json::to_value(message).map_err(|_| anyhow!("Cannot encode chat response"))
}

/// A thread to send into: opened under the chat if none is open at that root, joined otherwise.
pub struct Thread {
    pub root: String,
    pub with: Vec<String>,
    pub title: Option<String>,
}

/// Opens or joins the thread rooted at `root` under `parent` and returns the thread's ID. The
/// participants are named as in the envelope; the chat's roster resolves them.
async fn open_thread(link: &Path, parent: &str, thread: &Thread) -> Result<String> {
    ensure!(
        Uuid::parse_str(&thread.root).is_ok(),
        "Chat IDs must be UUIDs"
    );
    let descriptor = descriptor(link)?;
    let client = client()?;
    let inbox: Value = client
        .get(format!("{}/api/chat/inbox", descriptor.base_url))
        .bearer_auth(&descriptor.token)
        .send()
        .await
        .map_err(|_| Unreachable("Chat kernel unreachable; repeat the same request"))?
        .error_for_status()
        .map_err(|_| anyhow!("Chat inbox was refused"))?
        .json()
        .await
        .map_err(|_| anyhow!("Invalid chat inbox"))?;
    let roster = inbox["conversations"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|c| c["id"] == parent)
        .and_then(|c| c["members"].as_array())
        .context("This chat is not in the inbox")?;
    let mut participants = Vec::new();
    for name in &thread.with {
        let member = roster
            .iter()
            .find(|m| m["name"] == name.trim() && m["kind"] == "agent")
            .with_context(|| format!("No agent named {name} in this chat"))?;
        participants.push(member["actor_id"].as_str().unwrap_or_default().to_owned());
    }
    let response = client
        .post(format!("{}/api/conversations/{parent}/threads", descriptor.base_url))
        .bearer_auth(&descriptor.token)
        .json(&json!({"root":thread.root,"title":thread.title.clone().unwrap_or_else(|| "Thread".into()),"participants":participants}))
        .send()
        .await
        .map_err(|_| Unreachable("Chat thread outcome is uncertain; repeat the same request"))?;
    let status = response.status();
    ensure!(
        status != reqwest::StatusCode::UNAUTHORIZED,
        "Chat link was revoked or expired"
    );
    ensure!(
        status.is_success(),
        "Chat thread was not accepted ({status})"
    );
    let opened: Value = response
        .json()
        .await
        .map_err(|_| anyhow!("Invalid chat thread response"))?;
    opened["conversation"]["id"]
        .as_str()
        .map(str::to_owned)
        .context("Kernel returned no thread")
}

/// `zerolux chat-send --link <private descriptor> --to <conversation>`: sends the text on
/// stdin. With `--thread-on`, into the thread rooted at that message of the chat, opening or
/// joining it first. One JSON result on stdout.
pub async fn cli(
    link: PathBuf,
    to: String,
    reply: Option<String>,
    id: Option<String>,
    thread: Option<Thread>,
) -> Result<()> {
    let to = match &thread {
        Some(thread) => open_thread(&link, &to, thread).await?,
        None => to,
    };
    let request = {
        let mut bytes = Vec::new();
        tokio::io::stdin()
            .take(MAX_REQUEST + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| anyhow!("Cannot read chat text"))?;
        ensure!(bytes.len() as u64 <= MAX_REQUEST, "Chat text is too large");
        let text = String::from_utf8(bytes).map_err(|_| anyhow!("Chat text must be UTF-8"))?;
        json!({
            "conversation_id":to,
            "id":id.unwrap_or_else(|| Uuid::new_v4().to_string()),
            "text":text.strip_suffix('\n').unwrap_or(&text),
            "reply_to_delivery_id":reply
        })
    };
    // A kernel restart takes seconds: wait for it and repeat the same request, which the
    // kernel deduplicates by message ID.
    let deadline = tokio::time::Instant::now() + WAIT_FOR_KERNEL;
    let response = loop {
        match send(&link, request.clone()).await {
            Err(error) if error.is::<Unreachable>() && tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            result => break result?,
        }
    };
    let mut output =
        serde_json::to_vec(&response).map_err(|_| anyhow!("Cannot encode chat response"))?;
    output.push(b'\n');
    tokio::io::stdout()
        .write_all(&output)
        .await
        .map_err(|_| anyhow!("Cannot write chat response"))?;
    Ok(())
}
