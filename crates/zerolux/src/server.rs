//! The kernel lifecycle shared by the CLI and embedders. No desktop dependencies.
//!
//! One kernel serves one or more workspaces at one address, each under `/w/{id}`: each
//! workspace is its own folder of data, with its own database, sign-in and agents.
use std::{
    collections::HashMap,
    future::Future,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, bail};
use tokio::{net::TcpListener, sync::watch, task::JoinHandle};

use crate::{
    api,
    chat_runtime::ChatRuntime,
    db::Location,
    lease::Lease,
    livekit::{LiveKit, LiveKitConfig},
    model::WorkspaceInfo,
    store::Store,
};

#[derive(Clone)]
pub struct ServerOptions {
    pub address: SocketAddr,
    pub expose: Option<IpAddr>,
    /// Where the first workspace keeps what is local to it: links, sockets, secrets; and where
    /// this kernel keeps its LiveKit assets.
    pub data_dir: PathBuf,
    /// The first workspace's data: a SQLite file (usually in `data_dir`) or a PostgreSQL server.
    pub database: Location,
    /// An embedder's name for a new workspace, before its first account is bound.
    /// Existing workspace connections leave this unset.
    pub initial_workspace_name: Option<String>,
    pub web_dir: PathBuf,
    /// An explicit configuration avoids inheriting service credentials in embedders/tests.
    /// `None` retains the CLI's LIVEKIT_* environment configuration.
    pub livekit: Option<LiveKitConfig>,
    /// The origin a reverse proxy serves this kernel at, with the LiveKit address clients
    /// reach from there. `None`: this computer and the exposed address only.
    pub public: Option<Arc<api::PublicOrigin>>,
    pub runner: Option<crate::claude_runner::RunnerProgram>,
    /// Human sign-in through the authentication service started from here. `None` (tests,
    /// embedders) runs the kernel as it ran before accounts: the local owner is implicit.
    pub auth: Option<crate::auth::AuthEntry>,
}

/// Another workspace for a running kernel: a folder of its own, usually `<folder>/.zerolux`.
#[derive(Clone)]
pub struct WorkspaceOptions {
    pub data_dir: PathBuf,
    pub database: Location,
    /// Its name, when the folder holds no workspace yet.
    pub initial_workspace_name: Option<String>,
}

impl WorkspaceOptions {
    /// The workspace kept in `data_dir`, in its SQLite database there.
    pub fn in_folder(data_dir: PathBuf, initial_workspace_name: Option<String>) -> Self {
        Self {
            database: Location::Sqlite(data_dir.join("zerolux.db")),
            data_dir,
            initial_workspace_name,
        }
    }
}

/// Dropping requests shutdown; `shutdown`/`run_until` also wait for cleanup.
/// Shutdown releases kernel links, never Stops or restarts native agents.
pub struct Server {
    address: SocketAddr,
    stop: watch::Sender<bool>,
    task: Option<JoinHandle<Result<()>>>,
    shared: Arc<Shared>,
}

/// A running kernel's workspaces, for whoever keeps it while `run_until` waits on it.
#[derive(Clone)]
pub struct ServerHandle {
    shared: Arc<Shared>,
}

/// What every workspace of a kernel shares: its addresses, services and programs.
struct Shared {
    address: SocketAddr,
    expose: Option<IpAddr>,
    exposed: Option<Arc<api::Exposed>>,
    public: Option<Arc<api::PublicOrigin>>,
    web_dir: PathBuf,
    runner: Option<crate::claude_runner::RunnerProgram>,
    auth: Option<crate::auth::AuthEntry>,
    livekit: Arc<LiveKit>,
    livekit_config: LiveKitConfig,
    workspaces: Arc<api::Workspaces>,
    running: tokio::sync::Mutex<HashMap<String, Running>>,
    stopped: watch::Receiver<bool>,
}

/// A workspace being served, until it is asked to stop.
struct Running {
    stop: watch::Sender<bool>,
    task: JoinHandle<Result<()>>,
}

impl Server {
    pub async fn start(options: ServerOptions) -> Result<Self> {
        Self::start_inner(options, None, None).await
    }

    /// Continue ownership without releasing the lease between an offline backup and start.
    pub async fn start_with_lease(options: ServerOptions, lease: Lease) -> Result<Self> {
        lease.ensure_for(&options.database)?;
        Self::start_inner(options, Some(lease), None).await
    }

