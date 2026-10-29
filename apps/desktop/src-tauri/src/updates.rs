//! One updater for this installation. Feeds and packages are authenticated before use;
//! activation goes through the desktop host, which owns its windows and local kernels.

use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

const FEEDS: &str = "https://github.com/b3nab/darkcompany-zerolux/releases/download/updates";
const PUBLIC_KEY: &str = match option_env!("ZEROLUX_UPDATE_PUBLIC_KEY") {
    Some(key) => key,
    None => "",
};
const PREFERENCE: &str = "update-channel.json";

fn feed_root() -> Result<&'static str> {
    #[cfg(debug_assertions)]
    if let Some(root) = option_env!("ZEROLUX_UPDATE_TEST_FEEDS") {
        return test_feed_root(root);
    }
    Ok(FEEDS)
}

#[cfg(any(debug_assertions, test))]
fn test_feed_root(root: &str) -> Result<&str> {
    let url = tauri::Url::parse(root).context("Invalid local update fixture URL")?;
    ensure!(
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port().is_some_and(|port| port > 0)
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "Local update fixtures require http://127.0.0.1:<port> without credentials, query or fragment"
    );
    Ok(root.trim_end_matches('/'))
}

#[derive(Clone, Serialize)]
pub struct Available {
    version: String,
    commit: String,
    built_at: String,
    notes: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    channel: String,
    current: zerolux::build::BuildInfo,
    phase: &'static str,
    available: Option<Available>,
    downloaded: u64,
    total: Option<u64>,
    checked_at: Option<String>,
    error: Option<String>,
}

#[derive(Clone)]
pub(crate) struct Pending {
    pub update: Update,
    pub bytes: Arc<Vec<u8>>,
    pub schema: String,
}

struct Inner {
    state: UpdateState,
    offer: Option<Update>,
    pending: Option<Pending>,
}

pub struct Updates {
    root: PathBuf,
    inner: Mutex<Inner>,
    operation: tokio::sync::Mutex<()>,
}

fn channel(value: &str) -> Result<&str> {
    ensure!(
        matches!(value, "nightly" | "beta" | "stable"),
        "Unknown update channel"
    );
    Ok(value)
}

