//! Read-only native discovery, running and saved, and private handoff to an already-running
//! pi extension. No process launch of an agent or model request lives here.
use crate::platform::Canonical;
use crate::{codex::CodexRpc, harness::Harness};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

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
#[derive(Clone, Serialize)]
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
#[derive(Clone)]
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
pub(crate) fn agent_dir() -> Result<PathBuf> {
    let path = match std::env::var("PI_CODING_AGENT_DIR") {
        Ok(value) if value.starts_with("~/") => home()?.join(&value[2..]),
        Ok(value) => PathBuf::from(value),
        Err(_) => home()?.join(".pi/agent"),
    };
    ensure!(path.is_absolute(), "Pi agent directory must be absolute");
    Ok(path)
}

async fn command_json(program: &str, args: &[&str]) -> Result<Value> {
    let mut child = tokio::process::Command::new(crate::platform::executable(program))
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
pub(crate) struct PiDescriptor {
    version: u32,
    pub(crate) instance_id: String,
    endpoint: String,
    nonce: String,
    #[serde(default)]
    pub(crate) pid: Option<i32>,
    pub(crate) native_session_id: String,
    pub(crate) workspace: String,
}
pub(crate) async fn descriptor(path: &Path) -> Result<PiDescriptor> {
    let metadata = tokio::fs::symlink_metadata(path).await?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() < 64 * 1024,
        "Invalid pi descriptor"
    );
    ensure!(
        crate::platform::is_private(&metadata),
        "Pi descriptor is not private"
    );
    let record: PiDescriptor = serde_json::from_slice(&tokio::fs::read(path).await?)?;
    ensure!(
        record.version == 1
            && record.nonce.len() == 64
            && record.nonce.bytes().all(|c| c.is_ascii_hexdigit()),
        "Unsupported pi descriptor"
    );
    Ok(record)
}

/// A control exchange with a live pi. Pairing and takeover may wait for the extension;
/// the SDK's session catalogue can be large; other messages are small and quick.
pub(crate) async fn control(record: &PiDescriptor, mut request: Value) -> Result<Value> {
    let (deadline, limit) = match request["method"].as_str() {
        Some("pair" | "bind" | "takeover") => (Duration::from_secs(60), 64 * 1024),
        Some("sessions") => (Duration::from_secs(15), CATALOGUE_LIMIT),
        Some("settings") => (Duration::from_secs(10), 2 * 1024 * 1024),
        _ => (Duration::from_secs(5), 64 * 1024),
    };
    request["nonce"] = Value::String(record.nonce.clone());
    let exchange = async {
        let mut stream = crate::platform::Local::connect(&record.endpoint)
            .await
            .context("Pi control endpoint unavailable")?;
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
            "{}",
            response["error"]
                .as_str()
                .unwrap_or("Pi is busy, changed, or unavailable; refresh the session list")
        );
        Ok(response)
    };
    tokio::time::timeout(deadline, exchange)
        .await
        .context("Pi control timed out; do not blindly repeat pairing")?
}

#[cfg(all(test, unix))]
async fn live_pi(registry: &Path) -> Result<Vec<Candidate>> {
    Ok(live_pi_with_descriptors(registry).await?.0)
}

