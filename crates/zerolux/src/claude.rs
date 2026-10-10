//! Existing-session Claude Code bridge over the session's inbox socket. It never launches
//! Claude Code. The line format is the one Claude Code 2.1.284 accepts; it is not a documented
//! stable API, so every attach verifies the live session again.
//!
//! The socket is one-way. Claude Code shows each line as a message from another session, which
//! cannot approve prompts or grant permissions, so a notice can never pass for the owner.
//!
//! Receipts come from the session transcript that Claude Code appends to, as on a phone: a line
//! queued by the session is delivered, and a line placed in front of the model is read. The
//! agent never confirms anything; replying stays its own choice.

use std::{
    collections::HashMap,
    io::SeekFrom,
    os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    net::UnixStream,
    process::Command,
    sync::{mpsc, watch},
};

use crate::{
    chat_driver::{ChatMessage, Delivery, Kernel, MAX_TEXT, prompt},
    chat_tools::ChatLink,
};

const SOCKETS: &str = "/tmp/cc-socks";
const LIST_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(3);
const TRANSCRIPT_INTERVAL: Duration = Duration::from_secs(1);
const LIVENESS_INTERVAL: Duration = Duration::from_secs(5);
/// What Claude Code 2.1.284 records, verbatim, when the person interrupts a turn.
const INTERRUPTED: [&str; 2] = [
    "[Request interrupted by user]",
    "[Request interrupted by user for tool use]",
];
/// How far back the transcript is read for the current turn state when a link starts.
const RECENT: u64 = 1 << 20;
const WRITTEN: &str = "Handed to the Claude Code inbox; the session has not queued it yet.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Listed {
    session_id: String,
    cwd: String,
    kind: String,
    // Background sessions carry no process ID.
    pid: Option<u32>,
}

/// Read-only: asks Claude Code for its running sessions.
async fn list() -> Result<Vec<Listed>> {
    let listing = Command::new("claude")
        .args(["agents", "--json"])
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(LIST_TIMEOUT, listing)
        .await
        .context("Claude Code did not list its sessions in time")?
        .context("Cannot run Claude Code to list its sessions")?;
    ensure!(
        output.status.success(),
        "Claude Code could not list its sessions"
    );
    serde_json::from_slice(&output.stdout).context("Unexpected Claude Code session list")
}

/// One verified, running, interactive Claude Code session.
pub struct ClaudeSession {
    session_id: String,
    pid: u32,
    socket: PathBuf,
    /// Claude Code's projects directory: the transcript appears in it with the first turn.
    projects: PathBuf,
}

/// Where Claude Code keeps its sessions: `CLAUDE_CONFIG_DIR`, or `~/.claude`.
fn projects_dir(
    config_dir: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
) -> Result<PathBuf> {
    let root = match config_dir {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(home.context("HOME is not set")?).join(".claude"),
    };
    ensure!(
        root.is_absolute(),
        "The Claude Code configuration directory must be absolute"
    );
    Ok(root.join("projects"))
}

/// Whether the session's process is still there. Sockets outlive their process, so the
/// process is asked, not the socket.
fn alive(pid: u32) -> bool {
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None).is_ok()
}

/// What one transcript line proves about the envelope it holds.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Evidence {
    /// A `queue-operation` enqueue: the session holds the line.
    Delivered,
    /// A `user` entry or a mid-turn `attachment`: the line is in front of the model.
    Read,
}

/// The envelope text of a transcript line and what the line proves about it. Only the field
/// that carries the line itself is examined: a mention elsewhere proves nothing.
fn evidence(line: &str) -> Option<(String, Evidence)> {
    #[derive(Deserialize)]
    struct Entry {
        #[serde(rename = "type")]
        kind: String,
        operation: Option<String>,
        content: Option<String>,
        origin: Option<Origin>,
        message: Option<Message>,
        attachment: Option<Attachment>,
    }
    #[derive(Deserialize)]
    struct Origin {
        kind: String,
    }
    #[derive(Deserialize)]
    struct Message {
        content: serde_json::Value,
    }
    #[derive(Deserialize)]
    struct Attachment {
        prompt: Option<String>,
        origin: Option<Origin>,
    }
    let peer = |origin: Option<Origin>| origin.is_some_and(|origin| origin.kind == "peer");
    let entry: Entry = serde_json::from_str(line).ok()?;
    match entry.kind.as_str() {
        "queue-operation" if entry.operation.as_deref() == Some("enqueue") => {
            Some((entry.content?, Evidence::Delivered))
        }
        // Only what another session sent: the owner's own input is never an envelope, even
        // when typed inside a turn that a peer opened (`turnOrigin` says that, `origin` not).
        "user" if peer(entry.origin) => {
            let content = entry.message?.content;
            let text = match content {
                serde_json::Value::String(text) => text,
                serde_json::Value::Array(blocks) => blocks
                    .iter()
                    .filter_map(|block| block["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
                _ => return None,
            };
            Some((text, Evidence::Read))
        }
        "attachment" => {
            let attachment = entry.attachment?;
            peer(attachment.origin).then_some((attachment.prompt?, Evidence::Read))
        }
        _ => None,
    }
}

/// A line that joins the running turn: an attachment absorbed mid-turn, whoever it came from.
fn joins_turn(line: &str) -> bool {
    #[derive(Deserialize)]
    struct Entry {
        #[serde(rename = "type")]
        kind: String,
    }
    serde_json::from_str::<Entry>(line).is_ok_and(|entry| entry.kind == "attachment")
}

/// The envelope named after `delivery` is present as itself: its own command line, at the
/// start of a line. Quoted inside another message it carries a "> " prefix; a bare mention of
/// the ID is not the envelope.
fn holds_envelope(text: &str, delivery: &str) -> bool {
    let ending = format!(" --reply {delivery}");
    text.lines()
        .any(|line| line.starts_with("Reply, text on stdin: ") && line.ends_with(&ending))
}

/// What one transcript line says about the model: a turn opens with a `user` entry that is a
/// prompt (a person's input, a peer's line, a background task's notice) and closes with the
/// `turn_duration` record, or with the final answer before it. Tool results are inside a turn
/// and say nothing; a background process says nothing until it opens a turn of its own.
fn turn_signal(line: &str) -> Option<&'static str> {
    #[derive(Deserialize)]
    struct Entry {
        #[serde(rename = "type")]
        kind: String,
        subtype: Option<String>,
        message: Option<Message>,
        // After a context compaction Claude Code writes the summary as a `user` row with
        // text, and no turn follows it. Reading it as a turn leaves the agent "working".
        // Only this flag: `isMeta` rows include the ZeroLux deliveries that do open turns.
        #[serde(rename = "isCompactSummary", default)]
        compact_summary: bool,
    }
    #[derive(Deserialize)]
    struct Message {
        content: serde_json::Value,
        stop_reason: Option<String>,
    }
    let entry: Entry = serde_json::from_str(line).ok()?;
    match entry.kind.as_str() {
        "user" if entry.compact_summary => None,
        "user" => match entry.message?.content {
            serde_json::Value::String(_) => Some("working"),
            serde_json::Value::Array(blocks) => {
                // An interruption alone is recorded as one text block, with no turn record
                // after it. Anything more is what the person typed next: a new turn.
                if let [block] = blocks.as_slice()
                    && block["type"] == "text"
                    && INTERRUPTED.contains(&block["text"].as_str().unwrap_or_default())
                {
                    return Some("idle");
                }
                blocks
                    .iter()
                    .any(|block| block["type"] != "tool_result")
                    .then_some("working")
            }
            _ => None,
        },
        "system" if entry.subtype.as_deref() == Some("turn_duration") => Some("idle"),
        "assistant"
            if matches!(
                entry.message?.stop_reason.as_deref(),
                Some("end_turn" | "refusal")
            ) =>
        {
            Some("idle")
        }
        _ => None,
    }
}

/// The session transcript, read forward only. Lines still being written are kept for the
/// next read; a replaced or truncated file is read again from its start. The file is held
/// open, so a replacement never gets its inode back (Linux reuses freed ones at once), and
/// while the path is missing the held file is still read.
struct Transcript {
    path: PathBuf,
    file: tokio::fs::File,
    offset: u64,
    partial: Vec<u8>,
}

impl Transcript {
    /// `~/.claude/projects/<workspace>/<session>.jsonl`; the workspace name is Claude Code's,
    /// so the session ID is searched instead of guessed. None until the session's first turn
    /// writes it.
    fn locate(projects: &Path, session_id: &str) -> Option<PathBuf> {
        let name = format!("{session_id}.jsonl");
        std::fs::read_dir(projects)
            .ok()?
            .flatten()
            .map(|project| project.path().join(&name))
            .find(|path| path.is_file())
    }

    async fn open(path: PathBuf, from_start: bool) -> Result<Self> {
        let file = tokio::fs::File::open(&path).await?;
        let len = file.metadata().await?.len();
        Ok(Self {
            path,
            file,
            offset: if from_start { 0 } else { len },
            partial: Vec::new(),
        })
    }

    /// The turn state as of the end of the file: the last signal within `RECENT` bytes.
    async fn recent_activity(&self) -> Result<Option<&'static str>> {
        let mut file = tokio::fs::File::open(&self.path).await?;
        let len = file.metadata().await?.len();
        file.seek(SeekFrom::Start(len.saturating_sub(RECENT)))
            .await?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).await?;
        let text = String::from_utf8_lossy(&bytes);
        Ok(text.lines().rev().find_map(turn_signal))
    }

    async fn read_new(&mut self) -> Result<Vec<String>> {
        let held = self.file.metadata().await?;
        match tokio::fs::metadata(&self.path).await {
            Ok(current) if (current.dev(), current.ino()) != (held.dev(), held.ino()) => {
                self.file = tokio::fs::File::open(&self.path).await?;
                self.offset = 0;
                self.partial.clear();
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ if held.len() < self.offset => {
                self.offset = 0;
                self.partial.clear();
            }
            _ => {}
        }
        self.file.seek(SeekFrom::Start(self.offset)).await?;
        let mut bytes = Vec::new();
        self.offset += self.file.read_to_end(&mut bytes).await? as u64;
        self.partial.extend(bytes);
        let mut lines = Vec::new();
        while let Some(end) = self.partial.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.partial.drain(..=end).collect();
            lines.push(String::from_utf8_lossy(&line).into_owned());
        }
        Ok(lines)
    }
}

