//! A CLI gives its existing workspace to an embedder over the private local channel.
//! It waits for the embedder's commit, resuming its own configuration on disconnect.
//! No process IDs, executable paths or database restores are accepted from the client.

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncWrite, AsyncWriteExt},
    sync::{mpsc, oneshot},
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Network {
    pub listen: IpAddr,
    pub port: u16,
    pub expose: Option<IpAddr>,
    pub public_origin: Option<String>,
    pub public_livekit_url: Option<String>,
}

impl Network {
    pub fn local(port: u16) -> Self {
        Self {
            listen: [127, 0, 0, 1].into(),
            port,
            expose: None,
            public_origin: None,
            public_livekit_url: None,
        }
    }

    pub fn address(&self) -> SocketAddr {
        SocketAddr::new(self.listen, self.port)
    }

    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.listen.is_loopback(),
            "The kernel's primary address must be loopback"
        );
        ensure!(
            self.expose
                .is_none_or(|ip| !ip.is_loopback() && !ip.is_unspecified()),
            "Choose a specific address of this computer for network access"
        );
        ensure!(
            self.public_origin.is_some() || self.public_livekit_url.is_none(),
            "A public LiveKit URL requires a public origin"
        );
        if let Some(origin) = &self.public_origin {
            crate::api::PublicOrigin::new(origin, self.public_livekit_url.clone())?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub instance: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub host_id: String,
    pub version: String,
    pub schema: String,
    pub directory: PathBuf,
    pub database: PathBuf,
    pub network: Network,
    pub external_livekit: bool,
    pub authenticated: bool,
}

impl Info {
    pub fn validate(&self, directory: &Path, workspace_id: &str) -> Result<()> {
        ensure!(
            self.directory == dunce::canonicalize(directory)?,
            "This kernel uses a different data directory"
        );
        ensure!(
            self.database.is_absolute() && self.database == dunce::canonicalize(&self.database)?,
            "The kernel's database path is not canonical"
        );
        ensure!(
            self.workspace_id == workspace_id,
            "This directory belongs to a different workspace"
        );
        ensure!(
            self.schema == crate::build::schema(),
            "The kernel and desktop have different workspace schemas; update them to the same schema before adopting"
        );
        ensure!(
            self.authenticated,
            "Adoption requires a kernel with account authentication"
        );
        ensure!(
            std::fs::read_to_string(self.directory.join("host-id"))?.trim() == self.host_id,
            "The kernel host identity changed"
        );
        ensure!(self.network.port != 0, "The kernel has no listening port");
        self.network.validate()
    }
}

/// Private IPC only. The desktop persists it privately, never in the view or its catalog.
#[derive(Clone, Deserialize, Serialize)]
pub struct Configuration {
    pub info: Info,
    pub livekit: crate::livekit::LiveKitConfig,
}

pub(crate) struct Request {
    pub configuration: Configuration,
    pub ready: oneshot::Sender<Result<Configuration, String>>,
    pub decision: oneshot::Receiver<bool>,
}

#[derive(Deserialize, Serialize, PartialEq)]
struct Receipt {
    info: Info,
    profile: String,
}

fn receipt_path(info: &Info) -> Result<PathBuf> {
    let instance = uuid::Uuid::parse_str(&info.instance).context("Invalid handoff instance")?;
    Ok(info.directory.join(format!("handoff-{instance}.json")))
}

fn transaction_lock(directory: &Path) -> Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(nix::libc::O_NOFOLLOW);
    }
    let file = options.open(directory.join("handoff.lock"))?;
    fs2::FileExt::try_lock_exclusive(&file)
        .context("The previous ownership transfer is still finishing")?;
    Ok(file)
}

fn receipt(info: &Info, profile: &str) -> Result<bool> {
    let bytes = match std::fs::read(receipt_path(info)?) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let receipt: Receipt = serde_json::from_slice(&bytes)?;
    ensure!(
        receipt.info == *info && receipt.profile == profile,
        "The ownership receipt belongs to another transfer"
    );
    Ok(true)
}

