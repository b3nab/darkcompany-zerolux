//! Extensions of ZeroLux: installed in a workspace, enabled when needed. Each brings actions
//! (defined once for people, agents and the API), extension points with their contracts and
//! the implementations of others', events, triggers, settings and stored values, through its
//! parts. The kernel offers the mechanism; what the contracts mean is the extensions' own.

pub mod manifest;
pub mod process;

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
}

impl Caller {
    pub fn of(who: &ChatIdentity) -> Self {
        Self {
            actor_id: who.actor_id.clone(),
            session_id: who.session_id.clone(),
            by: None,
        }
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
    /// Told when what is installed or enabled changes.
    changed: Box<dyn Fn() + Send + Sync>,
    /// When each schedule trigger runs next, by extension and trigger.
    next_runs: std::sync::Mutex<HashMap<(String, usize), i64>>,
    me: Weak<Extensions>,
}

fn row_manifest(row: &extensions::Model) -> Result<Manifest> {
    Ok(serde_json::from_str(&row.manifest_json)?)
}

impl Extensions {
    pub fn new(store: Store, root: PathBuf, changed: Box<dyn Fn() + Send + Sync>) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            store,
            root,
            loaded: RwLock::default(),
            changed,
            next_runs: std::sync::Mutex::default(),
            me: me.clone(),
        })
    }

    /// The folder an extension keeps its files in, private to it and to the kernel.
    fn folder(&self, id: &str) -> PathBuf {
        self.root.join(id)
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
            let mut parts = Vec::new();
            if manifest.kernel.is_some() {
                parts.push("kernel");
            }
            if manifest.process.is_some() {
                parts.push("process");
            }
            if manifest.remote.is_some() {
                parts.push("remote");
            }
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
            });
        }
        Ok(result)
    }

    /// Installs, or installs again, the extension in `folder` on the kernel's computer, as one
    /// being worked on, and enables it.
    pub async fn install_folder(&self, who: &ChatIdentity, folder: &str) -> Result<Installed> {
        self.owner_only(who).await?;
        let folder = std::fs::canonicalize(folder)
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
            dev: Set(true),
            enabled: Set(false),
            error: Set(None),
            manifest_json: Set(serde_json::to_string(&manifest)?),
            contributes_json: Set(existing
                .as_ref()
                .and_then(|row| row.contributes_json.clone())),
            installed_at: Set(existing.as_ref().map_or(now, |row| row.installed_at)),
            updated_at: Set(now),
        };
        if existing.is_some() {
            row.update(self.store.db()).await?;
        } else {
            row.insert(self.store.db()).await?;
        }
        self.enable(who, &id).await?;
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
                update.contributes_json = Set(Some(serde_json::to_string(contributes)?));
            }
            Err(error) => {
                update.enabled = Set(false);
                update.error = Set(Some(format!("{error:#}")));
            }
        }
        update.update(self.store.db()).await?;
        (self.changed)();
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
        if let Some(part) = &manifest.process {
            let started = process::Process::start(
                &id,
                Path::new(&row.source),
                &part.command,
                &self.root.join(format!("{id}.log")),
                self.me.clone(),
            )
            .await?;
            let settings = self.setting_values(&id, &manifest, false).await?;
            let folder = self.folder(&id);
            crate::platform::private_dir(&folder)?;
            let answer = started
                .request_within(
                    "initialize",
                    json!({"extension": {"id": id, "version": manifest.extension.version},
                        "kernel": {"version": env!("CARGO_PKG_VERSION"), "api": manifest::API},
                        "settings": settings, "folder": folder}),
                    std::time::Duration::from_secs(part.start_seconds.unwrap_or(60)),
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
            updated_at: Set(now_ms()),
            ..Default::default()
        }
        .update(self.store.db())
        .await?;
        (self.changed)();
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
        (self.changed)();
        Ok(())
    }

    /// Enables, when the kernel starts, the extensions that were enabled; dependencies first.
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
        (self.changed)();
    }

    /// Stops every running part, as the kernel stops.
    pub async fn shutdown(&self) {
        let ids: Vec<String> = self.loaded.read().await.keys().cloned().collect();
        for id in ids {
            self.stop(&id).await;
        }
    }

    async fn values(&self, id: &str, kind: &str) -> Result<HashMap<String, Value>> {
        Ok(extension_values::Entity::find()
            .filter(extension_values::Column::ExtensionId.eq(id))
            .filter(extension_values::Column::Kind.eq(kind))
            .all(self.store.db())
            .await?
            .into_iter()
            .filter_map(|row| Some((row.key, serde_json::from_str(&row.value_json).ok()?)))
            .collect())
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
        (self.changed)();
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
