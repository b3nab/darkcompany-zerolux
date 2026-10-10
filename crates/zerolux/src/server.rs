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
    livekit::{LiveKit, LiveKitConfig},
    store::Store,
};

pub struct ServerOptions {
    pub address: SocketAddr,
    pub expose: Option<IpAddr>,
    pub database: PathBuf,
    pub web_dir: PathBuf,
    /// An explicit configuration avoids inheriting service credentials in embedders/tests.
    /// `None` retains the CLI's LIVEKIT_* environment configuration.
    pub livekit: Option<LiveKitConfig>,
    /// The origin a reverse proxy serves this kernel at, with the LiveKit address clients
    /// reach from there. `None`: this computer and the exposed address only.
    pub public: Option<Arc<api::PublicOrigin>>,
    #[cfg(unix)]
    pub runner: Option<crate::claude_runner::RunnerProgram>,
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
        let data_dir = options
            .database
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| std::path::Path::new("."))
            .to_path_buf();
        tokio::fs::create_dir_all(&data_dir)
            .await
            .context("Create database directory")?;
        // One running kernel per workspace, whatever started it (CLI, desktop, a second copy
        // of either). Held until cleanup ends; plain store access (tests, maintenance) is free.
        let lease = lease(&options.database)?;
        let store = Store::open(&options.database)
            .await
            .context("Open the database")?;
        let workspace = store.workspace_info().await?;
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
        let base_url = format!("http://{address}");
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
        )
        .into_make_service_with_connect_info::<SocketAddr>();
        tracing::info!(%address, database = %options.database.display(), "ZeroLux kernel ready (local, single-owner mode)");
        let task = tokio::spawn(async move {
            let relink = runtime.clone();
            let relinker = tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(10));
                loop {
                    interval.tick().await;
                    if let Err(error) = relink.reconnect().await {
                        tracing::error!(error = format!("{error:#}"), "Relinking sessions failed");
                    }
                }
            });
            let reaper = tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(5));
                loop {
                    interval.tick().await;
                    if let Err(error) = store.reap_expired().await {
                        tracing::error!(error = format!("{error:#}"), "Lease recovery failed");
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
            reaper.abort();
            relinker.abort();
            let _ = reaper.await;
            let _ = relinker.await;
            let runtime_stopped = runtime.shutdown().await;
            let livekit_stopped = livekit.shutdown().await;
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

/// The exclusive lease of a workspace's kernel: `<database>.lock` next to the real database
/// file, so every alias of the same data meets the same lease. Released with its file.
fn lease(database: &std::path::Path) -> Result<std::fs::File> {
    // The directory exists by now; the database may not yet. Resolve the directory, keep the
    // file name: a symlinked database still maps to one lease.
    let directory = database
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    let directory = std::fs::canonicalize(directory)
        .with_context(|| format!("Resolve the data directory {}", directory.display()))?;
    let name = database
        .file_name()
        .context("The database path must name a file")?;
    let real = match std::fs::canonicalize(database) {
        Ok(real) => real,
        Err(_) => directory.join(name),
    };
    // Hard links are not unified by canonicalize: a database reachable under two names
    // would get two leases. Refuse rather than guess.
    #[cfg(unix)]
    if let Ok(metadata) = std::fs::metadata(&real) {
        use std::os::unix::fs::MetadataExt;
        anyhow::ensure!(
            metadata.nlink() <= 1,
            "The database {} has more than one hard link; a workspace must have one path",
            real.display()
        );
    }
    let path = real.with_extension("db.lock");
    let mut open = std::fs::OpenOptions::new();
    open.read(true).write(true).create(true).truncate(false);
    // Never follow a symlink planted at the lease path, without a check-then-open race.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.custom_flags(nix::libc::O_NOFOLLOW);
    }
    #[cfg(not(unix))]
    if let Ok(metadata) = std::fs::symlink_metadata(&path) {
        anyhow::ensure!(
            metadata.file_type().is_file(),
            "The kernel lease {} must be a regular file",
            path.display()
        );
    }
    let file = open
        .open(&path)
        .with_context(|| format!("Open the kernel lease {}", path.display()))?;
    fs2::FileExt::try_lock_exclusive(&file).with_context(|| {
        format!(
            "Another ZeroLux kernel already serves {}. Stop it, or point this one at its address instead of its data.",
            database.display()
        )
    })?;
    Ok(file)
}

async fn stopping(mut stopped: watch::Receiver<bool>) {
    let _ = stopped.wait_for(|stop| *stop).await;
}
