//! In-process lifecycle for the concrete native session adapters and LiveKit.

use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use serde_json::Value;
use tokio::{
    sync::{Mutex, Notify, broadcast, mpsc, watch},
    task::JoinHandle,
};

use crate::{
    codex::{CodexDriver, CodexStartFailure},
    harness::Harness,
    livekit::{ClientToken, LiveKit},
    model::{
        Actor, ChatIdentity, ChatSession, ChatSessionStatus, CreateCodexSession, HireChatSession,
    },
    sessions,
    store::{Error, Store},
};

/// Pairing failed after the owner had already stopped the session it was for.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct StoppedByOwner(#[source] anyhow::Error);

struct AgentTask {
    stop: watch::Sender<bool>,
    task: JoinHandle<Result<()>>,
    subscriber: Option<JoinHandle<Result<()>>>,
    stop_note: Option<&'static str>,
}

impl AgentTask {
    /// Drops the kernel side without cancelling native work. The subscriber is asked to stop,
    /// never aborted: an aborted subscriber leaves its LiveKit room open, and every open room
    /// keeps the sockets of a WebRTC peer until the kernel runs out of file descriptors.
    async fn release(mut self) {
        self.task.abort();
        let _ = (&mut self.task).await;
        self.stop.send_replace(true);
        if let Some(mut subscriber) = self.subscriber.take() {
            let _ = finish(&mut subscriber).await;
        }
    }
}

/// The folder a session started by ZeroLux works in: absolute, existing, canonical.
pub(crate) fn workspace_dir(path: &str) -> Result<String> {
    if !PathBuf::from(path).is_absolute() {
        return Err(Error::Invalid("Choose an absolute workspace path".into()).into());
    }
    let workspace = std::fs::canonicalize(path)
        .map_err(|_| Error::Invalid("Workspace does not exist".into()))?;
    if !workspace.is_dir() {
        return Err(Error::Invalid("Workspace must be a directory".into()).into());
    }
    Ok(workspace.to_string_lossy().into_owned())
}

enum NativeDriver {
    Codex(Box<CodexDriver>),
    #[cfg(unix)]
    Claude(crate::claude::ClaudeSession),
}

impl NativeDriver {
    async fn run(
        self,
        base_url: String,
        links: PathBuf,
        session_id: String,
        token: String,
        invalidations: mpsc::Receiver<()>,
        stop: watch::Receiver<bool>,
    ) -> Result<()> {
        match self {
            Self::Codex(driver) => {
                driver
                    .run(base_url, links, session_id, token, invalidations, stop)
                    .await
            }
            #[cfg(unix)]
            Self::Claude(driver) => {
                driver
                    .run(base_url, links, session_id, token, invalidations, stop)
                    .await
            }
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PiStartFailure {
    #[error(
        "Pi creation was not confirmed. Inspect native sessions before starting another; no creation was retried."
    )]
    Uncertain,
    #[error(
        "Pi prepared session {native_session_id}, but ZeroLux could not link it. Its identity was retained; no replacement was created."
    )]
    Unlinked { native_session_id: String },
}

pub struct ChatRuntime {
    store: Store,
    livekit: Arc<LiveKit>,
    base_url: String,
    links: PathBuf,
    #[cfg(unix)]
    runners: crate::claude_runner::Registry,
    #[cfg(unix)]
    pi_runners: crate::pi_runner::Registry,
    changed: Arc<Notify>,
    /// Wakes the adapters that run inside this process: they share the store, so a notice
    /// written to the outbox reaches them here, without LiveKit, sockets or tokens.
    wake: broadcast::Sender<()>,
    stop: watch::Sender<bool>,
    agents: Mutex<HashMap<String, AgentTask>>,
    publisher: Mutex<Option<JoinHandle<()>>>,
}

impl ChatRuntime {
    pub async fn start(
        store: Store,
        livekit: Arc<LiveKit>,
        base_url: String,
        links: PathBuf,
    ) -> Result<Arc<Self>> {
        Self::start_inner(
            store,
            livekit,
            base_url,
            links,
            #[cfg(unix)]
            None,
        )
        .await
    }

    #[cfg(unix)]
    pub async fn start_with_runner(
        store: Store,
        livekit: Arc<LiveKit>,
        base_url: String,
        links: PathBuf,
        program: crate::claude_runner::RunnerProgram,
    ) -> Result<Arc<Self>> {
        Self::start_inner(store, livekit, base_url, links, Some(program)).await
    }

