//! The subagents a session's harness started, each with its own native record: Claude Code's
//! in the session's `subagents` folder, Codex's as threads spawned from the session's thread.
use super::*;

/// A subagent of a session, as its harness records it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Subagent {
    pub id: String,
    /// Its name or nickname, when the harness gives one.
    pub name: Option<String>,
    /// What it was asked to do, in a few words.
    pub description: Option<String>,
    /// Its type or role.
    pub kind: Option<String>,
    /// The tool call of the session that started it, when the harness says.
    pub tool_call_id: Option<String>,
    /// The subagent that started it, for one started by another.
    pub parent_id: Option<String>,
    pub updated_at: Option<i64>,
}

const CODEX_SUBAGENTS: [&str; 5] = [
    "subAgent",
    "subAgentReview",
    "subAgentCompact",
    "subAgentThreadSpawn",
    "subAgentOther",
];

/// Claude Code keeps a session's subagents next to its transcript.
fn claude_folder(transcript: &std::path::Path) -> Option<std::path::PathBuf> {
    Some(
        transcript
            .parent()?
            .join(transcript.file_stem()?)
            .join("subagents"),
    )
}

fn modified(path: &std::path::Path) -> Option<i64> {
    let at = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(at.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64)
}

fn claude_subagents(transcript: &std::path::Path) -> Vec<Subagent> {
    let Some(folder) = claude_folder(transcript) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&folder) else {
        return Vec::new();
    };
    let mut found: Vec<Subagent> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let id = name
                .strip_prefix("agent-")?
                .strip_suffix(".jsonl")?
                .to_owned();
            let meta: Value = std::fs::read(folder.join(format!("agent-{id}.meta.json")))
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default();
            let text = |key: &str| meta[key].as_str().map(str::to_owned);
            Some(Subagent {
                updated_at: modified(&entry.path()),
                id,
                name: text("name"),
                description: text("description"),
                kind: text("agentType"),
                tool_call_id: text("toolUseId"),
                parent_id: None,
            })
        })
        .collect();
    found.sort_by_key(|agent| std::cmp::Reverse(agent.updated_at));
    found
}

/// Codex's threads spawned from `thread`, at any depth, newest first.
async fn codex_subagents(thread: &str, homes: &crate::homes::Homes) -> Result<Vec<Value>> {
    let endpoint = sessions::ensure_codex_daemon_in(homes).await?;
    let rpc = crate::codex::CodexRpc::connect(&endpoint).await?;
    let (mut threads, mut cursor) = (Vec::new(), None::<String>);
    loop {
        let page = rpc
            .request(
                "thread/list",
                serde_json::json!({"ancestorThreadId": thread, "sourceKinds": CODEX_SUBAGENTS,
                    "limit": 100, "cursor": cursor}),
            )
            .await
            .context("Codex did not list the thread's subagents")?;
        threads.extend(page["data"].as_array().cloned().unwrap_or_default());
        cursor = page["nextCursor"].as_str().map(str::to_owned);
        if cursor.is_none() || threads.len() >= 500 {
            break;
        }
    }
    Ok(threads)
}

fn codex_subagent(thread: &Value) -> Option<Subagent> {
    let text = |key: &str| thread[key].as_str().map(str::to_owned);
    let seconds = |key: &str| thread[key].as_i64().map(|at| at * 1000);
    Some(Subagent {
        id: text("id")?,
        name: text("agentNickname").or_else(|| text("name")),
        description: text("preview"),
        kind: text("agentRole"),
        tool_call_id: None,
        parent_id: text("parentThreadId"),
        updated_at: seconds("updatedAt").or_else(|| seconds("createdAt")),
    })
}

fn homes_of(row: &crate::entity::sessions::Model) -> crate::homes::Homes {
    crate::homes::Homes::of_locator(
        &serde_json::from_str(&row.native_locator_json).unwrap_or_default(),
    )
}

/// What could not be done, said as it is.
fn said(error: anyhow::Error) -> anyhow::Error {
    match error.downcast::<Error>() {
        Ok(error) => error.into(),
        Err(error) => Error::Invalid(format!("{error:#}")).into(),
    }
}

impl ChatRuntime {
    /// The session's row and native record, from this host.
    async fn subagent_home(
        &self,
        who: &ChatIdentity,
        id: &str,
    ) -> Result<(crate::entity::sessions::Model, Option<std::path::PathBuf>)> {
        let row = self.store.observed_session(who, id).await?;
        ensure!(
            row.host_id.as_deref() == self.store.host(),
            "This session runs on another kernel host; read its subagents there"
        );
        let path = tokio::task::spawn_blocking({
            let row = row.clone();
            move || crate::native_output::locate(&row)
        })
        .await?;
        Ok((row, path))
    }

