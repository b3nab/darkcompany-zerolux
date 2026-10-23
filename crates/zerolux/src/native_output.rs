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
    io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, BufReader},
    sync::watch,
};

use crate::{
    entity::sessions,
    livekit::LiveKit,
    model::{ChatIdentity, ChatSession},
    native_events::{Event, Item, Tail, of_chat, project, tail},
    store::{Error, Result, Store},
};

/// A page reads up to this many bytes, but never splits a record.
pub const PAGE_BYTES: u64 = 512 * 1024;
const WATCH_EVERY: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Serialize)]
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
/// How each running session's record ends, kept by the watcher as the record grows.
static TAILS: LazyLock<Mutex<HashMap<String, Tail>>> = LazyLock::new(Default::default);

/// Sessions with how their records end, as far as the watcher has read them.
pub fn with_tails(mut sessions: Vec<ChatSession>) -> Vec<ChatSession> {
    if let Ok(tails) = TAILS.lock() {
        for session in &mut sessions {
            session.tail = tails.get(&session.id).cloned().unwrap_or_default();
        }
    }
    sessions
}

/// Where the session's native record is. None until the harness has written it.
pub fn locate(session: &sessions::Model) -> Option<PathBuf> {
    let locator: Value = serde_json::from_str(&session.native_locator_json).ok()?;
    if session.harness == "pi" {
        return locator["session_file"].as_str().map(PathBuf::from);
    }
    let key = format!("{}:{}", session.harness, session.native_session_id);
    if let Some(path) = FOUND.lock().ok()?.get(&key).filter(|path| path.is_file()) {
        return Some(path.clone());
    }
    // In the harness folders the session runs with.
    let homes = crate::homes::Homes::of_locator(&locator);
    let path = match session.harness.as_str() {
        #[cfg(unix)]
        "claude-code" => crate::claude::transcript_path_in(&session.native_session_id, &homes),
        "codex" => codex_rollout(&session.native_session_id, &homes),
        _ => None,
    }?;
    FOUND.lock().ok()?.insert(key, path.clone());
    Some(path)
}

/// `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`, or archived.
pub(crate) fn codex_rollout(thread: &str, homes: &crate::homes::Homes) -> Option<PathBuf> {
    let root = match (homes.codex(), std::env::var_os("CODEX_HOME")) {
        (Some(root), _) => root,
        (None, Some(root)) => PathBuf::from(root),
        (None, None) => PathBuf::from(std::env::var_os("HOME")?).join(".codex"),
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
        records.extend(record(next, &line));
        next += read as u64;
    }
    Ok((records, next, end.max(next)))
}

/// One native line; a line that is not JSON is kept as a string, an empty one is nothing.
fn record(at: u64, line: &[u8]) -> Option<Record> {
    let text = String::from_utf8_lossy(line);
    let text = text.trim_end();
    (!text.is_empty()).then(|| Record {
        at,
        record: serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_owned())),
    })
}

/// Complete records that end at or before `before`, reading back about `budget` bytes but
/// never splitting a record; a line still being written is left out. Returns them in order,
/// with the offset where they start, where the last one ends, and the file's size.
pub async fn read_back(
    path: &Path,
    before: u64,
    budget: u64,
) -> std::io::Result<(Vec<Record>, u64, u64, u64)> {
    let mut file = tokio::fs::File::open(path).await?;
    let end = file.metadata().await?.len();
    let stop = before.min(end);
    let mut start = stop.saturating_sub(budget.max(1));
    loop {
        file.seek(SeekFrom::Start(start)).await?;
        let mut bytes = vec![0; (stop - start) as usize];
        file.read_exact(&mut bytes).await?;
        // Only whole lines: up to the last newline, from the first one unless at the start.
        let tail = bytes.iter().rposition(|b| *b == b'\n').map(|i| i + 1);
        let head = if start == 0 {
            Some(0)
        } else {
            bytes.iter().position(|b| *b == b'\n').map(|i| i + 1)
        };
        match (head, tail) {
            (Some(head), Some(tail)) if head < tail => {
                let mut records = Vec::new();
                let mut at = head;
                for line in bytes[head..tail].split_inclusive(|b| *b == b'\n') {
                    records.extend(record(start + at as u64, line));
                    at += line.len();
                }
                return Ok((records, start + head as u64, start + tail as u64, end));
            }
            // Nothing complete before `stop`.
            _ if start == 0 => return Ok((Vec::new(), 0, 0, end)),
            // A record longer than the window: look further back.
            _ => start = start.saturating_sub((stop - start).max(budget)),
        }
    }
}