    async fn start_inner(
        store: Store,
        livekit: Arc<LiveKit>,
        base_url: String,
        links: PathBuf,
        #[cfg(unix)] program: Option<crate::claude_runner::RunnerProgram>,
    ) -> Result<Arc<Self>> {
        store.recover_chat_sessions().await?;
        let (stop, stopped) = watch::channel(false);
        let changed = Arc::new(Notify::new());
        let (wake, _) = broadcast::channel(16);
        let publisher = tokio::spawn(crate::livekit::run_publisher(
            store.clone(),
            livekit.clone(),
            changed.clone(),
            wake.clone(),
            stopped,
        ));
        #[cfg(unix)]
        let program = program.unwrap_or_default();
        Ok(Arc::new(Self {
            store,
            livekit,
            base_url,
            #[cfg(unix)]
            runners: crate::claude_runner::Registry::new(links.join("claude"), program.clone()),
            #[cfg(unix)]
            pi_runners: crate::pi_runner::Registry::new(links.join("pi"), program),
            links,
            changed,
            wake,
            stop,
            agents: Mutex::new(HashMap::new()),
            publisher: Mutex::new(Some(publisher)),
        }))
    }

    pub fn changed(&self) {
        // The in-process adapters first, directly: a publisher stuck on LiveKit must not
        // delay them. Then the publisher, for the clients outside.
        let _ = self.wake.send(());
        self.changed.notify_one();
    }

    pub fn client_token(&self, actor_id: &str) -> Result<ClientToken> {
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        self.livekit.client_token(actor_id)
    }

    pub async fn discover(&self) -> Result<Value> {
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        Ok(serde_json::to_value(sessions::discover_sessions().await)?)
    }

