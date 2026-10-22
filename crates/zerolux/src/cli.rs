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
        /// The web app's files: by default the ones a release packages with the kernel, or the
        /// checkout's `apps/web/dist`.
        #[arg(long)]
        web_dir: Option<PathBuf>,
        /// The authentication service to start, run with `bun`: by default the one a release
        /// packages with the kernel, or the checkout's `services/auth/src/server.ts`.
        #[arg(long, env = "ZEROLUX_AUTH_ENTRY")]
        auth_entry: Option<PathBuf>,
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
    /// This computer as a host of a workspace whose kernel runs elsewhere.
    Host {
        #[command(subcommand)]
        action: HostAction,
        /// Where this computer keeps what joining gave it and its sessions' links.
        #[arg(long, env = "ZEROLUX_DATA_DIR", default_value = ".zerolux/host")]
        data_dir: PathBuf,
    },
    /// Make and work on extensions.
    Ext {
        #[command(subcommand)]
        action: ExtAction,
    },
}

#[derive(Subcommand)]
enum ExtAction {
    /// A new extension in a new folder: its manifest, one action and the SDK of its language.
    New {
        /// `publisher.name`, in lowercase letters, digits and dashes.
        id: String,
        /// Its name as people read it; by default its id's name.
        #[arg(long)]
        name: Option<String>,
        #[arg(long, value_enum, default_value = "typescript")]
        language: crate::extensions::scaffold::Language,
        /// Where to write it; by default a folder named as its id's name, here.
        folder: Option<PathBuf>,
    },
    /// A new publisher's key, which signs its packages; its public key is what an index lists.
    Key {
        /// The publisher, as in its extensions' ids.
        publisher: String,
        /// Where to keep it; by default `~/.zerolux/keys/<publisher>.json`.
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Build what the extension brings for this computer: its kernel module into
    /// `kernel/<platform>/`, its interface from `ui/src/*.tsx` into `ui/native/`.
    Build {
        #[arg(default_value = ".")]
        folder: PathBuf,
    },
    /// Pack the extension into a signed `<id>-<version>.zlx`.
    Pack {
        #[arg(default_value = ".")]
        folder: PathBuf,
        /// The publisher's key; by default `~/.zerolux/keys/<publisher>.json`.
        #[arg(long)]
        key: Option<PathBuf>,
        /// Where to write the package.
        #[arg(long, default_value = "dist")]
        out: PathBuf,
    },
    /// Install an extension from its folder in the kernel running on this computer, as its
    /// owner, and follow it: the kernel starts it again as its files change.
    Dev {
        /// The extension's folder; by default this one.
        #[arg(default_value = ".")]
        folder: PathBuf,
        /// The running kernel's data folder.
        #[arg(long, env = "ZEROLUX_DATA_DIR", default_value = ".zerolux")]
        data_dir: PathBuf,
    },
}

#[derive(Subcommand)]
enum HostAction {
    /// Join with the code made in ZeroLux, under Computers, by this computer's person.
    Join {
        /// The workspace's kernel, as `http(s)://address:port`.
        url: String,
        code: String,
        /// This computer's name in the workspace.
        #[arg(long, default_value = "")]
        name: String,
    },
    /// Stay connected to the workspace and run its sessions here.
    Run,
}

/// The web app, sign-in and runners a release packages in `share/zerolux`, beside the `bin`
/// folder of its kernel, as in `/usr/local`; none for a kernel built in a checkout, which uses
/// the checkout's.
pub fn init_logging() {
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "zerolux=info,tower_http=info".into()),
        )
        .try_init();
}

/// Where a publisher's key is kept by default.
fn key_file(publisher: &str) -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default();
    home.join(".zerolux/keys").join(format!("{publisher}.json"))
}

