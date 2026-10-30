use super::*;
use crate::{
    claude_runner::RunnerLink,
    model::{AgentSettings, ClaudePermissionMode, CreateClaudeSession, IssuedChatSession},
};
use serde_json::json;

fn connection_reason(error: &anyhow::Error) -> String {
    let mut reason = format!("The Claude runner could not be connected: {error:#}");
    let mut end = reason.len().min(2_000);
    while !reason.is_char_boundary(end) {
        end -= 1;
    }
    reason.truncate(end);
    reason
}

// A surviving runner keeps its launch fingerprint; a cold replacement must instead
// preserve its last confirmed effective permissions, including owner changes made live.
fn restored_mode(
    locator: &mut Value,
    launch: ClaudePermissionMode,
) -> Result<ClaudePermissionMode> {
    let mode = match locator["settings"]["permission_mode"].as_str() {
        Some(value) => serde_json::from_value(json!(value))
            .context("The saved effective Claude permission mode is unsupported")?,
        None => launch,
    };
    locator["permission_mode"] = json!(mode);
    Ok(mode)
}

impl ChatRuntime {
    pub async fn create_claude(
        &self,
        who: &ChatIdentity,
        input: CreateClaudeSession,
    ) -> Result<(Option<Actor>, ChatSession)> {
        if !who.is_person() {
            return Err(Error::Forbidden.into());
        }
        self.store
            .check_hire(
                who,
                Harness::ClaudeCode,
                input.actor_id.as_deref(),
                &input.name,
            )
            .await?;
        let workspace = self
            .session_dir(&input.workspace, input.worktree.as_deref())
            .await?;
        let native_id = uuid::Uuid::new_v4().to_string();
        let chosen = self
            .launch_choices(
                who,
                input.actor_id.as_deref(),
                "claude-code",
                AgentSettings {
                    model: input.model,
                    effort: input.effort,
                    permission_mode: input.permission_mode.map(|mode| mode.name().to_owned()),
                    ..AgentSettings::default()
                },
            )
            .await?;
        let mode: ClaudePermissionMode = chosen
            .permission_mode
            .as_ref()
            .map(|mode| serde_json::from_value(json!(mode)))
            .transpose()?
            .unwrap_or_default();
        let initial = AgentSettings {
            model: chosen.model,
            effort: chosen.effort,
            ..AgentSettings::default()
        }
        .patch_json();
        // Started by ZeroLux with Claude Code's own system prompt, as a terminal would, and
        // with the person's own Claude Code: the computer's for its person, a guest's own.
        let mut native_locator = json!({"kind":"claude-runner","permission_mode":mode,"system_prompt":"claude_code","initial_settings":initial});
        self.store.homes(who).await?.record(&mut native_locator);
        let started = self
            .start_owned(
                who,
                HireChatSession {
                    name: input.name,
                    actor_id: input.actor_id,
                    harness: Harness::ClaudeCode,
                    native_session_id: native_id,
                    title: "Claude Code".into(),
                    workspace,
                    native_locator,
                    resume: false,
                },
                mode,
                false,
            )
            .await?;
        Ok(started)
    }

    pub async fn resume_claude(
        &self,
        who: &ChatIdentity,
        id: &str,
    ) -> Result<(Option<Actor>, ChatSession)> {
        if !who.is_person() {
            return Err(Error::Forbidden.into());
        }
        let mode = self
            .owned_mode(who, id)
            .await?
            .context("This is not an owned Claude session")?;
        let session = self.store.chat_session(who, id).await?;
        ensure!(
            session.stopped_at.is_some() || session.status == "attention",
            "Stop the running session before resuming it"
        );
        ensure!(
            self.runners
                .find(&session.native_session_id, &session.workspace, mode)
                .await?
                .is_none()
                && !self.runners.is_leased(&session.native_session_id)?,
            "The runner is still alive; reconnect it or Stop first"
        );
        self.runners
            .check_native_stopped(&session.native_session_id, &session.workspace)
            .await?;
        if session.stopped_at.is_none() {
            self.store.stop_chat_session(who, id).await?;
        }
        let mut locator = self.store.chat_session_locator(who, id).await?;
        let mode = restored_mode(&mut locator, mode)?;
        if let Some(previous) = self.agents.lock().await.remove(id) {
            previous.release().await;
        }
        self.start_owned(
            who,
            HireChatSession {
                name: String::new(),
                actor_id: session.actor_id,
                harness: Harness::ClaudeCode,
                native_session_id: session.native_session_id,
                title: session.title,
                workspace: session.workspace,
                native_locator: locator,
                resume: false,
            },
            mode,
            true,
        )
        .await
    }

