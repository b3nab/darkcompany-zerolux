//! Read-only native discovery and private handoff to an already-running pi extension.
//! No resume, process launch of an agent, transcript parser, or model request lives here.
use crate::{codex::CodexRpc, harness::Harness};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const IO_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_OUTPUT: u64 = 4 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
pub struct DiscoveredSession {
    pub id: String,
    pub harness: Harness,
    pub title: String,
    pub workspace: String,
    pub last_activity_at: Option<i64>,
    pub native_session_id: String,
    pub availability: String,
    pub can_create_context: bool,
    pub reason: Option<String>,
}
#[derive(Serialize)]
pub struct DiscoveryError {
    pub harness: Harness,
    pub message: String,
}
#[derive(Serialize, Default)]
pub struct Discovery {
    pub sessions: Vec<DiscoveredSession>,
    pub errors: Vec<DiscoveryError>,
}

// Never Serialize/Debug: only the kernel/adapter may see control endpoints and locator data.
#[derive(Clone)]
pub struct NativeSessionTarget {
    pub harness: Harness,
    pub native_session_id: String,
    pub title: String,
    pub workspace: String,
    pub native_locator: Value,
}
struct Candidate {
    public: DiscoveredSession,
    target: NativeSessionTarget,
    /// A session this kernel had linked can be relinked after a restart.
    resumable: bool,
}

fn candidate(
    target: NativeSessionTarget,
    last_activity_at: Option<i64>,
    attachable: bool,
    reason: &str,
) -> Candidate {
    // Opaque identity, stable across list calls. Never trust a browser-supplied path or endpoint.
    let identity = json!([
        target.harness.id(),
        target.native_session_id,
        target.native_locator
    ]);
    let id = format!("{:x}", Sha256::digest(identity.to_string().as_bytes()));
    Candidate {
        public: DiscoveredSession {
            id,
            harness: target.harness,
            title: target.title.clone(),
            workspace: target.workspace.clone(),
            last_activity_at,
            native_session_id: target.native_session_id.clone(),
            availability: if attachable {
                "attachable"
            } else {
                "attention"
            }
            .into(),
            can_create_context: false,
            reason: Some(reason.into()),
        },
        target,
        resumable: attachable,
    }
}
fn text(value: &Value, key: &str) -> Result<String> {
    let value = value[key].as_str().context("Missing native metadata")?;
    ensure!(
        !value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control),
        "Invalid native metadata"
    );
    Ok(value.to_owned())
}
fn title(value: &Value, key: &str, fallback: &str) -> String {
    value[key]
        .as_str()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(fallback)
        .chars()
        .filter(|c| !c.is_control())
        .take(200)
        .collect()
}
fn home() -> Result<PathBuf> {
    let path = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .context("Home directory unavailable")?;
    let path = PathBuf::from(path);
    ensure!(path.is_absolute(), "Home directory must be absolute");
    Ok(path)
}
fn agent_dir() -> Result<PathBuf> {
    let path = match std::env::var("PI_CODING_AGENT_DIR") {
        Ok(value) if value.starts_with("~/") => home()?.join(&value[2..]),
        Ok(value) => PathBuf::from(value),
        Err(_) => home()?.join(".pi/agent"),
    };
    ensure!(path.is_absolute(), "Pi agent directory must be absolute");
    Ok(path)
}

async fn command_json(program: &str, args: &[&str]) -> Result<Value> {
    let mut child = tokio::process::Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("Metadata command unavailable")?;
    let result = tokio::time::timeout(IO_TIMEOUT, async {
        let mut bytes = Vec::new();
        child
            .stdout
            .take()
            .context("Metadata stdout unavailable")?
            .take(MAX_OUTPUT + 1)
            .read_to_end(&mut bytes)
            .await?;
        ensure!(
            bytes.len() as u64 <= MAX_OUTPUT,
            "Native metadata exceeds the discovery response limit"
        );
        ensure!(
            child.wait().await?.success(),
            "Native metadata command failed"
        );
        serde_json::from_slice(&bytes).context("Invalid native metadata response")
    })
    .await;
    match result {
        Ok(Ok(value)) => Ok(value),
        other => {
            let _ = child.kill().await;
            match other {
                Ok(Err(error)) => Err(error),
                _ => bail!("Native metadata discovery timed out"),
            }
        }
    }
}