fn selected_channel(root: &Path, build_channel: &str) -> String {
    std::fs::read(root.join(PREFERENCE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<String>(&bytes).ok())
        .filter(|value| channel(value).is_ok())
        .unwrap_or_else(|| build_channel.to_owned())
}

fn save_channel(root: &Path, selected: &str) -> Result<()> {
    crate::preferences::write_json(root, PREFERENCE, &channel(selected)?)
        .context("Save the selected update channel")
}

fn permitted(window: &WebviewWindow) -> Result<(), String> {
    if (window.label() == "tray" || window.label().starts_with("workspace-"))
        && window
            .url()
            .ok()
            .as_ref()
            .is_some_and(crate::local::app_page)
    {
        Ok(())
    } else {
        Err("Updates are controlled from this app's own interface".into())
    }
}

impl Updates {
    fn state(&self) -> UpdateState {
        self.inner.lock().expect("update state").state.clone()
    }

    fn publish(&self, app: &tauri::AppHandle, change: impl FnOnce(&mut Inner)) -> UpdateState {
        let state = {
            let mut inner = self.inner.lock().expect("update state");
            change(&mut inner);
            inner.state.clone()
        };
        let _ = app.emit("zerolux-update", &state);
        state
    }

    async fn check(&self, app: &tauri::AppHandle) -> UpdateState {
        let Ok(_operation) = self.operation.try_lock() else {
            return self.state();
        };
        if self.state().phase == "installing" {
            return self.state();
        }
        self.publish(app, |inner| {
            inner.state.phase = "checking";
            inner.state.error = None;
        });
        let result = self.find(app).await;
        match result {
            Ok(Some(offer)) => {
                let retained = self
                    .inner
                    .lock()
                    .expect("update state")
                    .pending
                    .as_ref()
                    .is_some_and(|pending| pending.update.raw_json == offer.raw_json);
                if retained {
                    return self.publish(app, |inner| {
                        inner.state.phase = "ready";
                        inner.state.checked_at = Some(now());
                    });
                }
                let available = match available(&offer.raw_json) {
                    Ok(available) => available,
                    Err(error) => return self.failure(app, error),
                };
                self.publish(app, |inner| {
                    inner.state.phase = "available";
                    inner.state.available = Some(available);
                    inner.state.checked_at = Some(now());
                    inner.offer = Some(offer);
                    inner.pending = None;
                });
                if let Err(error) = self.download(app).await {
                    self.failure(app, error);
                }
            }
            Ok(None) => {
                self.publish(app, |inner| {
                    inner.state.phase = "idle";
                    inner.state.available = None;
                    inner.state.checked_at = Some(now());
                    inner.offer = None;
                    inner.pending = None;
                });
            }
            Err(error) => {
                self.failure(app, error);
            }
        }
        self.state()
    }

    fn failure(&self, app: &tauri::AppHandle, error: anyhow::Error) -> UpdateState {
        self.publish(app, |inner| {
            inner.state.phase = if inner.pending.is_some() {
                "ready"
            } else {
                "error"
            };
            inner.state.error = Some(format!("{error:#}"));
        })
    }

    async fn find(&self, app: &tauri::AppHandle) -> Result<Option<Update>> {
        ensure!(
            !PUBLIC_KEY.is_empty(),
            "This build has no update signing key configured"
        );
        let selected = self.state().channel;
        let url = format!("{}/{}.json", feed_root()?, channel(&selected)?);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()?;
        let Some(bytes) = get(&client, &url, 1024 * 1024).await? else {
            return Ok(None);
        };
        let signature = get(&client, &format!("{url}.sig"), 16 * 1024)
            .await?
            .context("The update feed has no signature")?;
        verify(&bytes, std::str::from_utf8(&signature)?, PUBLIC_KEY)?;
        let feed: serde_json::Value = serde_json::from_slice(&bytes)?;
        validate_feed(&feed, &selected)?;
        let current = semver::Version::parse(zerolux::build::version())?;
        if semver::Version::parse(feed["version"].as_str().unwrap())? <= current {
            return Ok(None);
        }
        for profile in crate::catalog::Catalog::load(&self.root)?.profiles {
            if profile.directory().is_some() && profile.database()?.is_file() {
                ensure!(
                    feed["schema"] == zerolux::build::schema(),
                    "This update changes the workspace schema; this pre-release cannot install it automatically"
                );
            }
        }
        let candidate = app
            .updater_builder()
            .pubkey(PUBLIC_KEY)
            .endpoints(vec![url.parse()?])?
            .version_comparator(move |_, release| release.version > current)
            .timeout(Duration::from_secs(300))
            .build()?
            .check()
            .await?;
        if let Some(candidate) = &candidate {
            // Publishing a feed and its sidecar may race a check. Retry on the next check;
            // never combine authenticated metadata with a different package announcement.
            ensure!(
                candidate.raw_json == feed,
                "The update feed changed while checking; try again"
            );
        }
        Ok(candidate)
    }

    async fn download(&self, app: &tauri::AppHandle) -> Result<()> {
        let offer = self
            .inner
            .lock()
            .expect("update state")
            .offer
            .clone()
            .context("No update is available")?;
        self.publish(app, |inner| {
            inner.state.phase = "downloading";
            inner.state.downloaded = 0;
            inner.state.total = None;
            inner.state.error = None;
        });
        let bytes = offer
            .download(
                |count, total| {
                    self.publish(app, |inner| {
                        inner.state.downloaded += count as u64;
                        inner.state.total = total;
                    });
                },
                || {},
            )
            .await?;
        let schema = offer.raw_json["schema"]
            .as_str()
            .context("The update has no schema fingerprint")?
            .to_owned();
        self.publish(app, |inner| {
            inner.pending = Some(Pending {
                update: offer,
                bytes: Arc::new(bytes),
                schema,
            });
            inner.state.phase = "ready";
        });
        Ok(())
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn available(feed: &serde_json::Value) -> Result<Available> {
    let field = |name| {
        feed[name]
            .as_str()
            .map(str::to_owned)
            .with_context(|| format!("The update feed has no {name}"))
    };
    Ok(Available {
        version: field("version")?,
        commit: field("commit")?,
        built_at: field("built_at")?,
        notes: feed["notes"].as_str().unwrap_or_default().to_owned(),
    })
}

fn validate_feed(feed: &serde_json::Value, selected: &str) -> Result<()> {
    let offer = available(feed)?;
    let version = semver::Version::parse(&offer.version)?;
    ensure!(
        feed["channel"] == selected,
        "The update feed belongs to another channel"
    );
    let fits = match selected {
        "nightly" => version.pre.is_empty() || version.pre.as_str().starts_with("alpha."),
        "beta" => {
            version.pre.is_empty()
                || version.pre.as_str().starts_with("beta.")
                || version.pre.as_str().starts_with("rc.")
        }
        "stable" => version.pre.is_empty(),
        _ => false,
    };
    ensure!(fits, "The update version does not belong to this channel");
    ensure!(
        feed["schema"].as_str().is_some_and(
            |value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        ),
        "The update has no valid schema fingerprint"
    );
    Ok(())
}

fn verify(bytes: &[u8], signature: &str, key: &str) -> Result<()> {
    let key = String::from_utf8(STANDARD.decode(key.trim())?)?;
    let signature = String::from_utf8(STANDARD.decode(signature.trim())?)?;
    let key = minisign_verify::PublicKey::decode(&key)?;
    let signature = minisign_verify::Signature::decode(&signature)?;
    key.verify(bytes, &signature, true)
        .context("The update feed signature is invalid")
}

async fn get(client: &reqwest::Client, url: &str, limit: usize) -> Result<Option<Vec<u8>>> {
    let mut response = client
        .get(url)
        .header("User-Agent", "ZeroLux")
        .send()
        .await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    response.error_for_status_ref()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len() + chunk.len() <= limit,
            "The update feed is too large"
        );
        bytes.extend(chunk);
    }
    Ok(Some(bytes))
}

pub fn initialize(app: &tauri::AppHandle, root: PathBuf) {
    let selected = selected_channel(&root, zerolux::build::channel());
    app.manage(Updates {
        root,
        inner: Mutex::new(Inner {
            state: UpdateState {
                channel: selected,
                current: zerolux::build::info(),
                phase: "idle",
                available: None,
                downloaded: 0,
                total: None,
                checked_at: None,
                error: None,
            },
            offer: None,
            pending: None,
        }),
        operation: tokio::sync::Mutex::new(()),
    });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if app.state::<Updates>().state().phase != "ready" {
                app.state::<Updates>().check(&app).await;
            }
            tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
        }
    });
}

