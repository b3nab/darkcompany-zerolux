//! What a session is producing right now, before its harness writes it to the native record:
//! text, reasoning and command output as they stream. Held in memory only; once a step is
//! complete the native record is its source of truth.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::store::Error;

/// Kept of one item: its latest output, when it grows past this.
const ITEM_BYTES: usize = 256 * 1024;
const ITEMS: usize = 64;
const CHANGES: usize = 256;
const APPEND_BYTES: usize = 64 * 1024;
/// A notice stays well under what one realtime data packet carries.
pub const NOTICE_BYTES: usize = 12 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// The agent's words.
    Text,
    /// Its reasoning.
    Thinking,
    /// A running tool's output, such as a command's.
    Output,
}

/// An item of the step in progress, with what it produced so far.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub kind: Kind,
    pub text: String,
}

/// What an integration reports, in order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Change {
    /// More of an item; the first one opens it.
    Append {
        item: String,
        kind: Kind,
        text: String,
    },
    /// All of an item so far, from a harness that reports output whole.
    Set {
        item: String,
        kind: Kind,
        text: String,
    },
    /// The item is complete: the native record has it.
    Done { item: String },
    /// The turn ended: nothing is in progress.
    Clear,
}

/// A session's live state: what is in progress, and the number of the last change.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct State {
    pub seq: u64,
    pub items: Vec<Item>,
}

/// Changes as they were applied, numbered from `first`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Applied {
    pub first: u64,
    pub changes: Vec<Change>,
}

#[derive(Default)]
pub struct Live {
    sessions: std::sync::Mutex<HashMap<String, State>>,
}

impl Live {
    pub fn state(&self, session: &str) -> State {
        self.sessions
            .lock()
            .expect("live state")
            .get(session)
            .cloned()
            .unwrap_or_default()
    }

    /// Applies an integration's changes and numbers them.
    pub fn apply(&self, session: &str, changes: Vec<Change>) -> Result<Applied, Error> {
        if changes.len() > CHANGES
            || changes.iter().any(|change| match change {
                Change::Append { item, text, .. } | Change::Set { item, text, .. } => {
                    item.is_empty() || item.len() > 200 || text.len() > APPEND_BYTES
                }
                Change::Done { item } => item.is_empty() || item.len() > 200,
                Change::Clear => false,
            })
        {
            return Err(Error::Invalid("Invalid live changes".into()));
        }
        let changes = pieces(changes);
        let mut sessions = self.sessions.lock().expect("live state");
        let state = sessions.entry(session.to_owned()).or_default();
        let first = state.seq + 1;
        for change in &changes {
            match change {
                Change::Append { item, kind, text } | Change::Set { item, kind, text } => {
                    let whole = matches!(change, Change::Set { .. });
                    match state.items.iter_mut().find(|open| &open.id == item) {
                        Some(open) if whole => open.text.clone_from(text),
                        Some(open) => open.text.push_str(text),
                        None => {
                            if state.items.len() == ITEMS {
                                state.items.remove(0);
                            }
                            state.items.push(Item {
                                id: item.clone(),
                                kind: *kind,
                                text: text.clone(),
                            });
                        }
                    }
                    if let Some(open) = state.items.iter_mut().find(|open| &open.id == item)
                        && open.text.len() > ITEM_BYTES
                    {
                        let mut cut = open.text.len() - ITEM_BYTES;
                        while !open.text.is_char_boundary(cut) {
                            cut += 1;
                        }
                        open.text.drain(..cut);
                    }
                }
                Change::Done { item } => state.items.retain(|open| &open.id != item),
                Change::Clear => state.items.clear(),
            }
            state.seq += 1;
        }
        Ok(Applied { first, changes })
    }

    /// The session no longer runs here.
    pub fn forget(&self, session: &str) {
        self.sessions.lock().expect("live state").remove(session);
    }
}

impl Applied {
    /// The changes in notices that each fit in one realtime packet.
    pub fn notices(self) -> Vec<Applied> {
        let mut notices: Vec<Applied> = Vec::new();
        let mut bytes = 0;
        for (n, change) in self.changes.into_iter().enumerate() {
            let size = serde_json::to_string(&change).map_or(0, |text| text.len());
            match notices.last_mut() {
                Some(notice) if bytes + size <= NOTICE_BYTES => {
                    bytes += size;
                    notice.changes.push(change);
                }
                _ => {
                    bytes = size;
                    notices.push(Applied {
                        first: self.first + n as u64,
                        changes: vec![change],
                    });
                }
            }
        }
        notices
    }
}

