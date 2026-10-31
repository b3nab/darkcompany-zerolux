//! What only the computer a session runs on can read or do: its native record and its folder.
//! The kernel does it itself for its own host's sessions, and asks a joined computer for its
//! own over the computer's channel. Both run this code.

use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::entity::sessions;

/// What a computer needs to know of a session to find its native record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordRef {
    pub id: String,
    pub harness: String,
    pub native_session_id: String,
    pub native_locator_json: String,
    pub workspace: String,
}

impl RecordRef {
    pub fn of(row: &sessions::Model) -> Self {
        Self {
            id: row.id.clone(),
            harness: row.harness.clone(),
            native_session_id: row.native_session_id.clone(),
            native_locator_json: row.native_locator_json.clone(),
            workspace: row.workspace.clone(),
        }
    }

    /// The session as this computer's own code reads it.
    pub fn model(&self) -> sessions::Model {
        sessions::Model {
            workspace_id: String::new(),
            id: self.id.clone(),
            actor_id: None,
            harness: self.harness.clone(),
            native_session_id: self.native_session_id.clone(),
            title: String::new(),
            workspace: self.workspace.clone(),
            native_locator_json: self.native_locator_json.clone(),
            token_hash: String::new(),
            status: String::new(),
            attention_reason: None,
            created_at: 0,
            stopped_at: None,
            activity: None,
            activity_conversation_id: None,
            host_id: None,
            pinned_at: None,
            archived_at: None,
            budget_cents: None,
            parent_session_id: None,
            owner_id: String::new(),
            shared: None,
            created: false,
        }
    }
}

fn param<T: serde::de::DeserializeOwned + Default>(params: &Value, key: &str) -> Result<T> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(T::default()),
        Some(value) => serde_json::from_value(value.clone()).context("Invalid parameters"),
    }
}

/// What the session's native record says: its records, its events, its subagents'.
pub async fn record(op: &str, record: &RecordRef, params: &Value) -> Result<Value> {
    let row = record.model();
    let path = tokio::task::spawn_blocking({
        let row = row.clone();
        move || crate::native_output::locate(&row)
    })
    .await?;
    Ok(match op {
        // A page carries the beginning of each long tool output; `events_at` the whole.
        "events" => {
            let mut page = crate::native_output::events_of(
                &row.id,
                &row.harness,
                path,
                param(params, "query")?,
            )
            .await?;
            page.events = page.events.into_iter().map(|item| item.light()).collect();
            json!(page)
        }
        "events_at" => {
            let at: u64 = param(params, "at")?;
            let path = path.context("The session's native record is not there yet")?;
            let (records, ..) = crate::native_output::read(&path, at).await?;
            let record: Vec<_> = records
                .into_iter()
                .take(1)
                .filter(|record| record.at == at)
                .collect();
            anyhow::ensure!(!record.is_empty(), crate::store::Error::NotFound);
            json!({"events": crate::native_events::project(&row.harness, &record)})
        }
        "output" => {
            let after: u64 = param(params, "after")?;
            let (records, next, end) = match path {
                Some(path) => crate::native_output::read(&path, after)
                    .await
                    .map_err(|error| crate::native_output::unreadable(error, after))?,
                None if after == 0 => (Vec::new(), 0, 0),
                None => bail!(crate::store::Error::NotFound),
            };
            json!(crate::native_output::Page {
                session_id: row.id.clone(),
                harness: row.harness.clone(),
                records,
                next,
                end,
            })
        }
        "at" => {
            let at: u64 = param(params, "at")?;
            let path = path.context("The session's native record is not there yet")?;
            let (records, ..) = crate::native_output::read(&path, at).await?;
            records
                .into_iter()
                .next()
                .filter(|record| record.at == at)
                .context("No record of this session starts there")?
                .record
        }
        "search" => {
            crate::history::search_record(row.clone(), &param::<String>(params, "query")?).await?
        }
        "subagents" => json!({"subagents": crate::chat_runtime::subagents_of(&row).await?}),
        "subagent_events" => json!(
            crate::chat_runtime::subagent_events_of(
                &row,
                &param::<String>(params, "agent")?,
                param(params, "query")?
            )
            .await?
        ),
        other => bail!("This computer's ZeroLux does not know `record.{other}`; update it"),
    })
}