/// Live pi processes: their candidates, and the verified descriptors that reached them.
async fn live_pi_with_descriptors(registry: &Path) -> Result<(Vec<Candidate>, Vec<PiDescriptor>)> {
    let mut candidates: Vec<(std::time::SystemTime, Candidate)> = Vec::new();
    let mut live = Vec::new();
    let mut entries = match tokio::fs::read_dir(registry).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), live));
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
        let workspace = match dunce::canonicalize(&record.workspace) {
            Ok(path) => path.to_string_lossy().into_owned(),
            Err(_) => continue,
        };
        if workspace != record.workspace {
            continue;
        }
        // A live pi is hireable and relinkable as it is, even mid-turn or linked elsewhere:
        // the extension takes a new token for its live link as a relink.
        let taking_over = actual["taking_over"] == true;
        let ready = !taking_over;
        let mut found = candidate(
            NativeSessionTarget {
                harness: Harness::Pi,
                native_session_id: record.native_session_id.clone(),
                title: title(&actual, "title", "pi session"),
                workspace,
                native_locator: json!({"descriptor":path,"instance_id":record.instance_id,
                    "pid":record.pid,"session_file":actual["session_file"],"profile":actual["profile"],"runner":actual["runner"],
                    "model":actual["model"],"effort":actual["effort"]}),
            },
            None,
            ready,
            if taking_over {
                "Taking over: waiting for pi to exit in its terminal."
            } else {
                "Ready"
            },
        );
        found.resumable = !taking_over;
        let started = entry
            .metadata()
            .await
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        // When the process started, as its activity until the catalogue says more: the
        // newest pi on a session comes first wherever candidates are ordered.
        found.public.last_activity_at = started
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_millis() as i64);
        candidates.push((started, found));
        live.push(record);
    }
    // Several live pi on one session (a terminal opened on a session the kernel also runs,
    // for instance): the newest one is the one to link; nothing is refused.
    candidates.sort_by_key(|(started, _)| std::cmp::Reverse(*started));
    Ok((candidates.into_iter().map(|(_, c)| c).collect(), live))
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
        candidates.push(candidate(
            NativeSessionTarget {
                harness: Harness::Pi,
                native_session_id: id,
                title: title(info, "title", "pi session"),
                workspace,
                native_locator: json!({"session_file":path}),
            },
            info["last_activity_at"].as_i64(),
            false,
            "ZeroLux's pi extension is not loaded in this session",
        ));
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

/// What is read of a saved transcript to list it: its folder near the start, its title near
/// the end, where Claude Code writes the latest one again.
const TRANSCRIPT_HEAD: u64 = 256 * 1024;
const TRANSCRIPT_TAIL: u64 = 64 * 1024;

/// Claude Code's saved sessions, from their transcripts.
async fn claude_history() -> Result<Vec<Candidate>> {
    claude_history_in(&crate::claude::projects()?).await
}

async fn claude_history_in(projects: &Path) -> Result<Vec<Candidate>> {
    use tokio::io::AsyncSeekExt;
    let mut found = Vec::new();
    let mut projects = match tokio::fs::read_dir(projects).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(found),
        Err(error) => return Err(error.into()),
    };
    while let Some(project) = projects.next_entry().await? {
        let Ok(mut files) = tokio::fs::read_dir(project.path()).await else {
            continue;
        };
        while let Some(file) = files.next_entry().await? {
            let path = file.path();
            let Some(id) = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .filter(|stem| uuid::Uuid::parse_str(stem).is_ok())
                .map(str::to_owned)
            else {
                continue;
            };
            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(mut handle) = tokio::fs::File::open(&path).await else {
                continue;
            };
            let metadata = handle.metadata().await?;
            let mut workspace = None;
            let mut lines = tokio::io::BufReader::new((&mut handle).take(TRANSCRIPT_HEAD)).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(cwd) = serde_json::from_str::<Value>(&line)
                    .ok()
                    .and_then(|record| record["cwd"].as_str().map(str::to_owned))
                {
                    workspace = Some(cwd);
                    break;
                }
            }
            drop(lines);
            let Some(workspace) = workspace.filter(|cwd| Path::new(cwd).is_absolute()) else {
                continue;
            };
            handle
                .seek(std::io::SeekFrom::Start(
                    metadata.len().saturating_sub(TRANSCRIPT_TAIL),
                ))
                .await?;
            let mut tail = Vec::new();
            handle.take(TRANSCRIPT_TAIL).read_to_end(&mut tail).await?;
            let records: Vec<Value> = String::from_utf8_lossy(&tail)
                .lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect();
            let named = |kind: &str, key: &str| {
                records
                    .iter()
                    .rev()
                    .find(|record| record["type"] == kind)
                    .map(|record| title(record, key, ""))
                    .filter(|name| !name.is_empty())
            };
            let name = named("custom-title", "customTitle")
                .or_else(|| named("ai-title", "aiTitle"))
                .unwrap_or_else(|| "Claude Code session".into());
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|time| time.as_millis() as i64);
            found.push(candidate(
                NativeSessionTarget {
                    harness: Harness::ClaudeCode,
                    native_session_id: id.clone(),
                    title: name,
                    workspace,
                    native_locator: json!({"session_id":id,"transcript":path}),
                },
                modified,
                false,
                "Saved Claude Code session",
            ));
        }
    }
    Ok(found)
}