/// Long text in pieces that each fit in a notice.
fn pieces(changes: Vec<Change>) -> Vec<Change> {
    let mut result = Vec::with_capacity(changes.len());
    for change in changes {
        match change {
            Change::Append {
                ref item,
                kind,
                ref text,
            }
            | Change::Set {
                ref item,
                kind,
                ref text,
            } if text.len() > NOTICE_BYTES / 2 => {
                // Whole output arrives as its first piece, set, then the rest, appended.
                let mut whole = matches!(change, Change::Set { .. });
                let mut rest = text.as_str();
                while !rest.is_empty() {
                    let mut cut = rest.len().min(NOTICE_BYTES / 2);
                    while !rest.is_char_boundary(cut) {
                        cut -= 1;
                    }
                    let (item, text) = (item.clone(), rest[..cut].to_owned());
                    result.push(if whole {
                        Change::Set { item, kind, text }
                    } else {
                        Change::Append { item, kind, text }
                    });
                    whole = false;
                    rest = &rest[cut..];
                }
            }
            change => result.push(change),
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn append(item: &str, kind: Kind, text: &str) -> Change {
        Change::Append {
            item: item.into(),
            kind,
            text: text.into(),
        }
    }

    #[test]
    fn changes_build_what_is_in_progress_and_are_numbered() {
        let live = Live::default();
        let applied = live
            .apply(
                "s",
                vec![
                    append("t", Kind::Thinking, "Let me "),
                    append("t", Kind::Thinking, "look"),
                    append("m", Kind::Text, "Hello"),
                ],
            )
            .unwrap();
        assert_eq!(applied.first, 1);
        let state = live.state("s");
        assert_eq!(state.seq, 3);
        assert_eq!(state.items[0].text, "Let me look");
        assert_eq!(state.items[1].kind, Kind::Text);
        let applied = live
            .apply("s", vec![Change::Done { item: "t".into() }])
            .unwrap();
        assert_eq!(applied.first, 4);
        assert_eq!(live.state("s").items.len(), 1);
        live.apply("s", vec![Change::Clear]).unwrap();
        assert_eq!(
            live.state("s"),
            State {
                seq: 5,
                items: vec![]
            }
        );
        assert_eq!(live.state("other"), State::default());
        live.forget("s");
        assert_eq!(live.state("s"), State::default());
    }

    #[test]
    fn long_output_keeps_its_end_and_reaches_clients_in_packets() {
        let live = Live::default();
        let chunk = "é".repeat(30 * 1024);
        let mut notices = Vec::new();
        for _ in 0..6 {
            notices.extend(
                live.apply("s", vec![append("cmd", Kind::Output, &chunk)])
                    .unwrap()
                    .notices(),
            );
        }
        let state = live.state("s");
        assert!(state.items[0].text.len() <= ITEM_BYTES);
        assert!(state.items[0].text.ends_with('é'));
        let mut seq = 1;
        for notice in &notices {
            assert_eq!(notice.first, seq);
            assert!(serde_json::to_string(notice).unwrap().len() < NOTICE_BYTES + 200);
            seq += notice.changes.len() as u64;
        }
        assert_eq!(seq - 1, state.seq);
    }

    #[test]
    fn whole_output_replaces_what_was_there() {
        let live = Live::default();
        live.apply("s", vec![append("cmd", Kind::Output, "line 1\n")])
            .unwrap();
        let set = |text: &str| Change::Set {
            item: "cmd".into(),
            kind: Kind::Output,
            text: text.into(),
        };
        live.apply("s", vec![set("line 2\n")]).unwrap();
        assert_eq!(live.state("s").items[0].text, "line 2\n");
        let long = "y".repeat(NOTICE_BYTES * 2);
        let applied = live.apply("s", vec![set(&long)]).unwrap();
        assert!(matches!(applied.changes[0], Change::Set { .. }));
        assert!(matches!(applied.changes[1], Change::Append { .. }));
        assert_eq!(live.state("s").items[0].text, long);
    }

    #[test]
    fn oversized_or_unnamed_changes_are_refused_whole() {
        let live = Live::default();
        assert!(live.apply("s", vec![append("", Kind::Text, "x")]).is_err());
        assert!(
            live.apply(
                "s",
                vec![append("m", Kind::Text, &"x".repeat(APPEND_BYTES + 1))]
            )
            .is_err()
        );
        assert!(live.apply("s", vec![Change::Clear; CHANGES + 1]).is_err());
        assert_eq!(live.state("s"), State::default());
    }
}