/// Envelopes written to the session and not yet read, by the delivery that names them.
#[derive(Default)]
struct Envelopes {
    carried: HashMap<String, Vec<String>>,
    /// The chat each envelope belongs to.
    chats: HashMap<String, String>,
}

/// The inputs of the current turn: which chats our envelopes brought, and whether anything
/// else came in. Cleared when the turn ends.
#[derive(Default)]
struct Turn {
    chats: std::collections::HashSet<String>,
    private: bool,
}

impl Turn {
    fn clear(&mut self) {
        self.chats.clear();
        self.private = false;
    }
    /// The chat the turn is about: one chat for every input, else none.
    fn conversation(&self) -> Option<String> {
        if self.private || self.chats.len() != 1 {
            return None;
        }
        self.chats.iter().next().cloned()
    }
}

impl Envelopes {
    /// Every delivery this session may still hear about: written or queued, not yet read.
    fn track(&mut self, deliveries: &[Delivery]) {
        for delivery in deliveries {
            if let Some(envelope) = &delivery.native_request_id
                && matches!(delivery.status.as_str(), "uncertain" | "notified")
            {
                let carried = self.carried.entry(envelope.clone()).or_default();
                if !carried.contains(&delivery.id) {
                    carried.push(delivery.id.clone());
                }
                self.chats
                    .insert(envelope.clone(), delivery.message.conversation_id.clone());
            }
        }
    }

    /// Settles the receipts the line proves and returns the chats of the envelopes it put in
    /// front of the model, if any.
    async fn settle(&mut self, kernel: &Kernel, line: &str) -> Result<Vec<String>> {
        let Some((text, evidence)) = evidence(line) else {
            return Ok(Vec::new());
        };
        let mut read = Vec::new();
        let named: Vec<String> = self
            .carried
            .keys()
            .filter(|envelope| holds_envelope(&text, envelope))
            .cloned()
            .collect();
        match evidence {
            Evidence::Delivered => {
                for envelope in named {
                    for id in &self.carried[&envelope] {
                        kernel
                            .receipt(
                                id,
                                json!({"status":"notified","native_request_id":envelope}),
                            )
                            .await?;
                    }
                }
            }
            // The kernel marks what the envelope carried together with the delivery naming it.
            Evidence::Read => {
                for envelope in named {
                    kernel.receipt(&envelope, json!({"status":"read"})).await?;
                    self.carried.remove(&envelope);
                    if let Some(chat) = self.chats.remove(&envelope) {
                        read.push(chat);
                    }
                }
            }
        }
        Ok(read)
    }
}

impl ClaudeSession {
    /// Verifies that the hired session is still alive in its workspace. Read-only: it lists the
    /// sessions and inspects the socket, without opening or resuming anything.
    pub async fn attach(session_id: &str, workspace: &str) -> Result<Self> {
        let projects = projects_dir(
            std::env::var_os("CLAUDE_CONFIG_DIR"),
            std::env::var_os("HOME"),
        )?;
        Self::select(
            list().await?,
            session_id,
            workspace,
            Path::new(SOCKETS),
            &projects,
        )
    }

