//! Search through what the sessions one may read have said and done, in their native records
//! as they are: nothing is indexed or copied.

use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

use serde::Serialize;

use crate::{
    model::ChatIdentity,
    native_events::{Event, project},
    native_output::{Record, locate},
    store::{Error, Result, Store},
};

/// What one search reads at most, so it answers in time.
const BUDGET: Duration = Duration::from_secs(10);
/// The latest matches kept of one session.
const PER_SESSION: usize = 20;
const SNIPPET_CHARS: usize = 80;

/// A step of a session that says what was looked for.
#[derive(Debug, Clone, Serialize)]
pub struct Found {
    pub session_id: String,
    pub title: String,
    pub harness: String,
    /// The record's offset, as `/events` names it.
    pub at: u64,
    pub time: Option<String>,
    /// `input`, `text`, `thinking` or `tool_call`.
    pub kind: &'static str,
    /// The words around the match, on one line.
    pub snippet: String,
}

#[derive(Debug, Serialize)]
pub struct Results {
    pub results: Vec<Found>,
    /// Some records were left unread: the search ran out of time.
    pub truncated: bool,
}

/// What a step says that can be searched: its words, or a tool's name and input.
fn searchable(event: &Event) -> Option<(&'static str, String)> {
    match event {
        Event::Input { text, .. } => Some(("input", text.clone())),
        Event::Text { text } => Some(("text", text.clone())),
        Event::Thinking { text } => Some(("thinking", text.clone())),
        Event::ToolCall { name, input, .. } => Some((
            "tool_call",
            format!(
                "{name} {}",
                input
                    .as_str()
                    .map_or_else(|| input.to_string(), str::to_owned)
            ),
        )),
        _ => None,
    }
}

/// Where `query` (already lowercase) starts in `text`, ignoring case.
fn find(text: &str, query: &[char]) -> Option<usize> {
    let lower: Vec<(usize, char)> = text
        .char_indices()
        .flat_map(|(at, c)| c.to_lowercase().map(move |l| (at, l)))
        .collect();
    lower
        .windows(query.len())
        .find(|window| window.iter().map(|(_, c)| *c).eq(query.iter().copied()))
        .map(|window| window[0].0)
}

/// The words around `at`, on one line.
fn snippet(text: &str, at: usize) -> String {
    let before: String = text[..at]
        .chars()
        .rev()
        .take(SNIPPET_CHARS / 2)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let after: String = text[at..].chars().take(SNIPPET_CHARS).collect();
    let line = format!("{before}{after}")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let start = if before.chars().count() == SNIPPET_CHARS / 2 && at > before.len() {
        "…"
    } else {
        ""
    };
    let end = if text.len() > at + after.len() {
        "…"
    } else {
        ""
    };
    format!("{start}{line}{end}")
}

