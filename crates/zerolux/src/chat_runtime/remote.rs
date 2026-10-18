//! Sessions on a person's computer joined to the workspace: the kernel keeps their records
//! and asks the computer, over its channel, to start, continue, stop and control them.
use super::*;
use serde_json::json;

/// A Codex session's controls: on this kernel's host, or on the joined computer it runs on.
#[derive(Clone)]
pub(crate) enum CodexControl {
    Here(crate::codex_settings::CodexSettings),
    There {
        hosts: Arc<crate::host_link::Links>,
        host: String,
        session: String,
    },
}

impl CodexControl {
    async fn ask(&self, request: Value) -> Result<Value> {
        match self {
            Self::Here(control) => control.request(&request).await,
            Self::There {
                hosts,
                host,
                session,
            } => {
                hosts
                    .call(
                        host,
                        "codex.control",
                        json!({"session_id": session, "request": request}),
                    )
                    .await
            }
        }
    }

    pub fn values(&self) -> AgentSettings {
        match self {
            Self::Here(control) => control.values(),
            Self::There { .. } => AgentSettings::default(),
        }
    }

    pub async fn input(
        &self,
        text: &str,
        mode: crate::model::InputMode,
        images: &[String],
    ) -> Result<()> {
        match self {
            Self::Here(control) => control.input(text, mode, images).await,
            Self::There { .. } => {
                ensure!(
                    images.is_empty(),
                    "Images reach sessions on this kernel's computer only"
                );
                self.ask(json!({"method": "input", "text": text, "mode": mode}))
                    .await
                    .map(drop)
            }
        }
    }

    pub async fn commands(&self) -> Result<Vec<crate::model::SessionCommand>> {
        match self {
            Self::Here(control) => control.commands().await,
            Self::There { .. } => Ok(serde_json::from_value(
                self.ask(json!({"method": "commands"})).await?["commands"].clone(),
            )?),
        }
    }

    pub async fn unqueue(&self, item: &str) -> Result<()> {
        self.ask(json!({"method": "unqueue", "item": item}))
            .await
            .map(drop)
    }

    pub async fn requeue(&self, item: &str, text: &str) -> Result<()> {
        self.ask(json!({"method": "requeue", "item": item, "text": text}))
            .await
            .map(drop)
    }

    pub async fn goal(&self) -> Result<Option<crate::live::Goal>> {
        Ok(serde_json::from_value(
            self.ask(json!({"method": "goal"})).await?["goal"].clone(),
        )?)
    }

    pub async fn set_goal(
        &self,
        objective: Option<&str>,
        status: Option<&str>,
        token_budget: Option<i64>,
    ) -> Result<crate::live::Goal> {
        Ok(serde_json::from_value(
            self.ask(
                json!({"method": "set_goal", "objective": objective, "status": status,
                "token_budget": token_budget}),
            )
            .await?["goal"]
                .clone(),
        )?)
    }

    pub async fn clear_goal(&self) -> Result<()> {
        self.ask(json!({"method": "clear_goal"})).await.map(drop)
    }

    pub async fn interrupt(&self) -> Result<bool> {
        Ok(self.ask(json!({"method": "interrupt"})).await?["interrupted"] == true)
    }

    pub async fn compact(&self) -> Result<()> {
        self.ask(json!({"method": "compact"})).await.map(drop)
    }

    pub async fn read(&self) -> Result<crate::agent_settings::NativeSettings> {
        match self {
            Self::Here(control) => control.read().await,
            Self::There { .. } => {
                bail!("The settings of a session on a joined computer are changed there")
            }
        }
    }

    pub async fn apply(
        &self,
        patch: &AgentSettings,
        check: bool,
    ) -> Result<crate::agent_settings::NativeSettings> {
        match self {
            Self::Here(control) => control.apply(patch, check).await,
            Self::There { .. } => {
                bail!("The settings of a session on a joined computer are changed there")
            }
        }
    }
}

impl ChatRuntime {
    /// Whether a session runs on a joined computer: its host, then.
    pub(super) fn remote_host(&self, session: &ChatSession) -> Option<String> {
        session
            .host_id
            .clone()
            .filter(|host| Some(host.as_str()) != self.store.host())
    }