    async fn start_inner(
        options: ServerOptions,
        lease: Option<Lease>,
        handoff: Option<tokio::sync::mpsc::Sender<crate::handoff::Request>>,
    ) -> Result<Self> {
        if !options.address.ip().is_loopback() {
            bail!("The kernel listens on this computer; use --expose for other devices");
        }
        if options
            .expose
            .is_some_and(|ip| ip.is_loopback() || ip.is_unspecified())
        {
            bail!("--expose takes one address of this computer on a private network");
        }
        // Bind before opening storage: a busy port must not recover another kernel's sessions.
        let listener = TcpListener::bind(options.address).await.with_context(|| {
            format!(
                "Cannot listen on {}: another program uses this address",
                options.address
            )
        })?;
        let address = listener.local_addr()?;
        let exposed = match options.expose {
            Some(ip) => Some(
                TcpListener::bind(SocketAddr::new(ip, address.port()))
                    .await
                    .context("Listen on the exposed address")?,
            ),
            None => None,
        };
        tokio::fs::create_dir_all(&options.data_dir)
            .await
            .context("Create the data directory")?;
        // One running kernel per SQLite workspace: the lease comes before migrations and
        // before anything is started for the workspace. Held until cleanup ends.
        let lease = match lease {
            Some(lease) => lease,
            None => Lease::acquire(&options.database)?,
        };
        let livekit_config = options
            .livekit
            .clone()
            .unwrap_or_else(|| LiveKitConfig::from_env(options.data_dir.clone()));
        let livekit =
            Arc::new(LiveKit::start_exposed(livekit_config.clone(), options.expose).await?);
        let (stop, stopped) = watch::channel(false);
        let shared = Arc::new(Shared {
            address,
            expose: options.expose,
            exposed: exposed
                .as_ref()
                .map(|listener| api::Exposed::new(listener.local_addr().expect("bound listener"))),
            public: options.public.clone(),
            web_dir: options.web_dir.clone(),
            runner: options.runner.clone(),
            auth: options.auth.clone(),
            livekit: livekit.clone(),
            livekit_config,
            workspaces: Arc::default(),
            running: tokio::sync::Mutex::default(),
            stopped: stopped.clone(),
        });
        let first = WorkspaceOptions {
            data_dir: options.data_dir,
            database: options.database,
            initial_workspace_name: options.initial_workspace_name,
        };
        if let Err(error) = shared.serve(first, lease, handoff).await {
            if let Err(cleanup) = livekit.shutdown().await {
                tracing::error!(%cleanup, "LiveKit cleanup failed after startup error");
            }
            return Err(error);
        }
        let request_stop = stop.clone();
        let app = api::instance_router(
            shared.workspaces.clone(),
            shared.web_dir.clone(),
            shared.exposed.clone(),
            shared.public.clone(),
        )
        .into_make_service_with_connect_info::<SocketAddr>();
        tracing::info!(%address, "ZeroLux kernel ready");
        let instance = shared.clone();
        let task = tokio::spawn(async move {
            let mut servers = tokio::task::JoinSet::new();
            if let Some(listener) = exposed {
                tracing::info!(address = %listener.local_addr().expect("bound listener"), "Also serving the owner's other devices (unauthenticated)");
                servers.spawn(
                    axum::serve(listener, app.clone())
                        .with_graceful_shutdown(stopping(stopped.clone()))
                        .into_future(),
                );
            }
            servers.spawn(
                axum::serve(listener, app)
                    .with_graceful_shutdown(stopping(stopped))
                    .into_future(),
            );
            let mut result = Ok(());
            while let Some(completed) = servers.join_next().await {
                // Any listener ending (including failure) shuts down the whole host.
                request_stop.send_replace(true);
                if let Err(error) = completed
                    .context("Kernel HTTP task failed")
                    .and_then(|r| r.context("Kernel HTTP server failed"))
                {
                    result = Err(error);
                }
            }
            let workspaces_stopped = instance.stop_all().await;
            let livekit_stopped = instance.livekit.shutdown().await;
            result?;
            workspaces_stopped?;
            livekit_stopped
        });
        Ok(Self {
            address,
            stop,
            task: Some(task),
            shared,
        })
    }

    pub fn address(&self) -> SocketAddr {
        self.address
    }

