use super::*;
use crate::{
    claude_runner::RunnerLink,
    model::{AgentSettings, ClaudePermissionMode, CreateClaudeSession, IssuedChatSession},
};
use serde_json::json;

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
    ) -> Result<(Actor, ChatSession)> {
        if !who.is_owner() {
            return Err(Error::Forbidden.into());
        }
        let workspace = super::workspace_dir(&input.workspace)?;
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
        let started = self.start_owned(who, HireChatSession {
            name: input.name, actor_id: input.actor_id, harness: Harness::ClaudeCode,
            native_session_id: native_id, title: "Claude Code".into(),
            workspace,
            // Started by ZeroLux with Claude Code's own system prompt, as a terminal would.
            native_locator: json!({"kind":"claude-runner","permission_mode":mode,"system_prompt":"claude_code","initial_settings":initial}),
            resume: false,
        }, mode, false).await?;
        let native = self.agent_settings(who, &started.0.id).await?;
        Ok((native.actor, started.1))
    }

    pub async fn resume_claude(
        &self,
        who: &ChatIdentity,
        id: &str,
    ) -> Result<(Actor, ChatSession)> {
        if !who.is_owner() {
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
                actor_id: Some(session.actor_id),
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

    async fn start_owned(
        &self,
        who: &ChatIdentity,
        input: HireChatSession,
        mode: ClaudePermissionMode,
        resume_native: bool,
    ) -> Result<(Actor, ChatSession)> {
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
        let issued = self.store.hire_chat_session(who, input).await?;
        self.changed();
        // The mode this session runs with is the agent's setting from now on.
        self.store
            .set_agent_settings(
                who,
                &issued.actor.id,
                AgentSettings {
                    permission_mode: Some(mode.name().to_owned()),
                    ..AgentSettings::default()
                },
            )
            .await?;
        let launched = self
            .runners
            .launch(
                &issued.session.native_session_id,
                &issued.session.workspace,
                mode,
                system_prompt.as_deref(),
                &initial,
            )
            .await;
        let link = match launched {
            Ok(link) => link,
            Err(error) => {
                self.owned_attention(who, &issued.session.id).await;
                return Err(error);
            }
        };
        let bound = link
            .bind(
                &self.base_url,
                &issued.token,
                &issued.session.id,
                &executable,
                resume_native,
            )
            .await;
        self.monitor_owned(&mut agents, link, &issued.session);
        drop(agents);
        self.finish_owned_bind(who, issued, bound).await
    }

    async fn finish_owned_bind(
        &self,
        who: &ChatIdentity,
        issued: IssuedChatSession,
        result: Result<()>,
    ) -> Result<(Actor, ChatSession)> {
        let current = self.store.chat_session(who, &issued.session.id).await?;
        if current.stopped_at.is_some() {
            let _ = self.stop_session(&current.id).await;
            return Err(Error::StoppedByOwner.into());
        }
        if let Err(error) = result {
            self.owned_attention(who, &current.id).await;
            return Err(error);
        }
        self.changed();
        Ok((
            self.store.settings_actor(who, &issued.actor.id).await?,
            current,
        ))
    }

    async fn owned_attention(&self, who: &ChatIdentity, id: &str) {
        let _ = self
            .store
            .set_chat_session_status(
                who,
                id,
                ChatSessionStatus {
                    status: "attention".into(),
                    reason: Some(
                        "The owned runner needs attention. No attempted input was resent.".into(),
                    ),
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
                "The owned runner is still leased; no replacement was started"
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
        if link.bound {
            link.prepare(&session.id).await?;
        }
        let issued = self
            .store
            .renew_owned_chat_session(who, &session.id)
            .await?;
        let bound = link
            .bind(
                &self.base_url,
                &issued.token,
                &session.id,
                &executable,
                true,
            )
            .await;
        if let Some(previous) = agents.remove(&session.id) {
            previous.release().await;
        }
        self.monitor_owned(&mut agents, link, session);
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
        let mode =
            crate::claude::ClaudeSession::saved_permission_mode(&session.native_session_id).await?;
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
        // Dead callbacks are settled; attempted deliveries retain their state. Stop wins
        // both here and in the transaction that issues the successor link.
        if self
            .store
            .stop_chat_session_marked(who, &session.id, crate::chat::RELINKING)
            .await?
        {
            return Ok(());
        }
        if let Some(previous) = agents.remove(&session.id) {
            previous.release().await;
        }
        drop(agents);
        let result = self
            .start_owned(
                who,
                HireChatSession {
                    name: String::new(),
                    actor_id: Some(session.actor_id.clone()),
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
            self.store.revive_chat_session(who, &session.harness, &session.native_session_id,
                &format!("The native session could not be restored ({error}); no attempted input was resent.")).await?;
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
                        if let Err(error) = link.describe().await { break Err(error); }
                    }
                }
            };
            if result.is_err()
                && !*stop.borrow()
                && let Ok(owner) = store.chat_identity(None).await
            {
                let _ = store.set_chat_session_status(&owner, &id, ChatSessionStatus {
                    status: "attention".into(), reason: Some("The Claude runner ended or became unreachable. Waiting to restore the saved session.".into()),
                }).await;
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
        let owner = self.store.chat_identity(None).await?;
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
