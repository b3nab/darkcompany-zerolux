//! Agent Console: what an agent does and produces, read from its native session record.
//!
//! pi's session file, Claude Code's transcript and Codex's rollout are the only source of
//! truth. The kernel reads them as they are, the same way for every harness: it keeps no
//! copy and rewrites nothing.

use std::{
    collections::HashMap,
    io::SeekFrom,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};

use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncSeekExt, BufReader},
    sync::watch,
};

use crate::{
    entity::{actors, chat_sessions},
    livekit::LiveKit,
    model::ChatIdentity,
    store::{Error, Result, Store},
};

/// A page reads up to this many bytes, but never splits a record.
pub const PAGE_BYTES: u64 = 512 * 1024;
const WATCH_EVERY: Duration = Duration::from_secs(1);

#[derive(Debug, Serialize)]
pub struct Record {
    /// Byte offset of the record in the native file.
    pub at: u64,
    /// The native line, unchanged. A line that is not JSON is kept as a string.
    pub record: Value,
}

#[derive(Debug, Serialize)]
pub struct Page {
    pub session_id: String,
    pub harness: String,
    pub records: Vec<Record>,
    /// Pass as `after` to continue.
    pub next: u64,
    /// The native file's size when read: `next < end` means there is more.
    pub end: u64,
}

/// Paths found by searching, per harness and native identity.
static FOUND: LazyLock<Mutex<HashMap<String, PathBuf>>> = LazyLock::new(Default::default);

/// Where the session's native record is. None until the harness has written it.
pub fn locate(session: &chat_sessions::Model) -> Option<PathBuf> {
    if session.harness == "pi" {
        let locator: Value = serde_json::from_str(&session.native_locator_json).ok()?;
        return locator["session_file"].as_str().map(PathBuf::from);
    }
    let key = format!("{}:{}", session.harness, session.native_session_id);
    if let Some(path) = FOUND.lock().ok()?.get(&key).filter(|path| path.is_file()) {
        return Some(path.clone());
    }
    let path = match session.harness.as_str() {
        #[cfg(unix)]
        "claude-code" => crate::claude::transcript_path(&session.native_session_id),
        "codex" => codex_rollout(&session.native_session_id),
        _ => None,
    }?;
    FOUND.lock().ok()?.insert(key, path.clone());
    Some(path)
}

/// `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`, or archived.
fn codex_rollout(thread: &str) -> Option<PathBuf> {
    let root = match std::env::var_os("CODEX_HOME") {
        Some(root) => PathBuf::from(root),
        None => PathBuf::from(std::env::var_os("HOME")?).join(".codex"),
    };
    let suffix = format!("-{thread}.jsonl");
    find(&root.join("sessions"), &suffix, 3)
        .or_else(|| find(&root.join("archived_sessions"), &suffix, 0))
}

fn find(dir: &Path, suffix: &str, depth: u8) -> Option<PathBuf> {
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth > 0
                && let Some(found) = find(&path, suffix, depth - 1)
            {
                return Some(found);
            }
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(suffix))
        {
            return Some(path);
        }
    }
    None
}

/// Complete records from `after`, up to `PAGE_BYTES`. A line still being written is left
/// for the next read.
pub async fn read(path: &Path, after: u64) -> std::io::Result<(Vec<Record>, u64, u64)> {
    let mut file = tokio::fs::File::open(path).await?;
    let end = file.metadata().await?.len();
    if after > end {
        return Err(std::io::Error::other("cursor past the end"));
    }
    file.seek(SeekFrom::Start(after)).await?;
    let mut reader = BufReader::new(file);
    let (mut records, mut next, mut line) = (Vec::new(), after, Vec::new());
    while next < end && next - after < PAGE_BYTES {
        line.clear();
        let read = reader.read_until(b'\n', &mut line).await?;
        if read == 0 || line.last() != Some(&b'\n') {
            break;
        }
        let text = String::from_utf8_lossy(&line);
        let text = text.trim_end();
        if !text.is_empty() {
            records.push(Record {
                at: next,
                record: serde_json::from_str(text)
                    .unwrap_or_else(|_| Value::String(text.to_owned())),
            });
        }
        next += read as u64;
    }
    Ok((records, next, end.max(next)))
}