/// What the session's folder holds: its git state, changes, files and pull request.
pub async fn folder(op: &str, folder: &Path, params: &Value) -> Result<Value> {
    use crate::workspace_git as git;
    Ok(match op {
        "git" => json!(git::status(folder).await?),
        "diff" => json!({"diff": git::diff(
            folder,
            param::<Option<String>>(params, "path")?.as_deref(),
            param(params, "staged")?
        )
        .await?}),
        "file" => {
            let path: String = param(params, "path")?;
            json!({"path": path, "text": git::file(folder, &path).await?})
        }
        "files" => json!({"files": crate::workspace_files::find(
            folder,
            &param::<String>(params, "query")?,
            param::<Option<usize>>(params, "limit")?.unwrap_or(50)
        )
        .await?}),
        "pr" => json!({"pull_request": git::pull_request(folder).await?}),
        "ci" => match crate::triggers::ci(folder).await? {
            Some(ended) => {
                json!({"seen": ended.seen, "failed": ended.failed, "report": ended.report})
            }
            None => Value::Null,
        },
        "stage" => {
            git::stage(folder, &param::<Vec<String>>(params, "paths")?).await?;
            json!(git::status(folder).await?)
        }
        "unstage" => {
            git::unstage(folder, &param::<Vec<String>>(params, "paths")?).await?;
            json!(git::status(folder).await?)
        }
        "discard" => {
            git::discard(folder, &param::<Vec<String>>(params, "paths")?).await?;
            json!(git::status(folder).await?)
        }
        "commit" => {
            json!({"commit": git::commit(folder, &param::<String>(params, "message")?).await?})
        }
        "push" => {
            git::push(folder).await?;
            json!(git::status(folder).await?)
        }
        "open_pr" => json!({"url": git::open_pull_request(
            folder,
            &param::<String>(params, "title")?,
            &param::<String>(params, "body")?,
            param(params, "draft")?
        )
        .await?}),
        other => bail!("This computer's ZeroLux does not know `folder.{other}`; update it"),
    })
}

/// What a joined computer answers when the kernel asks.
pub async fn answer(op: &str, params: Value) -> Result<Value> {
    match op {
        "ping" => Ok(json!({"version": crate::build::version(), "build": crate::build::info()})),
        "record" => {
            let record: RecordRef =
                serde_json::from_value(params["record"].clone()).context("Invalid session")?;
            self::record(
                params["op"].as_str().unwrap_or_default(),
                &record,
                &params["params"],
            )
            .await
        }
        "folder" => {
            let at = params["folder"].as_str().context("Invalid folder")?;
            folder(
                params["op"].as_str().unwrap_or_default(),
                Path::new(at),
                &params["params"],
            )
            .await
        }
        other => bail!("This computer's ZeroLux does not know `{other}`; update it"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_page_carries_a_long_tool_output_cut_and_its_record_gives_it_whole() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("session.jsonl");
        let long = "x".repeat(64 * 1024);
        let lines = [
            json!({"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"read","arguments":{}}]}}),
            json!({"type":"message","message":{"role":"toolResult","toolCallId":"t1","content":[{"type":"text","text":long}]}}),
            json!({"type":"message","message":{"role":"toolResult","toolCallId":"t2","content":[{"type":"text","text":"short"}]}}),
        ];
        let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
        std::fs::write(&file, text).unwrap();
        let record = RecordRef {
            id: "s".into(),
            harness: "pi".into(),
            native_session_id: "n".into(),
            native_locator_json: json!({"session_file": file}).to_string(),
            workspace: dir.path().to_string_lossy().into_owned(),
        };
        let page = record_op(&record, "events", json!({"query": {}})).await;
        let results: Vec<&Value> = page["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["type"] == "tool_result")
            .collect();
        assert_eq!(results.len(), 2);
        let (cut, short) = (results[0], results[1]);
        assert!(cut["output"].as_str().unwrap().len() < long.len());
        assert!(cut["truncated"].as_u64().unwrap() > long.len() as u64);
        assert!(short.get("truncated").is_none());
        let whole = record_op(&record, "events_at", json!({"at": cut["at"]})).await;
        assert_eq!(whole["events"][0]["output"][0]["text"], long.as_str());
    }

    async fn record_op(record: &RecordRef, op: &str, params: Value) -> Value {
        super::record(op, record, &params).await.unwrap()
    }
}
