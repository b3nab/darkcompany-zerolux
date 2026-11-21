//! Codex reverts by switching rollouts, not by erasing the old file. The new header's
//! `history_base` names the rollout and the exclusive byte cutoff inherited from it.
//! A Console cursor counts bytes in those prefixes followed by the active rollout.
use super::{Record, find};
use serde::Deserialize;
use std::{
    collections::{HashMap, HashSet},
    io,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
};
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Clone)]
struct Part {
    path: PathBuf,
    len: u64,
}
type Prefix = Arc<Vec<Part>>;
static PREFIX: LazyLock<Mutex<HashMap<PathBuf, Prefix>>> = LazyLock::new(Default::default);
#[derive(Deserialize)]
struct Header {
    payload: Meta,
}
#[derive(Deserialize)]
struct Meta {
    history_base: Option<Base>,
}
#[derive(Deserialize)]
struct Base {
    thread_id: uuid::Uuid,
    end_byte_offset: u64,
}

fn invalid(why: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, why)
}
fn is_rollout(path: &Path) -> bool {
    path.file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.starts_with("rollout-") && s.ends_with(".jsonl"))
}
async fn prefix(path: &Path) -> io::Result<Prefix> {
    if let Some(known) = PREFIX.lock().unwrap().get(path) {
        return Ok(known.clone());
    }
    let mut parts = Vec::new();
    let mut seen = HashSet::new();
    let mut current = path.to_path_buf();
    loop {
        if !seen.insert(current.clone()) {
            return Err(invalid("Cyclic Codex history base"));
        }
        let mut line = String::new();
        BufReader::new(tokio::fs::File::open(&current).await?)
            .read_line(&mut line)
            .await?;
        if !line.ends_with('\n') {
            return Ok(Arc::new(Vec::new()));
        } // Do not cache a partial header.
        let base = serde_json::from_str::<Header>(&line)
            .ok()
            .and_then(|h| h.payload.history_base);
        let Some(base) = base else {
            break;
        };
        let home = path
            .ancestors()
            .find(|p| {
                p.file_name()
                    .is_some_and(|n| n == "sessions" || n == "archived_sessions")
            })
            .and_then(Path::parent)
            .ok_or_else(|| invalid("No Codex home for this rollout"))?
            .to_owned();
        let suffix = format!("-{}.jsonl", base.thread_id);
        current = tokio::task::spawn_blocking(move || {
            find(&home.join("sessions"), &suffix, 3)
                .or_else(|| find(&home.join("archived_sessions"), &suffix, 0))
        })
        .await?
        .ok_or_else(|| invalid("The retained Codex rollout is missing"))?;
        if tokio::fs::metadata(&current).await?.len() < base.end_byte_offset {
            return Err(invalid("The retained Codex rollout is incomplete"));
        }
        parts.push(Part {
            path: current.clone(),
            len: base.end_byte_offset,
        });
    }
    parts.reverse();
    let parts = Arc::new(parts);
    PREFIX
        .lock()
        .unwrap()
        .insert(path.to_owned(), parts.clone());
    Ok(parts)
}

pub(super) async fn len(path: &Path, physical: u64) -> io::Result<u64> {
    if !is_rollout(path) {
        return Ok(physical);
    }
    prefix(path).await?.iter().try_fold(physical, |n, p| {
        n.checked_add(p.len)
            .ok_or_else(|| invalid("Invalid Codex history length"))
    })
}

/// Locate the segment containing a byte; for a read backwards use its last included byte.
async fn section(path: &Path, cursor: u64, back: bool) -> io::Result<(PathBuf, u64, u64, u64)> {
    let size = tokio::fs::metadata(path).await?.len();
    let base = prefix(path).await?;
    let end = base.iter().try_fold(size, |n, p| {
        n.checked_add(p.len)
            .ok_or_else(|| invalid("Invalid Codex history length"))
    })?;
    if !back && cursor > end {
        return Err(invalid("Cursor past end"));
    }
    let needle = if back {
        cursor.min(end).saturating_sub(1)
    } else {
        cursor
    };
    let mut offset = 0;
    for part in base.iter() {
        if needle < offset + part.len {
            return Ok((part.path.clone(), offset, part.len, end));
        }
        offset += part.len;
    }
    Ok((path.to_owned(), offset, size, end))
}

pub(super) async fn forward(path: &Path, after: u64) -> io::Result<(Vec<Record>, u64, u64)> {
    if !is_rollout(path) {
        return super::read_file(path, after, None).await;
    }
    let (file, offset, size, end) = section(path, after, false).await?;
    let (mut rows, next, _) = super::read_file(&file, after - offset, Some(size)).await?;
    for row in &mut rows {
        row.at += offset;
    }
    Ok((rows, offset + next, end))
}
pub(super) async fn backward(
    path: &Path,
    before: u64,
    budget: u64,
) -> io::Result<(Vec<Record>, u64, u64, u64)> {
    if !is_rollout(path) {
        return super::back_file(path, before, budget).await;
    }
    let (file, offset, _, end) = section(path, before, true).await?;
    let (mut rows, start, stop, _) =
        super::back_file(&file, before.min(end).saturating_sub(offset), budget).await?;
    for row in &mut rows {
        row.at += offset;
    }
    Ok((rows, offset + start, offset + stop, end))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn editing_twice_keeps_only_the_inherited_prefix_in_both_directions() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("sessions/2026/01/01");
        std::fs::create_dir_all(&dir).unwrap();
        let path = |id| dir.join(format!("rollout-fixture-{id}.jsonl"));
        let id = uuid::Uuid::new_v4();
        let second = uuid::Uuid::new_v4();
        let header = |base: serde_json::Value| {
            format!(
                "{}\n",
                json!({"type":"session_meta","payload":{"id":id,"history_base":base}})
            )
        };
        let first = header(serde_json::Value::Null) + "101\n";
        std::fs::write(path(id), first.clone() + "999\n").unwrap();
        let middle = header(json!({"thread_id":id,"end_byte_offset":first.len()})) + "202\n";
        std::fs::write(path(second), middle.clone() + "888\n").unwrap();
        let tip = path(uuid::Uuid::new_v4());
        std::fs::write(
            &tip,
            header(json!({"thread_id":second,"end_byte_offset":middle.len()})) + "303\n",
        )
        .unwrap();
        let mut from = 0;
        let mut forward_items = Vec::new();
        loop {
            let (items, next, end) = forward(&tip, from).await.unwrap();
            forward_items.extend(
                items
                    .into_iter()
                    .filter_map(|r| r.record.as_u64().map(|n| (r.at, n))),
            );
            if next == end {
                break;
            }
            assert!(next > from);
            from = next;
        }
        assert_eq!(
            forward_items.iter().map(|(_, n)| *n).collect::<Vec<_>>(),
            [101, 202, 303]
        );
        let mut before = u64::MAX;
        let mut backward_items = Vec::new();
        while before != 0 {
            let (items, first, _, _) = backward(&tip, before, super::super::PAGE_BYTES)
                .await
                .unwrap();
            backward_items.extend(
                items
                    .into_iter()
                    .rev()
                    .filter_map(|r| r.record.as_u64().map(|n| (r.at, n))),
            );
            assert!(first < before);
            before = first;
        }
        backward_items.reverse();
        assert_eq!(forward_items, backward_items);
    }
}