impl Store {
    /// Any workspace identity can read any session's native record, from this host.
    pub async fn native_output(&self, who: &ChatIdentity, id: &str, after: u64) -> Result<Page> {
        let session = self.observed_session(who, id).await?;
        if session.host_id.as_deref() != self.host() {
            return Err(Error::Invalid(
                "This session runs on another kernel host; read its output there".into(),
            ));
        }
        let page = |records, next, end| Page {
            session_id: session.id.clone(),
            harness: session.harness.clone(),
            records,
            next,
            end,
        };
        let Some(path) = locate(&session) else {
            return if after == 0 {
                Ok(page(Vec::new(), 0, 0))
            } else {
                Err(Error::NotFound)
            };
        };
        match read(&path, after).await {
            Ok((records, next, end)) => Ok(page(records, next, end)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(Error::NotFound),
            Err(_) if after > 0 => Err(Error::Invalid(
                "The native record changed; read it again from the start".into(),
            )),
            Err(error) => Err(Error::Invalid(format!(
                "The native record is unreadable: {error}"
            ))),
        }
    }
}

/// Tells the people in the workspace when an agent's native record grows. The notice has
/// no content: clients read the new records over HTTP.
pub async fn run_watcher(store: Store, livekit: Arc<LiveKit>, mut stop: watch::Receiver<bool>) {
    let mut sizes = HashMap::new();
    while !*stop.borrow() {
        if let Err(error) = watch_once(&store, &livekit, &mut sizes).await {
            tracing::debug!(error = format!("{error:#}"), "Native output watch failed");
        }
        tokio::select! {
            _ = tokio::time::sleep(WATCH_EVERY) => {}
            _ = stop.wait_for(|stopped| *stopped) => break,
        }
    }
}

async fn watch_once(
    store: &Store,
    livekit: &LiveKit,
    sizes: &mut HashMap<String, u64>,
) -> anyhow::Result<()> {
    let (sessions, people) = {
        let tx = store.read().await?;
        let sessions = chat_sessions::Entity::find()
            .filter(chat_sessions::Column::StoppedAt.is_null())
            .all(&tx)
            .await?;
        let people: Vec<String> = actors::Entity::find()
            .filter(actors::Column::Kind.eq("human"))
            .filter(actors::Column::Archived.eq(false))
            .all(&tx)
            .await?
            .into_iter()
            .map(|actor| actor.id)
            .collect();
        (sessions, people)
    };
    let mut seen = HashMap::new();
    for session in sessions
        .into_iter()
        .filter(|s| s.host_id.as_deref() == store.host())
    {
        let Some(path) = tokio::task::spawn_blocking({
            let session = session.clone();
            move || locate(&session)
        })
        .await?
        else {
            continue;
        };
        let Ok(meta) = tokio::fs::metadata(&path).await else {
            continue;
        };
        let end = meta.len();
        if sizes.get(&session.id).is_some_and(|last| *last != end) {
            let notice = json!({"type": "session.output", "session_id": session.id, "end": end});
            livekit.notify(&notice, &people).await?;
        }
        seen.insert(session.id, end);
    }
    *sizes = seen;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_whole_native_records_and_leaves_a_partial_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        std::fs::write(&path, "{\"a\":1}\nnot json\n\n{\"b\":2}\n{\"partial\"").unwrap();
        let (records, next, end) = read(&path, 0).await.unwrap();
        assert_eq!(records.len(), 3);
        assert_eq!(records[0].record, json!({"a": 1}));
        assert_eq!(records[1].record, json!("not json"));
        assert_eq!(records[2].at, 18);
        assert_eq!(next, 26);
        assert_eq!(end, 36);
        let (again, same, _) = read(&path, next).await.unwrap();
        assert!(again.is_empty());
        assert_eq!(same, next);
        assert!(read(&path, end + 1).await.is_err());
    }

    #[tokio::test]
    async fn a_page_never_splits_a_record() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.jsonl");
        let big = format!("\"{}\"\n", "x".repeat(PAGE_BYTES as usize));
        std::fs::write(&path, format!("{big}{{\"after\":true}}\n")).unwrap();
        let (records, next, _) = read(&path, 0).await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(next, big.len() as u64);
        let (rest, _, _) = read(&path, next).await.unwrap();
        assert_eq!(rest[0].record, json!({"after": true}));
    }

    #[test]
    fn finds_a_codex_rollout_by_thread() {
        let dir = tempfile::tempdir().unwrap();
        let day = dir.path().join("2026/10/13");
        std::fs::create_dir_all(&day).unwrap();
        let file = day.join("rollout-2026-10-13T17-32-22-thread-1.jsonl");
        std::fs::write(&file, "").unwrap();
        assert_eq!(find(dir.path(), "-thread-1.jsonl", 3), Some(file));
        assert_eq!(find(dir.path(), "-thread-2.jsonl", 3), None);
    }
}