    /// The kernel's own address; each workspace is under `/w/{id}` there.
    pub fn url(&self) -> String {
        format!("http://{}", self.address)
    }

    /// Adds, removes and lists its workspaces, even while `run_until` holds the server.
    pub fn handle(&self) -> ServerHandle {
        ServerHandle {
            shared: self.shared.clone(),
        }
    }

    pub async fn run_until(mut self, shutdown: impl Future<Output = ()>) -> Result<()> {
        let mut task = self.task.take().expect("server task is owned");
        tokio::select! {
            result = &mut task => result.context("Kernel lifecycle task failed")?,
            () = shutdown => {
                self.stop.send_replace(true);
                task.await.context("Kernel lifecycle task failed")?
            }
        }
    }

    pub async fn shutdown(self) -> Result<()> {
        self.run_until(async {}).await
    }
}

impl ServerHandle {
    /// The kernel's own address; each workspace is under `/w/{id}` there.
    pub fn url(&self) -> String {
        format!("http://{}", self.shared.address)
    }

    /// Where a workspace of this kernel answers: what its clients and agents call.
    pub fn workspace_url(&self, id: &str) -> String {
        format!("{}/w/{id}", self.url())
    }

    /// The workspaces this kernel serves, oldest first.
    pub async fn workspaces(&self) -> Result<Vec<WorkspaceInfo>> {
        let stores: Vec<Store> = self
            .shared
            .workspaces
            .read()
            .expect("workspaces")
            .values()
            .map(|hosted| hosted.store.clone())
            .collect();
        let mut infos = Vec::with_capacity(stores.len());
        for store in stores {
            infos.push(store.workspace_info().await?);
        }
        infos.sort_by_key(|info| info.created_at);
        Ok(infos)
    }

    /// Serves one more workspace: the one in its folder, or a new one there.
    pub async fn add_workspace(&self, options: WorkspaceOptions) -> Result<WorkspaceInfo> {
        if *self.shared.stopped.borrow() {
            bail!("The kernel is stopping");
        }
        tokio::fs::create_dir_all(&options.data_dir)
            .await
            .context("Create the workspace's folder")?;
        let lease = Lease::acquire(&options.database)?;
        self.shared.serve(options, lease, None).await
    }

    /// The same, continuing a lease already held, as after an offline backup or a handover.
    pub async fn add_workspace_with_lease(
        &self,
        options: WorkspaceOptions,
        lease: Lease,
    ) -> Result<WorkspaceInfo> {
        lease.ensure_for(&options.database)?;
        self.shared.serve(options, lease, None).await
    }