    fn select(
        listed: Vec<Listed>,
        session_id: &str,
        workspace: &str,
        sockets: &Path,
        projects: &Path,
    ) -> Result<Self> {
        let session = listed
            .into_iter()
            .find(|session| session.session_id == session_id)
            .context("This Claude Code session is no longer running")?;
        // A terminal session or one started in the background: what counts is a running
        // process with a private inbox. A background session that ended has neither.
        ensure!(
            matches!(session.kind.as_str(), "interactive" | "background"),
            "This Claude Code session is of a kind that cannot be connected"
        );
        ensure!(
            std::fs::canonicalize(&session.cwd)? == std::fs::canonicalize(workspace)?,
            "The Claude Code workspace changed before pairing"
        );
        let pid = session
            .pid
            .context("This Claude Code session has no running process")?;
        let socket = sockets.join(format!("{pid}.sock"));
        let metadata = std::fs::symlink_metadata(&socket)
            .context("This Claude Code session exposes no inbox; update Claude Code")?;
        ensure!(
            metadata.file_type().is_socket() && metadata.permissions().mode() & 0o077 == 0,
            "The Claude Code inbox is not a private socket"
        );
        Ok(Self {
            session_id: session.session_id,
            pid,
            socket,
            projects: projects.to_path_buf(),
        })
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Delivers the stored messages of this link until `stop` turns true or the link is stopped.
    /// Claude Code queues incoming lines by itself, so turns are not serialized here; the
    /// transcript then says when each line was queued and when it reached the model.
    pub async fn run(
        self,
        kernel_url: String,
        links: std::path::PathBuf,
        session_id: String,
        token: String,
        mut changed: mpsc::Receiver<()>,
        mut stop: watch::Receiver<bool>,
    ) -> Result<()> {
        let link = ChatLink::create(
            &links,
            &kernel_url,
            &token,
            &format!("claude-code:{}", self.session_id()),
        )?;
        let kernel = Kernel::new(kernel_url, session_id, token, link)?;
        let result = async {
            kernel.status("connected", None).await?;
            let mut reported = None;
            let mut reported_chat: Option<String> = None;
            let mut turn = Turn::default();
            let mut envelopes = Envelopes::default();
            let mut transcript = None;
            let mut tail = tokio::time::interval(TRANSCRIPT_INTERVAL);
            let mut liveness = tokio::time::interval(LIVENESS_INTERVAL);
            while self.refresh(&kernel, &mut envelopes).await? {
                loop {
                    // A fresh session writes its transcript with its first turn, which the
                    // first envelope opens: looked for until it is there. Envelopes written
                    // before this link may already be in it: the first look starts from the
                    // beginning only when something is still owed.
                    if transcript.is_none()
                        && let Some(path) = Transcript::locate(&self.projects, &self.session_id)
                    {
                        let from_start = !envelopes.carried.is_empty();
                        let opened = Transcript::open(path, from_start).await?;
                        // Starting at the end, the state is seeded from what came before;
                        // from the start, the replayed lines say it themselves.
                        if !from_start {
                            reported = opened.recent_activity().await?;
                            // A turn already running when the link starts had inputs this
                            // link never saw, and an unknown state may be one: nobody's chat
                            // until a turn is seen to end.
                            turn.private = reported != Some("idle");
                            kernel.activity(reported, None).await?;
                        }
                        transcript = Some(opened);
                    }
                    tokio::select! {
                        notification = changed.recv() => {
                            ensure!(notification.is_some(), "LiveKit adapter notifications stopped");
                            break;
                        }
                        _ = tail.tick() => {}
                        _ = liveness.tick() => {
                            ensure!(alive(self.pid), "The Claude Code session ended");
                        }
                        _ = stop.wait_for(|stopped| *stopped) => return Ok(()),
                    }
                    if let Some(transcript) = &mut transcript {
                        let lines = transcript.read_new().await?;
                        for line in &lines {
                            let read = envelopes.settle(&kernel, line).await?;
                            // The turn is about one chat only when every input belongs to
                            // it: our envelopes add their chat, anything else (typed input,
                            // a line that is not ours, absorbed mid-turn or not) makes it
                            // mixed; the end clears it.
                            match turn_signal(line) {
                                Some("idle") => turn.clear(),
                                Some("working") if read.is_empty() => turn.private = true,
                                None if joins_turn(line) && read.is_empty() => {
                                    turn.private = true;
                                }
                                _ => {}
                            }
                            turn.chats.extend(read);
                        }
                        // Only the state as of the last line: turns that ended within the
                        // batch, or a history read back for receipts, are not activity. A
                        // batch that changed the turn's inputs publishes even without one.
                        let activity = lines
                            .iter()
                            .rev()
                            .find_map(|l| turn_signal(l))
                            .or(reported);
                        if let Some(activity) = activity {
                            let chat = turn.conversation();
                            if Some(activity) != reported || chat != reported_chat {
                                kernel.activity(Some(activity), chat.as_deref()).await?;
                                reported = Some(activity);
                                reported_chat = chat;
                            }
                        }
                    }
                }
            }
            Ok(())
        }
        .await;
        // Stop revokes the token first: a refused request after that is the expected end.
        if *stop.borrow() {
            return Ok(());
        }
        if result.is_err() {
            let _ = kernel
                .status(
                    "attention",
                    Some("Claude Code needs attention. Uncertain messages have not been resent."),
                )
                .await;
        }
        result
    }

    /// Returns false once the owner stopped this link.
    async fn refresh(&self, kernel: &Kernel, envelopes: &mut Envelopes) -> Result<bool> {
        let inbox = kernel.get("/chat/inbox").await?;
        ensure!(
            inbox["session"]["id"] == kernel.session_id,
            "Kernel returned a different chat session"
        );
        if inbox["session"]["status"] == "stopped" {
            return Ok(false);
        }
        let mut pending: Vec<Delivery> =
            serde_json::from_value(inbox["deliveries"].clone()).context("Invalid chat inbox")?;
        pending.retain(|d| d.session_id == kernel.session_id);
        envelopes.track(&pending);
        pending.retain(|d| d.status == "stored");
        pending.sort_by_key(|delivery| delivery.message.seq);
        // Messages that were waiting in one conversation reach the session together.
        let mut conversations: Vec<Vec<Delivery>> = Vec::new();
        for mut delivery in pending {
            // The kernel marks the delivery uncertain before anything reaches the session.
            let path = format!("/chat/deliveries/{}/dispatch", delivery.id);
            let Some(dispatch) = kernel.post_conflict(&path, json!({})).await? else {
                continue;
            };
            ensure!(
                dispatch["delivery"]["id"] == delivery.id,
                "Kernel dispatched a different delivery"
            );
            delivery.message = serde_json::from_value::<ChatMessage>(dispatch["message"].clone())
                .context("Invalid dispatch message")?;
            ensure!(
                delivery.message.text.len() <= MAX_TEXT,
                "Chat message exceeds the Claude Code bridge limit"
            );
            match conversations
                .iter_mut()
                .find(|batch| batch[0].message.conversation_id == delivery.message.conversation_id)
            {
                Some(batch) => batch.push(delivery),
                None => conversations.push(vec![delivery]),
            }
        }
        for batch in conversations {
            // The envelope is named after its last delivery, and the kernel knows it before
            // anything reaches the session: a relink after a failure here still finds it in
            // the transcript. Only the receipt is ever retried, never the line.
            let envelope = batch
                .last()
                .map(|last| last.id.clone())
                .context("Empty batch")?;
            for delivery in &batch {
                kernel
                    .receipt(
                        &delivery.id,
                        json!({"status":"uncertain","reason":WRITTEN,"native_request_id":envelope}),
                    )
                    .await?;
            }
            envelopes.carried.insert(
                envelope.clone(),
                batch.iter().map(|d| d.id.clone()).collect(),
            );
            envelopes
                .chats
                .insert(envelope.clone(), batch[0].message.conversation_id.clone());
            if let Err(error) = self
                .deliver(&prompt(&batch, &inbox, &kernel.link, false)?)
                .await
            {
                for delivery in &batch {
                    kernel
                        .receipt(
                            &delivery.id,
                            json!({"status":"uncertain","reason":"The Claude Code inbox could not be reached. The message was not resent."}),
                        )
                        .await?;
                }
                return Err(error);
            }
        }
        Ok(true)
    }

    /// Writes one message to the session. Success means the line was written, not yet that the
    /// session queued it: the delivery stays uncertain until the transcript says so, and is
    /// never written twice.
    pub async fn deliver(&self, text: &str) -> Result<()> {
        let mut line =
            serde_json::to_vec(&json!({"type":"user","message":{"role":"user","content":text}}))?;
        line.push(b'\n');
        let write = async {
            let mut stream = UnixStream::connect(&self.socket).await?;
            stream.write_all(&line).await?;
            stream.shutdown().await
        };
        tokio::time::timeout(WRITE_TIMEOUT, write)
            .await
            .context("Claude Code did not accept the message in time; outcome may be uncertain")?
            .context("Cannot reach the Claude Code inbox; outcome may be uncertain")
    }
}

#[cfg(test)]
mod tests {
    use tokio::{io::AsyncReadExt, net::UnixListener};

    use super::*;

    fn listed(json: serde_json::Value) -> Vec<Listed> {
        serde_json::from_value(json).unwrap()
    }

    fn workspace() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap().to_owned();
        (dir, path)
    }

    /// Claude Code's projects directory with one transcript per named session.
    fn projects(sessions: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("-workspace");
        std::fs::create_dir(&project).unwrap();
        for session in sessions {
            std::fs::write(project.join(format!("{session}.jsonl")), "").unwrap();
        }
        dir
    }

    fn private_socket(sockets: &Path, pid: u32) -> UnixListener {
        let path = sockets.join(format!("{pid}.sock"));
        let listener = UnixListener::bind(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        listener
    }

    #[tokio::test]
    async fn delivers_one_line_to_the_verified_session_only() {
        let (sockets, _) = workspace();
        let (_dir, cwd) = workspace();
        let listener = private_socket(sockets.path(), me());
        let _other = private_socket(sockets.path(), 42);
        let sessions = listed(json!([
            {"sessionId":"aspen","cwd":cwd,"kind":"interactive","pid":42,"name":"a","status":"idle"},
            {"sessionId":"birch","cwd":cwd,"kind":"interactive","pid":me(),"name":"b","status":"busy"},
        ]));
        let projects = projects(&["birch"]);
        let session =
            ClaudeSession::select(sessions, "birch", &cwd, sockets.path(), projects.path())
                .unwrap();
        assert_eq!(session.session_id(), "birch");

        let text = "line one\nline two with \"quotes\"";
        let (sent, received) = tokio::join!(session.deliver(text), async {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).await.unwrap();
            bytes
        });
        sent.unwrap();
        // Exactly one line, whatever the text contains.
        assert_eq!(received.iter().filter(|byte| **byte == b'\n').count(), 1);
        let line: serde_json::Value = serde_json::from_slice(&received).unwrap();
        assert_eq!(
            line,
            json!({"type":"user","message":{"role":"user","content":text}})
        );
    }

