//! A fork of a session: a new session that goes on from all of its history, or from what came
//! before one of its inputs, with the harness's own fork.
use super::*;

impl ChatRuntime {
    /// Forks a session with its harness, whole or before the input at `at` (an offset of its
    /// `/events`), and opens the fork in ZeroLux: without an agent, or with the one named.
    /// The fork's history is the harness's copy; the session forked from goes on unchanged.
    pub async fn fork(
        &self,
        who: &ChatIdentity,
        id: &str,
        at: Option<u64>,
        name: &str,
        actor_id: Option<String>,
    ) -> Result<(Option<Actor>, ChatSession)> {
        if !who.is_owner() {
            return Err(Error::Forbidden.into());
        }
        let session = self.store.chat_session(who, id).await?;
        ensure!(
            session.host_id.as_deref() == self.store.host(),
            "This session runs on another kernel host; fork it there"
        );
        let harness = match session.harness.as_str() {
            "codex" => Harness::Codex,
            "pi" => Harness::Pi,
            _ => Harness::ClaudeCode,
        };
        self.store
            .check_hire(who, harness, actor_id.as_deref(), name)
            .await?;
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        // What came before the input: the native record names it.
        let before = match at {
            Some(at) => Some(self.before(who, id, at).await?),
            None => None,
        };
        let title = format!("{} (fork)", session.title)
            .chars()
            .take(200)
            .collect::<String>();
        match harness {
            Harness::Codex => {
                let endpoint = sessions::ensure_codex_daemon().await?;
                let rpc = crate::codex::CodexRpc::connect(&endpoint).await?;
                let mut params = serde_json::json!({"threadId": session.native_session_id});
                if let Some(turn) = &before {
                    params["beforeTurnId"] = serde_json::json!(turn);
                }
                let forked = rpc.request("thread/fork", params).await?;
                let thread = forked["thread"]["id"]
                    .as_str()
                    .context("Codex did not name the fork")?
                    .to_owned();
                let target = sessions::NativeSessionTarget {
                    harness: Harness::Codex,
                    native_session_id: thread,
                    title,
                    workspace: session.workspace.clone(),
                    native_locator: serde_json::json!({"endpoint": endpoint}),
                };
                self.link(who, target, name, actor_id, false).await
            }
            #[cfg(unix)]
            Harness::Pi => {
                let locator = self.store.chat_session_locator(who, id).await?;
                let file = locator["session_file"]
                    .as_str()
                    .context("The pi session has no saved file to fork")?;
                let (native, file) = self
                    .pi_runners
                    .fork(file, &session.workspace, before.as_deref())
                    .await?;
                let host = self
                    .pi_runners
                    .open(&native, &session.workspace, &file)
                    .await?;
                let result = async {
                    let mut opened = host.target().await?;
                    opened.title = title;
                    self.link(who, opened, name, actor_id, false).await
                }
                .await;
                if result.is_err() {
                    host.discard_unstarted().await;
                }
                result
            }
            #[cfg(unix)]
            Harness::ClaudeCode => {
                let native = self
                    .runners
                    .fork(
                        &session.native_session_id,
                        &session.workspace,
                        before.as_deref(),
                    )
                    .await?;
                let target = sessions::NativeSessionTarget {
                    harness: Harness::ClaudeCode,
                    native_session_id: native,
                    title,
                    workspace: session.workspace.clone(),
                    native_locator: serde_json::json!({}),
                };
                self.open_claude(who, target, name, actor_id).await
            }
            #[cfg(not(unix))]
            _ => bail!("Sessions fork only on a Unix execution host"),
        }
    }

    /// What comes before the input at `at` in the session's native record, as its harness
    /// names it: Claude Code's previous message, pi's previous entry, Codex's turn.
    async fn before(&self, who: &ChatIdentity, id: &str, at: u64) -> Result<String> {
        let row = self.store.observed_session(who, id).await?;
        let path = tokio::task::spawn_blocking({
            let row = row.clone();
            move || crate::native_output::locate(&row)
        })
        .await?
        .context("The session's native record is not there yet")?;
        let (records, ..) = crate::native_output::read(&path, at).await?;
        let record = &records
            .first()
            .filter(|record| record.at == at)
            .context("No record of this session starts there")?
            .record;
        let before = match row.harness.as_str() {
            "codex" => record["payload"]["turn_id"]
                .as_str()
                .or(record["turn_id"].as_str()),
            "pi" => record["parentId"].as_str(),
            _ => record["parentUuid"].as_str(),
        };
        Ok(before
            .context("Nothing comes before this input to fork from")?
            .to_owned())
    }
}
