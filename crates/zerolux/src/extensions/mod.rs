//! Extensions of ZeroLux: installed in a workspace, enabled when needed. Each brings actions
//! (defined once for people, agents and the API), extension points with their contracts and
//! the implementations of others', events, triggers, settings and stored values, through its
//! parts. The kernel offers the mechanism; what the contracts mean is the extensions' own.

pub mod card;
pub mod library;
pub mod manifest;
pub mod marketplace;
pub mod oauth;
pub mod package;
pub mod process;
pub mod scaffold;
pub mod vault;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Weak},
    time::Instant,
};

use anyhow::{Context, Result, bail, ensure};
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::RwLock;

use crate::{
    entity::{extension_calls, extension_values, extensions},
    model::ChatIdentity,
    store::{Error, Store, now_ms},
};

use manifest::{Contributes, Manifest};

/// Who runs an action.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Caller {
    /// The person, or the agent whose session runs it.
    pub actor_id: Option<String>,
    pub session_id: Option<String>,
    /// The extension or trigger that runs it.
    pub by: Option<String>,
    /// The kernel's address as the person's device reached it, for a sign-in to come back to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

impl Caller {
    pub fn of(who: &ChatIdentity) -> Self {
        Self {
            actor_id: who.actor_id.clone(),
            session_id: who.session_id.clone(),
            by: None,
            origin: None,
        }
    }

    /// From a person's device, which reached the kernel at `origin`.
    pub fn at(mut self, origin: Option<String>) -> Self {
        self.origin = origin;
        self
    }
}

/// An extension as people and clients see it.
#[derive(Debug, Clone, Serialize)]
pub struct Installed {
    pub id: String,
    pub name: String,
    pub version: String,
    pub publisher: String,
    pub description: String,
    pub source: String,
    pub dev: bool,
    pub enabled: bool,
    /// Its parts are running now.
    pub running: bool,
    pub error: Option<String>,
    pub dependencies: std::collections::BTreeMap<String, String>,
    pub parts: Vec<&'static str>,
    pub settings: Vec<SettingView>,
    pub contributes: Option<Contributes>,
    pub installed_at: i64,
    pub updated_at: i64,
    /// The agent that proposed it, until the owner enables it.
    pub proposed_by: Option<String>,
    /// What it shows of itself: icon, images, video, README, CHANGELOG, categories, links; each
    /// file at its `address`.
    pub card: Option<Value>,
}