/// A match: the record's offset and time, the kind of step, and its snippet.
type Match = (u64, Option<String>, &'static str, String);

/// What is read of a record at a time.
const CHUNK: usize = 8 * 1024 * 1024;

/// The latest matches of one native record, read until `deadline`. Lines are found in the raw
/// bytes, a chunk at a time, by the longest ASCII run of the query; only those are read.
fn scan(
    path: &PathBuf,
    harness: &str,
    query: &[char],
    deadline: Instant,
) -> std::io::Result<(Vec<Match>, bool)> {
    use std::io::Read;
    let needle: String = query.iter().collect();
    let probe = needle
        .split(|c: char| !c.is_ascii())
        .max_by_key(|run| run.len())
        .unwrap_or_default();
    let finder = (probe.len() >= 2).then(|| {
        aho_corasick::AhoCorasick::builder()
            .ascii_case_insensitive(true)
            .build([probe])
            .expect("a literal pattern")
    });
    let mut file = std::fs::File::open(path)?;
    let mut chunk = vec![0; CHUNK];
    let (mut found, mut data, mut base) = (Vec::new(), Vec::new(), 0u64);
    loop {
        if Instant::now() > deadline {
            return Ok((found, true));
        }
        let read = file.read(&mut chunk)?;
        data.extend_from_slice(&chunk[..read]);
        // Whole lines only: one still being written waits.
        let Some(last) = memchr::memrchr(b'\n', &data) else {
            if read == 0 {
                break;
            }
            continue;
        };
        let lines = &data[..=last];
        let mut spans = Vec::new();
        match &finder {
            Some(finder) => {
                let mut from = 0;
                for hit in finder.find_iter(lines) {
                    if hit.start() < from {
                        continue;
                    }
                    let start = memchr::memrchr(b'\n', &lines[..hit.start()]).map_or(0, |n| n + 1);
                    let end = memchr::memchr(b'\n', &lines[hit.start()..])
                        .map_or(lines.len(), |n| hit.start() + n);
                    spans.push((start, end));
                    from = end + 1;
                }
            }
            None => {
                let mut start = 0;
                for end in memchr::memchr_iter(b'\n', lines) {
                    spans.push((start, end));
                    start = end + 1;
                }
            }
        }
        for (start, end) in spans {
            let line = &lines[start..end];
            if !String::from_utf8_lossy(line)
                .to_lowercase()
                .contains(&needle)
            {
                continue;
            }
            let Ok(value) = serde_json::from_slice(line) else {
                continue;
            };
            let record = Record {
                at: base + start as u64,
                record: value,
            };
            for item in project(harness, std::slice::from_ref(&record)) {
                if let Some((kind, words)) = searchable(&item.event)
                    && let Some(at) = find(&words, query)
                {
                    if found.len() == PER_SESSION {
                        found.remove(0);
                    }
                    found.push((item.at, item.time.clone(), kind, snippet(&words, at)));
                }
            }
        }
        base += (last + 1) as u64;
        data.drain(..=last);
        if read == 0 {
            break;
        }
    }
    Ok((found, false))
}

impl Store {
    /// The latest steps, newest first, of the sessions `who` may read on this kernel's host
    /// whose words, reasoning or tool calls contain `query`, ignoring case.
    pub async fn search_sessions(
        &self,
        who: &ChatIdentity,
        query: &str,
        limit: usize,
    ) -> Result<Results> {
        let query = query.trim();
        if query.chars().count() < 2 || query.len() > 200 {
            return Err(Error::Invalid("Search for 2 to 200 bytes of text".into()));
        }
        let lower: Vec<char> = query.chars().flat_map(char::to_lowercase).collect();
        let deadline = Instant::now() + BUDGET;
        // Every session's record at once, each on its own thread.
        let mut scans = Vec::new();
        for session in self.sessions(who).await? {
            if session.host_id.as_deref() != self.host() {
                continue;
            }
            let row = self.observed_session(who, &session.id).await?;
            let lower = lower.clone();
            let harness = session.harness.clone();
            let scan = tokio::task::spawn_blocking(move || {
                let path = locate(&row)?;
                scan(&path, &harness, &lower, deadline).ok()
            });
            scans.push((session, scan));
        }
        let (mut results, mut truncated) = (Vec::new(), false);
        for (session, scan) in scans {
            let scanned = scan
                .await
                .map_err(|error| Error::Invalid(format!("The search stopped: {error}")))?;
            let Some((found, cut)) = scanned else {
                continue;
            };
            truncated |= cut;
            results.extend(found.into_iter().map(|(at, time, kind, snippet)| Found {
                session_id: session.id.clone(),
                title: session.title.clone(),
                harness: session.harness.clone(),
                at,
                time,
                kind,
                snippet,
            }));
        }
        results.sort_by(|a, b| b.time.cmp(&a.time));
        results.truncate(limit.clamp(1, 200));
        Ok(Results { results, truncated })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_ignore_case_and_show_the_words_around() {
        let query: Vec<char> = "release".chars().collect();
        let text = "We cut the RELEASE today";
        let at = find(text, &query).unwrap();
        assert_eq!(&text[at..at + 7], "RELEASE");
        assert_eq!(snippet(text, at), "We cut the RELEASE today");
        assert_eq!(find("nothing here", &query), None);
        let long = format!("{} release {}", "a ".repeat(100), "b ".repeat(100));
        let at = find(&long, &query).unwrap();
        let shown = snippet(&long, at);
        assert!(shown.starts_with('…') && shown.ends_with('…') && shown.contains("release"));
        let accents: Vec<char> = "città".chars().collect();
        assert!(find("La CITTÀ è grande", &accents).is_some());
    }

    #[test]
    fn a_record_is_searched_in_its_steps_and_keeps_its_latest_matches() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let line = |role: &str, block: serde_json::Value| {
            serde_json::json!({"type":"message","timestamp":"2026-10-18T10:00:00Z",
                "message":{"role":role,"content":[block]}})
            .to_string()
        };
        let mut lines = vec![
            line("user", serde_json::json!({"type":"text","text":"Plan the Release"})),
            line(
                "assistant",
                serde_json::json!({"type":"toolCall","id":"t","name":"bash","arguments":{"command":"git tag release-1"}}),
            ),
            // In the record, not in a step: a tool's result is not searched.
            serde_json::json!({"type":"message","message":{"role":"toolResult","content":[{"type":"text","text":"release done"}]}}).to_string(),
        ];
        for n in 0..PER_SESSION {
            lines.push(line(
                "assistant",
                serde_json::json!({"type":"text","text":format!("release step {n}")}),
            ));
        }
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        let query: Vec<char> = "release".chars().collect();
        let deadline = Instant::now() + BUDGET;
        let (found, cut) = scan(&path, "pi", &query, deadline).unwrap();
        assert!(!cut);
        assert_eq!(found.len(), PER_SESSION);
        assert_eq!(
            found.last().unwrap().3,
            format!("release step {}", PER_SESSION - 1)
        );
        let (all, _) = scan(
            &path,
            "pi",
            &"tag release".chars().collect::<Vec<_>>(),
            deadline,
        )
        .unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].2, "tool_call");
        assert!(all[0].3.contains("git tag release-1"), "{}", all[0].3);
        let (input, _) = scan(
            &path,
            "pi",
            &"plan the".chars().collect::<Vec<_>>(),
            deadline,
        )
        .unwrap();
        assert_eq!((input[0].0, input[0].2), (0, "input"));
        // Out of time: what was read so far, marked.
        let (_, cut) = scan(&path, "pi", &query, Instant::now() - BUDGET).unwrap();
        assert!(cut);
    }
}
