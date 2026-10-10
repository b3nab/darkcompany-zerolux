//! LiveKit realtime: a managed local server or an external one, client tokens, targeted notices.
//! External I/O and process lifecycle only. The store owns the outbox; no SQL lives here.

use std::{
    fs::OpenOptions,
    net::{IpAddr, Ipv4Addr, TcpListener, UdpSocket},
    path::PathBuf,
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, bail};
use livekit_api::{
    access_token::{AccessToken, VideoGrants},
    services::{
        ServerError, ServerErrorCode, ServiceError,
        room::{RoomClient, SendDataOptions},
    },
};
use tokio::{
    net::TcpStream,
    process::{Child, Command},
    sync::{Mutex, Notify, watch},
};
use uuid::Uuid;

use crate::store::{Store, now_ms};

/// The notice room of a kernel that was not told its workspace (tests, older callers).
pub const ROOM: &str = "zerolux";

/// The notice room of one workspace: with a shared LiveKit server, kernels stay apart.
/// Lossless: a UUID keeps its hyphenated form, anything else is hex-encoded.
pub fn workspace_room(workspace_id: &str) -> String {
    match Uuid::parse_str(workspace_id) {
        Ok(uuid) => format!("{ROOM}-{}", uuid.hyphenated()),
        Err(_) => format!(
            "{ROOM}-x{}",
            workspace_id
                .bytes()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        ),
    }
}
pub const TOPIC: &str = "chat";

const TOKEN_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const MANAGED_KEY: &str = "zerolux";
const READY_TIMEOUT: Duration = Duration::from_secs(10);
// The server drains for longer than eight seconds on SIGTERM; bound the wait, then force.
const STOP_TIMEOUT: Duration = Duration::from_secs(3);
const RETRY: Duration = Duration::from_secs(5);
const OUTBOX_BATCH: i64 = 100;

/// `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`: all three select an external
/// server or LiveKit Cloud, none lets ZeroLux run LiveKit itself, anything else is an error.
pub struct LiveKitConfig {
    pub url: Option<String>,
    pub api_key: Option<String>,
    pub api_secret: Option<String>,
    /// Receives the managed server's log. Secrets are never written here.
    pub data_dir: PathBuf,
}

impl LiveKitConfig {
    pub fn from_env(data_dir: PathBuf) -> Self {
        // A variable that is set but empty stays `Some("")`: it is a broken external
        // configuration, never a request for the managed server.
        let var = |name| std::env::var(name).ok();
        Self {
            url: var("LIVEKIT_URL"),
            api_key: var("LIVEKIT_API_KEY"),
            api_secret: var("LIVEKIT_API_SECRET"),
            data_dir,
        }
    }
}

#[derive(Debug, serde::Serialize)]
pub struct ClientToken {
    pub url: String,
    pub token: String,
    pub expires_at: i64,
    /// Whether `url` is the server this kernel runs itself; never sent to clients.
    #[serde(skip)]
    pub managed: bool,
}

pub struct LiveKit {
    url: String,
    api_key: String,
    api_secret: String,
    /// Where this kernel's notices go; clients only ever hold a token for it.
    room: String,
    rooms: Arc<RoomClient>,
    /// Started by this kernel (as opposed to an external server), whatever its URL says.
    owns_server: bool,
    managed: Mutex<Option<Child>>,
}

impl LiveKit {
    pub async fn start(config: LiveKitConfig) -> anyhow::Result<Self> {
        Self::start_exposed(config, None).await
    }