    pub async fn hire(
        &self,
        who: &ChatIdentity,
        discovered_session_id: &str,
        name: &str,
        actor_id: Option<String>,
    ) -> Result<(Actor, ChatSession)> {
        if !who.is_owner() {
            return Err(Error::Forbidden.into());
        }
        if discovered_session_id.len() != 64
            || !discovered_session_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(Error::Invalid("Invalid discovered session ID".into()).into());
        }
        let target = sessions::resolve_session(discovered_session_id).await?;
        self.link(who, target, name, actor_id, false).await
    }

    async fn link(
        &self,
        who: &ChatIdentity,
        target: sessions::NativeSessionTarget,
        name: &str,
        actor_id: Option<String>,
        resume: bool,
    ) -> Result<(Actor, ChatSession)> {
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        // Verify native identity before creating a link. No prompt is submitted.
        let driver = match target.harness {
            Harness::Codex => {
                let endpoint = target.native_locator["endpoint"]
                    .as_str()
                    .context("The Codex discovery target has no endpoint")?;
                // A first hire joins a live thread only; a relink continues the session
                // ZeroLux held, loading it again under the same identity if the runtime lost it.
                let driver = if resume {
                    let store = self.store.clone();
                    let wanted_for = target.native_session_id.clone();
                    CodexDriver::resume(
                        endpoint,
                        &target.native_session_id,
                        &target.workspace,
                        || async move { Ok(store.relink_wanted("codex", &wanted_for).await?) },
                    )
                    .await?
                } else {
                    CodexDriver::attach(endpoint, &target.native_session_id).await?
                };
                Some(NativeDriver::Codex(Box::new(driver)))
            }
            Harness::ClaudeCode => {
                #[cfg(unix)]
                {
                    Some(NativeDriver::Claude(
                        crate::claude::ClaudeSession::attach(
                            &target.native_session_id,
                            &target.workspace,
                        )
                        .await?,
                    ))
                }
                #[cfg(not(unix))]
                {
                    bail!("Claude Code native inbox attachment is unavailable on this platform");
                }
            }
            Harness::Pi => None,
        };
        self.bind(who, target, name, actor_id, resume, driver).await
    }

    /// Issues the link for a verified native session and pairs it: a native driver already
    /// attached, or pi's own extension.
    async fn bind(
        &self,
        who: &ChatIdentity,
        target: sessions::NativeSessionTarget,
        name: &str,
        actor_id: Option<String>,
        resume: bool,
        driver: Option<NativeDriver>,
    ) -> Result<(Actor, ChatSession)> {
        let issued = match self
            .store
            .hire_chat_session(
                who,
                HireChatSession {
                    name: name.into(),
                    actor_id,
                    harness: target.harness,
                    native_session_id: target.native_session_id.clone(),
                    title: target.title.clone(),
                    workspace: target.workspace.clone(),
                    native_locator: target.native_locator.clone(),
                    resume,
                },
            )
            .await
        {
            Ok(issued) => issued,
            Err(Error::StoppedByOwner) => {
                return Err(StoppedByOwner(Error::StoppedByOwner.into()).into());
            }
            Err(error) => return Err(error.into()),
        };
        self.changed();
        let paired = if let Some(driver) = driver {
            self.connect_native(driver, &issued.session, issued.token)
                .await
        } else {
            self.connect_pi(&target, &issued.session, issued.token, resume)
                .await
        };
        if let Err(error) = paired {
            // Pairing may have reached the external extension even if its ACK
            // was lost. Revoke the issued token; never retry native handoff.
            if self
                .store
                .stop_chat_session_marked(who, &issued.session.id, crate::chat::LINK_FAILED)
                .await?
            {
                // The owner pressed Stop while pairing was pending: their decision stands.
                return Err(StoppedByOwner(error).into());
            }
            self.changed();
            return Err(error);
        }
        // As it is now: the owner may have stopped it while it was pairing.
        let session = self.store.chat_session(who, &issued.session.id).await?;
        Ok((issued.actor, session))
    }

    /// A new Codex session in a folder, as a new agent or another session of an existing one.
    /// Everything is checked before the one `thread/start`; no prompt is submitted. A thread
    /// Codex created but ZeroLux could not link is reported by ID, never discarded or started
    /// again: it is live in Codex and can be hired from discovery. An unanswered start is
    /// reported as uncertain.
    pub async fn create_codex(
        &self,
        who: &ChatIdentity,
        input: CreateCodexSession,
    ) -> Result<(Actor, ChatSession)> {
        if !who.is_owner() {
            return Err(Error::Forbidden.into());
        }
        let workspace = workspace_dir(&input.workspace)?;
        self.store
            .check_hire(who, Harness::Codex, input.actor_id.as_deref(), &input.name)
            .await?;
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        let endpoint = sessions::ensure_codex_daemon().await?;
        let driver =
            CodexDriver::start(&endpoint, &workspace, input.approval_policy, input.sandbox).await?;
        let thread_id = driver.thread_id().to_owned();
        let target = sessions::NativeSessionTarget {
            harness: Harness::Codex,
            native_session_id: thread_id.clone(),
            title: "Codex".into(),
            workspace,
            native_locator: serde_json::json!({"endpoint": endpoint}),
        };
        self.bind(
            who,
            target,
            &input.name,
            input.actor_id,
            false,
            Some(NativeDriver::Codex(Box::new(driver))),
        )
        .await
        .context(CodexStartFailure::Unlinked { thread_id })
    }

    #[cfg(unix)]
    pub async fn create_pi(
        &self,
        who: &ChatIdentity,
        input: crate::model::CreatePiSession,
    ) -> Result<(Actor, ChatSession)> {
        if !who.is_owner() {
            return Err(Error::Forbidden.into());
        }
        let workspace = workspace_dir(&input.workspace)?;
        self.store
            .check_hire(who, Harness::Pi, input.actor_id.as_deref(), &input.name)
            .await?;
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        let host = self
            .pi_runners
            .create(&workspace)
            .await
            .context(PiStartFailure::Uncertain)?;
        let native_session_id = host.native_id().to_owned();
        let result = async {
            let target = host.target().await?;
            self.link(who, target, &input.name, input.actor_id, false)
                .await
        }
        .await;
        // A failed response is not permission to start another identity or kill native work.
        if result.is_err() {
            host.discard_unstarted().await;
        }
        result.context(PiStartFailure::Unlinked { native_session_id })
    }

    #[cfg(unix)]
    pub async fn resume_pi(&self, who: &ChatIdentity, id: &str) -> Result<(Actor, ChatSession)> {
        if !who.is_owner() {
            return Err(Error::Forbidden.into());
        }
        let session = self.store.chat_session(who, id).await?;
        ensure!(session.harness == "pi", "This is not a pi session");
        ensure!(
            session.stopped_at.is_some() || session.status == "attention",
            "Stop the running session before resuming it"
        );
        self.store
            .check_hire(who, Harness::Pi, Some(&session.actor_id), "")
            .await?;
        let live = sessions::resolve_linked("pi", &session.native_session_id).await;
        let target = self.pi_target(who, &session, live).await?;
        let reconnect = session.stopped_at.is_none();
        if reconnect
            && self
                .store
                .stop_chat_session_marked(who, id, crate::chat::RELINKING)
                .await?
        {
            return Err(Error::StoppedByOwner.into());
        }
        if let Some(previous) = self.agents.lock().await.remove(id) {
            previous.release().await;
        }
        // Explicit Resume after an owner's Stop transfers only never-attempted deliveries.
        self.bind(who, target, "", Some(session.actor_id), reconnect, None)
            .await
    }

    /// Cooperative handover: native pi closes its idle terminal. Ordinary recovery owns
    /// the later launch and still requires proof of native death; this request starts none.
    #[cfg(unix)]
    pub async fn takeover_pi(&self, who: &ChatIdentity, id: &str) -> Result<ChatSession> {
        if !who.is_owner() {
            return Err(Error::Forbidden.into());
        }
        let session = self.store.chat_session(who, id).await?;
        if session.harness != "pi" || session.stopped_at.is_some() {
            return Err(
                Error::Invalid("Takeover requires a live terminal pi session".into()).into(),
            );
        }
        self.store
            .check_hire(who, Harness::Pi, Some(&session.actor_id), "")
            .await?;
        let live = sessions::resolve_linked("pi", &session.native_session_id)
            .await
            .context("The terminal pi is unavailable; no native process was closed or started")?;
        let target = self.pi_target(who, &session, Some(live)).await?;
        let path = target.native_locator["descriptor"]
            .as_str()
            .context("Missing native pi control")?;
        let record = sessions::descriptor(std::path::Path::new(path)).await?;
        ensure!(
            record.native_session_id == session.native_session_id
                && record.workspace == session.workspace,
            "Native pi control changed"
        );
        let state = sessions::control(&record, serde_json::json!({"method":"describe"})).await?;
        ensure!(
            state["instance_id"] == record.instance_id && state["takeover"] == 1,
            "This native pi does not support terminal takeover; update its extension first"
        );
        let workspace = self.store.workspace_info().await?;
        let mut request = serde_json::json!({"method":"takeover", "check":true,
            "session_id":id, "workspace_id":workspace.id,
            "native_session_id":session.native_session_id, "workspace":session.workspace,
            "session_file":target.native_locator["session_file"]});
        if sessions::control(&record, request.clone()).await?["accepted"] != true {
            return Err(Error::Invalid("Let terminal pi finish its work, queue, drafts and dialogs. Its saved history and launch profile must be verifiable and no other workspace may be linked.".into()).into());
        }
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        // Durable recovery intent precedes shutdown. Owner Stop wins this write and the
        // extension's final authenticated inbox check. No token or input is replayed.
        self.store.set_chat_session_status(who, id, ChatSessionStatus {
            status: "attention".into(),
            reason: Some("Moving this idle terminal pi under ZeroLux; recovery waits for its native process to exit.".into()),
        }).await?;
        self.changed();
        request["check"] = serde_json::json!(false);
        let outcome = sessions::control(&record, request).await.context(
            "Pi takeover was not confirmed; inspect the session before repeating it. No native closure was retried.")?;
        if outcome["accepted"] != true {
            return Err(Error::Invalid(
                "The terminal could not confirm an idle takeover; no shutdown was retried.".into(),
            )
            .into());
        }
        self.store.chat_session(who, id).await.map_err(Into::into)
    }

    #[cfg(unix)]
    async fn pi_target(
        &self,
        who: &ChatIdentity,
        session: &ChatSession,
        live: Option<sessions::NativeSessionTarget>,
    ) -> Result<sessions::NativeSessionTarget> {
        let saved = self.store.chat_session_locator(who, &session.id).await?;
        let target = if let Some(target) = live {
            target
        } else {
            let locator = crate::pi_runner::recovery_locator(
                &session.native_session_id,
                &session.workspace,
                saved.clone(),
            )
            .await?;
            sessions::NativeSessionTarget {
                harness: Harness::Pi,
                native_session_id: session.native_session_id.clone(),
                title: session.title.clone(),
                workspace: session.workspace.clone(),
                native_locator: locator,
            }
        };
        ensure!(
            target.workspace == session.workspace,
            "The entrusted pi workspace changed; no other folder was selected"
        );
        if let Some(file) = saved["session_file"].as_str() {
            ensure!(
                target.native_locator["session_file"].as_str() == Some(file),
                "The entrusted pi history locator changed; no other file was selected"
            );
        }
        Ok(target)
    }

    /// Relinks every session whose link was lost, by a kernel restart or on the native side,
    /// and that is still live. Tokens are never persisted, so each link is reissued. No prompt
    /// is submitted and nothing is resent.
    pub async fn reconnect(&self) -> Result<()> {
        let owner = self.store.chat_identity(None).await?;
        let linked = self.store.chat_sessions(&owner).await?;
        for session in linked
            .into_iter()
            .filter(|s| s.stopped_at.is_none() && s.status == "attention")
        {
            #[cfg(unix)]
            if let Some(mode) = self.owned_mode(&owner, &session.id).await? {
                if let Err(error) = self.reconnect_owned(&owner, &session, mode).await {
                    tracing::warn!(
                        session_id = session.id,
                        error = format!("{error:#}"),
                        "Owned runner was not rebound"
                    );
                }
                continue;
            }
            let target = match sessions::resolve_linked(
                &session.harness,
                &session.native_session_id,
            )
            .await
            {
                #[cfg(unix)]
                target if session.harness == "pi" => {
                    match self.pi_target(&owner, &session, target).await {
                        Ok(target) => target,
                        Err(error) => {
                            tracing::warn!(session_id=session.id, error=%error, "Pi continuity metadata unavailable; no native process started");
                            continue;
                        }
                    }
                }
                Some(target) => target,
                // Codex keeps its threads: one the runtime no longer holds is still this
                // session, continued through Codex's own daemon. Other harnesses wait for a
                // live process.
                None if session.harness == "codex" => {
                    let endpoint = match sessions::ensure_codex_daemon().await {
                        Ok(endpoint) => endpoint,
                        Err(error) => {
                            tracing::warn!(
                                session_id = session.id,
                                error = format!("{error:#}"),
                                "Codex daemon unavailable; the session waits"
                            );
                            continue;
                        }
                    };
                    sessions::NativeSessionTarget {
                        harness: Harness::Codex,
                        native_session_id: session.native_session_id.clone(),
                        title: session.title.clone(),
                        workspace: session.workspace.clone(),
                        native_locator: serde_json::json!({"endpoint": endpoint}),
                    }
                }
                None => continue,
            };
            if let Some(lost) = self.agents.lock().await.remove(&session.id) {
                lost.release().await;
            }
            if self
                .store
                .stop_chat_session_marked(&owner, &session.id, crate::chat::RELINKING)
                .await?
            {
                continue;
            }
            match self
                .link(&owner, target, "", Some(session.actor_id), true)
                .await
            {
                // The owner stopped the relinking session while it was pairing: torn down.
                Ok((_, relinked)) if relinked.stopped_at.is_some() => {
                    let _ = self.stop_session(&relinked.id).await;
                }
                Ok(_) => {}
                Err(error) => {
                    if error.downcast_ref::<StoppedByOwner>().is_some() {
                        tracing::info!(
                            session_id = session.id,
                            "Relink abandoned: the owner stopped the session"
                        );
                        continue;
                    }
                    tracing::warn!(
                        session_id = session.id,
                        error = format!("{error:#}"),
                        "Session was not relinked; retrying"
                    );
                    // A busy or restarting harness is not a reason to lose the agent: the next
                    // pass tries again from whichever session of that context is the latest.
                    self.store
                        .revive_chat_session(
                            &owner,
                            &session.harness,
                            &session.native_session_id,
                            &format!("The link could not be restored ({error}); retrying."),
                        )
                        .await?;
                    self.changed();
                }
            }
        }
        Ok(())
    }

    /// Called only after discovery verified the target and the owner hired it.
    /// The driver receives its token privately and cannot read its inbox until
    /// the LiveKit subscription has produced the first invalidation.
    pub async fn connect_codex(
        &self,
        driver: CodexDriver,
        session: &ChatSession,
        token: String,
    ) -> Result<()> {
        self.connect_native(NativeDriver::Codex(Box::new(driver)), session, token)
            .await
    }

    async fn connect_native(
        &self,
        driver: NativeDriver,
        session: &ChatSession,
        token: String,
    ) -> Result<()> {
        let mut agents = self.agents.lock().await;
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        match &driver {
            NativeDriver::Codex(driver) => {
                ensure!(
                    session.harness == "codex" && driver.thread_id() == session.native_session_id,
                    "The native driver does not match the hired session"
                );
                let native_cwd = driver.settings()["cwd"]
                    .as_str()
                    .context("Codex did not report its workspace")?;
                ensure!(
                    std::fs::canonicalize(native_cwd)?
                        == std::fs::canonicalize(&session.workspace)?,
                    "The Codex workspace changed before pairing"
                );
            }
            #[cfg(unix)]
            NativeDriver::Claude(driver) => {
                ensure!(
                    session.harness == "claude-code"
                        && driver.session_id() == session.native_session_id,
                    "The native driver does not match the hired session"
                );
            }
        }
        ensure!(
            !agents.contains_key(&session.id),
            "This session already has a native driver"
        );
        let identity = self.store.chat_identity(Some(&token)).await?;
        ensure!(
            identity.session_id.as_deref() == Some(&session.id)
                && identity.actor_id == session.actor_id,
            "The adapter token does not match the hired session"
        );
        let (stopper, mut stop) = watch::channel(false);
        let (invalidate, mut invalidations) = mpsc::channel(1);
        // In-process: woken from the outbox directly. The first signal says "ready", like a
        // joined subscription would; a lagged receiver just re-reads its inbox.
        let mut woken = self.wake.subscribe();
        let mut stopping = stop.clone();
        let subscriber = tokio::spawn(async move {
            let _ = invalidate.try_send(());
            loop {
                tokio::select! {
                    received = woken.recv() => match received {
                        Ok(()) | Err(broadcast::error::RecvError::Lagged(_)) => {
                            let _ = invalidate.try_send(());
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    },
                    _ = stopping.wait_for(|stopped| *stopped) => break,
                }
            }
            Ok::<(), anyhow::Error>(())
        });
        let base_url = self.base_url.clone();
        let links = self.links.clone();
        let session_id = session.id.clone();
        let store = self.store.clone();
        let changed = self.changed.clone();
        let finished = stopper.clone();
        let task = tokio::spawn(async move {
            let result = async {
                if *stop.borrow() { return Ok(()); }
                tokio::select! {
                    ready = tokio::time::timeout(Duration::from_secs(30), invalidations.recv()) => {
                        ready.context("The adapter did not become ready")?.context("The adapter's wake-up channel closed before it was ready")?;
                    }
                    _ = stop.wait_for(|stopped| *stopped) => return Ok(()),
                }
                driver.run(base_url, links, session_id.clone(), token, invalidations, stop.clone()).await
            }.await;
            if let Err(error) = &result {
                tracing::warn!(
                    session_id,
                    error = format!("{error:#}"),
                    "Native chat adapter ended with an error"
                );
            }
            if result.is_err()
                && !*stop.borrow()
                && let Ok(owner) = store.chat_identity(None).await
            {
                let _ = store.set_chat_session_status(&owner, &session_id, ChatSessionStatus {
                        status: "attention".into(),
                        reason: Some("The native link needs attention. Uncertain messages have not been resent.".into()),
                    }).await;
                changed.notify_one();
            }
            finished.send_replace(true);
            result
        });
        agents.insert(
            session.id.clone(),
            AgentTask {
                stop: stopper,
                task,
                subscriber: Some(subscriber),
                stop_note: None,
            },
        );
        Ok(())
    }

    async fn connect_pi(
        &self,
        target: &sessions::NativeSessionTarget,
        session: &ChatSession,
        token: String,
        resume: bool,
    ) -> Result<()> {
        let mut agents = self.agents.lock().await;
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        let workspace = self.store.workspace_info().await?;
        let mut target = target.clone();
        #[cfg(unix)]
        let mut runner = self
            .pi_runners
            .find(&session.native_session_id, &session.workspace)
            .await?;
        #[cfg(unix)]
        if target.native_locator["cold"] == true {
            runner = Some(
                self.pi_runners
                    .get_or_launch(
                        &session.native_session_id,
                        &session.workspace,
                        &target.native_locator,
                    )
                    .await?,
            );
        }
        #[cfg(unix)]
        if let Some(host) = &runner {
            let pid = host.bind(&self.base_url, &token).await?;
            let description = host.describe().await?;
            let durable = crate::pi_runner::recovery_locator(&session.native_session_id, &session.workspace,
                serde_json::json!({"session_file":description["session_file"],"profile":description["profile"]})).await?;
            let agent = std::path::Path::new(
                durable["agent_dir"]
                    .as_str()
                    .context("Missing pi host directory")?,
            );
            let mut actual = sessions::running_pi(agent, &session.native_session_id, pid).await?;
            for key in ["session_file", "profile", "agent_dir"] {
                actual.native_locator[key] = durable[key].clone();
            }
            actual.native_locator["runner"] = serde_json::json!(host.path);
            actual.native_locator["kind"] = serde_json::json!("pi-runner");
            target = actual;
        }
        let owner = self.store.chat_identity(None).await?;
        if self
            .store
            .chat_session(&owner, &session.id)
            .await?
            .stopped_at
            .is_some()
        {
            #[cfg(unix)]
            if let Some(host) = &runner {
                let _ = host.stop(&session.id).await;
            }
            return Err(StoppedByOwner(Error::StoppedByOwner.into()).into());
        }
        self.store
            .remember_pi_locator(
                &session.id,
                &session.native_session_id,
                &target.native_locator,
            )
            .await?;
        let link = sessions::pair_pi(&target, &self.base_url, &workspace.id, token, resume).await?;
        let (stopper, mut stop) = watch::channel(false);
        #[cfg(unix)]
        let owned = runner.is_some();
        #[cfg(not(unix))]
        let owned = false;
        let session_id = session.id.clone();
        let task = tokio::spawn(async move {
            let _ = stop.wait_for(|stopped| *stopped).await;
            link.shutdown().await?;
            #[cfg(unix)]
            if let Some(host) = runner {
                host.stop(&session_id).await?;
            }
            Ok(())
        });
        agents.insert(
            session.id.clone(),
            AgentTask {
                stop: stopper,
                task,
                subscriber: None,
                stop_note: if owned { None } else { Some("The chat link is stopped and its token revoked. Native cancellation was not confirmed; pi may continue its native turn.") },
            },
        );
        Ok(())
    }

    pub async fn stop_session(&self, id: &str) -> Result<Option<&'static str>> {
        let agent = self.agents.lock().await.remove(id);
        let Some(mut agent) = agent else {
            #[cfg(unix)]
            if self.stop_untracked_owned(id).await? {
                return Ok(None);
            }
            #[cfg(unix)]
            {
                let owner = self.store.chat_identity(None).await?;
                let session = self.store.chat_session(&owner, id).await?;
                if session.harness == "pi"
                    && let Some(host) = self
                        .pi_runners
                        .find(&session.native_session_id, &session.workspace)
                        .await?
                {
                    host.stop(id).await?;
                    return Ok(None);
                }
            }
            return Ok(Some(
                "The chat link is stopped and its token revoked. Native cancellation was not confirmed because this kernel had no active adapter.",
            ));
        };
        agent.stop.send_replace(true);
        let (driver, subscriber) = tokio::join!(finish(&mut agent.task), async {
            if let Some(subscriber) = &mut agent.subscriber {
                finish(subscriber).await
            } else {
                Ok(())
            }
        });
        driver?;
        subscriber?;
        Ok(agent.stop_note)
    }

    /// Stops the kernel side only. Native work keeps running: the owner did not press Stop,
    /// and the next start relinks the sessions and reconciles what happened meanwhile.
    pub async fn shutdown(&self) -> Result<()> {
        self.stop.send_replace(true);
        let mut error = None;
        for (_, agent) in self.agents.lock().await.drain() {
            agent.release().await;
        }
        if let Some(mut publisher) = self.publisher.lock().await.take() {
            match tokio::time::timeout(Duration::from_secs(10), &mut publisher).await {
                Ok(Ok(())) => {}
                Ok(result) => {
                    error.get_or_insert_with(|| {
                        anyhow::anyhow!("Publisher shutdown failed: {result:?}")
                    });
                }
                Err(_) => {
                    publisher.abort();
                    let _ = publisher.await;
                    error.get_or_insert_with(|| {
                        anyhow::anyhow!("Publisher did not stop within its deadline")
                    });
                }
            }
        }
        error.map_or(Ok(()), Err)
    }
}

#[cfg(unix)]
mod owned;

async fn finish(task: &mut JoinHandle<Result<()>>) -> Result<()> {
    match tokio::time::timeout(Duration::from_secs(10), &mut *task).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => Err(error).context("Native adapter task stopped unexpectedly"),
        Err(_) => {
            task.abort();
            let _ = task.await;
            bail!("The link was stopped, but native cancellation was not confirmed");
        }
    }
}