/// The session catalogue of a machine: metadata only, but every session of every project.
const CATALOGUE_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Clone, Deserialize)]
struct PiDescriptor {
    version: u32,
    instance_id: String,
    endpoint: String,
    nonce: String,
    native_session_id: String,
    workspace: String,
}
async fn descriptor(path: &Path) -> Result<PiDescriptor> {
    let metadata = tokio::fs::symlink_metadata(path).await?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() < 64 * 1024,
        "Invalid pi descriptor"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "Pi descriptor is not private"
        );
    }
    let record: PiDescriptor = serde_json::from_slice(&tokio::fs::read(path).await?)?;
    ensure!(
        record.version == 1
            && record.nonce.len() == 64
            && record.nonce.bytes().all(|c| c.is_ascii_hexdigit()),
        "Unsupported pi descriptor"
    );
    Ok(record)
}

/// A control exchange with a live pi. Pairing may wait for the extension; the session
/// catalogue is computed by pi's SDK and can be large; every other message is small and quick.
async fn control(record: &PiDescriptor, mut request: Value) -> Result<Value> {
    let (deadline, limit) = match request["method"].as_str() {
        Some("pair") => (Duration::from_secs(60), 64 * 1024),
        Some("sessions") => (Duration::from_secs(15), CATALOGUE_LIMIT),
        _ => (Duration::from_secs(5), 64 * 1024),
    };
    request["nonce"] = Value::String(record.nonce.clone());
    let exchange = async {
        #[cfg(unix)]
        let mut stream = tokio::net::UnixStream::connect(&record.endpoint)
            .await
            .context("Pi control endpoint unavailable")?;
        #[cfg(windows)]
        let mut stream = tokio::net::windows::named_pipe::ClientOptions::new()
            .open(&record.endpoint)
            .context("Pi control endpoint unavailable")?;
        #[cfg(not(any(unix, windows)))]
        compile_error!("Native pi IPC requires Unix sockets or Windows named pipes");
        stream.write_all(format!("{request}\n").as_bytes()).await?;
        let mut bytes = Vec::new();
        stream
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .await?;
        ensure!(bytes.len() <= limit, "Pi control response too large");
        let response: Value =
            serde_json::from_slice(&bytes).context("Invalid pi control response")?;
        ensure!(
            response["ok"] == true,
            "Pi is busy, changed, or unavailable; refresh the session list"
        );
        Ok(response)
    };
    tokio::time::timeout(deadline, exchange)
        .await
        .context("Pi control timed out; do not blindly repeat pairing")?
}

#[cfg(test)]
async fn live_pi(registry: &Path) -> Result<Vec<Candidate>> {
    Ok(live_pi_with_descriptors(registry).await?.0)
}

/// Live pi processes: their candidates, and the verified descriptors that reached them.
async fn live_pi_with_descriptors(registry: &Path) -> Result<(Vec<Candidate>, Vec<PiDescriptor>)> {
    let mut candidates = Vec::new();
    let mut live = Vec::new();
    let mut entries = match tokio::fs::read_dir(registry).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((candidates, live));
        }
        Err(error) => return Err(error.into()),
    };
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(record) = descriptor(&path).await else {
            continue;
        };
        let Ok(actual) = control(&record, json!({"method":"describe"})).await else {
            continue;
        };
        if actual["instance_id"] != record.instance_id
            || actual["native_session_id"] != record.native_session_id
            || actual["workspace"] != record.workspace
        {
            continue;
        }
        let workspace = match tokio::fs::canonicalize(&record.workspace).await {
            Ok(path) => path.to_string_lossy().into_owned(),
            Err(_) => continue,
        };
        if workspace != record.workspace {
            continue;
        }
        let ready = actual["busy"] == false && actual["paired"] == false;
        let mut found = candidate(
            NativeSessionTarget {
                harness: Harness::Pi,
                native_session_id: record.native_session_id.clone(),
                title: title(&actual, "title", "pi session"),
                workspace,
                native_locator: json!({"descriptor":path,"instance_id":record.instance_id}),
            },
            None,
            ready,
            if ready {
                "Existing session ready. Native extension dialogs still require pi; new isolated contexts are not yet supported."
            } else {
                "This pi session is busy or already linked. Wait or stop its existing link before hiring."
            },
        );
        // The extension treats a new token for its live link as a relink, even mid-turn.
        found.resumable = true;
        candidates.push(found);
        live.push(record);
    }
    let mut counts = HashMap::new();
    for entry in &candidates {
        *counts
            .entry(entry.target.native_session_id.clone())
            .or_insert(0usize) += 1;
    }
    for entry in &mut candidates {
        if counts[&entry.target.native_session_id] > 1 {
            entry.resumable = false;
            entry.public.availability = "attention".into();
            entry.public.reason = Some("Several live pi processes claim this session identity. Resolve the duplicate processes before hiring.".into());
        }
    }
    Ok((candidates, live))
}

