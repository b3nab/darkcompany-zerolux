use super::*;
use crate::{
    claude_runner::RunnerLink,
    model::{ClaudePermissionMode, CreateClaudeSession, IssuedChatSession},
};
use serde_json::json;

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
        self.start_owned(who, HireChatSession {
            name: input.name, actor_id: input.actor_id, harness: Harness::ClaudeCode,
            native_session_id: native_id, title: "Claude Code".into(),
            workspace,
            native_locator: json!({"kind":"claude-runner","permission_mode":input.permission_mode}),
            resume: false,
        }, input.permission_mode).await
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
            .check_native_stopped(&session.native_session_id)
            .await?;
        if session.stopped_at.is_none() {
            self.store.stop_chat_session(who, id).await?;
        }
        let locator = self.store.chat_session_locator(who, id).await?;
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
        )
        .await
    }

    async fn start_owned(
        &self,
        who: &ChatIdentity,
        input: HireChatSession,
        mode: ClaudePermissionMode,
    ) -> Result<(Actor, ChatSession)> {
        let executable = self.runners.executable()?;
        let mut agents = self.agents.lock().await;
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        let issued = self.store.hire_chat_session(who, input).await?;
        self.changed();
        let launched = self
            .runners
            .launch(
                &issued.session.native_session_id,
                &issued.session.workspace,
                mode,
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
        Ok((issued.actor, current))
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
        // A dead runner needs explicit Resume. Reconnect never starts another process.
        let Some(link) = self
            .runners
            .find(&session.native_session_id, &session.workspace, mode)
            .await?
        else {
            return Ok(());
        };
        if link.bound {
            link.prepare(&session.id).await?;
        }
        let issued = self
            .store
            .renew_owned_chat_session(who, &session.id)
            .await?;
        let bound = link
            .bind(&self.base_url, &issued.token, &session.id, &executable)
            .await;
        if let Some(previous) = agents.remove(&session.id) {
            previous.release().await;
        }
        self.monitor_owned(&mut agents, link, session);
        drop(agents);
        self.finish_owned_bind(who, issued, bound).await?;
        Ok(())
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
                    status: "attention".into(), reason: Some("The owned Claude runner ended or became unreachable. Use Resume after checking its work.".into()),
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
        }
        Ok(true)
    }
}
