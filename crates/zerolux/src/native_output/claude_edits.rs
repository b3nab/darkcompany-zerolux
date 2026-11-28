//! A corrected prompt is a new native user entry with the original prompt's parent.
//! Claude keeps both in the file. Tell readers where their visible branch diverges, even
//! when the two entries arrive on different pages. Raw /output and its offsets never change.
use super::{Event, Item, PAGE_BYTES, Path, Record, project, read_back};
use std::io;

fn parent(row: &Record) -> Option<&str> {
    let r = &row.record;
    (r["type"] == "user"
        && r["isSidechain"] != true
        && r["isMeta"] != true
        && r["isCompactSummary"] != true
        && r["uuid"].is_string())
    .then(|| r["parentUuid"].as_str())
    .flatten()
}

// Stop at the actual parent in a linear history; only an older *sibling input* is
// evidence of replacement. Messages with the same words need not be related at all.
fn sibling(rows: &[Record], anchor: &str, id: &str) -> Option<Option<u64>> {
    for row in rows.iter().rev() {
        if row.record["uuid"].as_str() == Some(anchor) {
            return Some(None);
        }
        if parent(row) == Some(anchor)
            && row.record["uuid"].as_str() != Some(id)
            && project("claude-code", std::slice::from_ref(row))
                .iter()
                .any(|e| matches!(e.event, Event::Input { .. }))
        {
            return Some(Some(row.at));
        }
    }
    None
}

pub(super) async fn page(path: &Path, rows: &[Record]) -> io::Result<Vec<Item>> {
    let mut events = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        let items = project("claude-code", std::slice::from_ref(row));
        if let Some(anchor) = parent(row)
            && let Some(input) = items
                .iter()
                .find(|e| matches!(e.event, Event::Input { .. }))
        {
            let id = row.record["uuid"].as_str().unwrap();
            let mut found = sibling(&rows[..i], anchor, id);
            let mut before = rows[0].at;
            while found.is_none() && before > 0 {
                let (older, first, _, _) = read_back(path, before, PAGE_BYTES).await?;
                found = sibling(&older, anchor, id);
                if first >= before {
                    break;
                }
                before = first;
            }
            if let Some(Some(before)) = found {
                events.push(Item {
                    at: row.at,
                    time: input.time.clone(),
                    event: Event::InputEdited { before },
                    truncated: None,
                });
            }
        }
        events.extend(items);
    }
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_output::{EventQuery, events_of};
    use serde_json::json;

    #[tokio::test]
    async fn a_replacement_cuts_the_abandoned_suffix_on_incremental_and_reopened_reads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.jsonl");
        let mut file = String::new();
        let mut offsets = vec![];
        for (id, parent, role) in [
            (1, 0, "user"),
            (2, 1, "assistant"),
            (3, 2, "user"),
            (4, 3, "assistant"),
            (5, 4, "user"),
            (6, 5, "assistant"),
            (7, 2, "user"),
            (8, 7, "assistant"),
            (9, 2, "user"),
        ] {
            offsets.push(file.len() as u64);
            file.push_str(&json!({"type":role,"uuid":id.to_string(),"parentUuid":(parent!=0).then(||parent.to_string()),"message":{"role":role,"content":[{"type":"text","text":id.to_string()}]}}).to_string());
            file.push('\n');
        }
        std::fs::write(&path, &file).unwrap();
        for query in [
            EventQuery {
                after: Some(offsets[6]),
                ..Default::default()
            },
            EventQuery {
                before: Some(u64::MAX),
                ..Default::default()
            },
        ] {
            let page = events_of("fixture", "claude-code", Some(path.clone()), query)
                .await
                .unwrap();
            let cuts: Vec<_> = page
                .events
                .iter()
                .filter_map(|e| match e.event {
                    Event::InputEdited { before } => Some((e.at, before)),
                    _ => None,
                })
                .collect();
            assert_eq!(cuts, [(offsets[6], offsets[2]), (offsets[8], offsets[6])]);
        }
        assert_eq!(std::fs::read_to_string(path).unwrap(), file);
    }
}