/// The pi catalogue comes from a live pi: its extension lists the machine's sessions with
/// pi's own SDK, in-process. Without a live pi the catalogue is unavailable, not empty; a live
/// pi that cannot list keeps its own candidate and is reported.
async fn discover_pi() -> Result<(Vec<Candidate>, Option<String>)> {
    discover_pi_in(&agent_dir()?.join("zerolux-links")).await
}

async fn discover_pi_in(registry: &Path) -> Result<(Vec<Candidate>, Option<String>)> {
    let (mut candidates, live) = live_pi_with_descriptors(registry).await?;
    ensure!(!live.is_empty(), "No live pi with the ZeroLux extension");
    let mut listed = None;
    for record in &live {
        match control(record, json!({"method":"sessions"})).await {
            Ok(value) if value["sessions"].is_array() => {
                listed = Some(value);
                break;
            }
            Ok(_) | Err(_) => continue,
        }
    }
    let Some(value) = listed else {
        return Ok((
            candidates,
            Some("pi is running but could not list this computer's sessions; only its live sessions are shown".into()),
        ));
    };
    for info in value["sessions"].as_array().into_iter().flatten() {
        let Ok(id) = text(info, "native_session_id") else {
            continue;
        };
        if let Some(live) = candidates
            .iter_mut()
            .find(|c| c.target.native_session_id == id)
        {
            if info["workspace"] == live.target.workspace {
                live.public.last_activity_at = info["last_activity_at"].as_i64();
            }
            continue;
        }
        let Ok(path) = text(info, "path") else {
            continue;
        };
        let workspace = info["workspace"].as_str().unwrap_or("").to_owned();
        candidates.push(candidate(NativeSessionTarget {
            harness: Harness::Pi, native_session_id: id, title: title(info, "title", "pi session"),
            workspace, native_locator: json!({"session_file":path}),
        }, info["last_activity_at"].as_i64(), false,
        "No live ZeroLux extension was found for this session. Loading the extension requires native pi trust/reload; this release will not start a replacement process."));
    }
    Ok((candidates, None))
}

fn claude_candidates(value: &Value) -> Result<Vec<Candidate>> {
    value.as_array().context("Invalid Claude session list")?.iter().map(|info| {
        let id = text(info, "sessionId")?;
        let pid = info["pid"].as_u64();
        let socket = pid.map(|pid| format!("/tmp/cc-socks/{pid}.sock"));
        Ok(candidate(NativeSessionTarget {
            harness: Harness::ClaudeCode, native_session_id: id.clone(),
            title: title(info, "name", "Claude Code session"), workspace: text(info, "cwd")?,
            native_locator: json!({"session_id":id,"name":info["name"],"pid":pid,"socket":socket}),
        }, None, false, "This Claude Code session was not verified"))
    }).collect()
}

/// What a connected Claude Code session can and cannot do, stated up front.
const CLAUDE_READY: &str = "Claude Code inbox verified. Replies go through chat-send; tool permissions are answered in Claude Code itself; Stop closes the link but cannot interrupt a running turn.";