    /// A saved Claude Code session, opened again under ZeroLux with its saved permissions.
    pub(super) async fn open_claude(
        &self,
        who: &ChatIdentity,
        target: sessions::NativeSessionTarget,
        name: &str,
        actor_id: Option<String>,
        homes: &crate::homes::Homes,
    ) -> Result<(Option<Actor>, ChatSession)> {
        self.runners
            .check_native_stopped(&target.native_session_id, &target.workspace)
            .await?;
        let mode =
            crate::claude::ClaudeSession::saved_permission_mode(&target.native_session_id, homes)
                .await
                .unwrap_or_default();
        let mut native_locator =
            json!({"kind":"claude-runner","permission_mode":mode,"system_prompt":"claude_code"});
        homes.record(&mut native_locator);
        self.start_owned(
            who,
            HireChatSession {
                name: name.into(),
                actor_id,
                harness: Harness::ClaudeCode,
                native_session_id: target.native_session_id,
                title: target.title,
                workspace: target.workspace,
                native_locator,
                resume: false,
            },
            mode,
            true,
        )
        .await
    }

    async fn start_owned(
        &self,
        who: &ChatIdentity,
        input: HireChatSession,
        mode: ClaudePermissionMode,
        resume_native: bool,
    ) -> Result<(Option<Actor>, ChatSession)> {
        let executable = self.runners.executable()?;
        let mut agents = self.agents.lock().await;
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        let system_prompt = input.native_locator["system_prompt"]
            .as_str()
            .map(str::to_owned);
        let settings = if resume_native {
            &input.native_locator["settings"]
        } else {
            &input.native_locator["initial_settings"]
        };
        let initial = AgentSettings {
            model: settings["model"].as_str().map(str::to_owned),
            effort: settings["effort"].as_str().map(str::to_owned),
            ..AgentSettings::default()
        };
        let homes = crate::homes::Homes::of_locator(&input.native_locator);
        let issued = self.store.hire_chat_session(who, input).await?;
        self.changed();
        let launched = self
            .runners
            .launch(
                &issued.session.native_session_id,
                &issued.session.workspace,
                mode,
                system_prompt.as_deref(),
                &initial,
                &homes,
            )
            .await;
        let link = match launched {
            Ok(link) => link,
            Err(error) => {
                self.owned_attention(who, &issued.session.id, &error).await;
                return Err(error);
            }
        };
        let bound = link
            .bind(
                &self.harness_url,
                &issued.token,
                &issued.session.id,
                &executable,
                resume_native,
            )
            .await;
        if bound.is_ok() {
            self.monitor_owned(&mut agents, link, &issued.session);
        }
        drop(agents);
        self.finish_owned_bind(who, issued, bound).await
    }

    async fn finish_owned_bind(
        &self,
        who: &ChatIdentity,
        issued: IssuedChatSession,
        result: Result<()>,
    ) -> Result<(Option<Actor>, ChatSession)> {
        let current = self.store.chat_session(who, &issued.session.id).await?;
        if current.stopped_at.is_some() {
            let _ = self.stop_session(&current.id).await;
            return Err(Error::StoppedByOwner.into());
        }
        if let Err(error) = result {
            self.owned_attention(who, &current.id, &error).await;
            return Err(error);
        }
        let _ = self.session_settings(who, &current.id).await;
        self.changed();
        Ok((issued.actor, current))
    }