impl Store {
    /// The session and where its native record is, for any workspace identity, from the
    /// kernel host that runs it. None until the harness has written it.
    async fn native_record(
        &self,
        who: &ChatIdentity,
        id: &str,
    ) -> Result<(sessions::Model, Option<PathBuf>)> {
        let session = self.observed_session(who, id).await?;
        if session.host_id.as_deref() != self.host() {
            return Err(Error::Invalid(
                "This session runs on another kernel host; read its output there".into(),
            ));
        }
        let path = locate(&session);
        Ok((session, path))
    }

    /// Any workspace identity can read any session's native record, from this host.
    pub async fn native_output(&self, who: &ChatIdentity, id: &str, after: u64) -> Result<Page> {
        let (session, path) = self.native_record(who, id).await?;
        let page = |records, next, end| Page {
            session_id: session.id.clone(),
            harness: session.harness.clone(),
            records,
            next,
            end,
        };
        let Some(path) = path else {
            return if after == 0 {
                Ok(page(Vec::new(), 0, 0))
            } else {
                Err(Error::NotFound)
            };
        };
        let (records, next, end) = read(&path, after).await.map_err(|e| unreadable(e, after))?;
        Ok(page(records, next, end))
    }

    /// The same records in the Agent Console's common model, the same for every harness:
    /// forward from `after`, or back from `before`; with `chat`, only the turns a message of
    /// that chat opened.
    pub async fn native_events(
        &self,
        who: &ChatIdentity,
        id: &str,
        query: EventQuery,
    ) -> Result<EventPage> {
        if query.after.is_some() && query.before.is_some() {
            return Err(Error::Invalid("Read after or before, not both".into()));
        }
        let (session, path) = self.native_record(who, id).await?;
        events_of(&session.id, &session.harness, path, query).await
    }
}

/// The events of a native record at `path`, of `harness`, as `native_events` reads them; for a
/// session's own record or one of its subagents'.
pub(crate) async fn events_of(
    session: &str,
    harness: &str,
    path: Option<PathBuf>,
    query: EventQuery,
) -> Result<EventPage> {
    if query.after.is_some() && query.before.is_some() {
        return Err(Error::Invalid("Read after or before, not both".into()));
    }
    let page = |events, first, next, end| EventPage {
        session_id: session.to_owned(),
        harness: harness.to_owned(),
        events,
        first,
        next,
        end,
    };
    let Some(path) = path else {
        return if query.after.unwrap_or(0) == 0 {
            Ok(page(Vec::new(), 0, 0, 0))
        } else {
            Err(Error::NotFound)
        };
    };
    let chat = query.chat.as_deref();
    match query.before {
        None => {
            let after = query.after.unwrap_or(0);
            let (records, next, end) =
                read(&path, after).await.map_err(|e| unreadable(e, after))?;
            let mut events = project(harness, &records);
            if let Some(chat) = chat {
                let opened = opening_chat(&path, harness, after)
                    .await
                    .map_err(|e| unreadable(e, after))?;
                events = of_chat(events, chat, opened);
            }
            Ok(page(events, after, next, end))
        }
        Some(before) => {
            let (events, first, stop, end) = back(&path, harness, before, chat, PAGE_BYTES)
                .await
                .map_err(|e| unreadable(e, before))?;
            Ok(page(events, first, stop, end))
        }
    }
}

