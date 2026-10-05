use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, bail};
use clap::{Parser, Subcommand};
use zerolux::{
    api,
    store::Store,
    worker::{self, WorkerOptions},
};

#[derive(Parser)]
#[command(name = "zerolux", version, about = "ZeroLux — dark company OS")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Start the kernel on this computer. `--expose` also serves one more address of it.
    Serve {
        #[arg(long, default_value = "127.0.0.1")]
        host: IpAddr,
        /// Also serve this address.
        #[arg(long, env = "ZEROLUX_EXPOSE")]
        expose: Option<IpAddr>,
        #[arg(long, default_value_t = 4310)]
        port: u16,
        #[arg(long, env = "ZEROLUX_DATABASE", default_value = ".zerolux/zerolux.db")]
        database: PathBuf,
        #[arg(long, default_value = "apps/web/dist")]
        web_dir: PathBuf,
    },
    /// Execute one queued task with a local harness (or poll continuously with --watch).
    Worker(WorkerOptions),
    /// Probe installed harness CLI versions. Does not authenticate, connect, or start an agent.
    Doctor,
    /// Receive chat invalidations for an attached harness over a private stdin/stdout channel.
    AgentLink,
    /// Send the text on stdin to a chat through a private link descriptor.
    ChatSend {
        #[arg(long)]
        link: PathBuf,
        /// Conversation that receives the text on stdin.
        #[arg(long)]
        to: String,
        /// Delivery this message is the final reply to.
        #[arg(long)]
        reply: Option<String>,
        /// Message ID; repeat it only to retry the same send.
        #[arg(long)]
        id: Option<String>,
        /// Send into the thread rooted at this message (or delivery) of the chat, opening it
        /// if no open thread is rooted there.
        #[arg(long)]
        thread_on: Option<String>,
        /// Agents of the chat who take part in the thread, by name, comma-separated.
        #[arg(long, requires = "thread_on", value_delimiter = ',')]
        with: Vec<String>,
        /// Title of a thread being opened.
        #[arg(long, requires = "thread_on")]
        title: Option<String>,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "zerolux=info,tower_http=info".into()),
        )
        .init();
    match Cli::parse().command {
        Command::Serve {
            host,
            expose,
            port,
            database,
            web_dir,
        } => {
            if !host.is_loopback() {
                bail!("The kernel listens on this computer; use --expose for other devices");
            }
            if expose.is_some_and(|ip| ip.is_loopback() || ip.is_unspecified()) {
                bail!("--expose takes one address of this computer on a private network");
            }
            if let Some(parent) = database.parent().filter(|p| !p.as_os_str().is_empty()) {
                tokio::fs::create_dir_all(parent)
                    .await
                    .context("Create database directory")?;
            }
            let store = Store::open(&database).await.context("Open the database")?;
            let listener = tokio::net::TcpListener::bind(SocketAddr::new(host, port)).await?;
            let base_url = format!("http://{}", listener.local_addr()?);
            let data_dir = database
                .parent()
                .filter(|path| !path.as_os_str().is_empty())
                .unwrap_or_else(|| std::path::Path::new("."))
                .to_path_buf();
            let exposed = match expose {
                Some(ip) => Some(
                    tokio::net::TcpListener::bind(SocketAddr::new(ip, port))
                        .await
                        .context("Listen on the exposed address")?,
                ),
                None => None,
            };
            let livekit = Arc::new(
                zerolux::livekit::LiveKit::start_exposed(
                    zerolux::livekit::LiveKitConfig::from_env(data_dir.clone()),
                    expose,
                )
                .await?,
            );
            let runtime = match zerolux::chat_runtime::ChatRuntime::start(
                store.clone(),
                livekit.clone(),
                base_url,
                std::path::absolute(data_dir.join("links"))?,
            )
            .await
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    if let Err(cleanup) = livekit.shutdown().await {
                        tracing::error!(%cleanup, "LiveKit cleanup failed after startup error");
                    }
                    return Err(error);
                }
            };
            tracing::info!(address = %listener.local_addr()?, database = %database.display(), "ZeroLux kernel ready (local, single-owner mode)");
            let relink = runtime.clone();
            // At startup and whenever a link is lost: agents stay reachable without the owner.
            let relinker = tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(10));
                loop {
                    interval.tick().await;
                    if let Err(error) = relink.reconnect().await {
                        tracing::error!(%error, "Relinking sessions failed");
                    }
                }
            });
            let reaper_store = store.clone();
            let reaper = tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(5));
                loop {
                    interval.tick().await;
                    if let Err(error) = reaper_store.reap_expired().await {
                        tracing::error!(%error, "Lease recovery failed");
                    }
                }
            });
            let access = match &exposed {
                Some(listener) => Some(api::Exposed::new(listener.local_addr()?)),
                None => None,
            };
            let app = api::router_exposed(store, web_dir, Some(runtime.clone()), access)
                .into_make_service_with_connect_info::<SocketAddr>();
            let (stop, stopped) = tokio::sync::watch::channel(false);
            let stopping = |mut stopped: tokio::sync::watch::Receiver<bool>| async move {
                let _ = stopped.wait_for(|stop| *stop).await;
            };
            let other_devices = exposed.map(|listener| {
                tracing::info!(address = %listener.local_addr().unwrap(), "Also serving the owner's other devices (unauthenticated)");
                tokio::spawn(
                    axum::serve(listener, app.clone())
                        .with_graceful_shutdown(stopping(stopped.clone()))
                        .into_future(),
                )
            });
            let result = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    worker::shutdown_signal().await;
                    stop.send_replace(true);
                })
                .await;
            if let Some(other_devices) = other_devices {
                let _ = other_devices.await;
            }
            drop(stopped);
            reaper.abort();
            relinker.abort();
            let runtime_stopped = runtime.shutdown().await;
            let livekit_stopped = livekit.shutdown().await;
            result?;
            runtime_stopped?;
            livekit_stopped?;
        }
        Command::Worker(options) => worker::run(options).await?,
        Command::AgentLink => zerolux::agent_link::cli().await?,
        Command::ChatSend {
            link,
            to,
            reply,
            id,
            thread_on,
            with,
            title,
        } => {
            let thread = thread_on.map(|root| zerolux::chat_tools::Thread { root, with, title });
            zerolux::chat_tools::cli(link, to, reply, id, thread).await?
        }
        Command::Doctor => println!(
            "{}",
            serde_json::to_string_pretty(&zerolux::harness::doctor().await)?
        ),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serve_rejects_an_unknown_sign_in_option() {
        let error =
            match Cli::try_parse_from(["zerolux", "serve", "--expose", "192.0.2.7", "--sign-in"]) {
                Err(error) => error,
                Ok(_) => {
                    panic!(
                        "--sign-in is not an option and must not start an unauthenticated server"
                    )
                }
            };
        assert_eq!(error.kind(), clap::error::ErrorKind::UnknownArgument);
    }
}