    /// `expose` makes the managed server reachable from that address of this computer too.
    /// An external server is already reachable wherever its URL says.
    pub async fn start_exposed(
        config: LiveKitConfig,
        expose: Option<IpAddr>,
    ) -> anyhow::Result<Self> {
        let (url, api_key, api_secret, managed) = match (
            config.url,
            config.api_key,
            config.api_secret,
        ) {
            (None, None, None) => {
                let (url, secret, child) = start_managed(&config.data_dir, expose).await?;
                (url, MANAGED_KEY.to_owned(), secret, Some(child))
            }
            (Some(url), Some(key), Some(secret))
                if [&url, &key, &secret].iter().all(|v| !v.trim().is_empty()) =>
            {
                (client_url(&url)?, key, secret, None)
            }
            // Never fall back to the local server: the owner would believe the external one is in use.
            _ => bail!(
                "LiveKit configuration is incomplete. Set LIVEKIT_URL, LIVEKIT_API_KEY and \
                     LIVEKIT_API_SECRET together, or none of them to let ZeroLux run LiveKit itself."
            ),
        };
        Ok(Self {
            rooms: Arc::new(RoomClient::with_api_key(&url, &api_key, &api_secret)),
            url,
            api_key,
            api_secret,
            room: ROOM.to_owned(),
            owns_server: managed.is_some(),
            managed: Mutex::new(managed),
        })
    }

    /// Scopes the notices to one workspace's room. Call before any token is issued.
    pub fn for_workspace(mut self, workspace_id: &str) -> Self {
        self.room = workspace_room(workspace_id);
        self
    }

    pub fn room(&self) -> &str {
        &self.room
    }

    /// The managed server is a child of this kernel; an external one has its own URL.
    pub fn managed(&self) -> bool {
        self.owns_server
    }

    /// A receive-only token for the single notice room. The identity is unique per connection,
    /// so several tabs or devices of the same actor coexist instead of evicting each other.
    pub fn client_token(&self, actor_id: &str) -> anyhow::Result<ClientToken> {
        let token = AccessToken::with_api_key(&self.api_key, &self.api_secret)
            .with_identity(&format!("{actor_id}:{}", Uuid::new_v4()))
            .with_ttl(TOKEN_TTL)
            .with_grants(VideoGrants {
                room_join: true,
                room: self.room.clone(),
                can_subscribe: Some(true),
                can_publish: Some(false),
                can_publish_data: Some(false),
                ..Default::default()
            })
            .to_jwt()
            .context("Sign LiveKit client token")?;
        Ok(ClientToken {
            url: self.url.clone(),
            token,
            expires_at: now_ms() + TOKEN_TTL.as_millis() as i64,
            managed: self.managed(),
        })
    }

    /// Sends a short event to the connected clients of `actor_ids`. Absent actors recover from
    /// the kernel on their next connection. A transport or server failure stays an error, so
    /// the caller keeps the outbox row pending.
    pub async fn notify(
        &self,
        event: &serde_json::Value,
        actor_ids: &[String],
    ) -> anyhow::Result<()> {
        if actor_ids.is_empty() {
            return Ok(());
        }
        let participants = match self.rooms.list_participants(&self.room).await {
            Ok(participants) => participants,
            Err(error) if room_missing(&error) => return Ok(()),
            Err(error) => return Err(error).context("List LiveKit participants"),
        };
        let destination_identities =
            recipients(participants.into_iter().map(|p| p.identity), actor_ids);
        // LiveKit treats an empty destination list as a broadcast to the whole room.
        if destination_identities.is_empty() {
            return Ok(());
        }
        let options = SendDataOptions {
            topic: Some(TOPIC.to_owned()),
            destination_identities,
            ..Default::default()
        };
        let (rooms, room, payload) = (
            self.rooms.clone(),
            self.room.clone(),
            serde_json::to_vec(event)?,
        );
        let runtime = tokio::runtime::Handle::current();
        // `send_data` holds a thread-local RNG across an await, so its future is not `Send`.
        // Driving it on a blocking thread keeps `notify` usable from any spawned task.
        tokio::task::spawn_blocking(move || {
            runtime.block_on(rooms.send_data(&room, payload, options))
        })
        .await?
        .context("Publish LiveKit notice")
    }

    /// Stops the managed server. An external server is never stopped by ZeroLux.
    pub async fn shutdown(&self) -> anyhow::Result<()> {
        let Some(mut child) = self.managed.lock().await.take() else {
            return Ok(());
        };
        #[cfg(unix)]
        if let Some(pid) = child.id() {
            let _ = nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGTERM,
            );
        }
        if tokio::time::timeout(STOP_TIMEOUT, child.wait())
            .await
            .is_err()
        {
            child.kill().await.context("Stop managed LiveKit server")?;
        }
        Ok(())
    }
}