/// Installs the extension in `folder` in the local kernel and follows it: its state as it
/// starts again, and its log, until interrupted.
async fn dev(folder: &std::path::Path, data_dir: &std::path::Path) -> anyhow::Result<()> {
    use serde_json::json;
    let folder = std::path::absolute(folder)?;
    let mut kernel = crate::local_control::Client::connect(data_dir).await?;
    let installed = kernel
        .ask("extensions.dev", json!({"folder": folder}))
        .await?;
    let id = installed["id"].as_str().unwrap_or_default().to_owned();
    let state = |extension: &serde_json::Value| match extension["error"].as_str() {
        Some(error) => format!("{id}: {error}"),
        None if extension["enabled"] == true => format!("{id}: running"),
        None => format!("{id}: disabled"),
    };
    eprintln!("{}", state(&installed));
    let mut seen = installed["updated_at"].clone();
    let mut after = kernel
        .ask("extensions.log", json!({"id": id, "after": u64::MAX}))
        .await?["end"]
        .as_u64()
        .unwrap_or(0);
    let stop = crate::server::shutdown_signal();
    tokio::pin!(stop);
    loop {
        tokio::select! {
            _ = &mut stop => return Ok(()),
            _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {}
        }
        let log = kernel
            .ask("extensions.log", json!({"id": id, "after": after}))
            .await?;
        if let Some(text) = log["text"].as_str().filter(|text| !text.is_empty()) {
            eprint!("{text}");
        }
        after = log["next"].as_u64().unwrap_or(after);
        let listed = kernel.ask("extensions.list", json!({})).await?;
        let Some(extension) = listed
            .as_array()
            .into_iter()
            .flatten()
            .find(|extension| extension["id"] == id.as_str())
        else {
            anyhow::bail!("{id} was removed");
        };
        if extension["updated_at"] != seen {
            seen = extension["updated_at"].clone();
            eprintln!("{}", state(extension));
        }
    }
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
            // A release's kernel runs what it carries; a checkout's, the checkout.
            let carried = crate::carry::unpack(&data_dir)?;
            let web_dir = web_dir.unwrap_or_else(|| match &carried {
                Some(resources) => resources.join("web"),
                None => "apps/web/dist".into(),
            });
            let auth_entry = auth_entry.unwrap_or_else(|| match &carried {
                Some(resources) => resources.join("auth/server.js"),
                None => "services/auth/src/server.ts".into(),
            });
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
                runner: None,
                auth: Some(crate::auth::AuthEntry {
                    bun: crate::platform::executable("bun"),
                    entry: auth_entry,
                }),
            })
            .await?
            .run_until(crate::server::shutdown_signal())
            .await?;
        }
        Command::AgentLink => crate::agent_link::cli().await?,
        Command::Host { action, data_dir } => match action {
            HostAction::Join { url, code, name } => {
                crate::host_link::join(&url, &code, &name, &data_dir).await?;
                println!("Joined. Run `zerolux host run` to connect this computer.");
            }
            HostAction::Run => {
                crate::carry::unpack(&data_dir)?;
                let config = crate::host_link::HostConfig::load(&data_dir)?;
                let (stop, stopped) = tokio::sync::watch::channel(false);
                tokio::spawn(async move {
                    crate::server::shutdown_signal().await;
                    stop.send_replace(true);
                });
                crate::host_link::run(config, &data_dir, stopped).await?;
            }
        },
        Command::Ext { action } => match action {
            ExtAction::New {
                id,
                name,
                language,
                folder,
            } => {
                let short = id.split_once('.').map_or(id.as_str(), |(_, name)| name);
                let folder = folder.unwrap_or_else(|| PathBuf::from(short));
                let name = name.unwrap_or_else(|| short.to_owned());
                let made = crate::extensions::scaffold::create(&id, &name, language, &folder)?;
                println!("{}", made.display());
            }
            ExtAction::Dev { folder, data_dir } => dev(&folder, &data_dir).await?,
            ExtAction::Key { publisher, out } => {
                let path = out.unwrap_or_else(|| key_file(&publisher));
                let key = crate::extensions::package::Key::new(&publisher)?;
                key.write(&path)?;
                eprintln!("{}", path.display());
                println!("{}", key.public);
            }
            ExtAction::Build { folder } => {
                for built in crate::extensions::package::build(&folder)? {
                    println!("{}", built.display());
                }
            }
            ExtAction::Pack { folder, key, out } => {
                let manifest = crate::extensions::manifest::Manifest::parse(
                    &std::fs::read_to_string(folder.join(crate::extensions::manifest::FILE))?,
                )?;
                let key = key.unwrap_or_else(|| key_file(&manifest.extension.publisher));
                let key = crate::extensions::package::Key::read(&key)?;
                let package = crate::extensions::package::pack(&folder, &key, &out)?;
                println!("{}", package.display());
                println!(
                    "sha256 {}",
                    crate::extensions::package::sha256(&std::fs::read(&package)?)
                );
                let card = crate::extensions::package::card_beside(&folder, &out)?;
                println!("card {}", card.display());
            }
        },
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
    fn removed_reply_helper_is_not_a_command() {
        let error = Cli::try_parse_from(["zerolux", "chat-send"]).err().unwrap();
        assert_eq!(error.kind(), clap::error::ErrorKind::InvalidSubcommand);
    }

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