    /// Stops serving a workspace, the first one too. Its folder and data stay as they are.
    pub async fn remove_workspace(&self, id: &str) -> Result<()> {
        self.shared.stop_one(id).await
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}

async fn stopping(mut stopped: watch::Receiver<bool>) {
    let _ = stopped.wait_for(|stop| *stop).await;
}

impl Shared {
    /// Starts serving the workspace in `options.data_dir`, whose lease is held: until it is
    /// removed or the kernel stops.
    async fn serve(
        self: &Arc<Self>,
        options: WorkspaceOptions,
        lease: Lease,
        handoff: Option<tokio::sync::mpsc::Sender<crate::handoff::Request>>,
    ) -> Result<WorkspaceInfo> {
        if *self.stopped.borrow() {
            bail!("The kernel is stopping");
        }
        let data_dir = options.data_dir;
        let new = !data_dir.join("host-id").exists();
        let store = Store::open_at(&options.database)
            .await
            .context("Open the database")?;
        if let Some(name) = options.initial_workspace_name
            && !store.owner_bound().await?
        {
            store
                .set_workspace_name(crate::model::SetWorkspaceName { name })
                .await
                .context("Name the new workspace")?;
        }
        // This kernel's host: the agent sessions it starts live here, and only it links them.
        let host_id = host_id(&data_dir).await?;
        let store = store
            .hosted(host_id.clone())
            .with_people(data_dir.join("people"));
        store.register_host().await?;
        store.adopt_read_positions().await?;
        let workspace = store.workspace_info().await?;
        if self
            .workspaces
            .read()
            .expect("workspaces")
            .contains_key(&workspace.id)
        {
            bail!("This kernel already serves this workspace");
        }
        if new {
            exclude_from_git(&data_dir);
        }
        let handoff = match (handoff, &options.database) {
            (Some(send), Location::Sqlite(database)) => Some(crate::handoff::Control {
                configuration: crate::handoff::Configuration {
                    info: crate::handoff::Info {
                        instance: uuid::Uuid::new_v4().to_string(),
                        workspace_id: workspace.id.clone(),
                        workspace_name: workspace.name.clone(),
                        host_id,
                        version: crate::build::version().to_owned(),
                        schema: crate::build::schema().to_owned(),
                        directory: dunce::canonicalize(&data_dir)?,
                        database: dunce::canonicalize(database)?,
                        network: crate::handoff::Network {
                            listen: self.address.ip(),
                            port: self.address.port(),
                            expose: self.expose,
                            public_origin: self
                                .public
                                .as_ref()
                                .map(|public| public.origin().to_owned()),
                            public_livekit_url: self
                                .public
                                .as_ref()
                                .and_then(|public| public.livekit_url().map(str::to_owned)),
                        },
                        external_livekit: self.livekit_config.url.is_some(),
                        authenticated: self.auth.is_some(),
                    },
                    livekit: self.livekit_config.clone(),
                },
                send,
                busy: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            }),
            _ => None,
        };
        let origin = format!("http://{}", self.address);
        let auth = match &self.auth {
            Some(entry) => {
                // The exact origins clients sign in from: this computer, the exposed address,
                // the public origin and the desktop app. Cookies are set for the public origin
                // when there is one.
                let mut origins = vec![
                    origin.clone(),
                    format!("http://localhost:{}", self.address.port()),
                    "tauri://localhost".to_owned(),
                    "http://tauri.localhost".to_owned(),
                ];
                if let Some(expose) = self.expose {
                    origins.push(format!(
                        "http://{}",
                        SocketAddr::new(expose, self.address.port())
                    ));
                }
                let canonical = match &self.public {
                    Some(public) => public.origin().to_owned(),
                    None => origin.clone(),
                };
                let secret = store.auth_secret().await?;
                // Kernels of one workspace start their services one at a time: the service
                // migrates its own tables on start. PostgreSQL only; SQLite has one host.
                let turn = match &options.database {
                    Location::Postgres(_) => Some(store.write().await?),
                    Location::Sqlite(_) => None,
                };
                let service = crate::auth::AuthService::start(
                    entry,
                    &workspace.id,
                    &options.database,
                    &secret,
                    &canonical,
                    &origins,
                )
                .await?;
                if let Some(turn) = turn {
                    turn.commit().await?;
                }
                Some(Arc::new(api::Auth {
                    service: Arc::new(service),
                }))
            }
            None => None,
        };
        let livekit = Arc::new(self.livekit.scoped(&workspace.id));
        // Agents and joined computers call the workspace at its own address.
        let base_url = format!("{origin}/w/{}", workspace.id);
        let links = std::path::absolute(data_dir.join("links"))?;
        let started = match self.runner.clone() {
            Some(program) => {
                ChatRuntime::start_with_runner(store.clone(), livekit, base_url, links, program)
                    .await
            }
            None => ChatRuntime::start(store.clone(), livekit, base_url, links).await,
        };
        let runtime = match started {
            Ok(runtime) => runtime,
            Err(error) => {
                if let Some(auth) = &auth {
                    auth.service.shutdown().await;
                }
                return Err(error);
            }
        };
        let router = api::router_public(
            store.clone(),
            self.web_dir.clone(),
            Some(runtime.clone()),
            self.exposed.clone(),
            self.public.clone(),
            auth.clone(),
        );
        let (stop, stopped) = watch::channel(false);
        let task = tokio::spawn(run_workspace(
            runtime.clone(),
            data_dir,
            handoff,
            auth,
            lease,
            stopped,
        ));
        self.workspaces.write().expect("workspaces").insert(
            workspace.id.clone(),
            Arc::new(api::Hosted {
                store,
                runtime,
                router,
            }),
        );
        self.running
            .lock()
            .await
            .insert(workspace.id.clone(), Running { stop, task });
        tracing::info!(workspace = workspace.id, "Serving the workspace");
        Ok(workspace)
    }

    async fn stop_one(&self, id: &str) -> Result<()> {
        let running = self
            .running
            .lock()
            .await
            .remove(id)
            .context("This kernel serves no such workspace")?;
        self.workspaces.write().expect("workspaces").remove(id);
        running.stop.send_replace(true);
        running.task.await.context("Workspace task failed")?
    }