pub(crate) fn unreadable(error: std::io::Error, cursor: u64) -> Error {
    if error.kind() == std::io::ErrorKind::NotFound {
        Error::NotFound
    } else if cursor > 0 {
        Error::Invalid("The native record changed; read it again from the start".into())
    } else {
        Error::Invalid(format!("The native record is unreadable: {error}"))
    }
}

/// How far back a request may look for the input that opened a turn.
const SCAN_BYTES: u64 = 32 * 1024 * 1024;

/// The chat of the turn already in progress at `at`: the last input before it.
async fn opening_chat(path: &Path, harness: &str, at: u64) -> std::io::Result<Option<String>> {
    let mut before = at;
    while before > 0 && at - before < SCAN_BYTES {
        let (records, first, _, _) = read_back(path, before, PAGE_BYTES).await?;
        if let Some(chat) =
            project(harness, &records)
                .iter()
                .rev()
                .find_map(|item| match &item.event {
                    Event::Input { chat, .. } => Some(chat.clone()),
                    _ => None,
                })
        {
            return Ok(chat);
        }
        if first >= before {
            break;
        }
        before = first;
    }
    Ok(None)
}

/// A page back from `before`. With a chat, only whole turns of it: a page ends at the input
/// that opened its first turn, and reading continues further back, within `SCAN_BYTES`,
/// until a turn of that chat is found. Every record is read and projected once.
async fn back(
    path: &Path,
    harness: &str,
    before: u64,
    chat: Option<&str>,
    budget: u64,
) -> std::io::Result<(Vec<Item>, u64, u64, u64)> {
    // A page ends where its last whole record does, never inside a line still being written.
    let (records, mut first, stop, end) = read_back(path, before, budget).await?;
    let mut events = project(harness, &records);
    let Some(chat) = chat else {
        return Ok((events, first, stop, end));
    };
    loop {
        if let Some(index) = events
            .iter()
            .position(|item| matches!(item.event, Event::Input { .. }))
        {
            let from = events[index].at;
            let found = of_chat(events[index..].to_vec(), chat, None);
            if !found.is_empty() || from == 0 || stop - from >= SCAN_BYTES {
                return Ok((found, from, stop, end));
            }
            // Only other chats' turns from here on: what precedes still needs its opener.
            events.truncate(index);
        }
        if first == 0 || stop - first >= SCAN_BYTES {
            return Ok((Vec::new(), first, stop, end));
        }
        let (older, older_first, _, _) = read_back(path, first, budget).await?;
        let mut older = project(harness, &older);
        older.append(&mut events);
        (events, first) = (older, older_first);
    }
}

#[derive(Debug, Default, Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventQuery {
    pub after: Option<u64>,
    pub before: Option<u64>,
    pub chat: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct EventPage {
    pub session_id: String,
    pub harness: String,
    pub events: Vec<Item>,
    /// Where this page starts: pass as `before` for earlier events; 0 at the beginning.
    pub first: u64,
    /// Where this page ends: pass as `after` for later events.
    pub next: u64,
    /// The native file's size when read: `next < end` means there is more.
    pub end: u64,
}

/// How a native record ends, from its last page: unreadable reads as nothing known.
async fn read_tail(path: &Path, harness: &str) -> Tail {
    let output_at = tokio::fs::metadata(path)
        .await
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as i64);
    let records = read_back(path, u64::MAX, PAGE_BYTES)
        .await
        .map(|(records, ..)| records)
        .unwrap_or_default();
    tail(&project(harness, &records), output_at)
}

/// Queued inputs a Claude Code record says the running turn took: `queue-operation` removes
/// with `absorbed_mid_turn`, by the ID their sender gave them.
pub fn absorbed(records: &[Record]) -> Vec<String> {
    records
        .iter()
        .filter(|record| {
            record.record["type"] == "queue-operation"
                && record.record["operation"] == "remove"
                && record.record["reason"] == "absorbed_mid_turn"
        })
        .filter_map(|record| record.record["commandUuid"].as_str().map(str::to_owned))
        .collect()
}