async fn discover_claude() -> Result<Vec<Candidate>> {
    let mut candidates = claude_candidates(&command_json("claude", &["agents", "--json"]).await?)?;
    #[cfg(unix)]
    for entry in &mut candidates {
        // Reuse the driver's read-only verifier, rather than diverging on socket/identity rules.
        // A refusal shows its reason: the owner learns what is missing, not a generic notice.
        match crate::claude::ClaudeSession::attach(
            &entry.target.native_session_id,
            &entry.target.workspace,
        )
        .await
        {
            Ok(_) => {
                entry.resumable = true;
                entry.public.availability = "attachable".into();
                entry.public.reason = Some(CLAUDE_READY.into());
            }
            Err(error) => entry.public.reason = Some(format!("{error}")),
        }
    }
    Ok(candidates)
}

async fn codex_candidates(endpoint: &str) -> Result<Vec<Candidate>> {
    let rpc = CodexRpc::connect(endpoint).await?;
    let mut loaded = HashSet::new();
    let mut cursor = Value::Null;
    let mut cursors = HashSet::new();
    loop {
        let page = rpc
            .request("thread/loaded/list", json!({"limit":100,"cursor":cursor}))
            .await?;
        for id in page["data"]
            .as_array()
            .context("Invalid loaded thread list")?
        {
            loaded.insert(
                id.as_str()
                    .context("Invalid loaded thread identity")?
                    .to_owned(),
            );
        }
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
        ensure!(
            cursors.insert(cursor.to_string()),
            "Repeated native pagination cursor"
        );
    }
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    cursor = Value::Null;
    cursors.clear();
    loop {
        let page = rpc.request("thread/list", json!({"limit":100,"cursor":cursor,"modelProviders":[],"useStateDbOnly":true,"sortKey":"updated_at"})).await?;
        for info in page["data"]
            .as_array()
            .context("Invalid native thread list")?
        {
            let id = text(info, "id")?; // NOT sessionId, which is shared by forks.
            if !seen.insert(id.clone()) {
                continue;
            }
            let read = rpc
                .request("thread/read", json!({"threadId":id,"includeTurns":false}))
                .await?;
            let actual = &read["thread"];
            ensure!(actual["id"] == id, "Codex returned another native identity");
            let ready = loaded.contains(&id)
                && matches!(actual["status"]["type"].as_str(), Some("idle" | "active"))
                && actual["canAcceptDirectInput"] == true
                && actual["ephemeral"] == false;
            candidates.push(candidate(NativeSessionTarget {
                harness: Harness::Codex, native_session_id: id,
                title: title(actual, "name", "Codex thread"), workspace: text(actual, "cwd")?,
                native_locator: json!({"endpoint":endpoint}),
            }, actual["updatedAt"].as_i64().and_then(|time| time.checked_mul(1000)), ready,
            if ready { "Loaded in this Codex runtime. A new isolated context requires a verified launch profile." }
            else { "Not currently attachable in the discovered Codex runtime. No runtime or thread will be started implicitly." }));
        }
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
        ensure!(
            cursors.insert(cursor.to_string()),
            "Repeated native pagination cursor"
        );
    }
    Ok(candidates)
}
/// The control socket of the user's Codex app-server daemon, as `codex` itself finds it.
pub fn codex_endpoint() -> Result<String> {
    let root = match std::env::var_os("CODEX_HOME") {
        Some(root) => PathBuf::from(root),
        None => home()?.join(".codex"),
    };
    let endpoint = root.join("app-server-control/app-server-control.sock");
    ensure!(endpoint.is_absolute(), "Codex home must be absolute");
    Ok(format!("unix://{}", endpoint.to_string_lossy()))
}

/// Codex's own daemon, through its own lifecycle: `codex app-server daemon start` starts it
/// only if it is not running, and never restarts or reconfigures a running one. Returns the
/// endpoint once it answers. The daemon outlives the kernel: it is never stopped by ZeroLux.
pub async fn ensure_codex_daemon() -> Result<String> {
    let endpoint = codex_endpoint()?;
    ensure_codex_daemon_with(Path::new("codex"), &endpoint).await?;
    Ok(endpoint)
}