/// Publishes the outbox until `stop` turns true: once at startup, at once after every `changed`
/// signal, and every `RETRY` regardless. The timer recovers a failed publication and a row whose
/// commit never reached `changed`. Only the notice is repeated, with the same event ID; native
/// dispatch never happens here.
pub async fn run_publisher(
    store: Store,
    livekit: Arc<LiveKit>,
    changed: Arc<Notify>,
    wake: tokio::sync::broadcast::Sender<()>,
    mut stop: watch::Receiver<bool>,
) {
    while !*stop.borrow() {
        if let Err(error) = publish_pending(&store, &livekit, &wake).await {
            tracing::warn!(
                error = format!("{error:#}"),
                "LiveKit publication failed; notices stay pending"
            );
        }
        tokio::select! {
            _ = changed.notified() => {}
            _ = tokio::time::sleep(RETRY) => {}
            _ = stop.wait_for(|stopped| *stopped) => break,
        }
    }
}

/// One failing notice never blocks the ones queued behind it.
async fn publish_pending(
    store: &Store,
    livekit: &LiveKit,
    wake: &tokio::sync::broadcast::Sender<()>,
) -> anyhow::Result<()> {
    loop {
        let events = store.pending_chat_events(OUTBOX_BATCH).await?;
        if events.is_empty() {
            return Ok(());
        }
        // Whatever LiveKit does with these notices, the adapters in this process hear about
        // the pending work now: they read the store, not the room. Each batch wakes them,
        // so a batch that arrives while an earlier one is published is never missed.
        let _ = wake.send(());
        let mut failure = None;
        for event in events {
            match livekit.notify(&event.payload, &event.actor_ids).await {
                Ok(()) => store.mark_chat_event_published(&event.event_id).await?,
                Err(error) => drop(failure.get_or_insert(error)),
            }
        }
        if let Some(error) = failure {
            return Err(error);
        }
    }
}

/// Connected identities (`<actor>:<connection>`) that belong to one of `actor_ids`.
fn recipients(identities: impl Iterator<Item = String>, actor_ids: &[String]) -> Vec<String> {
    identities
        .filter(|identity| {
            identity
                .split_once(':')
                .is_some_and(|(actor, _)| actor_ids.iter().any(|id| id == actor))
        })
        .collect()
}

/// The room exists only while someone is connected. Every other failure is a real one.
fn room_missing(error: &ServiceError) -> bool {
    matches!(error, ServiceError::Twirp(ServerError::Twirp(code)) if code.code == ServerErrorCode::NOT_FOUND)
}