/// Where a file a card shows is found, by its digest.
#[derive(Debug, Clone)]
enum AssetSource {
    /// In an installed extension's folder.
    File(PathBuf),
    /// In an index, at this address.
    Index(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct SettingView {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub label: String,
    pub description: String,
    /// Its value; a secret's is never shown.
    pub value: Option<Value>,
    /// For a secret, whether it has one.
    pub set: bool,
    /// A choice's values, each with its label.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<manifest::SettingOption>,
}

/// An enabled extension's action, for clients and agents.
#[derive(Debug, Clone, Serialize)]
pub struct ActionView {
    pub extension: String,
    #[serde(flatten)]
    pub action: manifest::Action,
}

struct Loaded {
    manifest: Manifest,
    contributes: Contributes,
    process: Option<Arc<process::Process>>,
}

pub struct Extensions {
    store: Store,
    /// Where extensions keep their logs.
    root: PathBuf,
    loaded: RwLock<HashMap<String, Loaded>>,
    /// Tells every person's clients something: that extensions changed, an extension's event,
    /// or a view it keeps.
    tell: Box<dyn Fn(Value) + Send + Sync>,
    /// When each schedule trigger runs next, by extension and trigger.
    next_runs: std::sync::Mutex<HashMap<(String, usize), i64>>,
    /// How the folder of each extension being worked on looked when last seen, and whether it
    /// changed since it was loaded.
    watched: std::sync::Mutex<HashMap<String, (u64, bool)>>,
    /// Keys that open an extension's own pages, until they expire: extension and expiry.
    ui_keys: std::sync::Mutex<HashMap<String, (String, i64)>>,
    /// The runtime extensions reach the rest of ZeroLux through.
    runtime: std::sync::OnceLock<Weak<crate::chat_runtime::ChatRuntime>>,
    /// Their secrets, encrypted with the kernel's key.
    vault: vault::Vault,
    /// Sign-ins to other services under way.
    sign_ins: oauth::Flows,
    /// The files cards show, by digest, and each installed folder's card as last read.
    assets: std::sync::Mutex<HashMap<String, (AssetSource, String)>>,
    cards: std::sync::Mutex<HashMap<PathBuf, (String, Option<card::Card>)>>,
    me: Weak<Extensions>,
}

/// Secrets, encrypted: their settings' and those they keep themselves.
fn sealed(kind: &str) -> bool {
    kind == "secret"
}

/// Where a secret an extension keeps itself is, beside its settings' secrets, whose names
/// have no slash: `vault/<name>`, its name 1 to 200 bytes.
fn kept(name: &str) -> Result<String> {
    ensure!(
        !name.is_empty() && name.len() <= 200,
        Error::Invalid("A secret's name is 1 to 200 bytes".into())
    );
    Ok(format!("{VAULT}{name}"))
}

const VAULT: &str = "vault/";

/// A card as clients read it: each file at the kernel's address for it.
fn shown_card(card: &card::Card) -> Value {
    let mut shown = card.clone();
    for asset in shown.assets_mut() {
        asset.url = Some(format!(
            "/api/extensions/assets/{}",
            asset.sha256.to_lowercase()
        ));
    }
    json!(shown)
}

fn row_manifest(row: &extensions::Model) -> Result<Manifest> {
    Ok(serde_json::from_str(&row.manifest_json)?)
}

impl Extensions {
    pub fn new(store: Store, root: PathBuf, tell: Box<dyn Fn(Value) + Send + Sync>) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            store,
            loaded: RwLock::default(),
            tell,
            next_runs: std::sync::Mutex::default(),
            watched: std::sync::Mutex::default(),
            ui_keys: std::sync::Mutex::default(),
            runtime: std::sync::OnceLock::new(),
            vault: vault::Vault::at(root.join("vault.key")),
            sign_ins: oauth::Flows::default(),
            assets: std::sync::Mutex::default(),
            cards: std::sync::Mutex::default(),
            root,
            me: me.clone(),
        })
    }

    /// Where a person's client opens one of an extension's pages, `ui/…` in its folder: an
    /// address with a key of its own, good for an hour, under which its files are served.
    pub async fn ui_address(&self, who: &ChatIdentity, id: &str, entry: &str) -> Result<String> {
        ensure!(who.is_person(), Error::Forbidden);
        let shown = self.loaded.read().await.get(id).is_some_and(|loaded| {
            loaded.contributes.ui.iter().any(|piece| match &piece.view {
                manifest::UiView::Web { entry: known } => known == entry,
                manifest::UiView::Native { entry: Some(known) } => known == entry,
                _ => false,
            })
        });
        ensure!(shown, Error::NotFound);
        let key = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let now = now_ms();
        let mut keys = self.ui_keys.lock().expect("ui keys");
        keys.retain(|_, (_, expires)| *expires > now);
        keys.insert(key.clone(), (id.to_owned(), now + 3_600_000));
        Ok(format!(
            "/api/extension-ui/{key}/{}",
            entry.trim_start_matches("ui/")
        ))
    }

    /// The file a page's key opens: within its extension's `ui/` folder only.
    pub async fn ui_file(&self, key: &str, path: &str) -> Result<PathBuf> {
        let extension = {
            let keys = self.ui_keys.lock().expect("ui keys");
            match keys.get(key) {
                Some((extension, expires)) if *expires > now_ms() => extension.clone(),
                _ => bail!(Error::NotFound),
            }
        };
        ensure!(
            std::path::Path::new(path)
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_))),
            Error::NotFound
        );
        let row = self.row(&extension).await?;
        let root =
            dunce::canonicalize(Path::new(&row.source).join("ui")).map_err(|_| Error::NotFound)?;
        let file = dunce::canonicalize(root.join(path)).map_err(|_| Error::NotFound)?;
        ensure!(file.starts_with(&root) && file.is_file(), Error::NotFound);
        Ok(file)
    }

    /// Where a file given to one of an extension's actions is kept while the action runs: in
    /// the extension's own folder, which the action may move it from.
    pub fn incoming(&self, extension: &str) -> Result<PathBuf> {
        ensure!(
            manifest::Manifest::valid_id(extension),
            Error::Invalid("An extension's id is `publisher.name`".into())
        );
        let folder = self.folder(extension).join(".incoming");
        crate::platform::private_dir(&folder)?;
        Ok(folder.join(uuid::Uuid::new_v4().simple().to_string()))
    }

    /// A file an action's result gives, `{"$file": {"path": …}}`: one in an extension's own
    /// folder only.
    pub fn outgoing(&self, path: &str) -> Result<PathBuf> {
        let root = dunce::canonicalize(&self.root).map_err(|_| Error::NotFound)?;
        let file = dunce::canonicalize(path).map_err(|_| Error::NotFound)?;
        ensure!(
            file.starts_with(&root) && file.is_file(),
            Error::Invalid("An action gives only files in an extension's folder".into())
        );
        Ok(file)
    }

    /// Where an installed extension's log is kept.
    pub fn log_path(&self, id: &str) -> Result<PathBuf> {
        ensure!(
            manifest::Manifest::valid_id(id),
            Error::Invalid("An extension's id is `publisher.name`".into())
        );
        Ok(self.root.join(format!("{id}.log")))
    }

    /// A service sent the person back from a sign-in: the tokens go into the secret the
    /// extension named, and it hears `zerolux/signed_in` with whether it worked. The page the
    /// person sees.
    pub async fn signed_in(&self, state: &str, code: Option<&str>, error: Option<&str>) -> String {
        let Some(flow) = self.sign_ins.take(state) else {
            return oauth::page(Err("this sign-in expired; start it again".into()));
        };
        let done: Result<()> = async {
            if let Some(error) = error {
                bail!("the service said `{error}`");
            }
            let code = code.context("the service gave no code")?;
            let tokens = oauth::exchange(&flow, code).await?;
            self.put_value(
                &flow.extension,
                "secret",
                &kept(&flow.request.secret)?,
                Some(&tokens),
            )
            .await
        }
        .await;
        let done = done.map_err(|error| format!("{error:#}"));
        let payload = match &done {
            Ok(()) => json!({"secret": flow.request.secret, "ok": true}),
            Err(error) => json!({"secret": flow.request.secret, "ok": false, "error": error}),
        };
        if let Some(process) = self
            .loaded
            .read()
            .await
            .get(&flow.extension)
            .and_then(|loaded| loaded.process.clone())
        {
            process.notify(
                "event",
                json!({"name": "zerolux/signed_in", "payload": payload}),
            );
        }
        (self.tell)(json!({"type": "extension.event",
            "event": format!("{}/signed_in", flow.extension)}));
        oauth::page(done)
    }

    /// Extensions reach the rest of ZeroLux through this runtime: its agents' sessions.
    pub fn serve_runtime(&self, runtime: Weak<crate::chat_runtime::ChatRuntime>) {
        let _ = self.runtime.set(runtime);
    }

    /// People's clients read the extensions again.
    fn changed(&self) {
        (self.tell)(json!({"type": "extensions.changed"}));
    }

    /// The folder an extension keeps its files in, private to it and to the kernel.
    fn folder(&self, id: &str) -> PathBuf {
        self.root.join(id)
    }

    /// The workspace's storage area, `storage/` in the data folder: the files its people and
    /// agents keep, which Storage shows as the location `ZeroLux`.
    fn storage_area(&self) -> PathBuf {
        self.root.with_file_name("storage")
    }

    async fn owner_only(&self, who: &ChatIdentity) -> Result<()> {
        ensure!(self.store.is_workspace_owner(who).await?, Error::Forbidden);
        Ok(())
    }

    async fn row(&self, id: &str) -> Result<extensions::Model> {
        Ok(extensions::Entity::find_by_id(id)
            .one(self.store.db())
            .await?
            .ok_or(Error::NotFound)?)
    }

    /// The workspace's extensions, as they are now.
    pub async fn list(&self) -> Result<Vec<Installed>> {
        let rows = extensions::Entity::find()
            .order_by_asc(extensions::Column::Id)
            .all(self.store.db())
            .await?;
        let loaded = self.loaded.read().await;
        let mut result = Vec::with_capacity(rows.len());
        for row in rows {
            let manifest = row_manifest(&row)?;
            let running = loaded
                .get(&row.id)
                .is_some_and(|loaded| loaded.process.as_ref().is_none_or(|p| p.running()));
            let settings = self.setting_views(&row.id, &manifest).await?;
            let parts = manifest::parts_of(&manifest, Path::new(&row.source));
            result.push(Installed {
                id: row.id.clone(),
                name: manifest.extension.name.clone(),
                version: row.version.clone(),
                publisher: manifest.extension.publisher.clone(),
                description: manifest.extension.description.clone(),
                source: row.source.clone(),
                dev: row.dev,
                enabled: row.enabled,
                running,
                error: row.error.clone(),
                dependencies: manifest.dependencies.clone(),
                parts,
                settings,
                contributes: row
                    .contributes_json
                    .as_deref()
                    .and_then(|json| serde_json::from_str(json).ok()),
                installed_at: row.installed_at,
                updated_at: row.updated_at,
                proposed_by: row.proposed_by.clone(),
                card: self.folder_card(Path::new(&row.source), &manifest),
            });
        }
        Ok(result)
    }

    /// An installed folder's card, read again when its files change; its files known by digest.
    fn folder_card(&self, folder: &Path, manifest: &Manifest) -> Option<Value> {
        let identity = &manifest.extension;
        let mut seen = String::new();
        let mut note = |path: &Path| {
            if let Ok(meta) = std::fs::metadata(path) {
                let at = meta
                    .modified()
                    .ok()
                    .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |since| since.as_nanos());
                seen.push_str(&format!("{}:{}:{at};", path.display(), meta.len()));
            }
        };
        for name in [identity.icon.as_deref(), identity.icon_dark.as_deref()]
            .into_iter()
            .flatten()
            .chain(["README.md", "CHANGELOG.md", manifest::FILE])
        {
            note(&folder.join(name));
        }
        if let Ok(entries) = std::fs::read_dir(folder.join("media")) {
            let mut paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
            paths.sort();
            for path in paths {
                note(&path);
            }
        }
        let known = self
            .cards
            .lock()
            .expect("cards")
            .get(folder)
            .filter(|(was, _)| *was == seen)
            .map(|(_, card)| card.clone());
        let card = match known {
            Some(card) => card,
            None => {
                let card = card::card(folder, manifest)
                    .inspect_err(|error| {
                        tracing::warn!(folder = %folder.display(), error = format!("{error:#}"), "Card not shown")
                    })
                    .ok();
                self.cards
                    .lock()
                    .expect("cards")
                    .insert(folder.to_path_buf(), (seen, card.clone()));
                card
            }
        }?;
        let mut assets = self.assets.lock().expect("assets");
        for asset in card.assets() {
            assets.insert(
                asset.sha256.clone(),
                (
                    AssetSource::File(folder.join(&asset.name)),
                    asset.name.clone(),
                ),
            );
        }
        Some(shown_card(&card))
    }

    /// A file a card shows, by its digest: from an installed folder, or from its index,
    /// downloaded once and kept, and only as its digest says. Its path and type.
    pub async fn asset(&self, sha256: &str) -> Result<(PathBuf, &'static str)> {
        let sha256 = sha256.to_ascii_lowercase();
        ensure!(
            sha256.len() == 64 && sha256.bytes().all(|b| b.is_ascii_hexdigit()),
            Error::NotFound
        );
        let (source, name) = self
            .assets
            .lock()
            .expect("assets")
            .get(&sha256)
            .cloned()
            .ok_or(Error::NotFound)?;
        let kind = card::content_type(&name);
        match source {
            AssetSource::File(path) => {
                let bytes = tokio::fs::read(&path).await.map_err(|_| Error::NotFound)?;
                ensure!(package::sha256(&bytes) == sha256, Error::NotFound);
                Ok((path, kind))
            }
            AssetSource::Index(url) => {
                let kept = self.root.join("assets").join(&sha256);
                if !kept.is_file() {
                    let bytes = marketplace::download(
                        &url,
                        &marketplace::Package {
                            url: url.clone(),
                            sha256: sha256.clone(),
                        },
                    )
                    .await?;
                    tokio::fs::create_dir_all(self.root.join("assets")).await?;
                    let staged = kept.with_extension("part");
                    tokio::fs::write(&staged, &bytes).await?;
                    tokio::fs::rename(&staged, &kept).await?;
                }
                Ok((kept, kind))
            }
        }
    }

    /// Installs, or installs again, the extension in `folder` on the kernel's computer, as one
    /// being worked on, and enables it.
    pub async fn install_folder(&self, who: &ChatIdentity, folder: &str) -> Result<Installed> {
        if who.is_person() {
            return self.install(who, folder, true).await;
        }
        self.propose(who, folder).await
    }

    /// An agent's extension, from a folder it wrote on the kernel's computer: kept as proposed,
    /// and run only once the owner enables it. It never replaces one the owner installed.
    async fn propose(&self, who: &ChatIdentity, folder: &str) -> Result<Installed> {
        // The agent, or the session for one without an agent.
        let agent = who
            .actor_id
            .clone()
            .or_else(|| who.session_id.clone())
            .ok_or(Error::Forbidden)?;
        let folder = dunce::canonicalize(folder)
            .ok()
            .filter(|folder| folder.is_dir())
            .ok_or_else(|| Error::Invalid("This folder is not on the kernel's computer".into()))?;
        let text = std::fs::read_to_string(folder.join(manifest::FILE))
            .map_err(|_| Error::Invalid(format!("The folder has no {}", manifest::FILE)))?;
        let manifest = Manifest::parse(&text)?;
        let id = manifest.extension.id.clone();
        let existing = extensions::Entity::find_by_id(&id)
            .one(self.store.db())
            .await?;
        if let Some(existing) = &existing {
            ensure!(
                existing.proposed_by.is_some() && !existing.enabled,
                Error::Invalid(format!("{id} is installed; the owner installs it again"))
            );
        }
        let now = now_ms();
        let row = extensions::ActiveModel {
            id: Set(id.clone()),
            version: Set(manifest.extension.version.clone()),
            source: Set(folder.to_string_lossy().into_owned()),
            dev: Set(true),
            enabled: Set(false),
            error: Set(None),
            manifest_json: Set(serde_json::to_string(&manifest)?),
            contributes_json: Set(None),
            installed_at: Set(existing.as_ref().map_or(now, |row| row.installed_at)),
            updated_at: Set(now),
            proposed_by: Set(Some(agent)),
        };
        if existing.is_some() {
            row.update(self.store.db()).await?;
        } else {
            row.insert(self.store.db()).await?;
        }
        self.changed();
        self.installed(&id).await
    }

    /// What the indexes offer: each extension's newest version that runs here, with what is
    /// installed of it; an index that cannot be read is listed with its error.
    pub async fn offers(&self, who: &ChatIdentity) -> Result<Value> {
        ensure!(who.is_person(), Error::Forbidden);
        let rows = extensions::Entity::find().all(self.store.db()).await?;
        let installed: HashMap<String, String> = rows
            .iter()
            .map(|row| (row.id.clone(), row.version.clone()))
            .collect();
        // Which package each was installed from, by the start of its digest: a new build of the
        // same version is an update too.
        let packages: HashMap<String, String> = rows
            .iter()
            .filter_map(|row| {
                let folder = Path::new(&row.source);
                folder
                    .parent()?
                    .parent()
                    .filter(|up| up.ends_with("packages"))?;
                let name = folder.file_name()?.to_str()?;
                let (_, digest) = name.rsplit_once('-')?;
                Some((row.id.clone(), digest.to_owned()))
            })
            .collect();
        let (mut offers, mut errors, mut marketplaces) = (Vec::new(), Vec::new(), Vec::new());
        for url in marketplace::indexes(self.root.parent().unwrap_or(&self.root)) {
            match marketplace::read(&url).await {
                Ok(index) => {
                    marketplaces.push(json!({"index": url, "name": index.name}));
                    for listing in &index.extensions {
                        let Some(release) = listing.newest() else {
                            continue;
                        };
                        let digest = release
                            .package()
                            .map(|package| package.sha256.to_lowercase());
                        let current = match (packages.get(&listing.id), &digest) {
                            (Some(held), Some(digest)) => Some(digest.starts_with(held.as_str())),
                            _ => None,
                        };
                        // What it shows, each file known by digest at the index's address.
                        let card =
                            release.card.as_ref().map(|card| {
                                let mut assets = self.assets.lock().expect("assets");
                                for asset in card.assets() {
                                    let Some(at) = asset.url.as_deref().and_then(|at| {
                                        reqwest::Url::parse(&url).ok()?.join(at).ok()
                                    }) else {
                                        continue;
                                    };
                                    assets.entry(asset.sha256.to_lowercase()).or_insert((
                                        AssetSource::Index(at.to_string()),
                                        asset.name.clone(),
                                    ));
                                }
                                shown_card(card)
                            });
                        offers.push(json!({"index": url, "id": listing.id,
                            "name": listing.name, "description": listing.description,
                            "publisher": listing.publisher, "version": release.version,
                            "parts": release.parts,
                            "installed": installed.get(&listing.id),
                            "current": current, "card": card}));
                    }
                }
                Err(error) => errors.push(json!({"index": url, "error": format!("{error:#}")})),
            }
        }
        Ok(json!({"offers": offers, "errors": errors, "marketplaces": marketplaces}))
    }

    /// Updates every installed extension an index offers anew, a newer version or another build
    /// of it, or only those of `ids`, one after the other: which were updated, and why the
    /// others were not.
    pub async fn update_all(&self, who: &ChatIdentity, ids: Option<&[String]>) -> Result<Value> {
        self.owner_only(who).await?;
        let offers = self.offers(who).await?;
        let mut seen = std::collections::HashSet::new();
        let (mut updated, mut failed) = (Vec::new(), Vec::new());
        for offer in offers["offers"].as_array().into_iter().flatten() {
            let (Some(index), Some(id), Some(installed)) = (
                offer["index"].as_str(),
                offer["id"].as_str(),
                offer["installed"].as_str(),
            ) else {
                continue;
            };
            let newer = offer["version"].as_str() != Some(installed) || offer["current"] == false;
            let asked = ids.is_none_or(|ids| ids.iter().any(|asked| asked == id));
            // An extension two indexes offer is updated from the first.
            if !newer || !asked || !seen.insert(id.to_owned()) {
                continue;
            }
            match self.install_offer(who, index, id, None).await {
                Ok(_) => updated.push(json!({"id": id, "version": offer["version"]})),
                Err(error) => failed.push(json!({"id": id, "error": format!("{error:#}")})),
            }
        }
        if !updated.is_empty() {
            self.changed();
        }
        Ok(json!({"updated": updated, "failed": failed}))
    }

    /// Installs an extension from one of the indexes, its newest version or the one named:
    /// downloaded, checked against the index, unpacked only if its publisher signed it, and
    /// enabled.
    pub async fn install_offer(
        &self,
        who: &ChatIdentity,
        index_url: &str,
        id: &str,
        version: Option<&str>,
    ) -> Result<Installed> {
        self.owner_only(who).await?;
        ensure!(
            marketplace::indexes(self.root.parent().unwrap_or(&self.root))
                .iter()
                .any(|known| known == index_url),
            Error::Invalid("This kernel does not read that index".into())
        );
        let index = marketplace::read(index_url).await?;
        let listing = index
            .extensions
            .iter()
            .find(|listing| listing.id == id)
            .ok_or(Error::NotFound)?;
        let release = match version {
            Some(version) => listing
                .versions
                .iter()
                .find(|release| release.version == version)
                .ok_or(Error::NotFound)?,
            None => listing.newest().ok_or_else(|| {
                Error::Invalid("No version of it runs on this computer and kernel".into())
            })?,
        };
        let package = release.package().ok_or_else(|| {
            Error::Invalid("That version does not run on this computer and kernel".into())
        })?;
        let key = index
            .publishers
            .get(&listing.publisher)
            .ok_or_else(|| {
                Error::Invalid(format!("The index has no key for {}", listing.publisher))
            })?
            .key
            .clone();
        let bytes = marketplace::download(index_url, package).await?;
        let packages = self.root.join("packages").join(id);
        let into = packages.join(format!(
            "{}-{}",
            release.version,
            &package.sha256.to_lowercase()[..12.min(package.sha256.len())]
        ));
        if !into.is_dir() {
            let target = into.clone();
            let manifest =
                tokio::task::spawn_blocking(move || package::unpack(&bytes, &key, &target))
                    .await??;
            let mut parts: Vec<String> = manifest::parts_of(&manifest, &into)
                .into_iter()
                .map(str::to_owned)
                .collect();
            let mut listed = release.parts.clone();
            listed.sort();
            parts.sort();
            if manifest.extension.id != id
                || manifest.extension.version != release.version
                || manifest.extension.publisher != listing.publisher
                || parts != listed
            {
                let _ = std::fs::remove_dir_all(&into);
                bail!(Error::Invalid(
                    "The package is not the extension its index lists".into()
                ));
            }
        }
        let installed = self.install_from(&into.to_string_lossy(), false).await?;
        // Versions no longer installed are let go.
        if let Ok(entries) = std::fs::read_dir(&packages) {
            for entry in entries.flatten() {
                if entry.path() != into {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
        Ok(installed)
    }

    async fn install(&self, who: &ChatIdentity, folder: &str, dev: bool) -> Result<Installed> {
        self.owner_only(who).await?;
        self.install_from(folder, dev).await
    }

    async fn install_from(&self, folder: &str, dev: bool) -> Result<Installed> {
        // A folder being worked on has its interface built from its sources each time.
        if dev {
            let sources = PathBuf::from(folder);
            tokio::task::spawn_blocking(move || package::build_interface(&sources))
                .await?
                .map_err(|error| Error::Invalid(format!("{error:#}")))?;
        }
        let folder = dunce::canonicalize(folder)
            .ok()
            .filter(|folder| folder.is_dir())
            .ok_or_else(|| Error::Invalid("This folder is not on the kernel's computer".into()))?;
        let text = std::fs::read_to_string(folder.join(manifest::FILE))
            .map_err(|_| Error::Invalid(format!("The folder has no {}", manifest::FILE)))?;
        let manifest = Manifest::parse(&text)?;
        let id = manifest.extension.id.clone();
        let now = now_ms();
        let existing = extensions::Entity::find_by_id(&id)
            .one(self.store.db())
            .await?;
        if existing.is_some() {
            self.stop(&id).await;
        }
        let row = extensions::ActiveModel {
            id: Set(id.clone()),
            version: Set(manifest.extension.version.clone()),
            source: Set(folder.to_string_lossy().into_owned()),
            dev: Set(dev),
            enabled: Set(false),
            error: Set(None),
            manifest_json: Set(serde_json::to_string(&manifest)?),
            contributes_json: Set(existing
                .as_ref()
                .and_then(|row| row.contributes_json.clone())),
            installed_at: Set(existing.as_ref().map_or(now, |row| row.installed_at)),
            updated_at: Set(now),
            proposed_by: Set(None),
        };
        if existing.is_some() {
            row.update(self.store.db()).await?;
        } else {
            row.insert(self.store.db()).await?;
        }
        self.start(&id).await?;
        self.installed(&id).await
    }

    async fn installed(&self, id: &str) -> Result<Installed> {
        self.list()
            .await?
            .into_iter()
            .find(|extension| extension.id == id)
            .ok_or_else(|| Error::NotFound.into())
    }

    /// Enables an installed extension: its dependencies first, then its parts start and say
    /// what they bring. A failure is kept as its error, and it stays disabled.
    pub async fn enable(&self, who: &ChatIdentity, id: &str) -> Result<Installed> {
        self.owner_only(who).await?;
        self.start(id).await
    }

    async fn start(&self, id: &str) -> Result<Installed> {
        let row = self.row(id).await?;
        let result = self.load(&row).await;
        let now = now_ms();
        let mut update = extensions::ActiveModel {
            id: Set(id.to_owned()),
            updated_at: Set(now),
            ..Default::default()
        };
        match &result {
            Ok(contributes) => {
                update.enabled = Set(true);
                update.error = Set(None);
                // Enabled by the owner, an agent's proposal is the owner's.
                update.proposed_by = Set(None);
                update.contributes_json = Set(Some(serde_json::to_string(contributes)?));
            }
            Err(error) => {
                update.enabled = Set(false);
                update.error = Set(Some(format!("{error:#}")));
            }
        }
        update.update(self.store.db()).await?;
        self.changed();
        result?;
        self.installed(id).await
    }

    /// Starts an extension's parts and registers what they bring.
    async fn load(&self, row: &extensions::Model) -> Result<Contributes> {
        let manifest = row_manifest(row)?;
        let id = manifest.extension.id.clone();
        {
            let loaded = self.loaded.read().await;
            for (dependency, range) in &manifest.dependencies {
                let range = semver::VersionReq::parse(range)?;
                let found = loaded
                    .get(dependency)
                    .with_context(|| format!("It needs {dependency} {range}, enabled first"))?;
                let version = semver::Version::parse(&found.manifest.extension.version)?;
                ensure!(
                    range.matches(&version),
                    "It needs {dependency} {range}; {version} is enabled"
                );
            }
        }
        self.stop(&id).await;
        let mut contributes = Contributes::default();
        let mut process = None;
        let started = match (&manifest.process, &manifest.kernel) {
            (Some(part), _) => Some((
                process::Process::start(
                    &id,
                    Path::new(&row.source),
                    &part.command,
                    &self.root.join(format!("{id}.log")),
                    self.me.clone(),
                )
                .await?,
                part.start_seconds.unwrap_or(60),
            )),
            (None, Some(part)) => {
                let path = library::find(Path::new(&row.source), &part.library)?;
                Some((
                    process::Process::start_module(
                        &id,
                        &path,
                        &self.root.join("modules"),
                        self.me.clone(),
                    )?,
                    60,
                ))
            }
            (None, None) => None,
        };
        if let Some((started, seconds)) = started {
            let settings = self.setting_values(&id, &manifest, false).await?;
            let folder = self.folder(&id);
            crate::platform::private_dir(&folder)?;
            let storage = self.storage_area();
            std::fs::create_dir_all(&storage)?;
            let answer = started
                .request_within(
                    "initialize",
                    json!({"extension": {"id": id, "version": manifest.extension.version},
                        "kernel": {"version": env!("CARGO_PKG_VERSION"), "api": manifest::API},
                        "settings": settings, "folder": folder, "storage": storage}),
                    std::time::Duration::from_secs(seconds),
                )
                .await;
            let answer = match answer {
                Ok(answer) => answer,
                Err(error) => {
                    started.stop().await;
                    return Err(error.context("Its process did not start"));
                }
            };
            contributes = match serde_json::from_value(answer["contributes"].clone()) {
                Ok(contributes) => contributes,
                Err(error) => {
                    started.stop().await;
                    bail!(Error::Invalid(format!(
                        "Its process declared something invalid: {error}"
                    )));
                }
            };
            process = Some(started);
        }
        if let Err(error) = contributes.check(&id) {
            if let Some(process) = &process {
                process.stop().await;
            }
            return Err(error.into());
        }
        self.loaded.write().await.insert(
            id,
            Loaded {
                manifest,
                contributes: contributes.clone(),
                process,
            },
        );
        Ok(contributes)
    }

    async fn stop(&self, id: &str) {
        let loaded = self.loaded.write().await.remove(id);
        if let Some(process) = loaded.and_then(|loaded| loaded.process) {
            process.stop().await;
        }
        self.next_runs
            .lock()
            .expect("next runs")
            .retain(|(extension, _), _| extension != id);
    }

    /// Disables an extension; no enabled extension may depend on it. Its data stays.
    pub async fn disable(&self, who: &ChatIdentity, id: &str) -> Result<Installed> {
        self.owner_only(who).await?;
        self.row(id).await?;
        {
            let loaded = self.loaded.read().await;
            if let Some((dependent, _)) = loaded
                .iter()
                .find(|(_, other)| other.manifest.dependencies.contains_key(id))
            {
                bail!(Error::Invalid(format!(
                    "{dependent} depends on it; disable that first"
                )));
            }
        }
        self.stop(id).await;
        extensions::ActiveModel {
            id: Set(id.to_owned()),
            enabled: Set(false),
            error: Set(None),
            updated_at: Set(now_ms()),
            ..Default::default()
        }
        .update(self.store.db())
        .await?;
        self.changed();
        self.installed(id).await
    }

    /// Removes a disabled extension, with its settings, secrets and stored values.
    pub async fn remove(&self, who: &ChatIdentity, id: &str) -> Result<()> {
        self.owner_only(who).await?;
        let row = self.row(id).await?;
        ensure!(
            !row.enabled,
            Error::Invalid("Disable the extension before removing it".into())
        );
        extension_values::Entity::delete_many()
            .filter(extension_values::Column::ExtensionId.eq(id))
            .exec(self.store.db())
            .await?;
        extensions::Entity::delete_by_id(id)
            .exec(self.store.db())
            .await?;
        let folder = self.folder(id);
        if folder.exists() {
            std::fs::remove_dir_all(&folder)
                .with_context(|| format!("Cannot remove {}", folder.display()))?;
        }
        self.changed();
        Ok(())
    }

    /// Extensions being worked on start again from their folder once it changed and then held
    /// still for a check: enabled ones, and those whose last start failed. One the owner
    /// disabled is left alone.
    pub async fn reload_changed(&self) {
        let rows = match extensions::Entity::find()
            .filter(extensions::Column::Dev.eq(true))
            .all(self.store.db())
            .await
        {
            Ok(rows) => rows,
            Err(error) => {
                tracing::warn!(error = %error, "Extensions being worked on not read");
                return;
            }
        };
        for row in rows {
            if !row.enabled && row.error.is_none() {
                self.watched.lock().expect("watched").remove(&row.id);
                continue;
            }
            let folder = PathBuf::from(&row.source);
            // A kernel module being worked on is rebuilt where its tools put it.
            let library = row_manifest(&row)
                .ok()
                .and_then(|manifest| manifest.kernel)
                .map(|part| part.library);
            let Ok(print) = tokio::task::spawn_blocking(move || {
                let mut print = fingerprint(&folder);
                if let Some(meta) = library
                    .and_then(|library| library::find(&folder, &library).ok())
                    .and_then(|path| std::fs::metadata(path).ok())
                {
                    use std::hash::{Hash, Hasher};
                    let mut hasher = std::collections::hash_map::DefaultHasher::new();
                    (print, meta.len(), meta.modified().ok()).hash(&mut hasher);
                    print = hasher.finish();
                }
                print
            })
            .await
            else {
                continue;
            };
            let reload = {
                let mut watched = self.watched.lock().expect("watched");
                match watched.get_mut(&row.id) {
                    None => {
                        watched.insert(row.id.clone(), (print, false));
                        false
                    }
                    Some((seen, changed)) if *seen != print => {
                        *seen = print;
                        *changed = true;
                        false
                    }
                    Some((_, changed)) => std::mem::take(changed),
                }
            };
            if !reload {
                continue;
            }
            match self.install_from(&row.source, true).await {
                Ok(_) => tracing::info!(extension = %row.id, "Extension reloaded"),
                Err(error) => tracing::warn!(
                    extension = %row.id,
                    error = format!("{error:#}"),
                    "Extension not reloaded"
                ),
            }
        }
    }

    pub async fn start_enabled(&self) {
        let Ok(rows) = extensions::Entity::find()
            .filter(extensions::Column::Enabled.eq(true))
            .all(self.store.db())
            .await
        else {
            return;
        };
        let mut waiting: Vec<_> = rows;
        loop {
            let before = waiting.len();
            let mut still = Vec::new();
            for row in waiting {
                let ready = {
                    let loaded = self.loaded.read().await;
                    row_manifest(&row).is_ok_and(|manifest| {
                        manifest
                            .dependencies
                            .keys()
                            .all(|dependency| loaded.contains_key(dependency))
                    })
                };
                if !ready {
                    still.push(row);
                    continue;
                }
                if let Err(error) = self.load(&row).await {
                    tracing::warn!(
                        extension = row.id,
                        error = format!("{error:#}"),
                        "Extension not enabled"
                    );
                    let _ = extensions::ActiveModel {
                        id: Set(row.id.clone()),
                        error: Set(Some(format!("{error:#}"))),
                        ..Default::default()
                    }
                    .update(self.store.db())
                    .await;
                }
            }
            if still.is_empty() || still.len() == before {
                for row in still {
                    let _ = extensions::ActiveModel {
                        id: Set(row.id.clone()),
                        error: Set(Some("Its dependencies are not enabled".into())),
                        ..Default::default()
                    }
                    .update(self.store.db())
                    .await;
                }
                break;
            }
            waiting = still;
        }
        self.changed();
    }

    /// Stops every running part, as the kernel stops.
    pub async fn shutdown(&self) {
        let ids: Vec<String> = self.loaded.read().await.keys().cloned().collect();
        for id in ids {
            self.stop(&id).await;
        }
    }

    async fn values(&self, id: &str, kind: &str) -> Result<HashMap<String, Value>> {
        let rows = extension_values::Entity::find()
            .filter(extension_values::Column::ExtensionId.eq(id))
            .filter(extension_values::Column::Kind.eq(kind))
            .all(self.store.db())
            .await?;
        let mut values = HashMap::new();
        for row in rows {
            let Ok(value) = serde_json::from_str(&row.value_json) else {
                continue;
            };
            let value = if sealed(kind) {
                self.vault.open(value)?
            } else {
                value
            };
            values.insert(row.key, value);
        }
        Ok(values)
    }

    async fn put_value(
        &self,
        id: &str,
        kind: &str,
        key: &str,
        value: Option<&Value>,
    ) -> Result<()> {
        extension_values::Entity::delete_many()
            .filter(extension_values::Column::ExtensionId.eq(id))
            .filter(extension_values::Column::Kind.eq(kind))
            .filter(extension_values::Column::Key.eq(key))
            .exec(self.store.db())
            .await?;
        if let Some(value) = value {
            let value = if sealed(kind) {
                self.vault.seal(value)?
            } else {
                value.clone()
            };
            extension_values::ActiveModel {
                extension_id: Set(id.to_owned()),
                kind: Set(kind.to_owned()),
                key: Set(key.to_owned()),
                value_json: Set(value.to_string()),
                updated_at: Set(now_ms()),
            }
            .insert(self.store.db())
            .await?;
        }
        Ok(())
    }

    /// Its settings with their defaults, and with `secrets` its secrets too: for its own parts.
    async fn setting_values(
        &self,
        id: &str,
        manifest: &Manifest,
        secrets: bool,
    ) -> Result<serde_json::Map<String, Value>> {
        let settings = self.values(id, "setting").await?;
        let hidden = if secrets {
            self.values(id, "secret").await?
        } else {
            HashMap::new()
        };
        let mut result = serde_json::Map::new();
        for (key, setting) in &manifest.settings {
            let value = if setting.kind == "secret" {
                hidden.get(key).cloned()
            } else {
                settings
                    .get(key)
                    .cloned()
                    .or_else(|| setting.default.clone())
            };
            if let Some(value) = value {
                result.insert(key.clone(), value);
            }
        }
        Ok(result)
    }

    async fn setting_views(&self, id: &str, manifest: &Manifest) -> Result<Vec<SettingView>> {
        let settings = self.values(id, "setting").await?;
        let secrets = self.values(id, "secret").await?;
        Ok(manifest
            .settings
            .iter()
            .map(|(key, setting)| {
                let secret = setting.kind == "secret";
                SettingView {
                    key: key.clone(),
                    kind: setting.kind.clone(),
                    label: setting.label.clone(),
                    description: setting.description.clone(),
                    value: (!secret)
                        .then(|| {
                            settings
                                .get(key)
                                .cloned()
                                .or_else(|| setting.default.clone())
                        })
                        .flatten(),
                    set: if secret {
                        secrets.contains_key(key)
                    } else {
                        settings.contains_key(key)
                    },
                    options: setting.options.clone(),
                }
            })
            .collect())
    }

    /// Changes settings and secrets; `null` takes one away. Its running parts hear of it.
    pub async fn set_settings(
        &self,
        who: &ChatIdentity,
        id: &str,
        changes: serde_json::Map<String, Value>,
    ) -> Result<Installed> {
        self.owner_only(who).await?;
        let row = self.row(id).await?;
        let manifest = row_manifest(&row)?;
        for (key, value) in &changes {
            let setting = manifest
                .settings
                .get(key)
                .ok_or_else(|| Error::Invalid(format!("It has no setting `{key}`")))?;
            let fits = match (setting.kind.as_str(), value) {
                (_, Value::Null) => true,
                ("number", value) => value.is_number(),
                ("boolean", value) => value.is_boolean(),
                ("choice", value) => setting
                    .options
                    .iter()
                    .any(|option| Some(option.value.as_str()) == value.as_str()),
                (_, value) => value.as_str().is_some_and(|text| text.len() <= 64 * 1024),
            };
            ensure!(fits, Error::Invalid(format!("`{key}` is {}", setting.kind)));
        }
        for (key, value) in &changes {
            let kind = if manifest.settings[key].kind == "secret" {
                "secret"
            } else {
                "setting"
            };
            self.put_value(id, kind, key, (!value.is_null()).then_some(value))
                .await?;
        }
        if let Some(process) = self
            .loaded
            .read()
            .await
            .get(id)
            .and_then(|loaded| loaded.process.clone())
        {
            let settings = self.setting_values(id, &manifest, false).await?;
            process.notify("settings", json!({"settings": settings}));
        }
        self.changed();
        self.installed(id).await
    }

    /// The enabled extensions' actions.
    pub async fn actions(&self) -> Vec<ActionView> {
        let loaded = self.loaded.read().await;
        let mut actions: Vec<ActionView> = loaded
            .iter()
            .flat_map(|(id, loaded)| {
                loaded.contributes.actions.iter().map(|action| ActionView {
                    extension: id.clone(),
                    action: action.clone(),
                })
            })
            .collect();
        actions.sort_by(|a, b| (&a.extension, &a.action.name).cmp(&(&b.extension, &b.action.name)));
        actions
    }

    /// Runs an enabled extension's action with `input`, checked against its schema, for
    /// `caller`, and records it.
    pub async fn run(
        &self,
        caller: Caller,
        extension: &str,
        action: &str,
        input: Value,
    ) -> Result<Value> {
        let (spec, process) = {
            let loaded = self.loaded.read().await;
            let found = loaded.get(extension).ok_or_else(|| {
                Error::Invalid(format!("{extension} is not enabled in this workspace"))
            })?;
            let spec = found
                .contributes
                .actions
                .iter()
                .find(|spec| spec.name == action)
                .cloned()
                .ok_or_else(|| Error::Invalid(format!("{extension} has no action `{action}`")))?;
            (spec, found.process.clone())
        };
        let validator = jsonschema::validator_for(&spec.input)
            .map_err(|error| Error::Invalid(format!("Its input schema is invalid: {error}")))?;
        let problems: Vec<String> = validator
            .iter_errors(&input)
            .map(|error| format!("{}: {error}", error.instance_path()))
            .collect();
        if !problems.is_empty() {
            bail!(Error::Invalid(format!(
                "The input does not fit `{action}`: {}",
                problems.join("; ")
            )));
        }
        let started = Instant::now();
        let result = match process {
            Some(process) => {
                process
                    .request_within(
                        "action.run",
                        json!({"action": action, "input": input, "caller": caller}),
                        std::time::Duration::from_secs(spec.seconds.unwrap_or(60)),
                    )
                    .await
            }
            None => Err(anyhow::anyhow!(
                "{extension} has no running part for its actions"
            )),
        };
        let error = result.as_ref().err().map(|error| format!("{error:#}"));
        let _ = extension_calls::ActiveModel {
            id: Set(uuid::Uuid::new_v4().to_string()),
            extension_id: Set(extension.to_owned()),
            action: Set(action.to_owned()),
            actor_id: Set(caller.actor_id.clone()),
            session_id: Set(caller.session_id.clone()),
            by: Set(caller.by.clone()),
            at: Set(now_ms()),
            duration_ms: Set(started.elapsed().as_millis() as i64),
            ok: Set(error.is_none()),
            error: Set(error),
        }
        .insert(self.store.db())
        .await;
        result
    }

    /// The implementations of an extension point, among enabled extensions.
    pub async fn implementations(&self, point: &str) -> Result<Vec<Value>> {
        manifest::parse_point(point)?;
        let loaded = self.loaded.read().await;
        Ok(loaded
            .iter()
            .flat_map(|(id, loaded)| {
                loaded
                    .contributes
                    .implements
                    .iter()
                    .filter(|implementation| implementation.point == point)
                    .map(move |implementation| {
                        json!({"extension": id, "name": implementation.name,
                            "title": implementation.title})
                    })
            })
            .collect())
    }

    /// Calls an operation of an implementation of an extension point, checked against the
    /// contract its owner opened.
    pub async fn call_point(
        &self,
        point: &str,
        implementation: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value> {
        let (owner, name, version) = manifest::parse_point(point)?;
        let (spec, process, implementer) = {
            let loaded = self.loaded.read().await;
            let opened = loaded
                .get(&owner)
                .and_then(|owner| {
                    owner
                        .contributes
                        .points
                        .iter()
                        .find(|opened| opened.name == name && opened.version == version)
                })
                .ok_or_else(|| Error::Invalid(format!("Nobody enabled opens {point}")))?;
            let spec = opened
                .operations
                .iter()
                .find(|spec| spec.name == operation)
                .cloned()
                .ok_or_else(|| Error::Invalid(format!("{point} has no operation `{operation}`")))?;
            let (implementer, found) = loaded
                .iter()
                .find(|(_, loaded)| {
                    loaded
                        .contributes
                        .implements
                        .iter()
                        .any(|i| i.point == point && i.name == implementation)
                })
                .ok_or_else(|| {
                    Error::Invalid(format!(
                        "No enabled extension implements {point} as `{implementation}`"
                    ))
                })?;
            (spec, found.process.clone(), implementer.clone())
        };
        let validator = jsonschema::validator_for(&spec.input).map_err(|error| {
            Error::Invalid(format!("The contract's schema is invalid: {error}"))
        })?;
        ensure!(
            validator.is_valid(&input),
            Error::Invalid(format!("The input does not fit {point} `{operation}`"))
        );
        let process =
            process.with_context(|| format!("{implementer} has no running part for {point}"))?;
        process
            .request(
                "point.call",
                json!({"point": point, "implementation": implementation,
                    "operation": operation, "input": input}),
            )
            .await
    }

    /// Publishes an event: the extensions that hear it are told, and the triggers on it run.
    pub async fn publish(&self, name: &str, payload: Value) {
        let (heard, triggers): (Vec<_>, Vec<_>) = {
            let loaded = self.loaded.read().await;
            let heard = loaded
                .values()
                .filter(|loaded| {
                    loaded
                        .contributes
                        .subscribes
                        .iter()
                        .any(|event| event == name)
                })
                .filter_map(|loaded| loaded.process.clone())
                .collect();
            let triggers = loaded
                .iter()
                .flat_map(|(id, loaded)| {
                    loaded
                        .contributes
                        .triggers
                        .iter()
                        .filter(|trigger| trigger.on == format!("event:{name}"))
                        .map(move |trigger| (id.clone(), trigger.action.clone()))
                })
                .collect();
            (heard, triggers)
        };
        for process in heard {
            process.notify("event", json!({"name": name, "payload": payload}));
        }
        // Clients draw again the views that follow it.
        (self.tell)(json!({"type": "extension.event", "event": name}));
        for (extension, action) in triggers {
            let me = self.me.clone();
            let (name, payload) = (name.to_owned(), payload.clone());
            tokio::spawn(async move {
                let Some(me) = me.upgrade() else { return };
                let caller = Caller {
                    by: Some(format!("trigger:event:{name}")),
                    ..Caller::default()
                };
                if let Err(error) = me
                    .run(
                        caller,
                        &extension,
                        &action,
                        json!({"event": name, "payload": payload}),
                    )
                    .await
                {
                    tracing::warn!(
                        extension,
                        action,
                        error = format!("{error:#}"),
                        "Trigger failed"
                    );
                }
            });
        }
    }

    /// Runs the schedule triggers whose time has come.
    pub async fn run_schedules(&self) {
        let now = now_ms();
        let due: Vec<(String, String, String)> = {
            let loaded = self.loaded.read().await;
            let mut next_runs = self.next_runs.lock().expect("next runs");
            let mut due = Vec::new();
            for (id, loaded) in loaded.iter() {
                for (index, trigger) in loaded.contributes.triggers.iter().enumerate() {
                    let Some(cron) = trigger.on.strip_prefix("schedule:") else {
                        continue;
                    };
                    let key = (id.clone(), index);
                    let next = *next_runs.entry(key.clone()).or_insert_with(|| {
                        crate::schedules::next_run(cron, now).unwrap_or(i64::MAX)
                    });
                    if next <= now {
                        due.push((id.clone(), trigger.action.clone(), cron.to_owned()));
                        next_runs.insert(
                            key,
                            crate::schedules::next_run(cron, now).unwrap_or(i64::MAX),
                        );
                    }
                }
            }
            due
        };
        for (extension, action, cron) in due {
            let caller = Caller {
                by: Some(format!("trigger:schedule:{cron}")),
                ..Caller::default()
            };
            if let Err(error) = self.run(caller, &extension, &action, json!({})).await {
                tracing::warn!(
                    extension,
                    action,
                    error = format!("{error:#}"),
                    "Trigger failed"
                );
            }
        }
    }
}

impl process::Kernel for Extensions {
    /// What an extension's process asks the kernel.
    async fn answer(&self, extension: String, method: String, params: Value) -> Result<Value> {
        let text = |key: &str| params[key].as_str().unwrap_or_default().to_owned();
        match method.as_str() {
            "settings.get" => {
                let row = self.row(&extension).await?;
                let manifest = row_manifest(&row)?;
                Ok(json!({"settings": self.setting_values(&extension, &manifest, true).await?}))
            }
            "values.get" => Ok(json!({"value": self
                .values(&extension, "value")
                .await?
                .remove(&text("key"))})),
            "values.set" => {
                let key = text("key");
                ensure!(
                    !key.is_empty() && key.len() <= 512,
                    Error::Invalid("A value's key is 1 to 512 bytes".into())
                );
                let value = params.get("value").filter(|value| !value.is_null());
                ensure!(
                    value.is_none_or(|value| value.to_string().len() <= 1024 * 1024),
                    Error::Invalid("A value is up to 1 MiB".into())
                );
                self.put_value(&extension, "value", &key, value).await?;
                Ok(json!({}))
            }
            // Secrets it keeps itself, as many as it needs: one for each account, say. Encrypted,
            // and never shown to people's clients.
            "secrets.get" => {
                let key = kept(&text("name"))?;
                Ok(json!({"value": self.values(&extension, "secret").await?.remove(&key)}))
            }
            "secrets.set" => {
                let key = kept(&text("name"))?;
                let value = params.get("value").filter(|value| !value.is_null());
                ensure!(
                    value.is_none_or(|value| value.to_string().len() <= 64 * 1024),
                    Error::Invalid("A secret is up to 64 KiB".into())
                );
                self.put_value(&extension, "secret", &key, value).await?;
                Ok(json!({}))
            }
            "secrets.list" => {
                let prefix = format!("{VAULT}{}", text("prefix"));
                let mut names: Vec<String> = extension_values::Entity::find()
                    .filter(extension_values::Column::ExtensionId.eq(&extension))
                    .filter(extension_values::Column::Kind.eq("secret"))
                    .all(self.store.db())
                    .await?
                    .into_iter()
                    .filter(|row| row.key.starts_with(&prefix))
                    .map(|row| row.key[VAULT.len()..].to_owned())
                    .collect();
                names.sort();
                Ok(json!({"names": names}))
            }
            // A sign-in to another service: the address the person opens. The service comes
            // back to the kernel, which keeps the tokens in the secret named and tells the
            // extension with its `zerolux/signed_in` event.
            "oauth.start" => {
                let request: oauth::Request = serde_json::from_value(params.clone())
                    .map_err(|error| Error::Invalid(format!("Invalid sign-in: {error}")))?;
                let origin = self
                    .runtime
                    .get()
                    .and_then(Weak::upgrade)
                    .map(|runtime| runtime.base_url().to_owned())
                    .unwrap_or_default();
                self.sign_ins.start(&extension, request, &origin)
            }
            // A valid access token from a secret a sign-in filled, renewed when due.
            "oauth.token" => {
                let key = kept(&text("secret"))?;
                let held = self
                    .values(&extension, "secret")
                    .await?
                    .remove(&key)
                    .filter(|held| held["type"] == "oauth")
                    .ok_or_else(|| Error::Invalid("Not signed in".into()))?;
                let held = if oauth::due(&held) {
                    let renewed = oauth::renew(&held).await?;
                    self.put_value(&extension, "secret", &key, Some(&renewed))
                        .await?;
                    renewed
                } else {
                    held
                };
                Ok(json!({"access_token": held["access_token"],
                    "token_type": held["token_type"], "expires_at": held["expires_at"],
                    "scope": held["scope"]}))
            }
            "values.list" => {
                let prefix = text("prefix");
                let mut keys: Vec<String> = self
                    .values(&extension, "value")
                    .await?
                    .into_keys()
                    .filter(|key| key.starts_with(&prefix))
                    .collect();
                keys.sort();
                Ok(json!({"keys": keys}))
            }
            "events.publish" => {
                let name = text("name");
                // Its own events only, named under it.
                let declared = self
                    .loaded
                    .read()
                    .await
                    .get(&extension)
                    .is_some_and(|loaded| {
                        loaded
                            .contributes
                            .events
                            .iter()
                            .any(|event| event.name == name)
                    });
                ensure!(
                    declared,
                    Error::Invalid(format!("{extension} does not publish `{name}`"))
                );
                self.publish(&format!("{extension}/{name}"), params["payload"].clone())
                    .await;
                Ok(json!({}))
            }
            // An agent hears something, in the session it works in, as input that waits for its
            // turn: a task given to it, for one.
            "agents.tell" => {
                let runtime = self
                    .runtime
                    .get()
                    .and_then(Weak::upgrade)
                    .context("The kernel is stopping")?;
                let (actor, told) = (text("actor_id"), text("text"));
                ensure!(
                    !told.trim().is_empty() && told.len() <= 64 * 1024,
                    Error::Invalid("Tell an agent 1 byte to 64 KiB".into())
                );
                let session = runtime
                    .tell_agent(&actor, &format!("[{extension}] {told}"))
                    .await?;
                Ok(json!({"session_id": session}))
            }
            // A view it keeps: the clients showing it draw the new tree.
            "views.update" => {
                let name = text("name");
                let remote = self
                    .loaded
                    .read()
                    .await
                    .get(&extension)
                    .is_some_and(|loaded| {
                        loaded.contributes.ui.iter().any(|piece| {
                            piece.name == name
                                && matches!(piece.view, manifest::UiView::Remote { .. })
                        })
                    });
                ensure!(
                    remote,
                    Error::Invalid(format!("{extension} keeps no view `{name}`"))
                );
                ensure!(
                    params["tree"].is_object(),
                    Error::Invalid("A view is a tree".into())
                );
                (self.tell)(json!({"type": "extension.view", "extension": extension,
                    "name": name, "context": params["context"].clone(), "tree": params["tree"].clone()}));
                Ok(json!({}))
            }
            "actions.run" => {
                let caller = Caller {
                    by: Some(extension.clone()),
                    ..Caller::default()
                };
                Ok(json!({"result": self
                    .run(caller, &text("extension"), &text("action"), params["input"].clone())
                    .await?}))
            }
            // Who is in the workspace: its name, and its people and agents by name.
            "workspace.actors" => {
                let workspace = self.store.workspace().await?;
                let actors: Vec<Value> = workspace
                    .actors
                    .iter()
                    .filter(|actor| !actor.archived)
                    .map(|actor| {
                        json!({"id": actor.id, "name": actor.name,
                            "kind": if actor.kind == "human" { "person" } else { "agent" }})
                    })
                    .collect();
                Ok(json!({"name": workspace.workspace.name, "actors": actors}))
            }
            "points.implementations" => {
                Ok(json!({"implementations": self.implementations(&text("point")).await?}))
            }
            "points.call" => Ok(json!({"result": self
                .call_point(
                    &text("point"),
                    &text("implementation"),
                    &text("operation"),
                    params["input"].clone(),
                )
                .await?})),
            other => bail!(Error::Invalid(format!(
                "The kernel does not offer `{other}`"
            ))),
        }
    }

    fn heard(&self, extension: String, method: String, params: Value) {
        if method == "log" {
            tracing::info!(
                extension,
                message = params["message"].as_str().unwrap_or_default(),
                "Extension"
            );
        }
    }
}

/// What a folder holds, as a number that changes when a file is added, removed, resized or
/// written; what its tools make and download is left out.
fn fingerprint(folder: &Path) -> u64 {
    use std::hash::{Hash, Hasher};
    const SKIPPED: &[&str] = &[
        ".git",
        "node_modules",
        ".venv",
        "__pycache__",
        "target",
        ".DS_Store",
    ];
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut pending = vec![folder.to_path_buf()];
    let mut seen = 0usize;
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name();
            if SKIPPED.iter().any(|skipped| name == *skipped) {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                pending.push(entry.path());
                continue;
            }
            seen += 1;
            if seen > 20_000 {
                return hasher.finish();
            }
            entry.path().hash(&mut hasher);
            meta.len().hash(&mut hasher);
            meta.modified().ok().hash(&mut hasher);
        }
    }
    hasher.finish()
}
