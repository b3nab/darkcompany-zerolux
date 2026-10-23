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
        Actor, AgentSettings, ChatIdentity, ChatSession, ChatSessionStatus, CreateCodexSession,
        HireChatSession,
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
    settings: Option<crate::codex_settings::CodexSettings>,
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
    let workspace =
        dunce::canonicalize(path).map_err(|_| Error::Invalid("Workspace does not exist".into()))?;
    if !workspace.is_dir() {
        return Err(Error::Invalid("Workspace must be a directory".into()).into());
    }
    Ok(workspace.to_string_lossy().into_owned())
}

/// Tells the people in the workspace when a terminal's output grows or it ends, at most every
/// 100 ms per terminal: clients then read the new output over HTTP.
async fn terminal_notices(
    store: Store,
    livekit: Arc<LiveKit>,
    terminals: Arc<crate::terminals::Terminals>,
    mut heard: mpsc::UnboundedReceiver<String>,
) {
    while let Some(first) = heard.recv().await {
        let mut grown = std::collections::HashSet::from([first]);
        tokio::time::sleep(Duration::from_millis(100)).await;
        while let Ok(id) = heard.try_recv() {
            grown.insert(id);
        }
        for id in grown {
            let Ok(info) = terminals.info(&id) else {
                continue;
            };
            let Ok(people) = store.readers(&info.session_id).await else {
                continue;
            };
            let notice = serde_json::json!({"type":"terminal.output","terminal_id":id,
                "session_id":info.session_id,"end":info.end,"ended":info.ended});
            let _ = livekit.notify(&notice, &people).await;
        }
    }
}

/// What joined computers tell about their sessions, published to whoever may read each.
async fn host_notices_task(
    store: Store,
    livekit: Arc<LiveKit>,
    mut told: mpsc::UnboundedReceiver<(String, Value)>,
) {
    while let Some((host, notice)) = told.recv().await {
        let Some(session) = notice["session_id"].as_str() else {
            continue;
        };
        // Only about the host's own sessions.
        let Ok(row) =
            <crate::entity::sessions::Entity as sea_orm::EntityTrait>::find_by_id(session)
                .one(store.db())
                .await
        else {
            continue;
        };
        if row.is_none_or(|row| row.host_id.as_deref() != Some(host.as_str())) {
            continue;
        }
        // Its adapter ended there: the session waits for attention, and the computer's next
        // connection continues it.
        if notice["type"] == "session.ended" {
            if let Ok(owner) = store.session_person(session).await {
                let _ = store
                    .set_chat_session_status(
                        &owner,
                        session,
                        ChatSessionStatus {
                            status: "attention".into(),
                            reason: notice["reason"].as_str().map(str::to_owned),
                        },
                    )
                    .await;
            }
            continue;
        }
        if let Ok(people) = store.readers(session).await {
            let _ = livekit.notify(&notice, &people).await;
        }
    }
}