/// What a connected Claude Code session can and cannot do, stated up front.
const CLAUDE_READY: &str = "Ready";

async fn discover_claude(saved: bool) -> Result<Vec<Candidate>> {
    let mut candidates = claude_candidates(&command_json("claude", &["agents", "--json"]).await?)?;
    let running: HashSet<String> = candidates
        .iter()
        .map(|c| c.target.native_session_id.clone())
        .collect();
    let saved = if saved {
        claude_history().await.unwrap_or_default()
    } else {
        Vec::new()
    };
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
    candidates.extend(
        saved
            .into_iter()
            .filter(|c| !running.contains(&c.target.native_session_id)),
    );
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
            candidates.push(candidate(
                NativeSessionTarget {
                    harness: Harness::Codex,
                    native_session_id: id,
                    title: title(actual, "name", "Codex thread"),
                    workspace: text(actual, "cwd")?,
                    native_locator: json!({"endpoint":endpoint}),
                },
                actual["updatedAt"]
                    .as_i64()
                    .and_then(|time| time.checked_mul(1000)),
                ready,
                if ready {
                    "Running in Codex"
                } else {
                    "Not available in Codex now"
                },
            ));
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
    codex_endpoint_in(&crate::homes::Homes::own())
}

/// The control socket of the Codex daemon of a person's harness folders.
pub fn codex_endpoint_in(homes: &crate::homes::Homes) -> Result<String> {
    let root = match (homes.codex(), std::env::var_os("CODEX_HOME")) {
        (Some(root), _) => root,
        (None, Some(root)) => PathBuf::from(root),
        (None, None) => home()?.join(".codex"),
    };
    let endpoint = root.join("app-server-control/app-server-control.sock");
    ensure!(endpoint.is_absolute(), "Codex home must be absolute");
    Ok(format!("unix://{}", endpoint.to_string_lossy()))
}

/// Codex's own daemon, through its own lifecycle: `codex app-server daemon start` starts it
/// only if it is not running, and never restarts or reconfigures a running one. Returns the
/// endpoint once it answers. The daemon outlives the kernel: it is never stopped by ZeroLux.
pub async fn ensure_codex_daemon() -> Result<String> {
    ensure_codex_daemon_in(&crate::homes::Homes::own()).await
}

/// The Codex daemon of a person's harness folders: a guest's runs with their own Codex home,
/// account and threads.
pub async fn ensure_codex_daemon_in(homes: &crate::homes::Homes) -> Result<String> {
    let endpoint = codex_endpoint_in(homes)?;
    ensure_codex_daemon_with(&crate::platform::executable("codex"), &endpoint, homes).await?;
    Ok(endpoint)
}

/// One attempt to start, bounded; the daemon's own output never reaches the API.
pub async fn ensure_codex_daemon_with(
    program: &Path,
    endpoint: &str,
    homes: &crate::homes::Homes,
) -> Result<()> {
    if CodexRpc::connect(endpoint).await.is_ok() {
        return Ok(());
    }
    let mut launcher = tokio::process::Command::new(program);
    homes
        .apply(&mut launcher)
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
    .context("Codex's server does not answer")?;
    Ok(())
}

