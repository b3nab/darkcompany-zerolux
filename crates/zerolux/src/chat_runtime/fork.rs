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
        if !who.is_person() {
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
                let homes = crate::homes::Homes::of_locator(
                    &self.store.chat_session_locator(who, id).await?,
                );
                let endpoint = sessions::ensure_codex_daemon_in(&homes).await?;
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
                    native_locator: {
                        let mut locator = serde_json::json!({"endpoint": endpoint});
                        homes.record(&mut locator);
                        locator
                    },
                };
                self.link(who, target, name, actor_id, false).await
            }
            #[cfg(unix)]
            Harness::Pi => {
                let locator = self.store.chat_session_locator(who, id).await?;
                let homes = crate::homes::Homes::of_locator(&locator);
                let file = locator["session_file"]
                    .as_str()
                    .context("The pi session has no saved file to fork")?;
                let (native, file) = self
                    .pi_runners
                    .fork(file, &session.workspace, before.as_deref(), &homes)
                    .await?;
                let host = self
                    .pi_runners
                    .open(&native, &session.workspace, &file, &homes)
                    .await?;
                let result = async {
                    let mut opened = host.target().await?;
                    opened.title = title;
                    homes.record(&mut opened.native_locator);
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
                let homes = crate::homes::Homes::of_locator(
                    &self.store.chat_session_locator(who, id).await?,
                );
                let native = self
                    .runners
                    .fork(
                        &session.native_session_id,
                        &session.workspace,
                        before.as_deref(),
                        &homes,
                    )
                    .await?;
                let target = sessions::NativeSessionTarget {
                    harness: Harness::ClaudeCode,
                    native_session_id: native,
                    title,
                    workspace: session.workspace.clone(),
                    native_locator: serde_json::json!({}),
                };
                self.open_claude(who, target, name, actor_id, &homes).await
            }
            #[cfg(not(unix))]
            _ => bail!("Sessions fork only on a Unix execution host"),
        }
    }

    /// What comes before the input at `at` in the session's native record, as its harness
    /// names it: Claude Code's previous message, pi's previous entry, Codex's turn.
    async fn before(&self, who: &ChatIdentity, id: &str, at: u64) -> Result<String> {
        let (harness, record) = self.record_at(who, id, at).await?;
        let before = match harness.as_str() {
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

    /// The record of the session's native record that starts at `at`, and the harness.
    pub(super) async fn record_at(
        &self,
        who: &ChatIdentity,
        id: &str,
        at: u64,
    ) -> Result<(String, Value)> {
        let row = self.store.observed_session(who, id).await?;
        let path = tokio::task::spawn_blocking({
            let row = row.clone();
            move || crate::native_output::locate(&row)
        })
        .await?
        .context("The session's native record is not there yet")?;
        let (records, ..) = crate::native_output::read(&path, at).await?;
        let record = records
            .into_iter()
            .next()
            .filter(|record| record.at == at)
            .context("No record of this session starts there")?
            .record;
        Ok((row.harness, record))
    }

    /// The files as they were before the session's input at `at`, from Claude Code's own
    /// checkpoints; with `dry_run`, only what would change. Its result, as Claude Code says.
    pub async fn rewind_files(
        &self,
        who: &ChatIdentity,
        id: &str,
        at: u64,
        dry_run: bool,
    ) -> Result<Value> {
        async {
            if !who.is_person() {
                return Err(Error::Forbidden.into());
            }
            let session = self.store.chat_session(who, id).await?;
            let (_, record) = self.record_at(who, id, at).await?;
            match self.native_control(who, &session, "input-v1").await? {
                #[cfg(unix)]
                super::settings::Control::Claude(link) => {
                    let message = record["uuid"]
                        .as_str()
                        .context("No message of the session starts there")?;
                    let actual = link.describe().await?;
                    ensure!(
                        actual["capabilities"]
                            .as_array()
                            .is_some_and(|values| values.iter().any(|value| value == "rewind-files-v1")),
                        "The Claude runner needs an update for this control"
                    );
                    let reply = link
                        .request(serde_json::json!({"method":"rewind_files","link_id":session.id,
                            "message_id":message,"dry_run":dry_run}))
                        .await?;
                    Ok(reply["result"].clone())
                }
                _ => bail!(
                    "Only Claude Code keeps checkpoints of the files; restore them from the session's changes"
                ),
            }
        }
        .await
        .map_err(|error: anyhow::Error| match error.downcast::<Error>() {
            Ok(error) => error.into(),
            Err(error) => Error::Invalid(format!("{error:#}")).into(),
        })
    }
}