    pub(super) async fn owned_attention(
        &self,
        who: &ChatIdentity,
        id: &str,
        error: &anyhow::Error,
    ) {
        let _ = self
            .store
            .set_chat_session_status(
                who,
                id,
                ChatSessionStatus {
                    status: "attention".into(),
                    reason: Some(connection_reason(error)),
                },
            )
            .await;
        self.changed();
    }

    pub(super) async fn owned_mode(
        &self,
        who: &ChatIdentity,
        id: &str,
    ) -> Result<Option<ClaudePermissionMode>> {
        let locator = self.store.chat_session_locator(who, id).await?;
        if locator["kind"] != "claude-runner" {
            return Ok(None);
        }
        Ok(Some(
            serde_json::from_value(locator["permission_mode"].clone())
                .context("The owned session has no saved permission mode")?,
        ))
    }

    pub(super) async fn reconnect_owned(
        &self,
        who: &ChatIdentity,
        session: &ChatSession,
        mode: ClaudePermissionMode,
    ) -> Result<()> {
        let mut agents = self.agents.lock().await;
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        let executable = self.runners.executable()?;
        // Rebind a surviving query; only a verified absence permits cold recovery.
        let Some(link) = self
            .runners
            .find(&session.native_session_id, &session.workspace, mode)
            .await?
        else {
            ensure!(
                !self.runners.is_leased(&session.native_session_id)?,
                "The Claude runner is still running"
            );
            self.runners
                .check_native_stopped(&session.native_session_id, &session.workspace)
                .await?;
            let mut locator = self.store.chat_session_locator(who, &session.id).await?;
            let mode = restored_mode(&mut locator, mode)?;
            drop(agents);
            return self.restore_claude(who, session, locator, mode).await;
        };
        // Authenticate the surviving host before pausing work or rotating its token.
        link.check_bind().await?;
        // Preparing this same runner intentionally pauses its transport. Its old monitor
        // must finish before that transition, without sending Stop to the native query.
        if let Some(previous) = agents.remove(&session.id) {
            previous.release().await;
        }
        if link.bound {
            link.prepare(&session.id).await?;
        }
        let issued = self
            .store
            .renew_owned_chat_session(who, &session.id)
            .await?;
        let bound = link
            .bind(
                &self.harness_url,
                &issued.token,
                &session.id,
                &executable,
                true,
            )
            .await;
        if bound.is_ok() {
            self.monitor_owned(&mut agents, link, session);
        }
        drop(agents);
        self.finish_owned_bind(who, issued, bound).await?;
        Ok(())
    }

    pub(super) async fn restore_claude_terminal(
        &self,
        who: &ChatIdentity,
        session: &ChatSession,
    ) -> Result<()> {
        let locator = self.store.chat_session_locator(who, &session.id).await?;
        let pid = locator["pid"]
            .as_i64()
            .and_then(|pid| i32::try_from(pid).ok())
            .context("The entrusted Claude terminal has no saved process ID")?;
        self.runners
            .check_terminal_stopped(&session.native_session_id, pid)
            .await?;
        let mode = crate::claude::ClaudeSession::saved_permission_mode(
            &session.native_session_id,
            &crate::homes::Homes::own(),
        )
        .await?;
        // Preserve the native resume mode. Missing/unsupported metadata never becomes
        // a default permission choice, and the terminal is never killed here.
        self.restore_claude(
            who,
            session,
            json!({"kind":"claude-runner","permission_mode":mode,"system_prompt":"claude_code"}),
            mode,
        )
        .await
    }