    /// The subagents a session's harness started, newest first. pi starts none of its own.
    pub async fn subagents(&self, who: &ChatIdentity, id: &str) -> Result<Vec<Subagent>> {
        self.subagents_native(who, id).await.map_err(said)
    }

    async fn subagents_native(&self, who: &ChatIdentity, id: &str) -> Result<Vec<Subagent>> {
        let (row, path) = self.subagent_home(who, id).await?;
        match row.harness.as_str() {
            "claude-code" => Ok(match path {
                Some(path) => tokio::task::spawn_blocking(move || claude_subagents(&path)).await?,
                None => Vec::new(),
            }),
            "codex" => Ok(codex_subagents(&row.native_session_id, &homes_of(&row))
                .await?
                .iter()
                .filter_map(codex_subagent)
                .collect()),
            _ => Ok(Vec::new()),
        }
    }

    /// A subagent's events, read like the session's own.
    pub async fn subagent_events(
        &self,
        who: &ChatIdentity,
        id: &str,
        agent: &str,
        query: crate::native_output::EventQuery,
    ) -> Result<crate::native_output::EventPage> {
        self.subagent_events_native(who, id, agent, query)
            .await
            .map_err(said)
    }

    async fn subagent_events_native(
        &self,
        who: &ChatIdentity,
        id: &str,
        agent: &str,
        query: crate::native_output::EventQuery,
    ) -> Result<crate::native_output::EventPage> {
        ensure!(
            !agent.is_empty()
                && agent.len() <= 200
                && agent.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
            Error::NotFound
        );
        let (row, path) = self.subagent_home(who, id).await?;
        let record = match row.harness.as_str() {
            "claude-code" => path
                .as_deref()
                .and_then(claude_folder)
                .map(|folder| folder.join(format!("agent-{agent}.jsonl")))
                .filter(|path| path.is_file()),
            "codex" => {
                // Only a thread spawned from this session's.
                let ours = codex_subagents(&row.native_session_id, &homes_of(&row))
                    .await?
                    .iter()
                    .any(|thread| thread["id"] == agent);
                ensure!(ours, Error::NotFound);
                let (agent, homes) = (agent.to_owned(), homes_of(&row));
                tokio::task::spawn_blocking(move || {
                    crate::native_output::codex_rollout(&agent, &homes)
                })
                .await?
            }
            _ => None,
        };
        let record = record.ok_or(Error::NotFound)?;
        Ok(crate::native_output::events_of(&row.id, &row.harness, Some(record), query).await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_subagents_come_from_the_session_folder_with_what_they_were_asked() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir.path().join("session-1.jsonl");
        std::fs::write(&transcript, "").unwrap();
        let folder = dir.path().join("session-1/subagents");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("agent-a1.jsonl"), "{}\n").unwrap();
        std::fs::write(
            folder.join("agent-a1.meta.json"),
            r#"{"agentType":"general-purpose","description":"Review the diff","toolUseId":"toolu_1"}"#,
        )
        .unwrap();
        std::fs::write(folder.join("agent-b2.jsonl"), "{}\n").unwrap();
        std::fs::write(folder.join("agent-b2.forked-skill.json"), "{}").unwrap();
        let mut found = claude_subagents(&transcript);
        found.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].id, "a1");
        assert_eq!(found[0].description.as_deref(), Some("Review the diff"));
        assert_eq!(found[0].kind.as_deref(), Some("general-purpose"));
        assert_eq!(found[0].tool_call_id.as_deref(), Some("toolu_1"));
        assert_eq!(found[1].description, None);
        assert!(claude_subagents(&dir.path().join("none.jsonl")).is_empty());
    }

    #[test]
    fn codex_subagents_are_threads_spawned_from_the_session() {
        let thread = serde_json::json!({"id":"t2","agentNickname":"Ada","agentRole":"reviewer",
            "preview":"Check the tests","parentThreadId":"t1","updatedAt":5});
        let found = codex_subagent(&thread).unwrap();
        assert_eq!(found.name.as_deref(), Some("Ada"));
        assert_eq!(found.kind.as_deref(), Some("reviewer"));
        assert_eq!(found.parent_id.as_deref(), Some("t1"));
        assert_eq!(found.updated_at, Some(5000));
    }
}