async fn discover_codex() -> Result<Vec<Candidate>> {
    codex_candidates(&codex_endpoint()?).await
}

/// Running sessions, and with `saved` the ones that can be opened again.
async fn scan(saved: bool) -> (Vec<Candidate>, Vec<DiscoveryError>) {
    let (pi, claude, codex) = tokio::join!(discover_pi(), discover_claude(saved), discover_codex());
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

/// The last look at this computer's sessions. Looking takes seconds, since the harnesses
/// list their own, so one look runs at a time and every caller shares it: a recent one is
/// reused, an older one is given at once while a new look runs.
struct Look {
    at: std::time::Instant,
    candidates: Vec<Candidate>,
    errors: Vec<DiscoveryError>,
}

static LAST: std::sync::LazyLock<std::sync::Mutex<Option<Look>>> =
    std::sync::LazyLock::new(Default::default);
static LOOKING: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(Default::default);
/// How long a look stands for the computer as it is.
const FRESH: Duration = Duration::from_secs(10);

fn last(within: Option<Duration>) -> Option<(Vec<Candidate>, Vec<DiscoveryError>)> {
    let last = LAST.lock().expect("last look");
    last.as_ref()
        .filter(|look| within.is_none_or(|age| look.at.elapsed() < age))
        .map(|look| (look.candidates.clone(), look.errors.clone()))
}

async fn look_now() -> (Vec<Candidate>, Vec<DiscoveryError>) {
    let _looking = LOOKING.lock().await;
    // Another caller may have just looked.
    if let Some(look) = last(Some(FRESH)) {
        return look;
    }
    let (candidates, errors) = scan(true).await;
    *LAST.lock().expect("last look") = Some(Look {
        at: std::time::Instant::now(),
        candidates: candidates.clone(),
        errors: errors.clone(),
    });
    (candidates, errors)
}

/// The computer's sessions: the last look when recent; an older one at once, looking again
/// meanwhile; a new look only when there was none.
async fn looked() -> (Vec<Candidate>, Vec<DiscoveryError>) {
    if let Some(look) = last(Some(FRESH)) {
        return look;
    }
    if let Some(look) = last(None) {
        tokio::spawn(look_now());
        return look;
    }
    look_now().await
}

pub async fn discover_sessions() -> Discovery {
    let (candidates, errors) = looked().await;
    Discovery {
        sessions: candidates.into_iter().map(|c| c.public).collect(),
        errors,
    }
}
/// A discovered session, running or saved: its target, and whether it is running and can be
/// linked as it is.
pub async fn resolve_any(id: &str) -> Result<(NativeSessionTarget, bool)> {
    ensure!(
        id.len() == 64 && id.bytes().all(|c| c.is_ascii_hexdigit()),
        "Invalid discovery selection"
    );
    let find = |candidates: Vec<Candidate>| candidates.into_iter().find(|c| c.public.id == id);
    // A session listed a moment ago is found in that look; one not in it, in a new one.
    let candidate = match find(looked().await.0) {
        Some(candidate) => candidate,
        None => find(look_now().await.0)
            .context("The selected session is no longer available; refresh the list")?,
    };
    let running = candidate.public.availability == "attachable";
    Ok((candidate.target, running))
}

/// The live session that a link stopped by a kernel restart pointed to, if it can be relinked.
pub async fn resolve_linked(harness: &str, native_session_id: &str) -> Option<NativeSessionTarget> {
    let (candidates, _) = scan(false).await;
    candidates
        .into_iter()
        .find(|c| {
            c.resumable
                && c.target.harness.id() == harness
                && c.target.native_session_id == native_session_id
        })
        .map(|c| c.target)
}

pub(crate) async fn ensure_pi_stopped(agent: &Path, native: &str) -> Result<()> {
    let mut entries = match tokio::fs::read_dir(agent.join("zerolux-links")).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let record = descriptor(&path).await?;
        if record.native_session_id != native {
            continue;
        }
        let pid = record
            .pid
            .filter(|pid| *pid > 0)
            .context("Pi discovery cannot establish native process death")?;
        ensure!(
            !crate::platform::alive(pid as u32),
            "pi is still running this session"
        );
    }
    Ok(())
}