/// Browsers connect over WebSocket; accept the HTTP spelling of the same endpoint too.
/// This URL reaches every client, so it carries no credentials; errors never echo the value.
fn client_url(value: &str) -> anyhow::Result<String> {
    let mut url = reqwest::Url::parse(value.trim()).context("LIVEKIT_URL is not a valid URL")?;
    let scheme = match url.scheme() {
        "ws" | "http" => "ws",
        "wss" | "https" => "wss",
        _ => bail!("LIVEKIT_URL must start with ws://, wss://, http:// or https://"),
    };
    if url.host_str().is_none() {
        bail!("LIVEKIT_URL must include a host");
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("LIVEKIT_URL must not contain credentials, a query or a fragment");
    }
    url.set_scheme(scheme)
        .map_err(|_| anyhow::anyhow!("LIVEKIT_URL has an unsupported scheme"))?;
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

/// Loopback only, on every socket: `bind_addresses` covers signaling, the `ips` filter covers
/// RTC over UDP, and RTC over TCP is disabled because it binds every interface. An exposed
/// kernel adds that one address, which this computer reaches as well.
fn managed_config(port: u16, udp_port: u16, secret: &str, expose: Option<IpAddr>) -> String {
    // A node address would be the only one offered to clients. Without it LiveKit offers
    // every address that passes the filter: loopback for this computer, the other for the rest.
    let (bind, include, node) = match expose {
        Some(ip) => (
            format!("\n  - {ip}"),
            format!("\n      - {ip}/{}", if ip.is_ipv4() { 32 } else { 128 }),
            "",
        ),
        None => (String::new(), String::new(), "node_ip: 127.0.0.1\n  "),
    };
    format!(
        "port: {port}\n\
         bind_addresses:\n  - 127.0.0.1{bind}\n\
         rtc:\n  tcp_port: 0\n  udp_port: {udp_port}\n  use_external_ip: false\n  \
         {node}enable_loopback_candidate: true\n  \
         ips:\n    includes:\n      - 127.0.0.1/32{include}\n\
         keys:\n  {MANAGED_KEY}: {secret}\n"
    )
}

async fn start_managed(
    data_dir: &PathBuf,
    expose: Option<IpAddr>,
) -> anyhow::Result<(String, String, Child)> {
    let port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?
        .local_addr()?
        .port();
    let udp_port = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))?
        .local_addr()?
        .port();
    // Generated on every start and handed over in the environment: never on disk or in argv.
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    tokio::fs::create_dir_all(data_dir).await?;
    let log_path = data_dir.join("livekit.log");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let mut child = Command::new("livekit-server")
        .env(
            "LIVEKIT_CONFIG",
            managed_config(port, udp_port, &secret, expose),
        )
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .kill_on_drop(true)
        .spawn()
        .context("Cannot start the LiveKit server. Install `livekit-server`, or set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET to use an external one")?;
    let ready = async {
        loop {
            if let Some(status) = child.try_wait()? {
                bail!(
                    "The LiveKit server stopped during startup ({status}); see {}",
                    log_path.display()
                );
            }
            if TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                .await
                .is_ok()
            {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };
    tokio::time::timeout(READY_TIMEOUT, ready)
        .await
        .with_context(|| {
            format!(
                "The LiveKit server did not start in time; see {}",
                log_path.display()
            )
        })??;
    tracing::info!(
        port,
        udp_port,
        "Managed LiveKit server ready (loopback only)"
    );
    Ok((format!("ws://127.0.0.1:{port}"), secret, child))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(url: Option<&str>, key: Option<&str>, secret: Option<&str>) -> LiveKitConfig {
        LiveKitConfig {
            url: url.map(Into::into),
            api_key: key.map(Into::into),
            api_secret: secret.map(Into::into),
            data_dir: std::env::temp_dir(),
        }
    }

    #[test]
    fn notices_reach_every_connection_of_the_addressed_actors_only() {
        let connected = [
            "owner:tab1",
            "owner:tab2",
            "agent:a",
            "owner-other:x",
            "malformed",
        ]
        .map(String::from)
        .into_iter();
        assert_eq!(
            recipients(connected, &["owner".into(), "codex".into()]),
            ["owner:tab1", "owner:tab2"]
        );
    }

    #[tokio::test]
    async fn partial_external_configuration_is_an_error_without_secrets() {
        for partial in [
            config(Some("wss://example.livekit.cloud"), None, None),
            config(Some("wss://example.livekit.cloud"), Some("key"), None),
            config(None, Some("key"), Some("hidden-secret")),
            // Set but empty is still a broken external configuration.
            config(Some(""), Some(""), Some("")),
            config(Some(" "), Some("key"), Some("hidden-secret")),
        ] {
            let error = LiveKit::start(partial).await.err().unwrap().to_string();
            assert!(error.contains("incomplete"), "{error}");
            assert!(!error.contains("hidden-secret"), "{error}");
        }
    }

    #[tokio::test]
    async fn external_configuration_starts_no_local_server() {
        let livekit = LiveKit::start(config(
            Some("https://example.livekit.cloud/"),
            Some("key"),
            Some("secret"),
        ))
        .await
        .unwrap();
        assert!(livekit.managed.lock().await.is_none());
        assert_eq!(
            livekit.client_token("actor").unwrap().url,
            "wss://example.livekit.cloud"
        );
        for rejected in [
            "ftp://example",
            "wss://user:hidden-password@example.livekit.cloud",
            "wss://example.livekit.cloud?token=hidden-password",
            "wss://example.livekit.cloud#hidden-password",
        ] {
            let error = LiveKit::start(config(Some(rejected), Some("key"), Some("secret")))
                .await
                .err()
                .unwrap();
            assert!(!format!("{error:#}").contains("hidden-password"));
        }
    }

    #[test]
    fn managed_server_is_configured_for_loopback_only() {
        let exposed = managed_config(7880, 7882, "generated", Some("192.0.2.7".parse().unwrap()));
        assert!(exposed.contains("bind_addresses:\n  - 127.0.0.1\n  - 192.0.2.7\n"));
        assert!(!exposed.contains("node_ip"));
        assert!(exposed.contains("      - 127.0.0.1/32\n      - 192.0.2.7/32\n"));
        assert!(!exposed.contains("0.0.0.0"));
        let yaml = managed_config(7880, 7882, "generated", None);
        for line in [
            "  - 127.0.0.1",
            "  tcp_port: 0",
            "  use_external_ip: false",
            // Without it the server opens no UDP port and browsers never connect.
            "  enable_loopback_candidate: true",
            "      - 127.0.0.1/32",
        ] {
            assert!(
                yaml.lines().any(|l| l == line),
                "missing {line:?} in\n{yaml}"
            );
        }
    }

    #[tokio::test]
    async fn no_recipient_never_reaches_the_server() {
        // Port 9 is unreachable: a request would fail, so success proves nothing was sent.
        let livekit = LiveKit::start(config(
            Some("http://127.0.0.1:9"),
            Some("key"),
            Some("secret"),
        ))
        .await
        .unwrap();
        livekit
            .notify(&serde_json::json!({"type": "message.created"}), &[])
            .await
            .unwrap();
        // A transport failure is an error: the outbox row must stay pending.
        assert!(
            livekit
                .notify(&serde_json::json!({}), &["actor".into()])
                .await
                .is_err()
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn publisher_drains_at_startup_and_keeps_failed_notices_pending() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("test.db")).await.unwrap();
        for (event_id, recipients) in [("nobody", "[]"), ("someone", r#"["actor"]"#)] {
            sqlx::query("INSERT INTO chat_outbox VALUES (?, ?, ?, ?, NULL)")
                .bind(event_id)
                .bind(format!(r#"{{"event_id":"{event_id}"}}"#))
                .bind(recipients)
                .bind(now_ms())
                .execute(&store.pool)
                .await
                .unwrap();
        }
        // Unreachable server: the notice with a recipient fails, the one without is done.
        let livekit = LiveKit::start(config(
            Some("http://127.0.0.1:9"),
            Some("key"),
            Some("secret"),
        ))
        .await
        .unwrap();
        let (stopper, stop) = watch::channel(false);
        let publisher = tokio::spawn(run_publisher(
            store.clone(),
            Arc::new(livekit),
            Arc::new(Notify::new()),
            tokio::sync::broadcast::channel(4).0,
            stop,
        ));
        tokio::time::sleep(Duration::from_secs(2)).await;
        let pending = store.pending_chat_events(10).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].event_id, "someone");

        // A commit that never signalled `changed` is still published by the recovery timer.
        sqlx::query("INSERT INTO chat_outbox VALUES ('unsignalled', '{}', '[]', ?, NULL)")
            .bind(now_ms())
            .execute(&store.pool)
            .await
            .unwrap();
        tokio::time::sleep(RETRY + Duration::from_secs(2)).await;
        let pending = store.pending_chat_events(10).await.unwrap();
        assert_eq!(pending.len(), 1, "only the failing notice remains");
        assert_eq!(pending[0].event_id, "someone");
        stopper.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), publisher)
            .await
            .expect("publisher stops")
            .unwrap();
    }
}