    async fn stop_all(&self) -> Result<()> {
        let running: Vec<_> = self.running.lock().await.drain().collect();
        self.workspaces.write().expect("workspaces").clear();
        let mut result = Ok(());
        for (_, running) in &running {
            running.stop.send_replace(true);
        }
        for (_, running) in running {
            let stopped = running.task.await.context("Workspace task failed");
            if let Err(error) = stopped.and_then(|stopped| stopped) {
                result = Err(error);
            }
        }
        result
    }
}

/// A workspace's own work while it is served: its agents' links, schedules, extensions and
/// local channel. Its sign-in and lease end with it.
async fn run_workspace(
    runtime: Arc<ChatRuntime>,
    data_dir: PathBuf,
    handoff: Option<crate::handoff::Control>,
    auth: Option<Arc<api::Auth>>,
    lease: Lease,
    mut stopped: watch::Receiver<bool>,
) -> Result<()> {
    let relink = runtime.clone();
    let relinker = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(10));
        loop {
            interval.tick().await;
            if let Err(error) = relink.reconnect_due().await {
                tracing::error!(error = format!("{error:#}"), "Relinking sessions failed");
            }
        }
    });
    let settings = runtime.clone();
    let settings_observer = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(10));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if let Err(error) = settings.refresh_settings().await {
                tracing::warn!(error = %error, "Native settings observation failed");
            }
        }
    });
    // The owner's schedules: each one's input reaches its session when its time comes.
    let schedule = runtime.clone();
    let scheduler = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(20));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if let Err(error) = schedule.run_schedules().await {
                tracing::warn!(error = format!("{error:#}"), "Schedules did not run");
            }
        }
    });
    // Sessions hear how the commands they run in the background end.
    let background = tokio::spawn(crate::chat_runtime::background::watch(Arc::downgrade(
        &runtime,
    )));
    // The workspace's extensions, enabled as they were; their schedule triggers.
    // Extensions being worked on start again as their folders change.
    let watched = runtime.extensions.clone();
    let extension_reloads = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            watched.reload_changed().await;
        }
    });
    let extensions = runtime.extensions.clone();
    let extension_schedules = tokio::spawn(async move {
        extensions.start_enabled().await;
        let mut interval = tokio::time::interval(Duration::from_secs(20));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            extensions.run_schedules().await;
        }
    });
    // The local channel: the owner's commands from this computer, such as `zerolux ext dev`.
    let control = {
        let (data_dir, runtime) = (std::path::absolute(&data_dir)?, runtime.clone());
        tokio::spawn(async move {
            if let Err(error) =
                crate::local_control::serve_with_handoff(&data_dir, runtime, handoff).await
            {
                tracing::warn!(error = format!("{error:#}"), "Local channel stopped");
            }
        })
    };
    // Triggers: a session hears when the CI runs of its commit end.
    let watch = runtime.clone();
    let watcher = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if let Err(error) = watch.run_triggers().await {
                tracing::warn!(error = format!("{error:#}"), "Triggers did not run");
            }
        }
    });
    // People whose sign-in ended while connected to the notice room are disconnected.
    let sweep = runtime.clone();
    let sweeper = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            if let Err(error) = sweep.sweep_expired().await {
                tracing::error!(error = format!("{error:#}"), "Realtime sweep failed");
            }
        }
    });
    let _ = stopped.wait_for(|stop| *stop).await;
    for task in [
        relinker,
        sweeper,
        scheduler,
        watcher,
        extension_schedules,
        extension_reloads,
        control,
        background,
        settings_observer,
    ] {
        task.abort();
        let _ = task.await;
    }
    let runtime_stopped = runtime.shutdown().await;
    if let Some(auth) = &auth {
        auth.service.shutdown().await;
    }
    // Released last, once everything else has stopped.
    drop(lease);
    runtime_stopped
}