pub(crate) async fn running_pi(
    agent: &Path,
    native: &str,
    pid: i32,
) -> Result<NativeSessionTarget> {
    let (candidates, descriptors) = live_pi_with_descriptors(&agent.join("zerolux-links")).await?;
    let record = descriptors
        .iter()
        .find(|d| d.native_session_id == native && d.pid == Some(pid))
        .context("Native pi has not advertised its verified control")?;
    candidates
        .into_iter()
        .find(|c| {
            c.resumable
                && c.target.native_session_id == native
                && c.target.native_locator["instance_id"] == record.instance_id
        })
        .map(|c| c.target)
        .context("The restored pi context is ambiguous")
}

/// Owns the private control link, NOT the externally launched pi process.
pub struct PiLink {
    descriptor: PiDescriptor,
    link_id: String,
}
impl PiLink {
    /// A control request to the paired pi integration.
    pub async fn control(&self, request: Value) -> Result<Value> {
        control(&self.descriptor, request).await
    }
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
    workspace_id: &str,
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
    let executable = std::env::current_exe()?.canonical()?;
    let paired = control(
        &record,
        // The workspace identity lets pi tell a relink by the same kernel from a different
        // workspace claiming a session it already serves.
        json!({"method":"pair","native_session_id":target.native_session_id,
        "workspace":target.workspace,"workspace_id":workspace_id,"base_url":base_url,"token":token,"executable":executable}),
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
        assert!(resolve_any("../../personal").await.is_err());
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
            .canonical()
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
    #[cfg(unix)]
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
            .canonical()
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
        assert!(partial.is_some());
        server.abort();

        // No live pi: the catalogue is unavailable, not empty.
        tokio::fs::remove_file(registry.join("instance.json"))
            .await
            .unwrap();
        assert!(discover_pi_in(&registry).await.is_err());
    }

    #[tokio::test]
    async fn saved_claude_sessions_are_listed_with_their_folder_and_latest_title() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("-work");
        std::fs::create_dir(&project).unwrap();
        let id = "3aad9b7c-8834-4fd0-bad4-db1e33573f3d";
        let work = if cfg!(windows) { r"C:\work" } else { "/work" };
        let lines = [
            json!({"type":"mode","sessionId":id}),
            json!({"type":"user","cwd":work,"sessionId":id}),
            json!({"type":"ai-title","aiTitle":"First","sessionId":id}),
            json!({"type":"custom-title","customTitle":"Release","sessionId":id}),
            json!({"type":"ai-title","aiTitle":"Later","sessionId":id}),
        ];
        let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
        std::fs::write(project.join(format!("{id}.jsonl")), text).unwrap();
        std::fs::write(project.join("notes.jsonl"), "{}\n").unwrap();
        std::fs::write(
            project.join("4be6ac03-dbca-45f4-9ef5-1ee0ff9f783b.jsonl"),
            "{\"type\":\"mode\"}\n",
        )
        .unwrap();
        let found = claude_history_in(root.path()).await.unwrap();
        assert_eq!(found.len(), 1);
        let saved = &found[0];
        assert_eq!(saved.target.native_session_id, id);
        assert_eq!(saved.target.workspace, work);
        assert_eq!(saved.public.title, "Release");
        assert_eq!(saved.public.availability, "attention");
        assert!(saved.public.last_activity_at.is_some());
        assert!(
            claude_history_in(&root.path().join("missing"))
                .await
                .unwrap()
                .is_empty()
        );
    }
}