    /// A kernel stand-in that records what the driver asks, in order.
    async fn kernel(
        inbox: serde_json::Value,
        dispatch: axum::http::StatusCode,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use axum::{Json, Router, extract::Request, http::StatusCode};
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = calls.clone();
        let app = Router::new().fallback(move |request: Request| {
            let (seen, inbox) = (seen.clone(), inbox.clone());
            async move {
                let path = request.uri().path().to_owned();
                let body = axum::body::to_bytes(request.into_body(), 1 << 20)
                    .await
                    .unwrap();
                seen.lock()
                    .unwrap()
                    .push(format!("{path} {}", String::from_utf8_lossy(&body)));
                if path.ends_with("/dispatch") {
                    let delivery = &inbox["deliveries"][0];
                    let body =
                        json!({"delivery":{"id":delivery["id"]},"message":delivery["message"]});
                    return (dispatch, Json(body));
                }
                if inbox.is_null() {
                    // A revoked token: the kernel refuses every request.
                    return (StatusCode::UNAUTHORIZED, Json(json!({"error": "revoked"})));
                }
                let body = if path.ends_with("/inbox") {
                    inbox
                } else {
                    json!({})
                };
                (StatusCode::OK, Json(body))
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await });
        (url, calls)
    }

    fn inbox(status: &str) -> serde_json::Value {
        json!({
            "session": {"id": "link", "status": "connected"},
            "conversations": [{"id": "room", "kind": "dm", "title": "Owner and agent", "members": [
                {"actor_id": "owner", "kind": "human", "name": "Owner", "session_id": null},
                {"actor_id": "birch", "kind": "agent", "name": "birch", "session_id": "link"},
            ]}],
            "deliveries": [{"id": "delivery", "session_id": "link", "status": status, "message": {
                "id": "message", "conversation_id": "room", "author_id": "owner",
                "text": "Can you check the test?", "seq": 1,
            }}],
        })
    }

    fn links() -> PathBuf {
        std::env::temp_dir().join(uuid::Uuid::new_v4().to_string())
    }

    /// This process stands in for the session: alive for as long as the test runs.
    fn me() -> u32 {
        std::process::id()
    }

    async fn linked(sockets: &Path, cwd: &str, projects: &Path) -> ClaudeSession {
        let sessions = listed(json!([
            {"sessionId":"birch","cwd":cwd,"kind":"interactive","pid":me()},
        ]));
        ClaudeSession::select(sessions, "birch", cwd, sockets, projects).unwrap()
    }

    #[test]
    fn the_configuration_directory_is_honoured() {
        assert_eq!(
            projects_dir(None, Some("/home/example".into())).unwrap(),
            PathBuf::from("/home/example/.claude/projects")
        );
        assert_eq!(
            projects_dir(Some("/profiles/b".into()), Some("/home/example".into())).unwrap(),
            PathBuf::from("/profiles/b/projects")
        );
        assert!(projects_dir(Some("relative".into()), None).is_err());
        assert!(projects_dir(None, None).is_err());
    }

    /// The session's process is gone: the link ends and asks for attention, even with
    /// nothing to deliver and the stale socket still on disk.
    #[tokio::test]
    async fn a_session_whose_process_ended_is_disconnected() {
        let (sockets, _) = workspace();
        let (_dir, cwd) = workspace();
        let projects = projects(&["birch"]);
        let mut child = tokio::process::Command::new("sleep")
            .arg("30")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let _listener = private_socket(sockets.path(), pid);
        let sessions = listed(json!([
            {"sessionId":"birch","cwd":cwd,"kind":"interactive","pid":pid},
        ]));
        let session =
            ClaudeSession::select(sessions, "birch", &cwd, sockets.path(), projects.path())
                .unwrap();
        let (url, calls) = kernel(inbox("read"), axum::http::StatusCode::OK).await;
        let (_wake, changed) = mpsc::channel(1);
        let (_stopper, stop) = watch::channel(false);
        let run =
            tokio::spawn(session.run(url, links(), "link".into(), "token".into(), changed, stop));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!run.is_finished(), "alive: linked");
        child.kill().await.unwrap();
        child.wait().await.unwrap();
        let ended = tokio::time::timeout(Duration::from_secs(10), run)
            .await
            .expect("the link ends")
            .unwrap();
        assert!(ended.unwrap_err().to_string().contains("ended"));
        assert!(
            calls
                .lock()
                .unwrap()
                .iter()
                .any(|call| call.contains("/status") && call.contains("attention"))
        );
    }

    /// The three transcript shapes Claude Code 2.1.284 writes for a peer line.
    #[test]
    fn transcript_lines_prove_queueing_and_reading() {
        let enqueue =
            json!({"type":"queue-operation","operation":"enqueue","content":"[ZeroLux] x"});
        let remove = json!({"type":"queue-operation","operation":"remove","content":"[ZeroLux] x","reason":"absorbed_mid_turn"});
        let user = json!({"type":"user","origin":{"kind":"peer"},"message":{"role":"user","content":"[ZeroLux] x"}});
        let blocks = json!({"type":"user","origin":{"kind":"peer"},"message":{"role":"user","content":[{"type":"text","text":"[ZeroLux]"},{"type":"text","text":"x"}]}});
        let own = json!({"type":"user","turnOrigin":"peer","message":{"role":"user","content":"[ZeroLux] x"}});
        let attachment = json!({"type":"attachment","attachment":{"type":"queued_command","prompt":"[ZeroLux] x","origin":{"kind":"peer"}}});
        let own_attachment = json!({"type":"attachment","attachment":{"type":"queued_command","prompt":"[ZeroLux] x"}});
        let assistant = json!({"type":"assistant","message":{"content":"[ZeroLux] x"}});
        let shapes = [
            (
                enqueue,
                Some(("[ZeroLux] x".to_owned(), Evidence::Delivered)),
            ),
            (remove, None),
            (user, Some(("[ZeroLux] x".to_owned(), Evidence::Read))),
            (blocks, Some(("[ZeroLux]\nx".to_owned(), Evidence::Read))),
            (own, None),
            (attachment, Some(("[ZeroLux] x".to_owned(), Evidence::Read))),
            (own_attachment, None),
            (assistant, None),
        ];
        for (line, expected) in shapes {
            assert_eq!(evidence(&line.to_string()), expected, "{line}");
        }
        assert_eq!(evidence("not json"), None);

        let envelope = "[ZeroLux] 1 new message\nReply, text on stdin: zerolux chat-send --to c --reply d\nEach message";
        assert!(holds_envelope(envelope, "d"));
        assert!(holds_envelope(
            &format!("Another session:\n{envelope}"),
            "d"
        ));
        assert!(!holds_envelope(envelope, "dd"));
        let quoted: String = envelope.lines().map(|l| format!("> {l}\n")).collect();
        assert!(
            !holds_envelope(&quoted, "d"),
            "an envelope quoted in another one"
        );
        assert!(
            !holds_envelope("please look at delivery d --reply d", "d"),
            "a mention"
        );
    }