#[tauri::command]
pub fn update_status(window: WebviewWindow, app: tauri::AppHandle) -> Result<UpdateState, String> {
    permitted(&window)?;
    Ok(updates(&app)?.state())
}

fn updates(app: &tauri::AppHandle) -> Result<tauri::State<'_, Updates>, String> {
    app.try_state::<Updates>()
        .ok_or_else(|| "The desktop is still starting".into())
}

/// Looks for an update on the channel chosen.
pub(crate) async fn check(app: &tauri::AppHandle) -> Result<UpdateState, String> {
    Ok(updates(app)?.check(app).await)
}

#[tauri::command]
pub async fn update_check(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<UpdateState, String> {
    permitted(&window)?;
    check(&app).await
}

#[tauri::command]
pub async fn update_channel(
    window: WebviewWindow,
    app: tauri::AppHandle,
    channel: String,
) -> Result<UpdateState, String> {
    permitted(&window)?;
    self::channel(&channel).map_err(|error| error.to_string())?;
    let updates = updates(&app)?;
    {
        let _operation = updates
            .operation
            .try_lock()
            .map_err(|_| "An update is already in progress")?;
        if updates.state().phase == "installing" {
            return Err("The app is installing an update".into());
        }
        save_channel(&updates.root, &channel).map_err(|error| error.to_string())?;
        updates.publish(&app, |inner| {
            inner.state.channel = channel;
            inner.state.phase = "idle";
            inner.state.available = None;
            inner.state.error = None;
            inner.state.checked_at = None;
            inner.offer = None;
            inner.pending = None;
        });
    }
    Ok(updates.check(&app).await)
}

/// Downloads the update found, ready to install.
pub(crate) async fn download(app: &tauri::AppHandle) -> Result<UpdateState, String> {
    let updates = updates(app)?;
    let _operation = updates
        .operation
        .try_lock()
        .map_err(|_| "An update is already in progress")?;
    if matches!(updates.state().phase, "ready" | "installing") {
        return Ok(updates.state());
    }
    if let Err(error) = updates.download(app).await {
        updates.failure(app, error);
    }
    Ok(updates.state())
}

#[tauri::command]
pub async fn update_download(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<UpdateState, String> {
    permitted(&window)?;
    download(&app).await
}

/// Installs the update downloaded, restarting the app.
pub(crate) async fn install(app: &tauri::AppHandle) -> Result<UpdateState, String> {
    let updates = updates(app)?;
    let _operation = updates
        .operation
        .try_lock()
        .map_err(|_| "An update is already in progress")?;
    let pending = {
        let inner = updates.inner.lock().expect("update state");
        if inner.state.phase != "ready" {
            return Err("The update is not ready to install".into());
        }
        inner
            .pending
            .clone()
            .ok_or("The update is not downloaded")?
    };
    // A stable build promoted into Nightly or Beta must not change an implicit preference.
    // Persist it before any shutdown or replacement; a write failure leaves this app ready.
    save_channel(&updates.root, &updates.state().channel).map_err(|error| format!("{error:#}"))?;
    updates.publish(app, |inner| {
        inner.state.phase = "installing";
        inner.state.error = None;
    });
    if let Err(error) = crate::app::install_update(app, pending).await {
        updates.publish(app, |inner| {
            inner.state.phase = "ready";
            inner.state.error = Some(error.clone());
        });
        return Err(error);
    }
    Ok(updates.state())
}

#[tauri::command]
pub async fn update_install(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<UpdateState, String> {
    permitted(&window)?;
    install(&app).await
}

/// Called only after the desktop has stopped its local kernels and taken their leases.
pub(crate) async fn backup(database: &Path, target: &Path) -> Result<()> {
    use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
    let options = SqliteConnectOptions::new()
        .filename(database)
        .read_only(true)
        .create_if_missing(false);
    let mut source = SqliteConnection::connect_with(&options).await?;
    let result = sqlx::query("VACUUM INTO ?")
        .bind(target.to_str().context("Invalid backup path")?)
        .execute(&mut source)
        .await;
    source.close().await?;
    result.context("Back up the local workspace")?;
    let mut snapshot = SqliteConnection::connect_with(
        &SqliteConnectOptions::new().filename(target).read_only(true),
    )
    .await?;
    let check: String = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_one(&mut snapshot)
        .await?;
    snapshot.close().await?;
    ensure!(
        check == "ok",
        "The workspace backup failed its integrity check"
    );
    std::fs::OpenOptions::new()
        .write(true)
        .open(target)?
        .sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_update_fixtures_only_use_an_explicit_loopback_port() {
        assert_eq!(
            test_feed_root("http://127.0.0.1:4311/feeds/").unwrap(),
            "http://127.0.0.1:4311/feeds"
        );
        for invalid in [
            "https://example.org/feeds",
            "http://example.org:4311/feeds",
            "http://localhost:4311/feeds",
            "http://0.0.0.0:4311/feeds",
            "http://127.0.0.1/feeds",
            "http://127.0.0.1:0/feeds",
            "http://user:secret@127.0.0.1:4311/feeds",
            "http://127.0.0.1:4311/feeds?channel=stable",
            "http://127.0.0.1:4311/feeds#stable",
        ] {
            assert!(test_feed_root(invalid).is_err(), "{invalid}");
        }
    }

    #[cfg(not(debug_assertions))]
    #[test]
    fn release_builds_always_use_the_production_feed() {
        assert_eq!(feed_root().unwrap(), FEEDS);
    }

    /// Deterministic test-only keys. No installed signing key or personal data is read.
    fn signed(bytes: &[u8]) -> (String, String) {
        use ed25519_dalek::Signer;
        let key = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
        let id = [3; 8];
        let signature = key.sign(bytes).to_bytes();
        let comment = "fixture";
        let global = key.sign(&[signature.as_slice(), comment.as_bytes()].concat());
        let public =
            STANDARD.encode([b"Ed".as_slice(), &id, key.verifying_key().as_bytes()].concat());
        let packet = STANDARD.encode([b"Ed".as_slice(), &id, &signature].concat());
        (
            STANDARD.encode(format!("untrusted comment: fixture\n{public}\n")),
            STANDARD.encode(format!(
                "untrusted comment: fixture\n{packet}\ntrusted comment: {comment}\n{}\n",
                STANDARD.encode(global.to_bytes())
            )),
        )
    }

    fn feed(channel: &str, version: &str) -> serde_json::Value {
        serde_json::json!({ "channel": channel, "version": version, "schema": "a".repeat(64),
            "commit": "0123456789abcdef", "built_at": "2026-10-23T12:00:00Z", "notes": "Fixture" })
    }

    #[test]
    fn authenticated_feeds_reject_changed_channels_and_schemas() {
        let original = feed("nightly", "0.0.1-alpha.20261023.1");
        let bytes = serde_json::to_vec(&original).unwrap();
        let (key, signature) = signed(&bytes);
        verify(&bytes, &signature, &key).unwrap();
        for field in ["channel", "schema", "version"] {
            let mut changed = original.clone();
            changed[field] = "tampered".into();
            assert!(verify(&serde_json::to_vec(&changed).unwrap(), &signature, &key).is_err());
        }
        assert!(verify(&bytes, "invalid", &key).is_err());
    }

    #[test]
    fn channels_are_explicit_and_stable_can_be_promoted_without_changing_preference() {
        assert!(validate_feed(&feed("nightly", "0.0.1-alpha.20261023.1"), "nightly").is_ok());
        assert!(validate_feed(&feed("beta", "0.0.1-rc.1"), "beta").is_ok());
        for selected in ["nightly", "beta", "stable"] {
            assert!(validate_feed(&feed(selected, "0.0.1"), selected).is_ok());
        }
        assert!(validate_feed(&feed("nightly", "0.0.1-alpha.20261023.1"), "stable").is_err());
        assert!(validate_feed(&feed("stable", "0.0.1-rc.1"), "stable").is_err());
        assert!(channel("../../other").is_err());
    }

    #[test]
    fn a_promoted_stable_build_keeps_the_implicit_testing_channel() {
        for initial in ["nightly", "beta"] {
            let root = tempfile::tempdir().unwrap();
            let selected = selected_channel(root.path(), initial);
            assert_eq!(selected, initial);
            assert!(!root.path().join(PREFERENCE).exists());
            // The install saves the preference before the replacement build starts.
            save_channel(root.path(), &selected).unwrap();
            assert_eq!(selected_channel(root.path(), "stable"), initial);
            save_channel(root.path(), "stable").unwrap();
            assert_eq!(selected_channel(root.path(), initial), "stable");
        }
        let root = tempfile::NamedTempFile::new().unwrap();
        assert!(save_channel(root.path(), "nightly").is_err());
    }

    #[tokio::test]
    async fn backup_includes_committed_wal_and_never_replaces_the_live_database() {
        use sqlx::{
            Connection, SqliteConnection,
            sqlite::{SqliteConnectOptions, SqliteJournalMode},
        };
        let root = tempfile::tempdir().unwrap();
        let database = root.path().join("workspace.db");
        let target = root.path().join("backup.db");
        let options = SqliteConnectOptions::new()
            .filename(&database)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal);
        let mut source = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("CREATE TABLE messages (body TEXT)")
            .execute(&mut source)
            .await
            .unwrap();
        sqlx::query("INSERT INTO messages VALUES ('kept')")
            .execute(&mut source)
            .await
            .unwrap();
        assert!(root.path().join("workspace.db-wal").is_file());
        backup(&database, &target).await.unwrap();
        let mut snapshot = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&target)
                .read_only(true),
        )
        .await
        .unwrap();
        let body: String = sqlx::query_scalar("SELECT body FROM messages")
            .fetch_one(&mut snapshot)
            .await
            .unwrap();
        assert_eq!(body, "kept");
        snapshot.close().await.unwrap();
        assert!(
            backup(&database, &target).await.is_err(),
            "An existing backup is never overwritten"
        );
        sqlx::query("INSERT INTO messages VALUES ('after failure')")
            .execute(&mut source)
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
            .fetch_one(&mut source)
            .await
            .unwrap();
        assert_eq!(count, 2);
        source.close().await.unwrap();

        // Installation closes the kernel first, so SQLite's WAL and shared memory are gone.
        assert!(!root.path().join("workspace.db-wal").exists());
        assert!(!root.path().join("workspace.db-shm").exists());
        let closed_target = root.path().join("closed-backup.db");
        backup(&database, &closed_target).await.unwrap();
        let mut snapshot = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&closed_target)
                .read_only(true),
        )
        .await
        .unwrap();
        let bodies: Vec<String> = sqlx::query_scalar("SELECT body FROM messages ORDER BY rowid")
            .fetch_all(&mut snapshot)
            .await
            .unwrap();
        assert_eq!(bodies, ["kept", "after failure"]);
        snapshot.close().await.unwrap();
        let saved = std::fs::read(&closed_target).unwrap();
        assert!(
            backup(&database, &closed_target).await.is_err(),
            "A closed-database backup is never overwritten"
        );
        assert_eq!(std::fs::read(&closed_target).unwrap(), saved);
    }
}