/// `git` in `dir`, bounded; its own message on failure.
async fn git(dir: &std::path::Path, args: &[&str]) -> Result<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(60),
        tokio::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .context("git timed out")?
    .context("Cannot run git")?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(Error::Invalid(if message.is_empty() {
            "git failed".into()
        } else {
            message
        })
        .into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

impl ChatRuntime {
    /// The kernel's own address, on this computer.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// The folder a new session works in: `workspace`, or with `worktree` the same folder in
    /// a new git worktree of its repository, on a branch of its own (`worktree` names it;
    /// empty, ZeroLux does).
    pub(crate) async fn session_dir(
        &self,
        workspace: &str,
        worktree: Option<&str>,
    ) -> Result<String> {
        session_dir_in(&self.worktrees, workspace, worktree).await
    }
}

/// A session's folder: `workspace`, or a new git worktree of its repository under `worktrees`,
/// on `worktree`'s branch (a new one named by ZeroLux when empty).
pub(crate) async fn session_dir_in(
    worktrees: &std::path::Path,
    workspace: &str,
    worktree: Option<&str>,
) -> Result<String> {
    let workspace = workspace_dir(workspace)?;
    let Some(branch) = worktree else {
        return Ok(workspace);
    };
    let folder = PathBuf::from(&workspace);
    let top = PathBuf::from(git(&folder, &["rev-parse", "--show-toplevel"]).await?);
    let branch = match branch.trim() {
        "" => format!(
            "zerolux/{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ),
        name => git(&folder, &["check-ref-format", "--branch", name]).await?,
    };
    let repository = top
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repository".into());
    let dir = worktrees.join(repository).join(branch.replace('/', "-"));
    std::fs::create_dir_all(dir.parent().context("Invalid worktree folder")?)?;
    git(
        &top,
        &[
            "worktree",
            "add",
            "-b",
            &branch,
            &dir.to_string_lossy(),
            "HEAD",
        ],
    )
    .await?;
    let inner = dunce::canonicalize(&folder)?
        .strip_prefix(dunce::canonicalize(&top)?)
        .map(PathBuf::from)
        .unwrap_or_default();
    workspace_dir(&dir.join(inner).to_string_lossy())
}

enum NativeDriver {
    Codex(Box<CodexDriver>),
    Claude(crate::claude::ClaudeSession),
}

impl NativeDriver {
    async fn run(
        self,
        base_url: String,
        session_id: String,
        token: String,
        invalidations: mpsc::Receiver<()>,
        stop: watch::Receiver<bool>,
    ) -> Result<()> {
        match self {
            Self::Codex(driver) => {
                driver
                    .run(base_url, session_id, token, invalidations, stop)
                    .await
            }
            Self::Claude(driver) => {
                driver
                    .run(base_url, session_id, token, invalidations, stop)
                    .await
            }
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PiStartFailure {
    #[error("pi did not confirm the new session; check Hire before starting another")]
    Uncertain,
    #[error("pi started session {native_session_id} but it could not be linked; hire it from Hire")]
    Unlinked { native_session_id: String },
}

pub struct ChatRuntime {
    pub(crate) store: Store,
    livekit: Arc<LiveKit>,
    base_url: String,
    runners: crate::claude_runner::Registry,
    pi_runners: crate::pi_runner::Registry,
    changed: Arc<Notify>,
    /// Wakes the adapters that run inside this process: they share the store, so a notice
    /// written to the outbox reaches them here, without LiveKit, sockets or tokens.
    wake: broadcast::Sender<()>,
    stop: watch::Sender<bool>,
    agents: Mutex<HashMap<String, AgentTask>>,
    publisher: Mutex<Option<JoinHandle<()>>>,
    /// Notices of native output growth; see `native_output`.
    watcher: Mutex<Option<JoinHandle<()>>>,
    settings_gates: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Relinks that failed, by session: failures so far and when to try again.
    retries: std::sync::Mutex<HashMap<String, (u32, std::time::Instant)>>,
    /// Installed code at kernel activation, not edits made later in a checkout.
    integration_revisions: HashMap<&'static str, String>,
    /// Where sessions started in a worktree of their own work.
    worktrees: PathBuf,
    /// Images the owner sent with their input, per session, for its harness to read.
    attachments: PathBuf,
    /// What each session is producing right now; see `live`.
    live: crate::live::Live,
    /// The budget, in cents, each session last reached: its work was stopped for it once.
    budgets_reached: std::sync::Mutex<HashMap<String, i64>>,
    /// Terminals the owner opened in sessions' folders.
    pub terminals: Arc<crate::terminals::Terminals>,
    terminal_notices: Mutex<Option<JoinHandle<()>>>,
    /// The people's computers joined to the workspace and connected now.
    pub hosts: Arc<crate::host_link::Links>,
    /// Terminals opened on those computers, by ID: the computer and the session.
    pub remote_terminals: std::sync::Mutex<HashMap<String, (String, String)>>,
    /// The workspace's extensions.
    pub extensions: Arc<crate::extensions::Extensions>,
    /// The processes of the background commands of this computer's sessions.
    pub background_processes: crate::background_processes::BackgroundProcesses,
    /// What those computers tell, to publish to whoever may read it.
    pub host_notices: mpsc::UnboundedSender<(String, Value)>,
    host_notice_task: Mutex<Option<JoinHandle<()>>>,
    /// The harness subscriptions people asked about; see `plans`.
    plans: plans::Plans,
}

impl ChatRuntime {
    pub async fn start(
        store: Store,
        livekit: Arc<LiveKit>,
        base_url: String,
        links: PathBuf,
    ) -> Result<Arc<Self>> {
        Self::start_inner(store, livekit, base_url, links, None).await
    }

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
        program: Option<crate::claude_runner::RunnerProgram>,
    ) -> Result<Arc<Self>> {
        store.recover_sessions().await?;
        let worktrees = links.with_file_name("worktrees");
        let (grown, heard) = mpsc::unbounded_channel();
        let terminals = Arc::new(crate::terminals::Terminals::new(grown));
        let terminal_notices = tokio::spawn(terminal_notices(
            store.clone(),
            livekit.clone(),
            terminals.clone(),
            heard,
        ));
        let attachments = links.with_file_name("attachments");
        let extensions = crate::extensions::Extensions::new(
            store.clone(),
            links.with_file_name("extensions"),
            Box::new({
                let (store, livekit) = (store.clone(), livekit.clone());
                move |notice: serde_json::Value| {
                    let (store, livekit) = (store.clone(), livekit.clone());
                    tokio::spawn(async move {
                        if let Ok(people) = store.everyone().await {
                            let _ = livekit.notify(&notice, &people).await;
                        }
                    });
                }
            }),
        );
        let (host_notices, told) = mpsc::unbounded_channel();
        let host_notice_task =
            tokio::spawn(host_notices_task(store.clone(), livekit.clone(), told));
        let (stop, stopped) = watch::channel(false);
        let changed = Arc::new(Notify::new());
        let (wake, _) = broadcast::channel(16);
        let publisher = tokio::spawn(crate::livekit::run_publisher(
            store.clone(),
            livekit.clone(),
            changed.clone(),
            wake.clone(),
            stopped.clone(),
        ));
        let (taken, mut absorbed) = mpsc::unbounded_channel();
        let watcher = tokio::spawn(crate::native_output::run_watcher(
            store.clone(),
            livekit.clone(),
            taken,
            stopped,
        ));
        let program = program.unwrap_or_default();
        let integration_revisions = {
            let mut revisions = HashMap::new();
            if let Ok(revision) = crate::integration_code::revision(&program.entry) {
                revisions.insert("claude-code", revision);
            }
            if let Some(entry) = &program.pi_entry {
                let extension =
                    entry.with_file_name(if entry.extension().is_some_and(|ext| ext == "ts") {
                        "chat-extension.ts"
                    } else {
                        "chat-extension.js"
                    });
                if let Ok(revision) = crate::integration_code::revision(&extension) {
                    revisions.insert("pi", revision);
                }
            }
            revisions
        };
        let runtime = Arc::new(Self {
            store,
            livekit,
            base_url,
            runners: crate::claude_runner::Registry::new(links.join("claude"), program.clone()),
            pi_runners: crate::pi_runner::Registry::new(links.join("pi"), program),
            changed,
            wake,
            stop,
            agents: Mutex::new(HashMap::new()),
            publisher: Mutex::new(Some(publisher)),
            watcher: Mutex::new(Some(watcher)),
            settings_gates: Mutex::new(HashMap::new()),
            retries: std::sync::Mutex::new(HashMap::new()),
            integration_revisions,
            worktrees,
            attachments,
            live: crate::live::Live::default(),
            budgets_reached: std::sync::Mutex::new(HashMap::new()),
            terminals,
            terminal_notices: Mutex::new(Some(terminal_notices)),
            hosts: Arc::default(),
            remote_terminals: Default::default(),
            extensions,
            background_processes: crate::background_processes::BackgroundProcesses::new(
                links.with_file_name("background"),
            ),
            host_notices,
            host_notice_task: Mutex::new(Some(host_notice_task)),
            plans: plans::Plans::default(),
        });
        runtime.extensions.serve_runtime(Arc::downgrade(&runtime));
        Self::watch_plans(Arc::downgrade(&runtime));
        // What a native record says a running turn took leaves the session's queue at once.
        let weak = Arc::downgrade(&runtime);
        tokio::spawn(async move {
            while let Some((session, ids)) = absorbed.recv().await {
                let Some(runtime) = weak.upgrade() else {
                    return;
                };
                if let Some(applied) = runtime.live.absorb(&session, &ids) {
                    runtime.publish_live(&session, applied).await;
                }
            }
        });
        Ok(runtime)
    }

    /// A session's live changes, from its integration: applied, then sent to the people in
    /// the workspace as `session.live` notices numbered like the changes.
    pub async fn live_changes(&self, id: &str, changes: Vec<crate::live::Change>) -> Result<u64> {
        let cost = changes.iter().rev().find_map(|change| match change {
            crate::live::Change::Usage(usage) => usage.cost_usd,
            _ => None,
        });
        let used = changes
            .iter()
            .any(|change| matches!(change, crate::live::Change::Usage(_)));
        let applied = self.live.apply(id, changes)?;
        if let Some(cost) = cost {
            self.check_budget(id, cost).await;
        }
        if used {
            self.plans_after_turn(id).await;
        }
        self.publish_live(id, applied).await;
        Ok(self.live.state(id).seq)
    }

    /// Live changes applied, sent to whoever may read the session as `session.live` notices.
    async fn publish_live(&self, id: &str, applied: crate::live::Applied) {
        let Ok(people) = self.store.readers(id).await else {
            return;
        };
        for notice in applied.notices() {
            let payload = serde_json::json!({"type":"session.live","session_id":id,
                "first":notice.first,"changes":notice.changes});
            if let Err(error) = self.livekit.notify(&payload, &people).await {
                tracing::debug!(error = format!("{error:#}"), "Live notice not sent");
            }
        }
    }

    /// At its budget, a session's work stops: the turn in progress is interrupted and the
    /// owner told, once for that budget. A higher budget lets it go on.
    async fn check_budget(&self, id: &str, cost: f64) {
        let Ok(owner) = self.store.session_person(id).await else {
            return;
        };
        let Ok(session) = self.store.chat_session(&owner, id).await else {
            return;
        };
        let Some(budget) = session.budget_usd else {
            return;
        };
        let cents = (budget * 100.0).round() as i64;
        if cost < budget
            || self
                .budgets_reached
                .lock()
                .expect("budgets")
                .insert(id.to_owned(), cents)
                == Some(cents)
        {
            return;
        }
        let interrupted = self.interrupt(&owner, id).await;
        let reason = format!(
            "Budget of ${budget:.2} reached (${cost:.2} spent){}. Raise it to continue.",
            match interrupted {
                Ok(true) => "; its turn was stopped",
                Ok(false) => "",
                Err(_) => "; its turn could not be stopped",
            }
        );
        let _ = self
            .store
            .set_chat_session_status(
                &owner,
                id,
                ChatSessionStatus {
                    status: "attention".into(),
                    reason: Some(reason),
                },
            )
            .await;
        self.changed();
    }

    /// A new budget for a session stopped at its old one: above what it has cost, it goes on.
    pub async fn budget_changed(&self, who: &ChatIdentity, session: &ChatSession) -> Result<()> {
        let reached = self
            .budgets_reached
            .lock()
            .expect("budgets")
            .get(&session.id)
            .copied();
        let Some(reached) = reached else {
            return Ok(());
        };
        let cost = self
            .live
            .state(&session.id)
            .usage
            .and_then(|usage| usage.cost_usd);
        let room = match session.budget_usd {
            None => true,
            Some(budget) => {
                (budget * 100.0).round() as i64 > reached && cost.is_none_or(|cost| cost < budget)
            }
        };
        if !room {
            return Ok(());
        }
        self.budgets_reached
            .lock()
            .expect("budgets")
            .remove(&session.id);
        if session.status == "attention" && session.stopped_at.is_none() {
            self.store
                .set_chat_session_status(
                    who,
                    &session.id,
                    ChatSessionStatus {
                        status: "connected".into(),
                        reason: None,
                    },
                )
                .await?;
            self.changed();
        }
        Ok(())
    }

    /// The schedules whose time has come: each one's words reach its session as the owner's
    /// input, after the turn in progress. A session that is not running misses the run, and
    /// the schedule says why.
    pub async fn run_schedules(&self) -> Result<()> {
        let now = crate::store::now_ms();
        for schedule in self.store.due_schedules(now).await? {
            // As the person whose session it is.
            let owner = self.store.session_person(&schedule.session_id).await?;
            let sent = self
                .input(
                    &owner,
                    &schedule.session_id,
                    &schedule.prompt,
                    crate::model::InputMode::Queue,
                    &[],
                )
                .await;
            let error = sent.err().map(|error| format!("{error:#}"));
            self.store.schedule_ran(&schedule.id, now, error).await?;
        }
        Ok(())
    }

    /// Triggers whose event happened: their session receives what happened, with their words,
    /// queued after its turn, once. Only this host's running sessions are watched; one that is
    /// not running is told when it runs again, if its commit's runs are still the latest.
    pub async fn run_triggers(&self) -> Result<()> {
        for trigger in self.store.enabled_triggers().await? {
            let owner = self.store.session_person(&trigger.session_id).await?;
            let Ok(session) = self.store.chat_session(&owner, &trigger.session_id).await else {
                continue;
            };
            if session.stopped_at.is_some() || session.status != "connected" {
                continue;
            }
            // Asked where the session's folder is: here, or on its joined computer.
            let ci = match self.remote_host(&session) {
                None => crate::triggers::ci(std::path::Path::new(&session.workspace)).await,
                Some(host) => self
                    .hosts
                    .call(
                        &host,
                        "folder",
                        serde_json::json!({"op": "ci", "folder": session.workspace, "params": {}}),
                    )
                    .await
                    .map(|ended| {
                        (!ended.is_null()).then(|| crate::triggers::Ended {
                            seen: ended["seen"].as_str().unwrap_or_default().to_owned(),
                            failed: ended["failed"] == true,
                            report: ended["report"].as_str().unwrap_or_default().to_owned(),
                        })
                    }),
            };
            let ended = match ci {
                Ok(Some(ended)) if trigger.last_seen.as_ref() != Some(&ended.seen) => ended,
                Ok(_) => continue,
                Err(error) => {
                    let error = format!("{error:#}");
                    if trigger.last_error.as_ref() != Some(&error) {
                        self.store
                            .trigger_saw(&trigger.id, None, None, Some(error))
                            .await?;
                    }
                    continue;
                }
            };
            if trigger.failures_only && !ended.failed {
                self.store
                    .trigger_saw(&trigger.id, Some(ended.seen), None, None)
                    .await?;
                continue;
            }
            let text = if trigger.prompt.trim().is_empty() {
                ended.report.clone()
            } else {
                format!("{}\n\n{}", ended.report, trigger.prompt.trim())
            };
            let sent = self
                .input(
                    &owner,
                    &session.id,
                    &text,
                    crate::model::InputMode::Queue,
                    &[],
                )
                .await;
            // Never sent twice: input whose delivery is uncertain is not tried again.
            let error = sent.err().map(|error| format!("{error:#}"));
            let told = error.is_none().then(crate::store::now_ms);
            self.store
                .trigger_saw(&trigger.id, Some(ended.seen), told, error)
                .await?;
        }
        Ok(())
    }

    /// What a session is producing right now.
    pub fn live_state(&self, id: &str) -> crate::live::State {
        self.live.state(id)
    }

    pub fn changed(&self) {
        // The in-process adapters first, directly: a publisher stuck on LiveKit must not
        // delay them. Then the publisher, for the clients outside.
        let _ = self.wake.send(());
        self.hosts.wake_all();
        self.changed.notify_one();
    }

    pub fn client_token(&self, actor_id: &str) -> Result<ClientToken> {
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        self.livekit.client_token(actor_id)
    }

    /// A person's token, tied to their sign-in.
    pub fn human_token(&self, actor_id: &str, session_expires_at: i64) -> Result<ClientToken> {
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        self.livekit.human_token(actor_id, session_expires_at)
    }

    /// After a sign-out or a revocation: the person's devices reconnect only if still signed in.
    pub async fn disconnect_clients(&self, actor_id: &str) -> Result<()> {
        self.livekit.disconnect_clients(actor_id).await
    }

    /// People whose sign-in ended while connected are disconnected.
    pub async fn sweep_expired(&self) -> Result<()> {
        self.livekit.sweep_expired().await
    }

    pub async fn discover(&self) -> Result<Value> {
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        Ok(serde_json::to_value(sessions::discover_sessions().await)?)
    }

    /// A discovered session in ZeroLux: a running one is linked as it is; a saved one is
    /// opened again under ZeroLux, with its own history and folder. No input is sent.
    pub async fn attach(
        &self,
        who: &ChatIdentity,
        discovered_session_id: &str,
        name: &str,
        actor_id: Option<String>,
    ) -> Result<(Option<Actor>, ChatSession)> {
        if !who.is_person() {
            return Err(Error::Forbidden.into());
        }
        if discovered_session_id.len() != 64
            || !discovered_session_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(Error::Invalid("Invalid discovered session ID".into()).into());
        }
        let (target, running) = sessions::resolve_any(discovered_session_id).await?;
        if running {
            return self.link(who, target, name, actor_id, false).await;
        }
        self.store
            .check_hire(who, target.harness, actor_id.as_deref(), name)
            .await?;
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        match target.harness {
            Harness::Codex => {
                let endpoint = sessions::ensure_codex_daemon().await?;
                let driver = CodexDriver::resume(
                    &endpoint,
                    &target.native_session_id,
                    &target.workspace,
                    || async { Ok(true) },
                )
                .await?;
                let target = sessions::NativeSessionTarget {
                    native_locator: serde_json::json!({"endpoint": endpoint}),
                    ..target
                };
                self.bind(
                    who,
                    target,
                    name,
                    actor_id,
                    false,
                    Some(NativeDriver::Codex(Box::new(driver))),
                )
                .await
            }
            Harness::Pi => {
                let file = target.native_locator["session_file"]
                    .as_str()
                    .context("The saved pi session has no file")?;
                let host = self
                    .pi_runners
                    .open(
                        &target.native_session_id,
                        &target.workspace,
                        file,
                        &crate::homes::Homes::own(),
                    )
                    .await?;
                let result = async {
                    let opened = host.target().await?;
                    self.link(who, opened, name, actor_id, false).await
                }
                .await;
                if result.is_err() {
                    host.discard_unstarted().await;
                }
                result
            }
            Harness::ClaudeCode => {
                self.open_claude(who, target, name, actor_id, &crate::homes::Homes::own())
                    .await
            }
        }
    }

    async fn link(
        &self,
        who: &ChatIdentity,
        mut target: sessions::NativeSessionTarget,
        name: &str,
        actor_id: Option<String>,
        resume: bool,
    ) -> Result<(Option<Actor>, ChatSession)> {
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
                let driver = crate::claude::ClaudeSession::attach(
                    &target.native_session_id,
                    &target.workspace,
                )
                .await?;
                target.native_locator["pid"] = serde_json::json!(driver.pid());
                target.native_locator["socket"] =
                    serde_json::json!(format!("/tmp/cc-socks/{}.sock", driver.pid()));
                Some(NativeDriver::Claude(driver))
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
    ) -> Result<(Option<Actor>, ChatSession)> {
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
        self.live.forget(&issued.session.id);
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
                .fail_chat_link(who, &issued.session.id, crate::chat::LINK_FAILED)
                .await?
            {
                // The owner pressed Stop while pairing was pending: their decision stands.
                return Err(StoppedByOwner(error).into());
            }
            self.changed();
            return Err(error);
        }
        // What it runs with, confirmed by its harness, for a later relaunch.
        let _ = self.session_settings(who, &issued.session.id).await;
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
    ) -> Result<(Option<Actor>, ChatSession)> {
        if !who.is_person() {
            return Err(Error::Forbidden.into());
        }
        self.store
            .check_hire(who, Harness::Codex, input.actor_id.as_deref(), &input.name)
            .await?;
        let workspace = self
            .session_dir(&input.workspace, input.worktree.as_deref())
            .await?;
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        let chosen = self
            .launch_choices(
                who,
                input.actor_id.as_deref(),
                "codex",
                AgentSettings {
                    model: input.model,
                    effort: input.effort,
                    approval_policy: serde_json::to_value(input.approval_policy)?
                        .as_str()
                        .map(str::to_owned),
                    sandbox: serde_json::to_value(input.sandbox)?
                        .as_str()
                        .map(str::to_owned),
                    ..AgentSettings::default()
                },
            )
            .await?;
        let initial = AgentSettings {
            model: chosen.model,
            effort: chosen.effort,
            ..AgentSettings::default()
        };
        let policy = serde_json::from_value(serde_json::json!(chosen.approval_policy))?;
        let sandbox = serde_json::from_value(serde_json::json!(chosen.sandbox))?;
        // With the person's own Codex: the computer's for its person, a guest's own otherwise.
        let homes = self.store.homes(who).await?;
        let endpoint = sessions::ensure_codex_daemon_in(&homes).await?;
        let driver = CodexDriver::start(&endpoint, &workspace, policy, sandbox, &initial).await?;
        let thread_id = driver.thread_id().to_owned();
        let mut native_locator = serde_json::json!({"endpoint": endpoint});
        homes.record(&mut native_locator);
        let target = sessions::NativeSessionTarget {
            harness: Harness::Codex,
            native_session_id: thread_id.clone(),
            title: "Codex".into(),
            workspace,
            native_locator,
        };
        let (actor, session) = self
            .bind(
                who,
                target,
                &input.name,
                input.actor_id,
                false,
                Some(NativeDriver::Codex(Box::new(driver))),
            )
            .await
            .context(CodexStartFailure::Unlinked { thread_id })?;
        Ok((actor, session))
    }

    pub async fn create_pi(
        &self,
        who: &ChatIdentity,
        input: crate::model::CreatePiSession,
    ) -> Result<(Option<Actor>, ChatSession)> {
        if !who.is_person() {
            return Err(Error::Forbidden.into());
        }
        self.store
            .check_hire(who, Harness::Pi, input.actor_id.as_deref(), &input.name)
            .await?;
        let workspace = self
            .session_dir(&input.workspace, input.worktree.as_deref())
            .await?;
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        let initial = self
            .launch_choices(
                who,
                input.actor_id.as_deref(),
                "pi",
                AgentSettings {
                    model: input.model,
                    effort: input.effort,
                    ..AgentSettings::default()
                },
            )
            .await?;
        let homes = self.store.homes(who).await?;
        let host = self
            .pi_runners
            .create(&workspace, &initial, &homes)
            .await
            .context(PiStartFailure::Uncertain)?;
        let native_session_id = host.native_id().to_owned();
        let result = async {
            let mut target = host.target().await?;
            homes.record(&mut target.native_locator);
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

    /// The owner's Resume of a stopped session, or of one whose link was lost, through its
    /// harness: the same native session, continued.
    pub async fn resume(
        &self,
        who: &ChatIdentity,
        id: &str,
    ) -> Result<(Option<Actor>, ChatSession)> {
        let session = self.store.chat_session(who, id).await?;
        if let Some(host) = self.remote_host(&session) {
            ensure!(
                session.harness == "codex",
                "Only Codex runs on joined computers"
            );
            ensure!(
                session.stopped_at.is_some() || session.status == "attention",
                "Stop the running session before resuming it"
            );
            return self.continue_on(&host, &session, false).await;
        }
        match session.harness.as_str() {
            "codex" => self.resume_codex(who, session).await,
            "pi" => self.resume_pi(who, id).await,
            _ => self.resume_claude(who, id).await,
        }
    }

    async fn resume_codex(
        &self,
        who: &ChatIdentity,
        session: ChatSession,
    ) -> Result<(Option<Actor>, ChatSession)> {
        if !who.is_person() {
            return Err(Error::Forbidden.into());
        }
        ensure!(
            session.stopped_at.is_some() || session.status == "attention",
            "Stop the running session before resuming it"
        );
        self.store
            .check_hire(who, Harness::Codex, session.actor_id.as_deref(), "")
            .await?;
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        let homes = crate::homes::Homes::of_locator(
            &self.store.chat_session_locator(who, &session.id).await?,
        );
        let endpoint = sessions::ensure_codex_daemon_in(&homes).await?;
        if let Some(previous) = self.agents.lock().await.remove(&session.id) {
            previous.release().await;
        }
        let driver = CodexDriver::resume(
            &endpoint,
            &session.native_session_id,
            &session.workspace,
            || async { Ok(true) },
        )
        .await?;
        let mut native_locator = serde_json::json!({"endpoint": endpoint});
        homes.record(&mut native_locator);
        let target = sessions::NativeSessionTarget {
            harness: Harness::Codex,
            native_session_id: session.native_session_id.clone(),
            title: session.title.clone(),
            workspace: session.workspace.clone(),
            native_locator,
        };
        let reconnect = session.stopped_at.is_none();
        self.bind(
            who,
            target,
            "",
            session.actor_id,
            reconnect,
            Some(NativeDriver::Codex(Box::new(driver))),
        )
        .await
    }

    pub async fn resume_pi(
        &self,
        who: &ChatIdentity,
        id: &str,
    ) -> Result<(Option<Actor>, ChatSession)> {
        if !who.is_person() {
            return Err(Error::Forbidden.into());
        }
        let session = self.store.chat_session(who, id).await?;
        ensure!(session.harness == "pi", "This is not a pi session");
        ensure!(
            session.stopped_at.is_some() || session.status == "attention",
            "Stop the running session before resuming it"
        );
        self.store
            .check_hire(who, Harness::Pi, session.actor_id.as_deref(), "")
            .await?;
        let live = sessions::resolve_linked("pi", &session.native_session_id).await;
        let target = self.pi_target(who, &session, live).await?;
        let reconnect = session.stopped_at.is_none();
        if let Some(previous) = self.agents.lock().await.remove(id) {
            previous.release().await;
        }
        // Explicit Resume after an owner's Stop transfers only never-attempted deliveries.
        self.bind(who, target, "", session.actor_id, reconnect, None)
            .await
    }

    /// Cooperative handover: native pi closes its idle terminal. Ordinary recovery owns
    /// the later launch and still requires proof of native death; this request starts none.
    pub async fn takeover_pi(&self, who: &ChatIdentity, id: &str) -> Result<ChatSession> {
        if !who.is_person() {
            return Err(Error::Forbidden.into());
        }
        let session = self.store.chat_session(who, id).await?;
        if session.harness != "pi" || session.stopped_at.is_some() {
            return Err(
                Error::Invalid("Takeover requires a live terminal pi session".into()).into(),
            );
        }
        self.store
            .check_hire(who, Harness::Pi, session.actor_id.as_deref(), "")
            .await?;
        let live = sessions::resolve_linked("pi", &session.native_session_id)
            .await
            .context("The terminal pi is unavailable")?;
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
            "Update pi's ZeroLux extension to take over its terminal"
        );
        let workspace = self.store.workspace_info().await?;
        let mut request = serde_json::json!({"method":"takeover", "check":true,
            "session_id":id, "workspace_id":workspace.id,
            "native_session_id":session.native_session_id, "workspace":session.workspace,
            "session_file":target.native_locator["session_file"]});
        if sessions::control(&record, request.clone()).await?["accepted"] != true {
            return Err(Error::Invalid(
                "Finish pi's work, queue, drafts and dialogs in its terminal first".into(),
            )
            .into());
        }
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        // Durable recovery intent precedes shutdown. Owner Stop wins this write and the
        // extension's final authenticated inbox check. No token or input is replayed.
        self.store
            .set_chat_session_status(
                who,
                id,
                ChatSessionStatus {
                    status: "attention".into(),
                    reason: Some("Taking over: waiting for pi to exit in its terminal.".into()),
                },
            )
            .await?;
        self.changed();
        request["check"] = serde_json::json!(false);
        let outcome = sessions::control(&record, request)
            .await
            .context("pi did not confirm the takeover; check the session before trying again")?;
        if outcome["accepted"] != true {
            return Err(Error::Invalid("pi did not confirm the takeover".into()).into());
        }
        self.store.chat_session(who, id).await.map_err(Into::into)
    }

    async fn pi_target(
        &self,
        who: &ChatIdentity,
        session: &ChatSession,
        live: Option<sessions::NativeSessionTarget>,
    ) -> Result<sessions::NativeSessionTarget> {
        let saved = self.store.chat_session_locator(who, &session.id).await?;
        let mut target = if let Some(target) = live {
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
        ensure!(target.workspace == session.workspace, "pi's folder changed");
        if let Some(file) = saved["session_file"].as_str() {
            ensure!(
                target.native_locator["session_file"].as_str() == Some(file),
                "pi's session file changed"
            );
        }
        // Still with the person's own pi.
        crate::homes::Homes::of_locator(&saved).record(&mut target.native_locator);
        Ok(target)
    }

    /// Reconnects entrusted sessions after kernel/link loss, resuming saved native contexts
    /// when their processes ended. Tokens are reissued; no startup prompt or attempted input
    /// is resent. Sessions explicitly stopped by their owner remain stopped.
    pub async fn reconnect(&self) -> Result<()> {
        self.relink(false).await
    }

    /// The periodic relink: a session whose relinks keep failing waits longer each time.
    pub async fn reconnect_due(&self) -> Result<()> {
        self.relink(true).await
    }

    async fn relink(&self, backoff: bool) -> Result<()> {
        // A pi whose integration restarted (reloaded for an update, or crashed) no longer
        // has the control its link went through: the link is lost, though nobody said so.
        for session in self.store.all_sessions().await?.into_iter().filter(|s| {
            s.stopped_at.is_none()
                && s.status == "connected"
                && s.harness == "pi"
                && s.host_id.as_deref() == self.store.host()
        }) {
            let owner = ChatIdentity::person(&session.owner_id);
            let locator = self.store.chat_session_locator(&owner, &session.id).await?;
            if locator["descriptor"]
                .as_str()
                .is_some_and(|path| !std::path::Path::new(path).exists())
            {
                self.store
                    .set_chat_session_status(
                        &owner,
                        &session.id,
                        ChatSessionStatus {
                            status: "attention".into(),
                            reason: Some(
                                "pi restarted its ZeroLux integration; linking it again".into(),
                            ),
                        },
                    )
                    .await?;
                self.changed();
            }
        }
        let linked = self.store.all_sessions().await?;
        // This host's sessions only: their native processes are here.
        for session in linked.into_iter().filter(|s| {
            s.stopped_at.is_none()
                && s.status == "attention"
                && s.host_id.as_deref() == self.store.host()
        }) {
            // The kernel acts for the person whose session it is.
            let owner = ChatIdentity::person(&session.owner_id);
            // A notice on a live link is for the owner: relinking would replace the link
            // and erase it. Only a lost link is relinked, and a failing one less often.
            if self.link_alive(&owner, &session).await || (backoff && !self.retry_due(&session.id))
            {
                continue;
            }
            if let Some(mode) = self.owned_mode(&owner, &session.id).await? {
                match self.reconnect_owned(&owner, &session, mode).await {
                    Ok(()) => self.retried(&session.id, true),
                    Err(error) => {
                        self.retried(&session.id, false);
                        tracing::warn!(
                            session_id = session.id,
                            error = format!("{error:#}"),
                            "Owned runner was not rebound"
                        );
                    }
                }
                continue;
            }
            let target = match sessions::resolve_linked(
                &session.harness,
                &session.native_session_id,
            )
            .await
            {
                target if session.harness == "pi" => {
                    match self.pi_target(&owner, &session, target).await {
                        Ok(target) => target,
                        Err(error) => {
                            self.retried(&session.id, false);
                            tracing::warn!(session_id=session.id, error=%error, "pi's saved session is unavailable");
                            continue;
                        }
                    }
                }
                Some(target) => target,
                None if session.harness == "claude-code" => {
                    let restored = self.restore_claude_terminal(&owner, &session).await;
                    self.retried(&session.id, restored.is_ok());
                    if let Err(error) = restored {
                        tracing::warn!(
                            session_id = session.id,
                            error = format!("{error:#}"),
                            "Entrusted Claude terminal could not be resumed"
                        );
                    }
                    continue;
                }
                // Codex keeps its threads: one the runtime no longer holds is still this
                // session, continued through Codex's own daemon.
                None if session.harness == "codex" => {
                    let homes = match self.store.chat_session_locator(&owner, &session.id).await {
                        Ok(locator) => crate::homes::Homes::of_locator(&locator),
                        Err(_) => continue,
                    };
                    let endpoint = match sessions::ensure_codex_daemon_in(&homes).await {
                        Ok(endpoint) => endpoint,
                        Err(error) => {
                            self.retried(&session.id, false);
                            tracing::warn!(
                                session_id = session.id,
                                error = format!("{error:#}"),
                                "Codex daemon unavailable; the session waits"
                            );
                            continue;
                        }
                    };
                    let mut native_locator = serde_json::json!({"endpoint": endpoint});
                    homes.record(&mut native_locator);
                    sessions::NativeSessionTarget {
                        harness: Harness::Codex,
                        native_session_id: session.native_session_id.clone(),
                        title: session.title.clone(),
                        workspace: session.workspace.clone(),
                        native_locator,
                    }
                }
                None => continue,
            };
            if let Some(lost) = self.agents.lock().await.remove(&session.id) {
                lost.release().await;
            }
            match self
                .link(&owner, target, "", session.actor_id.clone(), true)
                .await
            {
                // The owner stopped the relinking session while it was pairing: torn down.
                Ok((_, relinked)) if relinked.stopped_at.is_some() => {
                    self.retried(&session.id, true);
                    let _ = self.stop_session(&relinked.id).await;
                }
                Ok(_) => self.retried(&session.id, true),
                Err(error) => {
                    // An empty Codex session goes on in a new thread, as it was.
                    if session.harness == "codex"
                        && error.downcast_ref::<crate::codex::Rejected>().is_some()
                    {
                        match self.restart_unstarted_codex(&owner, &session).await {
                            Ok(true) => {
                                self.retried(&session.id, true);
                                continue;
                            }
                            Ok(false) => {}
                            Err(restart) => tracing::warn!(
                                session_id = session.id,
                                error = format!("{restart:#}"),
                                "Empty Codex session was not started again"
                            ),
                        }
                    }
                    self.retried(&session.id, false);
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
                    // A busy or restarting harness is not a reason to lose the agent: the
                    // session waits for attention and the next pass tries again.
                    self.store
                        .fail_chat_link(
                            &owner,
                            &session.id,
                            &format!("The link could not be restored ({error}); retrying."),
                        )
                        .await?;
                    self.changed();
                }
            }
        }
        Ok(())
    }

    /// A Codex session that never had a message, whose thread Codex cannot resume: it holds
    /// nothing, so the session goes on in a new thread, in the same folder and with the same
    /// model, effort, approvals and sandbox. False when the thread has had a message.
    async fn restart_unstarted_codex(
        &self,
        owner: &ChatIdentity,
        session: &ChatSession,
    ) -> Result<bool> {
        let locator = self.store.chat_session_locator(owner, &session.id).await?;
        let homes = crate::homes::Homes::of_locator(&locator);
        let endpoint = sessions::ensure_codex_daemon_in(&homes).await?;
        let Some(thread) = CodexDriver::unstarted(&endpoint, &session.native_session_id).await?
        else {
            return Ok(false);
        };
        ensure!(
            self.store
                .relink_wanted("codex", &session.native_session_id)
                .await?,
            "The session was stopped before it was started again"
        );
        // As last recorded; model and effort as Codex keeps them, if not recorded.
        let settings = &locator["settings"];
        let text = |key: &str| settings[key].as_str().map(str::to_owned);
        let initial = AgentSettings {
            model: text("model").or_else(|| thread["model"].as_str().map(str::to_owned)),
            effort: text("effort")
                .or_else(|| thread["reasoningEffort"].as_str().map(str::to_owned)),
            ..AgentSettings::default()
        };
        let policy = serde_json::from_value(settings["approval_policy"].clone()).unwrap_or(None);
        let sandbox = serde_json::from_value(settings["sandbox"].clone()).unwrap_or(None);
        let driver =
            CodexDriver::start(&endpoint, &session.workspace, policy, sandbox, &initial).await?;
        let thread_id = driver.thread_id().to_owned();
        self.store
            .replace_native_session(owner, &session.id, &thread_id)
            .await?;
        tracing::info!(
            session_id = session.id,
            previous = session.native_session_id,
            thread_id,
            "Empty Codex session continues in a new thread"
        );
        let mut native_locator = serde_json::json!({"endpoint": endpoint});
        homes.record(&mut native_locator);
        let target = sessions::NativeSessionTarget {
            harness: Harness::Codex,
            native_session_id: thread_id,
            title: session.title.clone(),
            workspace: session.workspace.clone(),
            native_locator,
        };
        self.bind(
            owner,
            target,
            "",
            session.actor_id.clone(),
            true,
            Some(NativeDriver::Codex(Box::new(driver))),
        )
        .await?;
        Ok(true)
    }

    /// Whether the session's link is still up: its kernel-side adapter runs and, for pi, the
    /// extension still holds this link. An older pi extension does not say: as before, its
    /// session is relinked.
    async fn link_alive(&self, owner: &ChatIdentity, session: &ChatSession) -> bool {
        let running = self
            .agents
            .lock()
            .await
            .get(&session.id)
            .is_some_and(|agent| !agent.task.is_finished());
        if !running || session.harness != "pi" {
            return running;
        }
        let Ok(locator) = self.store.chat_session_locator(owner, &session.id).await else {
            return false;
        };
        let Some(path) = locator["descriptor"].as_str() else {
            return false;
        };
        let Ok(record) = sessions::descriptor(std::path::Path::new(path)).await else {
            return false;
        };
        sessions::control(&record, serde_json::json!({"method":"describe"}))
            .await
            .is_ok_and(|actual| {
                actual["links"]
                    .as_array()
                    .is_some_and(|links| links.iter().any(|link| link == session.id.as_str()))
            })
    }

    /// A failing relink is retried after 10 s, then less and less often, up to 5 minutes.
    fn retry_due(&self, id: &str) -> bool {
        self.retries
            .lock()
            .unwrap()
            .get(id)
            .is_none_or(|(_, next)| std::time::Instant::now() >= *next)
    }

    fn retried(&self, id: &str, succeeded: bool) {
        let mut retries = self.retries.lock().unwrap();
        if succeeded {
            retries.remove(id);
            return;
        }
        let failures = retries.get(id).map_or(0, |(failures, _)| *failures) + 1;
        let wait =
            Duration::from_secs(10 * 2u64.pow(failures.min(5))).min(Duration::from_secs(300));
        retries.insert(id.to_owned(), (failures, std::time::Instant::now() + wait));
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
                    dunce::canonicalize(native_cwd)? == dunce::canonicalize(&session.workspace)?,
                    "The Codex workspace changed before pairing"
                );
            }
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
        let settings = match &driver {
            NativeDriver::Codex(driver) => Some(driver.settings_control()),
            NativeDriver::Claude(_) => None,
        };
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
                driver.run(base_url, session_id.clone(), token, invalidations, stop.clone()).await
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
                && let Ok(owner) = store.session_person(&session_id).await
            {
                let _ = store
                    .set_chat_session_status(
                        &owner,
                        &session_id,
                        ChatSessionStatus {
                            status: "attention".into(),
                            reason: Some(
                                "Needs attention. Unconfirmed messages were not sent again.".into(),
                            ),
                        },
                    )
                    .await;
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
                settings,
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
        let mut runner = self
            .pi_runners
            .find(&session.native_session_id, &session.workspace)
            .await?;
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
            crate::homes::Homes::of_locator(&target.native_locator)
                .record(&mut actual.native_locator);
            target = actual;
        }
        let owner = self.store.session_person(&session.id).await?;
        if self
            .store
            .chat_session(&owner, &session.id)
            .await?
            .stopped_at
            .is_some()
        {
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
        let owned = runner.is_some();
        let session_id = session.id.clone();
        let task = tokio::spawn(async move {
            let _ = stop.wait_for(|stopped| *stopped).await;
            link.shutdown().await?;
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
                stop_note: if owned {
                    None
                } else {
                    Some("Stopped. pi did not confirm it stopped working.")
                },
                settings: None,
            },
        );
        Ok(())
    }

    pub async fn stop_session(&self, id: &str) -> Result<Option<&'static str>> {
        self.live.forget(id);
        self.terminals.close_all(id);
        // On a joined computer: it stops its adapter there.
        let owner = self.store.session_person(id).await?;
        let session = self.store.chat_session(&owner, id).await?;
        if let Some(host) = self.remote_host(&session) {
            // Offline, its computer cannot be asked: the session is stopped here, and its token
            // no longer works there.
            if !self.hosts.online(&host).await {
                return Ok(Some(
                    "Stopped. Its computer is offline, so its harness did not confirm it stopped working.",
                ));
            }
            self.stop_on(&host, &session).await?;
            return Ok(None);
        }
        let agent = self.agents.lock().await.remove(id);
        let Some(mut agent) = agent else {
            if self.stop_untracked_owned(id).await? {
                return Ok(None);
            }
            {
                let owner = self.store.session_person(id).await?;
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
                "Stopped. Its harness did not confirm it stopped working.",
            ));
        };
        // An adapter that had already ended (its link lost) before the owner's Stop is not a
        // stop that failed: there was nothing live to cancel, and the note says so.
        let gone = agent.task.is_finished();
        agent.stop.send_replace(true);
        let (driver, subscriber) = tokio::join!(finish(&mut agent.task), async {
            if let Some(subscriber) = &mut agent.subscriber {
                finish(subscriber).await
            } else {
                Ok(())
            }
        });
        if gone && let Err(error) = &driver {
            tracing::warn!(
                session_id = id,
                error = format!("{error:#}"),
                "Stopped a link that had already ended"
            );
            subscriber?;
            return Ok(Some(
                "Stopped. Its harness did not confirm it stopped working.",
            ));
        }
        // The stop revokes the token before it reaches the adapter: a request the adapter made
        // in between is refused, and that is the stop, not a failure.
        let revoked = |result: Result<()>| match result {
            Err(error) if error.is::<crate::chat_driver::Revoked>() => Ok(()),
            other => other,
        };
        revoked(driver)?;
        revoked(subscriber)?;
        Ok(agent.stop_note)
    }

    /// Stops the kernel side only. Native work keeps running: the owner did not press Stop,
    /// and the next start relinks the sessions and reconciles what happened meanwhile.
    pub async fn shutdown(&self) -> Result<()> {
        self.stop.send_replace(true);
        let mut error = None;
        self.extensions.shutdown().await;
        if let Some(notices) = self.host_notice_task.lock().await.take() {
            notices.abort();
        }
        if let Some(notices) = self.terminal_notices.lock().await.take() {
            notices.abort();
            let _ = notices.await;
        }
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
        if let Some(mut watcher) = self.watcher.lock().await.take()
            && tokio::time::timeout(Duration::from_secs(5), &mut watcher)
                .await
                .is_err()
        {
            watcher.abort();
            let _ = watcher.await;
        }
        error.map_or(Ok(()), Err)
    }
}

mod control;
pub(crate) use control::localize_images;
pub mod background;
mod fork;
mod owned;
mod plans;
mod remote;
mod settings;
mod subagents;
pub use subagents::Subagent;
pub(crate) use subagents::{events as subagent_events_of, list as subagents_of};

async fn finish(task: &mut JoinHandle<Result<()>>) -> Result<()> {
    match tokio::time::timeout(Duration::from_secs(10), &mut *task).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => Err(error).context("Native adapter task stopped unexpectedly"),
        Err(_) => {
            task.abort();
            let _ = task.await;
            bail!("Stopped. Its harness did not confirm it stopped working.");
        }
    }
}