    /// Turn boundaries as Claude Code 2.1.284 writes them; nothing else moves the badge.
    #[test]
    fn transcript_lines_open_and_close_turns() {
        let typed = json!({"type":"user","message":{"role":"user","content":"do it"}});
        let peer = json!({"type":"user","origin":{"kind":"peer"},"message":{"role":"user","content":"[ZeroLux] x"}});
        let notice = json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":"task done"}]}});
        let tool = json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}});
        let thinking = json!({"type":"assistant","message":{"content":[{"type":"thinking"}],"stop_reason":"tool_use"}});
        let answer = json!({"type":"assistant","message":{"content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}});
        let ended = json!({"type":"system","subtype":"turn_duration","durationMs":10});
        let interrupted = json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}});
        let interrupted_tool = json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}});
        let asked = json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user] what does that mean?"}]}});
        let resumed = json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"},{"type":"text","text":"run it again"}]}});
        let failed = json!({"type":"assistant","isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"API error"}],"stop_reason":null}});
        let other = json!({"type":"system","subtype":"informational"});
        let queued = json!({"type":"queue-operation","operation":"enqueue","content":"x"});
        // After a compaction the summary is a `user` row with text, but no turn follows it.
        let boundary = json!({"type":"system","subtype":"compact_boundary"});
        let summary = json!({"type":"user","isCompactSummary":true,"isVisibleInTranscriptOnly":true,"message":{"role":"user","content":"This session is being continued from a previous conversation…"}});
        let summary_alone = json!({"type":"user","isCompactSummary":true,"message":{"role":"user","content":[{"type":"text","text":"Summary of the conversation so far"}]}});
        // A ZeroLux delivery is a meta row and does open a turn.
        let delivery = json!({"type":"user","isMeta":true,"message":{"role":"user","content":"Another Claude session sent a message: [ZeroLux] x"}});
        let flagged_false = json!({"type":"user","isCompactSummary":false,"message":{"role":"user","content":"do it"}});
        for (line, expected) in [
            (typed, Some("working")),
            (peer, Some("working")),
            (notice, Some("working")),
            (tool, None),
            (thinking, None),
            (answer, Some("idle")),
            (ended, Some("idle")),
            (interrupted, Some("idle")),
            (interrupted_tool, Some("idle")),
            (asked, Some("working")),
            (resumed, Some("working")),
            // An API error is followed by the turn record: nothing to add here.
            (failed, None),
            (other, None),
            (queued, None),
            (boundary, None),
            (summary, None),
            (summary_alone, None),
            (delivery, Some("working")),
            (flagged_false, Some("working")),
        ] {
            assert_eq!(turn_signal(&line.to_string()), expected, "{line}");
        }
    }

    /// A session hired before its first turn has no transcript yet: the envelope goes out,
    /// the transcript appears with the turn it opens, and receipts follow from there.
    #[tokio::test]
    async fn a_fresh_session_is_linked_and_receipts_start_with_its_first_turn() {
        let (sockets, _) = workspace();
        let (_dir, cwd) = workspace();
        let projects = projects(&[]);
        let listener = private_socket(sockets.path(), me());
        let session = linked(sockets.path(), &cwd, projects.path()).await;
        let (url, calls) = kernel(inbox("stored"), axum::http::StatusCode::OK).await;
        let (_wake, changed) = mpsc::channel(1);
        let (stopper, stop) = watch::channel(false);
        let run =
            tokio::spawn(session.run(url, links(), "link".into(), "token".into(), changed, stop));
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await.unwrap();
        let line: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let envelope = line["message"]["content"].as_str().unwrap().to_owned();
        // The first turn creates the transcript, with the envelope in it.
        use std::io::Write;
        let mut file =
            std::fs::File::create(projects.path().join("-workspace/birch.jsonl")).unwrap();
        writeln!(
            file,
            "{}",
            json!({"type":"queue-operation","operation":"enqueue","content":envelope})
        )
        .unwrap();
        writeln!(file, "{}", json!({"type":"user","origin":{"kind":"peer"},"message":{"role":"user","content":envelope}})).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !calls
                .lock()
                .unwrap()
                .iter()
                .any(|c| c.ends_with(&json!({"status":"read"}).to_string()))
            {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("read from the new transcript");
        stopper.send(true).unwrap();
        run.await.unwrap().unwrap();
        let activities: Vec<String> = calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call.contains("/activity "))
            .map(|call| call.split_once(' ').unwrap().1.to_owned())
            .collect();
        assert_eq!(
            activities,
            [json!({"activity":"working","conversation_id":"room"}).to_string()]
        );
    }

    /// Nothing on the Claude Code side records who is linked: two kernels (two workspaces)
    /// attach the same session and both deliver to its inbox. This documents the gap that a
    /// machine-wide session lease would close; it is not the behaviour we want.
    #[tokio::test]
    async fn two_kernels_can_attach_the_same_claude_session_and_both_deliver() {
        let (sockets, _) = workspace();
        let (_dir, cwd) = workspace();
        let projects = projects(&["birch"]);
        let listener = private_socket(sockets.path(), me());
        // The same selection succeeds twice: no lease, no "already linked" anywhere.
        let first = linked(sockets.path(), &cwd, projects.path()).await;
        let second = linked(sockets.path(), &cwd, projects.path()).await;
        let (url_a, _) = kernel(inbox("stored"), axum::http::StatusCode::OK).await;
        let (url_b, _) = kernel(inbox("stored"), axum::http::StatusCode::OK).await;
        let (_wake_a, changed_a) = mpsc::channel(1);
        let (_wake_b, changed_b) = mpsc::channel(1);
        let (stop_a, stopped_a) = watch::channel(false);
        let (stop_b, stopped_b) = watch::channel(false);
        let run_a = tokio::spawn(first.run(
            url_a,
            links(),
            "link".into(),
            "token-a".into(),
            changed_a,
            stopped_a,
        ));
        let run_b = tokio::spawn(second.run(
            url_b,
            links(),
            "link".into(),
            "token-b".into(),
            changed_b,
            stopped_b,
        ));
        let mut delivered = Vec::new();
        for _ in 0..2 {
            // Generous: two deliveries with the whole suite running in parallel on a busy CPU.
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
                .await
                .expect("both kernels deliver")
                .unwrap();
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).await.unwrap();
            let line: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            delivered.push(line["message"]["content"].as_str().unwrap().to_owned());
        }
        assert_eq!(
            delivered.len(),
            2,
            "the session got the envelope of both workspaces"
        );
        stop_a.send(true).unwrap();
        stop_b.send(true).unwrap();
        run_a.await.unwrap().unwrap();
        run_b.await.unwrap().unwrap();
    }

    /// The turn is about the chat of the envelope the transcript put in front of the model;
    /// a typed input or envelopes of two chats make it nobody's chat; the end clears it.
    #[tokio::test]
    async fn activity_names_the_chat_of_the_envelope_in_front_of_the_model() {
        let (sockets, _) = workspace();
        let (_dir, cwd) = workspace();
        let projects = projects(&["birch"]);
        let transcript = projects.path().join("-workspace/birch.jsonl");
        let listener = private_socket(sockets.path(), me());
        let session = linked(sockets.path(), &cwd, projects.path()).await;
        let (url, calls) = kernel(inbox("stored"), axum::http::StatusCode::OK).await;
        let (_wake, changed) = mpsc::channel(1);
        let (stopper, stop) = watch::channel(false);
        let run =
            tokio::spawn(session.run(url, links(), "link".into(), "token".into(), changed, stop));
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await.unwrap();
        let line: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let envelope = line["message"]["content"].as_str().unwrap().to_owned();
        let activities = |calls: &Vec<String>| -> Vec<String> {
            calls
                .iter()
                .filter(|call| call.contains("/activity "))
                .map(|call| call.split_once(' ').unwrap().1.to_owned())
                .collect()
        };
        let wait = |count: usize| {
            let calls = calls.clone();
            async move {
                tokio::time::timeout(Duration::from_secs(5), async {
                    while activities(&calls.lock().unwrap()).len() < count {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                })
                .await
                .expect("activity in time");
            }
        };
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&transcript)
            .unwrap();
        // Our envelope opens the turn: working on its chat.
        writeln!(file, "{}", json!({"type":"user","origin":{"kind":"peer"},"message":{"role":"user","content":envelope}})).unwrap();
        wait(1).await;
        // The owner types into the same turn: no longer one chat's work.
        writeln!(
            file,
            "{}",
            json!({"type":"user","message":{"role":"user","content":"and this too"}})
        )
        .unwrap();
        wait(2).await;
        writeln!(
            file,
            "{}",
            json!({"type":"system","subtype":"turn_duration","durationMs":5})
        )
        .unwrap();
        wait(3).await;
        stopper.send(true).unwrap();
        run.await.unwrap().unwrap();
        assert_eq!(
            activities(&calls.lock().unwrap()),
            [
                json!({"activity":"working","conversation_id":"room"}).to_string(),
                json!({"activity":"working","conversation_id":null}).to_string(),
                json!({"activity":"idle","conversation_id":null}).to_string(),
            ]
        );
    }

    /// A line absorbed mid-turn that is not our envelope makes the turn nobody's chat, at
    /// once, without waiting for the turn to end.
    #[tokio::test]
    async fn an_input_absorbed_mid_turn_makes_the_turn_nobodys_chat() {
        let (sockets, _) = workspace();
        let (_dir, cwd) = workspace();
        let projects = projects(&["birch"]);
        let transcript = projects.path().join("-workspace/birch.jsonl");
        let listener = private_socket(sockets.path(), me());
        let session = linked(sockets.path(), &cwd, projects.path()).await;
        let (url, calls) = kernel(inbox("stored"), axum::http::StatusCode::OK).await;
        let (_wake, changed) = mpsc::channel(1);
        let (stopper, stop) = watch::channel(false);
        let run =
            tokio::spawn(session.run(url, links(), "link".into(), "token".into(), changed, stop));
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await.unwrap();
        let line: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let envelope = line["message"]["content"].as_str().unwrap().to_owned();
        let activities = |calls: &Vec<String>| -> Vec<String> {
            calls
                .iter()
                .filter(|call| call.contains("/activity "))
                .map(|call| call.split_once(' ').unwrap().1.to_owned())
                .collect()
        };
        let wait = |count: usize| {
            let calls = calls.clone();
            async move {
                tokio::time::timeout(Duration::from_secs(5), async {
                    while activities(&calls.lock().unwrap()).len() < count {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                })
                .await
                .expect("activity in time");
            }
        };
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&transcript)
            .unwrap();
        writeln!(file, "{}", json!({"type":"user","origin":{"kind":"peer"},"message":{"role":"user","content":envelope}})).unwrap();
        wait(1).await;
        // Another session's line, absorbed mid-turn: not ours, so not one chat's work.
        writeln!(file, "{}", json!({"type":"attachment","attachment":{"type":"queued_command","prompt":"[ZeroLux] something else","origin":{"kind":"peer"}}})).unwrap();
        wait(2).await;
        stopper.send(true).unwrap();
        run.await.unwrap().unwrap();
        assert_eq!(
            activities(&calls.lock().unwrap()),
            [
                json!({"activity":"working","conversation_id":"room"}).to_string(),
                json!({"activity":"working","conversation_id":null}).to_string(),
            ]
        );
    }

    /// Linked while a turn this link never saw is running: the envelope that joins it does
    /// not make it the envelope's chat.
    #[tokio::test]
    async fn an_envelope_joining_a_turn_already_running_at_link_time_names_no_chat() {
        let (sockets, _) = workspace();
        let (_dir, cwd) = workspace();
        let projects = projects(&["birch"]);
        let transcript = projects.path().join("-workspace/birch.jsonl");
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&transcript)
            .unwrap();
        writeln!(
            file,
            "{}",
            json!({"type":"user","message":{"role":"user","content":"a private task"}})
        )
        .unwrap();
        let listener = private_socket(sockets.path(), me());
        let session = linked(sockets.path(), &cwd, projects.path()).await;
        // Nothing owed at link time: the transcript is read from its end.
        let (url, calls) = kernel(inbox("read"), axum::http::StatusCode::OK).await;
        let (wake, changed) = mpsc::channel(1);
        let (stopper, stop) = watch::channel(false);
        let run =
            tokio::spawn(session.run(url, links(), "link".into(), "token".into(), changed, stop));
        let activities = |calls: &Vec<String>| -> Vec<String> {
            calls
                .iter()
                .filter(|call| call.contains("/activity "))
                .map(|call| call.split_once(' ').unwrap().1.to_owned())
                .collect()
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            while activities(&calls.lock().unwrap()).is_empty() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("seeded");
        // An envelope of ours, by the look of its line, joins that turn.
        writeln!(file, "{}", json!({"type":"attachment","attachment":{"type":"queued_command","prompt":"[ZeroLux] 1 new message\nReply, text on stdin: x --to room --reply delivery\n","origin":{"kind":"peer"}}})).unwrap();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        drop(wake);
        stopper.send(true).unwrap();
        run.await.unwrap().unwrap();
        let activities = activities(&calls.lock().unwrap());
        assert_eq!(
            activities[0],
            json!({"activity":"working","conversation_id":null}).to_string()
        );
        assert!(
            activities
                .iter()
                .all(|a| a.contains("\"conversation_id\":null")),
            "{activities:?}"
        );
        let _ = listener;
    }

    /// No signal in the transcript's tail at link time means an unknown state: an envelope
    /// joining before any turn end names no chat.
    #[tokio::test]
    async fn an_unknown_state_at_link_time_names_no_chat_until_a_turn_ends() {
        let (sockets, _) = workspace();
        let (_dir, cwd) = workspace();
        let projects = projects(&["birch"]);
        let transcript = projects.path().join("-workspace/birch.jsonl");
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&transcript)
            .unwrap();
        // Only tool traffic in the tail: the prompt that opened it is out of reach.
        writeln!(file, "{}", json!({"type":"assistant","message":{"content":[{"type":"tool_use"}],"stop_reason":"tool_use"}})).unwrap();
        writeln!(file, "{}", json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}})).unwrap();
        let listener = private_socket(sockets.path(), me());
        let session = linked(sockets.path(), &cwd, projects.path()).await;
        let (url, calls) = kernel(inbox("read"), axum::http::StatusCode::OK).await;
        let (wake, changed) = mpsc::channel(1);
        let (stopper, stop) = watch::channel(false);
        let run =
            tokio::spawn(session.run(url, links(), "link".into(), "token".into(), changed, stop));
        tokio::time::sleep(Duration::from_millis(1200)).await;
        writeln!(file, "{}", json!({"type":"attachment","attachment":{"type":"queued_command","prompt":"[ZeroLux] 1 new message\nReply, text on stdin: x --to room --reply delivery\n","origin":{"kind":"peer"}}})).unwrap();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        drop(wake);
        stopper.send(true).unwrap();
        run.await.unwrap().unwrap();
        let activities: Vec<String> = calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call.contains("/activity "))
            .map(|call| call.split_once(' ').unwrap().1.to_owned())
            .collect();
        assert!(
            activities
                .iter()
                .all(|a| a.contains("\"conversation_id\":null")),
            "{activities:?}"
        );
        let _ = listener;
    }

    /// Receipts owed make the link read the transcript from its start: past turns are not
    /// activity, only the state as of the end is.
    #[tokio::test]
    async fn a_history_read_back_for_receipts_reports_only_the_current_state() {
        let (sockets, _) = workspace();
        let (_dir, cwd) = workspace();
        let projects = projects(&["birch"]);
        let transcript = projects.path().join("-workspace/birch.jsonl");
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&transcript)
            .unwrap();
        for _ in 0..3 {
            writeln!(
                file,
                "{}",
                json!({"type":"user","message":{"role":"user","content":"go"}})
            )
            .unwrap();
            writeln!(file, "{}", json!({"type":"assistant","message":{"content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"}})).unwrap();
            writeln!(
                file,
                "{}",
                json!({"type":"system","subtype":"turn_duration","durationMs":5})
            )
            .unwrap();
        }
        let _listener = private_socket(sockets.path(), me());
        let session = linked(sockets.path(), &cwd, projects.path()).await;
        // An envelope still owed: the whole transcript is read back.
        let mut owed = inbox("uncertain");
        owed["deliveries"][0]["native_request_id"] = json!("delivery");
        let (url, calls) = kernel(owed, axum::http::StatusCode::OK).await;
        let (_wake, changed) = mpsc::channel(1);
        let (stopper, stop) = watch::channel(false);
        let run =
            tokio::spawn(session.run(url, links(), "link".into(), "token".into(), changed, stop));
        tokio::time::sleep(Duration::from_millis(2500)).await;
        stopper.send(true).unwrap();
        run.await.unwrap().unwrap();
        let activities: Vec<String> = calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call.contains("/activity "))
            .map(|call| call.split_once(' ').unwrap().1.to_owned())
            .collect();
        assert_eq!(
            activities,
            [json!({"activity":"idle","conversation_id":null}).to_string()]
        );
    }

    /// Working while the model is in a turn, idle after it: a background process the session
    /// keeps running is not the model working, so the badge follows the transcript alone.
    #[tokio::test]
    async fn activity_follows_the_turns_of_the_transcript() {
        let (sockets, _) = workspace();
        let (_dir, cwd) = workspace();
        let projects = projects(&["birch"]);
        let transcript = projects.path().join("-workspace/birch.jsonl");
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&transcript)
            .unwrap();
        // Linked in the middle of a turn: working from the start.
        writeln!(
            file,
            "{}",
            json!({"type":"user","message":{"role":"user","content":"go"}})
        )
        .unwrap();
        writeln!(file, "{}", json!({"type":"assistant","message":{"content":[{"type":"tool_use"}],"stop_reason":"tool_use"}})).unwrap();
        let _listener = private_socket(sockets.path(), me());
        let session = linked(sockets.path(), &cwd, projects.path()).await;
        let (url, calls) = kernel(inbox("read"), axum::http::StatusCode::OK).await;
        let (_wake, changed) = mpsc::channel(1);
        let (stopper, stop) = watch::channel(false);
        let run =
            tokio::spawn(session.run(url, links(), "link".into(), "token".into(), changed, stop));
        let activities = |calls: &Vec<String>| -> Vec<String> {
            calls
                .iter()
                .filter(|call| call.contains("/activity "))
                .map(|call| call.split_once(' ').unwrap().1.to_owned())
                .collect()
        };
        let wait = |count: usize| {
            let calls = calls.clone();
            async move {
                tokio::time::timeout(Duration::from_secs(5), async {
                    while activities(&calls.lock().unwrap()).len() < count {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                })
                .await
                .expect("activity in time");
            }
        };
        wait(1).await;
        // The turn ends although a background process keeps running: idle.
        writeln!(file, "{}", json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"started in background"}]}})).unwrap();
        writeln!(file, "{}", json!({"type":"assistant","message":{"content":[{"type":"text","text":"waiting"}],"stop_reason":"end_turn"}})).unwrap();
        writeln!(
            file,
            "{}",
            json!({"type":"system","subtype":"turn_duration","durationMs":5})
        )
        .unwrap();
        wait(2).await;
        // A context compaction writes a boundary and a summary row, with no turn after them:
        // still idle. The real case: an agent shown "working" for eleven hours after compacting.
        writeln!(
            file,
            "{}",
            json!({"type":"system","subtype":"compact_boundary","content":"Conversation compacted"})
        )
        .unwrap();
        writeln!(file, "{}", json!({"type":"user","isCompactSummary":true,"isVisibleInTranscriptOnly":true,"message":{"role":"user","content":"This session is being continued from a previous conversation"}})).unwrap();
        // Past two transcript reads: the summary was read on its own, and reported nothing.
        tokio::time::sleep(TRANSCRIPT_INTERVAL * 2 + Duration::from_millis(200)).await;
        assert_eq!(activities(&calls.lock().unwrap()).len(), 2);
        // Its notice opens the next turn: working again.
        writeln!(file, "{}", json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":"background task finished"}]}})).unwrap();
        wait(3).await;
        stopper.send(true).unwrap();
        run.await.unwrap().unwrap();
        assert_eq!(
            activities(&calls.lock().unwrap()),
            [
                json!({"activity":"working","conversation_id":null}).to_string(),
                json!({"activity":"idle","conversation_id":null}).to_string(),
                json!({"activity":"working","conversation_id":null}).to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn the_state_at_link_time_ignores_a_compaction_summary() {
        let projects = projects(&["birch"]);
        let path = projects.path().join("-workspace/birch.jsonl");
        let summary = json!({"type":"user","isCompactSummary":true,"isVisibleInTranscriptOnly":true,"message":{"role":"user","content":"This session is being continued from a previous conversation"}});
        let boundary = json!({"type":"system","subtype":"compact_boundary"});
        let typed = json!({"type":"user","message":{"role":"user","content":"go"}});
        let ended = json!({"type":"system","subtype":"turn_duration","durationMs":5});
        let state = |lines: &[&serde_json::Value]| {
            let text = lines.iter().map(|l| format!("{l}\n")).collect::<String>();
            let path = path.clone();
            async move {
                std::fs::write(&path, text).unwrap();
                Transcript::open(path, false)
                    .await
                    .unwrap()
                    .recent_activity()
                    .await
                    .unwrap()
            }
        };
        // A transcript that ends in a compaction says nothing new: idle stays idle,
        // a turn still running stays working, and a lone summary is no signal at all.
        assert_eq!(
            state(&[&typed, &ended, &boundary, &summary]).await,
            Some("idle")
        );
        assert_eq!(state(&[&typed, &boundary, &summary]).await, Some("working"));
        assert_eq!(state(&[&boundary, &summary]).await, None);
    }

    #[tokio::test]
    async fn the_transcript_is_read_forward_and_keeps_unfinished_lines() {
        let projects = projects(&["birch"]);
        let path = projects.path().join("-workspace/birch.jsonl");
        std::fs::write(&path, "old\n").unwrap();
        let mut transcript = Transcript::open(path.clone(), false).await.unwrap();
        assert!(transcript.read_new().await.unwrap().is_empty());
        std::fs::write(&path, "old\none\ntw").unwrap();
        assert_eq!(transcript.read_new().await.unwrap(), ["one\n"]);
        std::fs::write(&path, "old\none\ntwo\n").unwrap();
        assert_eq!(transcript.read_new().await.unwrap(), ["two\n"]);
        let mut whole = Transcript::open(path.clone(), true).await.unwrap();
        assert_eq!(whole.read_new().await.unwrap().len(), 3);
        // Truncated: read again from the start. Missing: nothing new, no error. Replaced by a
        // longer file, even with the inode Linux just freed: the new file, from its start.
        std::fs::write(&path, "new\n").unwrap();
        assert_eq!(transcript.read_new().await.unwrap(), ["new\n"]);
        std::fs::remove_file(&path).unwrap();
        assert!(transcript.read_new().await.unwrap().is_empty());
        std::fs::write(&path, "other\n").unwrap();
        assert_eq!(transcript.read_new().await.unwrap(), ["other\n"]);
    }

    /// As on a phone: queued by the session is delivered, in front of the model is read.
    #[tokio::test]
    async fn receipts_follow_the_transcript_without_any_command() {
        let (sockets, _) = workspace();
        let (_dir, cwd) = workspace();
        let projects = projects(&["birch"]);
        let transcript = projects.path().join("-workspace/birch.jsonl");
        let listener = private_socket(sockets.path(), me());
        let session = linked(sockets.path(), &cwd, projects.path()).await;
        let (url, calls) = kernel(inbox("stored"), axum::http::StatusCode::OK).await;
        let (_wake, changed) = mpsc::channel(1);
        let (stopper, stop) = watch::channel(false);
        let run =
            tokio::spawn(session.run(url, links(), "link".into(), "token".into(), changed, stop));
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await.unwrap();
        let line: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let envelope = line["message"]["content"].as_str().unwrap().to_owned();

        let receipts = |calls: &Vec<String>| -> Vec<String> {
            calls
                .iter()
                .filter(|call| call.contains("/receipt"))
                .map(|call| call.split_once(' ').unwrap().1.to_owned())
                .collect()
        };
        let wait = |count: usize| {
            let calls = calls.clone();
            async move {
                tokio::time::timeout(Duration::from_secs(5), async {
                    loop {
                        if receipts(&calls.lock().unwrap()).len() >= count {
                            return;
                        }
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                })
                .await
                .expect("receipt in time");
            }
        };
        wait(1).await;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&transcript)
            .unwrap();
        use std::io::Write;
        // Unrelated lines, a mention of the delivery, another envelope, and this envelope
        // quoted inside a message prove nothing about this one.
        let quoted: String = envelope.lines().map(|l| format!("> {l}\n")).collect();
        writeln!(
            file,
            "{}",
            json!({"type":"assistant","message":{"content":envelope}})
        )
        .unwrap();
        writeln!(file, "{}", json!({"type":"user","message":{"role":"user","content":"look at delivery --reply delivery"}})).unwrap();
        // The owner pasting the command into their own session is not the envelope either.
        writeln!(
            file,
            "{}",
            json!({"type":"user","turnOrigin":"peer","message":{"role":"user","content":envelope}})
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            json!({"type":"attachment","attachment":{"type":"queued_command","prompt":envelope}})
        )
        .unwrap();
        writeln!(file, "{}", json!({"type":"user","message":{"role":"user","content":format!("[ZeroLux] 1 new message\nReply, text on stdin: x --to room --reply other\n{quoted}")}})).unwrap();
        writeln!(file, "{}", json!({"type":"queue-operation","operation":"enqueue","content":"[ZeroLux] --reply other"})).unwrap();
        writeln!(
            file,
            "{}",
            json!({"type":"queue-operation","operation":"enqueue","content":envelope})
        )
        .unwrap();
        wait(2).await;
        writeln!(file, "{}", json!({"type":"user","origin":{"kind":"peer"},"message":{"role":"user","content":format!("Another Claude session sent a message:\n{envelope}")}})).unwrap();
        wait(3).await;
        // What comes later never rewrites a read.
        writeln!(
            file,
            "{}",
            json!({"type":"attachment","attachment":{"type":"queued_command","prompt":envelope,"origin":{"kind":"peer"}}})
        )
        .unwrap();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        stopper.send(true).unwrap();
        run.await.unwrap().unwrap();
        let receipts = receipts(&calls.lock().unwrap());
        assert_eq!(receipts.len(), 3);
        assert!(receipts[0].contains("\"status\":\"uncertain\""));
        assert!(receipts[0].contains(WRITTEN));
        assert_eq!(
            receipts[1],
            json!({"status":"notified","native_request_id":"delivery"}).to_string()
        );
        assert_eq!(receipts[2], json!({"status":"read"}).to_string());
    }

    #[tokio::test]
    async fn marks_the_delivery_uncertain_before_and_after_writing_it_once() {
        let (sockets, _) = workspace();
        let (_dir, cwd) = workspace();
        let listener = private_socket(sockets.path(), me());
        let projects = projects(&["birch"]);
        let session = linked(sockets.path(), &cwd, projects.path()).await;
        let (url, calls) = kernel(inbox("stored"), axum::http::StatusCode::OK).await;
        let (wake, changed) = mpsc::channel(1);
        let (stopper, stop) = watch::channel(false);
        let run =
            tokio::spawn(session.run(url, links(), "link".into(), "token".into(), changed, stop));

        let (mut stream, _) = listener.accept().await.unwrap();
        assert!(
            calls
                .lock()
                .unwrap()
                .last()
                .unwrap()
                .contains("\"native_request_id\":\"delivery\""),
            "the kernel knows the envelope before the session does"
        );
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await.unwrap();
        let line: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let prompt = line["message"]["content"].as_str().unwrap();
        assert!(prompt.ends_with("\n> Can you check the test?"));
        assert!(prompt.contains(" --reply delivery\n"));
        assert!(prompt.contains("Your terminal answer stays private"));
        assert!(
            !prompt.contains("token"),
            "the credential never reaches the session"
        );

        // A later invalidation re-reads the inbox; the same stored row is dispatched once more
        // by this stand-in, so stop first and check the order of the first delivery.
        stopper.send(true).unwrap();
        drop(wake);
        run.await.unwrap().unwrap();
        let calls = calls.lock().unwrap();
        let order: Vec<_> = calls
            .iter()
            .map(|call| call.split(' ').next().unwrap())
            .collect();
        assert_eq!(
            order,
            [
                "/api/chat/sessions/link/status",
                "/api/chat/inbox",
                "/api/chat/deliveries/delivery/dispatch",
                "/api/chat/deliveries/delivery/receipt",
            ]
        );
        assert!(calls[3].contains("\"status\":\"uncertain\""));
    }

    #[tokio::test]
    async fn writes_nothing_when_the_kernel_refuses_the_dispatch() {
        let (sockets, _) = workspace();
        let (_dir, cwd) = workspace();
        let listener = private_socket(sockets.path(), me());
        let projects = projects(&["birch"]);
        let session = linked(sockets.path(), &cwd, projects.path()).await;
        // Paused conversation or a delivery already attempted: the kernel answers 409.
        let (url, calls) = kernel(inbox("stored"), axum::http::StatusCode::CONFLICT).await;
        let (_wake, changed) = mpsc::channel(1);
        let (stopper, stop) = watch::channel(false);
        let run =
            tokio::spawn(session.run(url, links(), "link".into(), "token".into(), changed, stop));
        let written = tokio::time::timeout(Duration::from_millis(500), listener.accept()).await;
        assert!(written.is_err(), "nothing reaches the session");
        stopper.send(true).unwrap();
        run.await.unwrap().unwrap();
        assert!(
            !calls
                .lock()
                .unwrap()
                .iter()
                .any(|call| call.contains("/receipt"))
        );
    }

    #[tokio::test]
    async fn an_unreachable_inbox_leaves_the_delivery_uncertain_and_asks_for_attention() {
        let (sockets, _) = workspace();
        let (_dir, cwd) = workspace();
        let listener = private_socket(sockets.path(), me());
        let projects = projects(&["birch"]);
        let session = linked(sockets.path(), &cwd, projects.path()).await;
        drop(listener);
        std::fs::remove_file(sockets.path().join(format!("{}.sock", me()))).unwrap();
        let (url, calls) = kernel(inbox("stored"), axum::http::StatusCode::OK).await;
        let (_wake, changed) = mpsc::channel(1);
        let (_stopper, stop) = watch::channel(false);
        let result = session
            .run(url, links(), "link".into(), "token".into(), changed, stop)
            .await;
        assert!(result.is_err());
        let calls = calls.lock().unwrap();
        assert!(
            calls
                .iter()
                .any(|call| call.contains("/receipt") && call.contains("uncertain"))
        );
        assert!(calls.last().unwrap().contains("attention"));
        assert_eq!(
            calls
                .iter()
                .filter(|call| call.contains("/dispatch"))
                .count(),
            1,
            "never dispatched twice"
        );
    }

    #[tokio::test]
    async fn a_revoked_token_is_a_clean_end_only_when_the_link_was_stopped() {
        let (sockets, _) = workspace();
        let (_dir, cwd) = workspace();
        let _listener = private_socket(sockets.path(), me());
        for stopped in [true, false] {
            let projects = projects(&["birch"]);
            let session = linked(sockets.path(), &cwd, projects.path()).await;
            let (url, calls) = kernel(serde_json::Value::Null, axum::http::StatusCode::OK).await;
            let (_wake, changed) = mpsc::channel(1);
            let (_stopper, stop) = watch::channel(stopped);
            let result = session
                .run(url, links(), "link".into(), "token".into(), changed, stop)
                .await;
            let asked_attention = calls
                .lock()
                .unwrap()
                .iter()
                .any(|call| call.contains("attention"));
            assert_eq!(result.is_ok(), stopped);
            assert_eq!(asked_attention, !stopped);
        }
    }

    #[tokio::test]
    async fn refuses_sessions_that_cannot_be_connected() {
        let (sockets, _) = workspace();
        let (_dir, cwd) = workspace();
        let (_elsewhere, other_cwd) = workspace();
        let _listener = private_socket(sockets.path(), me());
        let open = private_socket(sockets.path(), 43);
        std::fs::set_permissions(
            sockets.path().join("43.sock"),
            std::fs::Permissions::from_mode(0o666),
        )
        .unwrap();
        let sessions = || {
            listed(json!([
                {"sessionId":"live","cwd":cwd,"kind":"interactive","pid":me()},
                {"sessionId":"in-background","cwd":cwd,"kind":"background","id":"y","state":"blocked","pid":me()},
                {"sessionId":"ended","cwd":cwd,"kind":"background","id":"x","state":"done"},
                {"sessionId":"no-inbox","cwd":cwd,"kind":"interactive","pid":40},
                {"sessionId":"shared-inbox","cwd":cwd,"kind":"interactive","pid":43},
            ]))
        };
        let projects = projects(&["live", "in-background", "ended", "no-inbox", "shared-inbox"]);
        let attach = |id, workspace| {
            ClaudeSession::select(sessions(), id, workspace, sockets.path(), projects.path())
        };
        assert!(attach("live", &cwd).is_ok());
        assert!(
            attach("in-background", &cwd).is_ok(),
            "a running background session connects"
        );
        for (id, workspace, why) in [
            ("gone", &cwd, "no longer running"),
            ("ended", &cwd, "no running process"),
            ("no-inbox", &cwd, "exposes no inbox"),
            ("shared-inbox", &cwd, "not a private socket"),
            ("live", &other_cwd, "workspace changed"),
        ] {
            let error = attach(id, workspace)
                .err()
                .unwrap_or_else(|| panic!("{id} must be refused"));
            assert!(error.to_string().contains(why), "{id}: {error}");
        }
        // A session that has not written its transcript yet is still a live session.
        std::fs::remove_file(projects.path().join("-workspace/live.jsonl")).unwrap();
        assert!(attach("live", &cwd).is_ok());
        drop(open);
    }
}
