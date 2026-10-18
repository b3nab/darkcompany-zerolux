//! The kernel lifecycle shared by the CLI and embedders. No desktop dependencies.
use std::{
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
    store::Store,
};

pub struct ServerOptions {
    pub address: SocketAddr,
    pub expose: Option<IpAddr>,
    /// Where this kernel keeps what is local to it: links, sockets, secrets, LiveKit assets.
    pub data_dir: PathBuf,
    /// The workspace's data: a SQLite file (usually in `data_dir`) or a PostgreSQL server.
    pub database: Location,
    pub web_dir: PathBuf,
    /// An explicit configuration avoids inheriting service credentials in embedders/tests.
    /// `None` retains the CLI's LIVEKIT_* environment configuration.
    pub livekit: Option<LiveKitConfig>,
    /// The origin a reverse proxy serves this kernel at, with the LiveKit address clients
    /// reach from there. `None`: this computer and the exposed address only.
    pub public: Option<Arc<api::PublicOrigin>>,
    #[cfg(unix)]
    pub runner: Option<crate::claude_runner::RunnerProgram>,
    /// Human sign-in through the authentication service started from here. `None` (tests,
    /// embedders) runs the kernel as it ran before accounts: the local owner is implicit.
    pub auth: Option<crate::auth::AuthEntry>,
}

/// Dropping requests shutdown; `shutdown`/`run_until` also wait for cleanup.
/// Shutdown releases kernel links, never Stops or restarts native agents.
pub struct Server {
    address: SocketAddr,
    stop: watch::Sender<bool>,
    task: Option<JoinHandle<Result<()>>>,
}

impl Server {
    pub async fn start(options: ServerOptions) -> Result<Self> {
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
        let listener = TcpListener::bind(options.address)
            .await
            .with_context(|| format!("Cannot listen on {}. Close the service using this address and retry; no other server was used.", options.address))?;
        let address = listener.local_addr()?;
        let exposed = match options.expose {
            Some(ip) => Some(
                TcpListener::bind(SocketAddr::new(ip, address.port()))
                    .await
                    .context("Listen on the exposed address")?,
            ),
            None => None,
        };
        let data_dir = options.data_dir;
        tokio::fs::create_dir_all(&data_dir)
            .await
            .context("Create the data directory")?;
        // One running kernel per SQLite workspace: the lease comes before migrations and
        // before anything is started for the workspace. Held until cleanup ends.
        let lease = Lease::acquire(&options.database)?;
        let store = Store::open_at(&options.database)
            .await
            .context("Open the database")?;
        // This kernel's host: the agent sessions it starts live here, and only it links them.
        let host_id = host_id(&data_dir).await?;
        let store = store.hosted(host_id);
        let workspace = store.workspace_info().await?;
        let base_url = format!("http://{address}");
        let auth = match &options.auth {
            Some(entry) => {
                // The exact origins clients sign in from: this computer, the exposed address,
                // the public origin and the desktop app. Cookies are set for the public origin
                // when there is one.
                let mut origins = vec![
                    base_url.clone(),
                    format!("http://localhost:{}", address.port()),
                    "tauri://localhost".to_owned(),
                    "http://tauri.localhost".to_owned(),
                ];
                if let Some(listener) = &exposed {
                    origins.push(format!("http://{}", listener.local_addr()?));
                }
                let canonical = match &options.public {
                    Some(public) => public.origin().to_owned(),
                    None => base_url.clone(),
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
        let livekit = Arc::new(
            LiveKit::start_exposed(
                options
                    .livekit
                    .unwrap_or_else(|| LiveKitConfig::from_env(data_dir.clone())),
                options.expose,
            )
            .await?
            .for_workspace(&workspace.id),
        );
        let links = std::path::absolute(data_dir.join("links"))?;
        #[cfg(unix)]
        let started = match options.runner {
            Some(program) => {
                ChatRuntime::start_with_runner(
                    store.clone(),
                    livekit.clone(),
                    base_url,
                    links,
                    program,
                )
                .await
            }
            None => ChatRuntime::start(store.clone(), livekit.clone(), base_url, links).await,
        };
        #[cfg(not(unix))]
        let started = ChatRuntime::start(store.clone(), livekit.clone(), base_url, links).await;
        let runtime = match started {
            Ok(runtime) => runtime,
            Err(error) => {
                if let Err(cleanup) = livekit.shutdown().await {
                    tracing::error!(%cleanup, "LiveKit cleanup failed after startup error");
                }
                if let Some(auth) = &auth {
                    auth.service.shutdown().await;
                }
                return Err(error);
            }
        };
        let (stop, stopped) = watch::channel(false);
        let request_stop = stop.clone();
        let access = exposed
            .as_ref()
            .map(|listener| api::Exposed::new(listener.local_addr().expect("bound listener")));
        let app = api::router_public(
            store.clone(),
            options.web_dir,
            Some(runtime.clone()),
            access,
            options.public,
            auth.clone(),
        )
        .into_make_service_with_connect_info::<SocketAddr>();
        tracing::info!(%address, database = %options.database, "ZeroLux kernel ready (local, single-owner mode)");
        let task = tokio::spawn(async move {
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
            relinker.abort();
            sweeper.abort();
            settings_observer.abort();
            let _ = relinker.await;
            let _ = sweeper.await;
            let _ = settings_observer.await;
            let runtime_stopped = runtime.shutdown().await;
            let livekit_stopped = livekit.shutdown().await;
            if let Some(auth) = &auth {
                auth.service.shutdown().await;
            }
            // Released last, once everything else has stopped.
            drop(lease);
            result?;
            runtime_stopped?;
            livekit_stopped
        });
        Ok(Self {
            address,
            stop,
            task: Some(task),
        })
    }

    pub fn address(&self) -> SocketAddr {
        self.address
    }
    pub fn url(&self) -> String {
        format!("http://{}", self.address)
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

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}

async fn stopping(mut stopped: watch::Receiver<bool>) {
    let _ = stopped.wait_for(|stop| *stop).await;
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