/// A new workspace in a git repository stays out of its commits: `.git/info/exclude` is the
/// repository's own, never committed.
fn exclude_from_git(data_dir: &std::path::Path) {
    let (Some(folder), Some(name)) = (data_dir.parent(), data_dir.file_name()) else {
        return;
    };
    let info = folder.join(".git/info");
    if !info.is_dir() {
        return;
    }
    let line = format!("/{}/", name.to_string_lossy());
    let exclude = info.join("exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if existing.lines().any(|known| known.trim() == line) {
        return;
    }
    let separator = if existing.is_empty() || existing.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    if let Err(error) = std::fs::write(&exclude, format!("{existing}{separator}{line}\n")) {
        tracing::warn!(%error, "The workspace folder could not be kept out of git");
    }
}

/// The terminal remains the recovery owner until an embedder commits the handoff.
/// A lost acknowledgement never authorizes killing the new owner or restoring a database.
pub async fn serve_cli(options: ServerOptions) -> Result<()> {
    use std::io::IsTerminal;
    // An interactive CLI may relinquish its workspace. A service manager may restart a
    // non-interactive process after it exits, so it gets no adoption capability.
    if !std::io::stdin().is_terminal() {
        return Server::start(options)
            .await?
            .run_until(shutdown_signal())
            .await;
    }
    serve_cli_until(options, shutdown_signal()).await
}

/// The same supervisor with an explicit shutdown request, including temporary tests.
pub async fn serve_cli_until(
    mut options: ServerOptions,
    signal: impl Future<Output = ()>,
) -> Result<()> {
    options.data_dir = std::path::absolute(&options.data_dir)?;
    if let Location::Sqlite(path) = &mut options.database {
        *path = std::path::absolute(&*path)?;
    }
    options.livekit = Some(
        options
            .livekit
            .take()
            .unwrap_or_else(|| LiveKitConfig::from_env(options.data_dir.clone())),
    );
    let (send, mut requests) = tokio::sync::mpsc::channel::<crate::handoff::Request>(1);
    tokio::pin!(signal);
    let mut recovering = false;
    loop {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        let mut server = loop {
            match Server::start_inner(options.clone(), None, Some(send.clone())).await {
                Ok(server) => break server,
                Err(error)
                    if recovering
                        && tokio::time::Instant::now() < deadline
                        && (error.chain().any(|cause| {
                            cause
                                .downcast_ref::<std::io::Error>()
                                .is_some_and(|error| error.kind() == std::io::ErrorKind::AddrInUse)
                        }) || format!("{error:#}")
                            .contains("Another ZeroLux kernel already serves")) =>
                {
                    tokio::select! { _ = &mut signal => return Ok(()), _ = tokio::time::sleep(Duration::from_millis(250)) => {} }
                }
                Err(error) => {
                    return Err(error.context(
                        "The CLI could not resume; another owner is never stopped automatically",
                    ));
                }
            }
        };
        // `--port 0` chooses once; a cancelled transfer resumes the same origin.
        options.address = server.address();
        let mut task = server.task.take().expect("CLI owns the lifecycle");
        let request = tokio::select! {
            result = &mut task => return result.context("Kernel lifecycle task failed")?,
            _ = &mut signal => { server.stop.send_replace(true); return task.await.context("Kernel lifecycle task failed")?; },
            request = requests.recv() => request.context("The handoff channel closed")?,
        };
        server.stop.send_replace(true);
        let stopped = task.await.context("Kernel lifecycle task failed")?;
        if let Err(error) = stopped {
            let message = format!("The kernel could not finish stopping: {error:#}");
            let _ = request.ready.send(Err(message));
            recovering = true;
            continue;
        }
        let ready = request.ready.send(Ok(request.configuration));
        let committed = ready.is_ok()
            && matches!(
                tokio::time::timeout(Duration::from_secs(610), request.decision).await,
                Ok(Ok(true))
            );
        if committed {
            return Ok(());
        }
        recovering = true;
    }
}

/// The identity of this kernel host, made once in its data directory.
async fn host_id(data_dir: &std::path::Path) -> Result<String> {
    let path = data_dir.join("host-id");
    match tokio::fs::read_to_string(&path).await {
        Ok(existing) if !existing.trim().is_empty() => Ok(existing.trim().to_owned()),
        Ok(_) => bail!("The host identity file {} is empty", path.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let id = uuid::Uuid::new_v4().to_string();
            crate::auth::write_private(&path, &id).await?;
            Ok(id)
        }
        Err(error) => Err(error).with_context(|| format!("Read {}", path.display())),
    }
}

/// Ctrl-C or SIGTERM: the kernel's request to stop.
pub async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
