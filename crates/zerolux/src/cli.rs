//! Shared CLI entrypoint, including the private helpers used by attached harnesses.
use crate::server::{Server, ServerOptions};
use clap::{Parser, Subcommand};
use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
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
        /// Where this kernel keeps links, sockets, secrets and LiveKit assets. With a SQLite
        /// database given by path, its directory.
        #[arg(long, env = "ZEROLUX_DATA_DIR")]
        data_dir: Option<PathBuf>,
        /// The workspace's data: a SQLite file, or a postgresql:// URL.
        #[arg(long, env = "ZEROLUX_DATABASE", default_value = ".zerolux/zerolux.db")]
        database: String,
        #[arg(long, default_value = "apps/web/dist")]
        web_dir: PathBuf,
        /// The authentication service to start, run with `bun`.
        #[arg(
            long,
            env = "ZEROLUX_AUTH_ENTRY",
            default_value = "services/auth/src/server.ts"
        )]
        auth_entry: PathBuf,
        /// The origin a reverse proxy serves this kernel at, e.g. https://company.example.
        #[arg(long, env = "ZEROLUX_PUBLIC_ORIGIN")]
        public_origin: Option<String>,
        /// The LiveKit address clients reach from the public origin (wss://…), when the
        /// kernel runs LiveKit itself behind the proxy.
        #[arg(long, env = "ZEROLUX_PUBLIC_LIVEKIT_URL", requires = "public_origin")]
        public_livekit_url: Option<String>,
    },
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
        /// Root message (or delivery); open or join its thread.
        #[arg(long)]
        thread_on: Option<String>,
        /// Participating agents, comma-separated.
        #[arg(long, requires = "thread_on", value_delimiter = ',')]
        with: Vec<String>,
        /// Title of a thread being opened.
        #[arg(long, requires = "thread_on")]
        title: Option<String>,
    },
}

pub fn init_logging() {
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "zerolux=info,tower_http=info".into()),
        )
        .try_init();
}

pub async fn run() -> anyhow::Result<()> {
    match Cli::parse().command {
        Command::Serve {
            host,
            expose,
            port,
            data_dir,
            database,
            web_dir,
            auth_entry,
            public_origin,
            public_livekit_url,
        } => {
            let database = crate::db::Location::parse(&database).map_err(anyhow::Error::msg)?;
            let data_dir = match (data_dir, &database) {
                (Some(dir), _) => dir,
                (None, crate::db::Location::Sqlite(path)) => path
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .map_or_else(|| PathBuf::from("."), PathBuf::from),
                (None, crate::db::Location::Postgres(_)) => PathBuf::from(".zerolux"),
            };
            Server::start(ServerOptions {
                address: SocketAddr::new(host, port),
                expose,
                data_dir,
                database,
                web_dir,
                livekit: None,
                public: match public_origin {
                    Some(origin) => {
                        Some(crate::api::PublicOrigin::new(&origin, public_livekit_url)?)
                    }
                    None => None,
                },
                #[cfg(unix)]
                runner: None,
                auth: Some(crate::auth::AuthEntry {
                    bun: "bun".into(),
                    entry: auth_entry,
                }),
            })
            .await?
            .run_until(crate::server::shutdown_signal())
            .await?;
        }
        Command::AgentLink => crate::agent_link::cli().await?,
        Command::ChatSend {
            link,
            to,
            reply,
            id,
            thread_on,
            with,
            title,
        } => {
            let thread = thread_on.map(|root| crate::chat_tools::Thread { root, with, title });
            crate::chat_tools::cli(link, to, reply, id, thread).await?;
        }
        Command::Doctor => println!(
            "{}",
            serde_json::to_string_pretty(&crate::harness::doctor().await)?
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
                Ok(_) => panic!("--sign-in must not start an unauthenticated server"),
            };
        assert_eq!(error.kind(), clap::error::ErrorKind::UnknownArgument);
    }
}