/// Tells the people in the workspace when an agent's native record grows, with how it now
/// ends; clients read the new records over HTTP. What a Claude Code record says its running
/// turn took from the queue goes to `taken`, by session.
pub async fn run_watcher(
    store: Store,
    livekit: Arc<LiveKit>,
    taken: tokio::sync::mpsc::UnboundedSender<(String, Vec<String>)>,
    mut stop: watch::Receiver<bool>,
) {
    let mut sizes = HashMap::new();
    while !*stop.borrow() {
        if let Err(error) = watch_once(&store, &livekit, &taken, &mut sizes).await {
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
    taken: &tokio::sync::mpsc::UnboundedSender<(String, Vec<String>)>,
    sizes: &mut HashMap<String, u64>,
) -> anyhow::Result<()> {
    let sessions = {
        let tx = store.read().await?;
        sessions::Entity::find()
            .filter(sessions::Column::StoppedAt.is_null())
            .all(&tx)
            .await?
    };
    let mut seen = HashMap::new();
    let mut tails = HashMap::new();
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
        let last = sizes.get(&session.id).copied();
        let current = TAILS.lock().ok().and_then(|t| t.get(&session.id).cloned());
        let ending = match current {
            Some(ending) if last == Some(end) => ending,
            // Read again only when the record grew, or at first sight.
            _ => read_tail(&path, &session.harness).await,
        };
        if session.harness == "claude-code"
            && let Some(last) = last.filter(|last| *last < end)
            && let Ok((records, ..)) = read(&path, last).await
        {
            let ids = absorbed(&records);
            if !ids.is_empty() {
                let _ = taken.send((session.id.clone(), ids));
            }
        }
        // Grown, or first seen since the kernel started: a client that read before then hears it.
        if last != Some(end) {
            let mut notice = serde_json::to_value(&ending)?;
            notice["type"] = json!("session.output");
            notice["session_id"] = json!(session.id);
            notice["end"] = json!(end);
            livekit
                .notify(&notice, &store.readers(&session.id).await?)
                .await?;
        }
        tails.insert(session.id.clone(), ending);
        seen.insert(session.id, end);
    }
    *sizes = seen;
    if let Ok(mut all) = TAILS.lock() {
        *all = tails;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_claude_record_says_which_queued_inputs_its_turn_took() {
        let records: Vec<Record> = [
            json!({"type":"queue-operation","operation":"enqueue","content":"x"}),
            json!({"type":"queue-operation","operation":"remove","reason":"absorbed_mid_turn","commandUuid":"u1"}),
            json!({"type":"queue-operation","operation":"remove","reason":"cancelled","commandUuid":"u2"}),
            json!({"type":"attachment","attachment":{"type":"queued_command","prompt":"x","source_uuid":"u1"}}),
        ]
        .into_iter()
        .enumerate()
        .map(|(at, record)| Record {
            at: at as u64,
            record,
        })
        .collect();
        assert_eq!(absorbed(&records), ["u1"]);
    }

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

    #[tokio::test]
    async fn reads_back_whole_records_page_by_page() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let line = |i: usize| format!("{{\"n\":{i}}}\n");
        let body: String = (0..10).map(line).collect();
        std::fs::write(&path, format!("{body}{{\"partial\"")).unwrap();
        // From past the end: the last whole records, never the line still being written.
        let (records, first, last, end) = read_back(&path, u64::MAX, 20).await.unwrap();
        assert_eq!(end, body.len() as u64 + 10);
        // Reading on from the page's end starts at the line still being written, whole.
        assert_eq!(last, body.len() as u64);
        assert_eq!(
            records
                .iter()
                .map(|r| r.record["n"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            [9]
        );
        assert_eq!(first, records[0].at);
        // Page by page to the start, with every record exactly once.
        let (mut seen, mut before) = (Vec::new(), u64::MAX);
        loop {
            let (records, first, _, _) = read_back(&path, before, 20).await.unwrap();
            if records.is_empty() {
                break;
            }
            seen.splice(
                0..0,
                records.iter().map(|r| r.record["n"].as_u64().unwrap()),
            );
            before = first;
        }
        assert_eq!(seen, (0..10).collect::<Vec<u64>>());
        // A record longer than the window is still read whole.
        let long = format!("\"{}\"\n", "x".repeat(100));
        std::fs::write(&path, format!("{long}{{\"after\":1}}\n")).unwrap();
        let (records, first, _, _) = read_back(&path, u64::MAX, 10).await.unwrap();
        assert_eq!(first, records[0].at);
        let (earlier, start, _, _) = read_back(&path, first, 10).await.unwrap();
        assert_eq!((earlier.len(), start), (1, 0));
    }

    #[tokio::test]
    async fn a_chat_reads_only_the_turns_its_messages_opened() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.jsonl");
        let user = |chat: &str| {
            json!({"type":"message","message":{"role":"user","content":[
            {"type":"text","text":format!("[ZeroLux] \"x\"\nChat: {chat}; delivery: d")}]}})
        };
        let text = |t: &str| {
            json!({"type":"message","message":{"role":"assistant","content":[
            {"type":"text","text":t}],"stopReason":"stop"}})
        };
        let lines = [
            user("a"),
            text("a1"),
            user("b"),
            text("b1"),
            text("b2"),
            user("a"),
            text("a2"),
        ];
        let body: String = lines.iter().map(|l| format!("{l}\n")).collect();
        std::fs::write(&path, &body).unwrap();
        let texts = |items: &[Item]| -> Vec<String> {
            items
                .iter()
                .filter_map(|i| match &i.event {
                    Event::Text { text } => Some(text.clone()),
                    _ => None,
                })
                .collect()
        };
        // Small pages: each one ends at the input that opened its first turn.
        let pages = |chat: &'static str| {
            let path = path.clone();
            async move {
                let (mut out, mut before) = (Vec::new(), u64::MAX);
                loop {
                    let (events, first, _, _) =
                        back(&path, "pi", before, Some(chat), 1).await.unwrap();
                    out.push(texts(&events));
                    if first == 0 {
                        return out;
                    }
                    before = first;
                }
            }
        };
        // A page goes back past other chats' turns to the next turn of its own.
        assert_eq!(pages("a").await, [vec!["a2"], vec!["a1"]]);
        assert_eq!(pages("b").await, [vec!["b1", "b2"], vec![]]);
        // One page for the whole file: both of a's turns.
        let (all, first, _, _) = back(&path, "pi", u64::MAX, Some("a"), PAGE_BYTES)
            .await
            .unwrap();
        assert_eq!(texts(&all), ["a1", "a2"]);
        assert_eq!(first, 0);
        // Forward from the middle of b's turn: the turn in progress is known to be b's.
        let middle = (lines[..4]
            .iter()
            .map(|l| l.to_string().len() + 1)
            .sum::<usize>()) as u64;
        assert_eq!(
            opening_chat(&path, "pi", middle).await.unwrap().as_deref(),
            Some("b")
        );
    }

    #[tokio::test]
    async fn the_tail_comes_from_the_end_of_the_record_and_its_time() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.jsonl");
        let lines = [
            json!({"type":"message","message":{"role":"assistant","content":[
                {"type":"text","text":"Reading the tests"}],"stopReason":"toolUse"}}),
            json!({"type":"message","message":{"role":"assistant","content":[
                {"type":"text","text":"All green."}],"stopReason":"stop"}}),
        ];
        let body: String = lines.iter().map(|l| format!("{l}\n")).collect();
        std::fs::write(&path, body).unwrap();
        let ending = read_tail(&path, "pi").await;
        assert_eq!(ending.last_turn.as_deref(), Some("completed"));
        assert_eq!(ending.summary.as_deref(), Some("All green."));
        assert!(ending.output_at.is_some_and(|at| at > 0));
        assert_eq!(
            read_tail(&dir.path().join("missing.jsonl"), "pi").await,
            Tail::default()
        );
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