    /// A new Codex session on one of `who`'s joined computers: the computer starts the thread,
    /// the kernel issues its token, and the computer runs its adapter with it.
    pub async fn create_codex_on(
        &self,
        who: &ChatIdentity,
        input: CreateCodexSession,
        host: &str,
    ) -> Result<(Option<Actor>, ChatSession)> {
        if !who.is_person() {
            return Err(Error::Forbidden.into());
        }
        ensure!(
            self.store.host_person(host).await? == who.actor_id,
            Error::Forbidden
        );
        ensure!(
            input.worktree.is_none(),
            "A joined computer starts sessions in a folder of its own, without a worktree"
        );
        self.store
            .check_hire(who, Harness::Codex, input.actor_id.as_deref(), &input.name)
            .await?;
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        let settings = json!({"model": input.model, "effort": input.effort,
            "approval_policy": input.approval_policy, "sandbox": input.sandbox});
        let started = self
            .hosts
            .call(
                host,
                "codex.start",
                json!({"workspace": input.workspace, "settings": settings}),
            )
            .await?;
        let thread = started["thread_id"]
            .as_str()
            .context("The computer did not name the thread")?
            .to_owned();
        let issued = self
            .store
            .hire_chat_session(
                who,
                HireChatSession {
                    name: input.name,
                    actor_id: input.actor_id,
                    harness: Harness::Codex,
                    native_session_id: thread.clone(),
                    title: "Codex".into(),
                    workspace: started["cwd"]
                        .as_str()
                        .unwrap_or(&input.workspace)
                        .to_owned(),
                    native_locator: json!({"endpoint": started["endpoint"]}),
                    resume: false,
                },
            )
            .await
            .context(CodexStartFailure::Unlinked {
                thread_id: thread.clone(),
            })?;
        self.store.place_session(&issued.session.id, host).await?;
        self.changed();
        let bound = self
            .hosts
            .call(
                host,
                "codex.bind",
                json!({"pending": started["pending"], "session_id": issued.session.id,
                    "token": issued.token}),
            )
            .await;
        if let Err(error) = bound {
            self.store
                .fail_chat_link(who, &issued.session.id, crate::chat::LINK_FAILED)
                .await?;
            self.changed();
            return Err(error);
        }
        let session = self.store.chat_session(who, &issued.session.id).await?;
        Ok((issued.actor, session))
    }

    /// The Codex sessions of a joined computer that has just connected, continued there with a
    /// new token each: the kernel or the computer may have restarted meanwhile.
    pub async fn relink_host(&self, host: &str) -> Result<()> {
        for session in self.store.all_sessions().await? {
            if session.host_id.as_deref() != Some(host)
                || session.stopped_at.is_some()
                || session.harness != "codex"
            {
                continue;
            }
            let owner = ChatIdentity::person(&session.owner_id);
            if let Err(error) = self.continue_on(host, &session, true).await {
                tracing::warn!(
                    session_id = session.id,
                    error = format!("{error:#}"),
                    "A joined computer's session was not continued"
                );
                let _ = self
                    .store
                    .fail_chat_link(&owner, &session.id, crate::chat::LINK_FAILED)
                    .await;
            }
            self.changed();
        }
        Ok(())
    }

    /// A Codex session on a joined computer, continued there with a new token: after a break,
    /// or at its person's Resume.
    pub(super) async fn continue_on(
        &self,
        host: &str,
        session: &ChatSession,
        relink: bool,
    ) -> Result<(Option<Actor>, ChatSession)> {
        let owner = ChatIdentity::person(&session.owner_id);
        let resumed = self
            .hosts
            .call(
                host,
                "codex.resume",
                json!({"thread_id": session.native_session_id, "workspace": session.workspace}),
            )
            .await?;
        // What the computer was running for it before ends: the new token replaces it.
        self.hosts
            .call(host, "codex.stop", json!({"session_id": session.id}))
            .await?;
        let issued = self
            .store
            .hire_chat_session(
                &owner,
                HireChatSession {
                    name: String::new(),
                    actor_id: session.actor_id.clone(),
                    harness: Harness::Codex,
                    native_session_id: session.native_session_id.clone(),
                    title: session.title.clone(),
                    workspace: session.workspace.clone(),
                    native_locator: json!({"endpoint": resumed["endpoint"]}),
                    resume: relink,
                },
            )
            .await?;
        self.store.place_session(&issued.session.id, host).await?;
        self.changed();
        self.hosts
            .call(
                host,
                "codex.bind",
                json!({"pending": resumed["pending"], "session_id": issued.session.id,
                    "token": issued.token}),
            )
            .await?;
        let session = self.store.chat_session(&owner, &issued.session.id).await?;
        Ok((issued.actor, session))
    }
}