    async fn restore_claude(
        &self,
        who: &ChatIdentity,
        session: &ChatSession,
        locator: Value,
        mode: ClaudePermissionMode,
    ) -> Result<()> {
        let mut agents = self.agents.lock().await;
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        // Attempted deliveries retain their state. The owner's Stop wins in the transaction
        // that issues the new token.
        if let Some(previous) = agents.remove(&session.id) {
            previous.release().await;
        }
        drop(agents);
        let result = self
            .start_owned(
                who,
                HireChatSession {
                    name: String::new(),
                    actor_id: session.actor_id.clone(),
                    harness: Harness::ClaudeCode,
                    native_session_id: session.native_session_id.clone(),
                    title: session.title.clone(),
                    workspace: session.workspace.clone(),
                    native_locator: locator,
                    resume: true,
                },
                mode,
                true,
            )
            .await;
        if let Err(error) = &result {
            if matches!(error.downcast_ref::<Error>(), Some(Error::StoppedByOwner)) {
                return Ok(());
            }
            self.store
                .fail_chat_link(who, &session.id, &connection_reason(error))
                .await?;
            self.changed();
        }
        result.map(|_| ())
    }

    fn monitor_owned(
        &self,
        agents: &mut HashMap<String, AgentTask>,
        link: RunnerLink,
        session: &ChatSession,
    ) {
        let (stopper, mut stop) = watch::channel(false);
        let id = session.id.clone();
        let store = self.store.clone();
        let changed = self.changed.clone();
        let task = tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(5));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            tick.tick().await;
            let result = loop {
                tokio::select! {
                    stopped = stop.changed() => {
                        if stopped.is_err() { break Ok(()); }
                        if *stop.borrow() { break link.stop(&id).await; }
                    }
                    _ = tick.tick() => {
                        match link.describe().await {
                            Ok(description) if description["bound"] == true => {}
                            Ok(_) => break Err(anyhow::anyhow!("The Claude runner lost its connection")),
                            Err(error) => break Err(error),
                        }
                    }
                }
            };
            if let Err(error) = &result
                && !*stop.borrow()
                && let Ok(owner) = store.session_person(&id).await
            {
                tracing::warn!(
                    session_id = id,
                    error = format!("{error:#}"),
                    "Claude runner connection ended"
                );
                let _ = store
                    .set_chat_session_status(
                        &owner,
                        &id,
                        ChatSessionStatus {
                            status: "attention".into(),
                            reason: Some(connection_reason(error)),
                        },
                    )
                    .await;
                changed.notify_one();
            }
            result
        });
        agents.insert(
            session.id.clone(),
            AgentTask {
                stop: stopper,
                task,
                subscriber: None,
                stop_note: None,
                settings: None,
            },
        );
    }

    pub(super) async fn stop_untracked_owned(&self, id: &str) -> Result<bool> {
        let owner = self.store.session_person(id).await?;
        let Some(mode) = self.owned_mode(&owner, id).await? else {
            return Ok(false);
        };
        let session = self.store.chat_session(&owner, id).await?;
        if let Some(link) = self
            .runners
            .find(&session.native_session_id, &session.workspace, mode)
            .await?
        {
            link.stop(id).await?;
        } else {
            ensure!(
                !self.runners.is_leased(&session.native_session_id)?,
                "The owned runner's exit could not be confirmed"
            );
            self.runners
                .check_native_exit(&session.native_session_id, &session.workspace)?;
        }
        Ok(true)
    }
}

#[cfg(test)]
mod settings_tests {
    use super::*;

    #[test]
    fn cold_recovery_keeps_confirmed_mode_instead_of_launch_default() {
        let mut locator =
            json!({"permission_mode":"default","settings":{"permission_mode":"auto"}});
        let mode = restored_mode(&mut locator, ClaudePermissionMode::Default).unwrap();
        assert_eq!(mode.name(), "auto");
        assert_eq!(locator["permission_mode"], "auto");
        assert!(
            restored_mode(
                &mut json!({"settings":{"permission_mode":"future-mode"}}),
                mode
            )
            .is_err()
        );
    }

    #[test]
    fn recovery_without_confirmed_changes_keeps_the_original_explicit_mode() {
        let mut locator = json!({"permission_mode":"plan"});
        assert_eq!(
            restored_mode(&mut locator, ClaudePermissionMode::Plan)
                .unwrap()
                .name(),
            "plan"
        );
    }
}