fn commit(info: &Info, profile: &str) -> Result<()> {
    use std::io::Write;
    let path = receipt_path(info)?;
    let staged = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result: Result<()> = (|| {
        let mut file = options.open(&staged)?;
        file.write_all(&serde_json::to_vec(&Receipt {
            info: info.clone(),
            profile: profile.to_owned(),
        })?)?;
        file.sync_all()?;
        std::fs::rename(&staged, path)?;
        #[cfg(unix)]
        std::fs::File::open(&info.directory)?.sync_all()?;
        Ok(())
    })();
    let _ = std::fs::remove_file(staged);
    result
}

/// Held while the desktop reconciles its journal. A receipt is authoritative only after
/// the previous handler has finished deciding; a timeout never guesses which side owns it.
pub struct Decision {
    _lock: std::fs::File,
    pub committed: bool,
}

impl Decision {
    pub async fn read(info: &Info, profile: &str) -> Result<Self> {
        let until = tokio::time::Instant::now() + Duration::from_secs(10);
        let lock = loop {
            match transaction_lock(&info.directory) {
                Ok(lock) => break lock,
                Err(error)
                    if error.chain().any(|cause| {
                        cause.downcast_ref::<std::io::Error>().is_some_and(|error| {
                            error.raw_os_error() == fs2::lock_contended_error().raw_os_error()
                        })
                    }) && tokio::time::Instant::now() < until =>
                {
                    tokio::time::sleep(Duration::from_millis(50)).await
                }
                Err(error) => return Err(error),
            }
        };
        Ok(Self {
            _lock: lock,
            committed: receipt(info, profile)?,
        })
    }
}

#[derive(Clone)]
pub(crate) struct Control {
    pub configuration: Configuration,
    pub send: mpsc::Sender<Request>,
    pub busy: Arc<AtomicBool>,
}

impl Control {
    pub async fn exchange<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin>(
        &self,
        request: &Value,
        lines: &mut tokio::io::Lines<R>,
        write: &mut W,
    ) -> Result<()> {
        let expected: Info = serde_json::from_value(request["params"]["kernel"].clone())?;
        let profile = request["params"]["profile"]
            .as_str()
            .context("The desktop profile is required")?;
        uuid::Uuid::parse_str(profile).context("Invalid desktop profile")?;
        ensure!(
            expected == self.configuration.info,
            "The kernel changed after the adoption preview; check it again"
        );
        let _transaction = transaction_lock(&expected.directory)?;
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| anyhow::anyhow!("This kernel is already being adopted"))?;
        let (ready, wait) = oneshot::channel();
        let (decision, decided) = oneshot::channel();
        if self
            .send
            .try_send(Request {
                configuration: self.configuration.clone(),
                ready,
                decision: decided,
            })
            .is_err()
        {
            self.busy.store(false, Ordering::Release);
            anyhow::bail!("The kernel cannot begin adoption now");
        }
        let configuration = wait
            .await
            .context("The kernel stopped before preparing adoption")?
            .map_err(anyhow::Error::msg)?;
        write_answer(write, json!({"result": configuration})).await?;
        // A lost client automatically relinquishes the attempt. If another kernel has
        // already taken the lease, the old CLI never kills it or writes through its lock.
        let commit = match tokio::time::timeout(Duration::from_secs(600), lines.next_line()).await {
            Ok(Ok(Some(line))) => {
                serde_json::from_str::<Value>(&line)
                    .ok()
                    .is_some_and(|request| {
                        request["method"] == "kernel.commit"
                            && request["params"]["instance"] == expected.instance
                            && request["params"]["profile"] == profile
                    })
            }
            _ => false,
        };
        // A crash or lost ACK after this durable receipt must never resume the old owner.
        let persistence = if commit {
            self::commit(&expected, profile)
        } else {
            Ok(())
        };
        let recorded = receipt(&expected, profile);
        // An unreadable receipt after a valid commit is indeterminate. Never resume a
        // second kernel in that case; journal recovery requires a readable receipt.
        let committed = commit && recorded.as_ref().copied().unwrap_or(true);
        let answer = match persistence.and(recorded.map(|_| ())) {
            Ok(()) => json!({"result": committed}),
            Err(error) => json!({"error": format!("Record ownership decision: {error:#}")}),
        };
        let acknowledged = write_answer(write, answer).await;
        let _ = decision.send(committed);
        acknowledged
    }
}