/// One attempt to start, bounded; the daemon's own output never reaches the API.
pub async fn ensure_codex_daemon_with(program: &Path, endpoint: &str) -> Result<()> {
    if CodexRpc::connect(endpoint).await.is_ok() {
        return Ok(());
    }
    let mut launcher = tokio::process::Command::new(program);
    launcher
        .args(["app-server", "daemon", "start"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // The launcher only; the daemon it starts detaches and is Codex's to keep.
        .kill_on_drop(true);
    let status = tokio::time::timeout(Duration::from_secs(30), launcher.status())
        .await
        .context("Starting the Codex daemon timed out")?
        .context("Cannot run `codex`; install Codex or put it on PATH")?;
    ensure!(status.success(), "Codex daemon did not start ({status})");
    tokio::time::timeout(Duration::from_secs(15), async {
        while CodexRpc::connect(endpoint).await.is_err() {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    })
    .await
    .context("The Codex daemon started but its control socket does not answer")?;
    Ok(())
}

async fn discover_codex() -> Result<Vec<Candidate>> {
    codex_candidates(&codex_endpoint()?).await
}

async fn scan() -> (Vec<Candidate>, Vec<DiscoveryError>) {
    let (pi, claude, codex) = tokio::join!(discover_pi(), discover_claude(), discover_codex(),);
    let mut candidates = Vec::new();
    let mut errors = Vec::new();
    let pi = pi.map(|(found, partial)| {
        if let Some(message) = partial {
            errors.push(DiscoveryError {
                harness: Harness::Pi,
                message,
            });
        }
        found
    });
    for (harness, result) in [
        (Harness::Pi, pi),
        (Harness::ClaudeCode, claude),
        (Harness::Codex, codex),
    ] {
        match result {
            Ok(found) => candidates.extend(found),
            // Don't surface CLI/RPC errors containing personal paths, content, or credentials.
            Err(_) => errors.push(DiscoveryError {
                harness,
                message: format!(
                    "{} discovery is unavailable; no agent was started",
                    harness.id()
                ),
            }),
        }
    }
    candidates.sort_by(|a, b| {
        b.public
            .last_activity_at
            .cmp(&a.public.last_activity_at)
            .then(a.public.id.cmp(&b.public.id))
    });
    (candidates, errors)
}

pub async fn discover_sessions() -> Discovery {
    let (candidates, errors) = scan().await;
    Discovery {
        sessions: candidates.into_iter().map(|c| c.public).collect(),
        errors,
    }
}
pub async fn resolve_session(id: &str) -> Result<NativeSessionTarget> {
    ensure!(
        id.len() == 64 && id.bytes().all(|c| c.is_ascii_hexdigit()),
        "Invalid discovery selection"
    );
    let (candidates, _) = scan().await;
    let candidate = candidates
        .into_iter()
        .find(|c| c.public.id == id)
        .context("The selected session is no longer available; refresh the list")?;
    ensure!(
        candidate.public.availability == "attachable",
        "The selected native session needs attention before linking"
    );
    Ok(candidate.target)
}

/// The live session that a link stopped by a kernel restart pointed to, if it can be relinked.
pub async fn resolve_linked(harness: &str, native_session_id: &str) -> Option<NativeSessionTarget> {
    let (candidates, _) = scan().await;
    candidates
        .into_iter()
        .find(|c| {
            c.resumable
                && c.target.harness.id() == harness
                && c.target.native_session_id == native_session_id
        })
        .map(|c| c.target)
}

/// Owns the private control link, NOT the externally launched pi process.
pub struct PiLink {
    descriptor: PiDescriptor,
    link_id: String,
}
impl PiLink {
    pub async fn shutdown(self) -> Result<()> {
        control(
            &self.descriptor,
            json!({"method":"stop","link_id":self.link_id}),
        )
        .await?;
        Ok(())
    }
}
pub async fn pair_pi(
    target: &NativeSessionTarget,
    base_url: &str,
    token: String,
    resume: bool,
) -> Result<PiLink> {
    ensure!(target.harness == Harness::Pi, "This target is not pi");
    let path = target.native_locator["descriptor"]
        .as_str()
        .context("No live pi descriptor")?;
    let record = descriptor(Path::new(path)).await?;
    ensure!(
        record.instance_id == target.native_locator["instance_id"]
            && record.native_session_id == target.native_session_id
            && record.workspace == target.workspace,
        "The pi process changed before pairing"
    );
    let actual = control(&record, json!({"method":"describe"})).await?;
    ensure!(
        actual["instance_id"] == record.instance_id
            && actual["native_session_id"] == target.native_session_id
            && actual["workspace"] == target.workspace
            && (resume || actual["busy"] == false),
        "The pi session changed or is busy"
    );
    let executable = std::env::current_exe()?.canonicalize()?;
    let paired = control(
        &record,
        json!({"method":"pair","native_session_id":target.native_session_id,
        "workspace":target.workspace,"base_url":base_url,"token":token,"executable":executable}),
    )
    .await?;
    let link_id = text(&paired, "link_id")?;
    Ok(PiLink {
        descriptor: record,
        link_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn claude_projects_only_metadata_and_does_not_invent_activity_or_attach() {
        let input = json!([
            {"sessionId":"a","cwd":"/work","name":"aspen","pid":123,"kind":"interactive","status":"idle","startedAt":100,"secret":"never"},
            {"sessionId":"b","cwd":"/work","name":"birch","id":"bg","kind":"background","state":"blocked","startedAt":200}
        ]);
        let candidates = claude_candidates(&input).unwrap();
        let public =
            serde_json::to_string(&candidates.iter().map(|c| &c.public).collect::<Vec<_>>())
                .unwrap();
        assert!(!public.contains("never") && !public.contains("socket") && !public.contains("pid"));
        assert_eq!(
            candidates[0].target.native_locator["socket"],
            "/tmp/cc-socks/123.sock"
        );
        assert!(candidates[1].target.native_locator["pid"].is_null());
        assert!(
            candidates
                .iter()
                .all(|c| c.public.last_activity_at.is_none()
                    && c.public.availability == "attention"
                    && !c.public.can_create_context)
        );
    }
    #[test]
    fn ids_are_stable_and_distinguish_native_runtime_and_thread() {
        let make = |native: &str, endpoint: &str| {
            candidate(
                NativeSessionTarget {
                    harness: Harness::Codex,
                    native_session_id: native.into(),
                    title: "friendly".into(),
                    workspace: "/work".into(),
                    native_locator: json!({"endpoint":endpoint}),
                },
                None,
                true,
                "test",
            )
            .public
            .id
        };
        assert_eq!(make("thread-a", "runtime-a"), make("thread-a", "runtime-a"));
        assert_ne!(make("thread-a", "runtime-a"), make("thread-b", "runtime-a"));
        assert_ne!(make("thread-a", "runtime-a"), make("thread-a", "runtime-b"));
    }
    #[tokio::test]
    async fn malformed_selection_is_rejected_before_any_discovery_io() {
        assert!(resolve_session("../../personal").await.is_err());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn pi_discovery_proves_liveness_without_pairing_or_exposing_nonce() {
        use tokio::net::UnixListener;
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("p.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let registry = dir.path().join("registry");
        tokio::fs::create_dir(&registry).await.unwrap();
        let descriptor = registry.join("instance.json");
        let workspace = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        tokio::fs::write(&descriptor, json!({"version":1,"instance_id":"instance","endpoint":socket,"nonce":"a".repeat(64),"native_session_id":"native","workspace":workspace}).to_string()).await.unwrap();
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&descriptor, std::fs::Permissions::from_mode(0o600))
            .await
            .unwrap();
        let actual = json!({"ok":true,"instance_id":"instance","native_session_id":"native","workspace":workspace,"title":"pi test","busy":false,"paired":false});
        let server = tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["method"], "describe");
            assert_eq!(request["nonce"], "a".repeat(64));
            stream
                .get_mut()
                .write_all(format!("{actual}\n").as_bytes())
                .await
                .unwrap();
        });
        let candidates = live_pi(&registry).await.unwrap();
        server.await.unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].public.availability, "attachable");
        let public = serde_json::to_string(&candidates[0].public).unwrap();
        assert!(
            !public.contains(&"a".repeat(64))
                && !public.contains("descriptor")
                && !public.contains("endpoint")
        );
        assert!(live_pi(&registry).await.unwrap().is_empty()); // stale socket is never attachable
    }

    /// The catalogue comes from a live pi and can be large; a live pi that cannot list keeps
    /// its own candidate and is reported; without a live pi the catalogue is unavailable.
    #[tokio::test]
    async fn pi_catalogue_comes_from_a_live_pi_and_may_exceed_a_control_message() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        use tokio::net::UnixListener;
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("p.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let registry = dir.path().join("registry");
        tokio::fs::create_dir(&registry).await.unwrap();
        let workspace = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        tokio::fs::write(registry.join("instance.json"), json!({"version":1,"instance_id":"instance","endpoint":socket,"nonce":"a".repeat(64),"native_session_id":"native","workspace":workspace}).to_string()).await.unwrap();
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(
            registry.join("instance.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .await
        .unwrap();
        let describe = json!({"ok":true,"instance_id":"instance","native_session_id":"native","workspace":workspace,"title":"pi test","busy":false,"paired":false});
        // 1500 past sessions of other projects plus the live one: well over 64 KiB.
        let mut sessions: Vec<Value> = (0..1500)
            .map(|i| json!({"native_session_id":format!("past-{i}"),"title":format!("Past session {i}"),"workspace":format!("/projects/{i}"),"last_activity_at":1000+i,"path":format!("/sessions/past-{i}.jsonl")}))
            .collect();
        sessions.push(json!({"native_session_id":"native","title":"pi test","workspace":workspace,"last_activity_at":777,"path":"/sessions/native.jsonl"}));
        let catalogue = json!({"ok":true,"sessions":sessions}).to_string();
        assert!(catalogue.len() > 64 * 1024);
        let refuse_listing = Arc::new(AtomicBool::new(false));
        let refuse_flag = refuse_listing.clone();
        let server = tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let mut stream = BufReader::new(stream);
                let mut line = String::new();
                stream.read_line(&mut line).await.unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                assert_eq!(request["nonce"], "a".repeat(64));
                let reply = match request["method"].as_str().unwrap() {
                    "describe" => describe.to_string(),
                    // The socket closes without an answer.
                    "sessions" if refuse_flag.load(Ordering::SeqCst) => continue,
                    "sessions" => catalogue.clone(),
                    other => panic!("unexpected method {other}"),
                };
                stream
                    .get_mut()
                    .write_all(format!("{reply}\n").as_bytes())
                    .await
                    .unwrap();
                let _ = stream.get_mut().shutdown().await;
            }
        });
        let (candidates, partial) = discover_pi_in(&registry).await.unwrap();
        assert!(partial.is_none());
        assert_eq!(candidates.len(), 1501);
        let live = candidates
            .iter()
            .find(|c| c.target.native_session_id == "native")
            .unwrap();
        assert_eq!(live.public.availability, "attachable");
        assert_eq!(
            live.public.last_activity_at,
            Some(777),
            "activity merged from the catalogue"
        );
        let past = candidates
            .iter()
            .find(|c| c.target.native_session_id == "past-7")
            .unwrap();
        assert_eq!(past.public.availability, "attention");
        assert_eq!(past.public.workspace, "/projects/7");
        assert!(
            !serde_json::to_string(&past.public)
                .unwrap()
                .contains("/sessions/")
        );

        // The live pi cannot list: its own candidate stays, and the gap is reported.
        refuse_listing.store(true, Ordering::SeqCst);
        let (candidates, partial) = discover_pi_in(&registry).await.unwrap();
        assert_eq!(candidates.len(), 1);
        assert!(partial.unwrap().contains("could not list"));
        server.abort();

        // No live pi: the catalogue is unavailable, not empty.
        tokio::fs::remove_file(registry.join("instance.json"))
            .await
            .unwrap();
        assert!(discover_pi_in(&registry).await.is_err());
    }
}