pub(crate) async fn write_answer(
    write: &mut (impl AsyncWrite + Unpin),
    value: Value,
) -> Result<()> {
    write.write_all(format!("{value}\n").as_bytes()).await?;
    write.flush().await?;
    Ok(())
}

pub async fn describe(directory: &Path) -> Result<Info> {
    let mut client = crate::local_control::Client::connect(directory).await?;
    let value = tokio::time::timeout(
        Duration::from_secs(10),
        client.ask("kernel.describe", json!({})),
    )
    .await
    .context("The kernel did not answer the adoption check")?
    .map_err(|error| {
        if error
            .to_string()
            .contains("does not know `kernel.describe`")
        {
            anyhow::anyhow!("Update the CLI kernel before transferring this workspace to the app")
        } else {
            error
        }
    })?;
    serde_json::from_value(value).context("Update the CLI kernel before adopting this workspace")
}

pub struct Transfer {
    client: crate::local_control::Client,
    pub configuration: Configuration,
    profile: String,
}

impl Transfer {
    pub async fn begin(info: &Info, profile: &str) -> Result<Self> {
        let mut client = crate::local_control::Client::connect(&info.directory).await?;
        let configuration: Configuration = serde_json::from_value(
            tokio::time::timeout(
                Duration::from_secs(120),
                client.ask(
                    "kernel.handoff",
                    json!({"kernel": info, "profile": profile}),
                ),
            )
            .await
            .context("The kernel did not finish shutting down for adoption")??,
        )?;
        ensure!(
            configuration.info == *info,
            "The kernel's adoption configuration changed"
        );
        Ok(Self {
            client,
            configuration,
            profile: profile.to_owned(),
        })
    }

    pub async fn finish(mut self, commit: bool) -> Result<()> {
        let method = if commit {
            "kernel.commit"
        } else {
            "kernel.cancel"
        };
        let answer = tokio::time::timeout(
            Duration::from_secs(10),
            self.client.ask(
                method,
                json!({"instance": self.configuration.info.instance, "profile": self.profile}),
            ),
        )
        .await
        .context("The kernel did not acknowledge the adoption decision")??;
        ensure!(
            answer == commit,
            "The kernel did not accept the adoption decision"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn adoption_description_pins_directory_database_host_workspace_and_schema() {
        let dir = tempfile::tempdir().unwrap();
        let directory = dunce::canonicalize(dir.path()).unwrap();
        let database = directory.join("custom.sqlite");
        std::fs::write(&database, b"untouched").unwrap();
        std::fs::write(directory.join("host-id"), "host-kept").unwrap();
        let info = Info {
            instance: "instance".into(),
            workspace_id: "workspace".into(),
            workspace_name: "Company".into(),
            host_id: "host-kept".into(),
            version: crate::build::version().into(),
            schema: crate::build::schema().into(),
            directory: directory.clone(),
            database: database.clone(),
            network: Network::local(4310),
            external_livekit: false,
            authenticated: true,
        };
        assert!(info.validate(&directory, "workspace").is_ok());
        assert!(info.validate(&directory, "another-workspace").is_err());
        let other = tempfile::tempdir().unwrap();
        assert!(info.validate(other.path(), "workspace").is_err());
        let mut changed = info.clone();
        changed.schema = "different-schema".into();
        assert!(changed.validate(&directory, "workspace").is_err());
        changed = info.clone();
        changed.host_id = "different-host".into();
        assert!(changed.validate(&directory, "workspace").is_err());
        changed = info;
        changed.database = "relative.sqlite".into();
        assert!(changed.validate(&directory, "workspace").is_err());
        assert_eq!(std::fs::read(database).unwrap(), b"untouched");
    }
    #[test]
    fn network_rejects_implicit_exposure_and_invalid_public_origins() {
        let mut network = Network::local(4310);
        assert!(network.validate().is_ok());
        network.expose = Some([0, 0, 0, 0].into());
        assert!(network.validate().is_err());
        network.expose = Some([192, 0, 2, 1].into());
        assert!(network.validate().is_ok());
        network.public_livekit_url = Some("wss://example.org".into());
        assert!(network.validate().is_err());
        network.public_origin = Some("https://example.org".into());
        assert!(network.validate().is_ok());
    }
}
