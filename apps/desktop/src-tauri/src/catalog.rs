//! Client-owned connections, one for each ZeroLux instance this app reaches: its own kernel on
//! this computer, and the kernels of other computers. An instance has one database and one
//! sign-in; its workspaces are chosen in its window, at `/w/<id>`. Loading or forgetting a
//! connection never opens, moves or deletes workspace data.
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    connection::{VerifiedKernel, kernel_url},
    preferences::{self, SavedConnection},
};

const FILE: &str = "workspaces.json";
const VERSION: u32 = 4;

/// Private recovery state, written before the CLI stops. Its profile keeps browser storage
/// and Keychain identity; the kernel's receipt resolves crashes around catalog persistence.
#[derive(Clone, Deserialize, Serialize)]
pub struct AdoptionJournal {
    pub previous: Profile,
    pub info: zerolux::handoff::Info,
    pub private_before: Option<serde_json::Value>,
}

fn confirmed_save(root: &Path, catalog: &Catalog, result: Result<()>) -> Result<()> {
    if let Err(error) = result {
        let observed = Catalog::load(root)?;
        ensure!(
            observed == *catalog,
            "The recovered connection was not persisted: {error:#}"
        );
        catalog
            .save(root)
            .context("Confirm the recovered connection after a persistence error")?;
    }
    Ok(())
}

fn remove_journal(root: &Path, filename: &str) -> Result<()> {
    std::fs::remove_file(root.join(filename))?;
    #[cfg(unix)]
    std::fs::File::open(root)?.sync_all()?;
    Ok(())
}

impl AdoptionJournal {
    fn filename(&self) -> Result<String> {
        let id = Uuid::parse_str(&self.previous.id)?;
        Ok(format!("adoption-{id}.json"))
    }

    pub fn save(&self, root: &Path) -> Result<()> {
        preferences::write_json(root, &self.filename()?, self)
    }

    pub async fn recover(&self, root: &Path, catalog: &mut Catalog) -> Result<bool> {
        let decision = zerolux::handoff::Decision::read(&self.info, &self.previous.id).await?;
        self.reconcile(root, catalog, decision.committed)?;
        Ok(decision.committed)
    }

    fn reconcile(&self, root: &Path, catalog: &mut Catalog, committed: bool) -> Result<()> {
        let current = catalog.profile(&self.previous.id)?.clone();
        let adopted = self.previous.adopted()?;
        ensure!(
            current.instance_id == self.previous.instance_id
                && (current.source == self.previous.source || current.source == adopted.source),
            "An unfinished transfer conflicts with this connection; its files were not changed"
        );
        if !committed {
            let file = format!("runtime-{}.json", self.previous.id);
            match &self.private_before {
                Some(value) => preferences::write_json(root, &file, value)?,
                None => match std::fs::remove_file(root.join(file)) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                },
            }
        }
        *catalog.profile_mut(&self.previous.id)? = if committed {
            adopted
        } else {
            self.previous.clone()
        };
        catalog.instance = if committed {
            Some(Instance::taken_over(&self.info, &self.previous.id))
        } else if current.source == Source::Local && self.previous.source != Source::Local {
            None
        } else {
            catalog.instance.clone()
        };
        // A rename can succeed before directory fsync fails. Read what is actually there;
        // never assume an error left the old catalog on disk. Keep the journal on failure.
        confirmed_save(root, catalog, catalog.save(root))?;
        remove_journal(root, &self.filename()?)?;
        // The tiny, private kernel receipt remains as evidence. Deleting it before the
        // journal deletion is durable could turn a committed transfer into a rollback.
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Source {
    /// The app's own kernel, on this computer.
    Local,
    /// Another computer's kernel, at its address.
    Existing { url: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    /// The instance it reached, verified: for an older kernel, its one workspace.
    #[serde(alias = "workspace_id")]
    pub instance_id: Option<String>,
    /// Its name as last shown: the computer's, or an older kernel's workspace's.
    pub name: String,
    pub source: Source,
    /// Only the imported active connection keeps the old browser store and its drafts.
    #[serde(default)]
    pub legacy_browser: bool,
    /// False until drafts have been imported from the old kernel-origin browser store.
    #[serde(default)]
    pub app_ui: bool,
    #[serde(default)]
    pub start_on_launch: bool,
}

impl Profile {
    /// The same connection, its kernel now this app's own, from the CLI's files.
    pub fn adopted(&self) -> Result<Self> {
        ensure!(
            matches!(self.source, Source::Existing { .. }),
            "Only an existing connection can be adopted"
        );
        let mut profile = self.clone();
        profile.source = Source::Local;
        profile.start_on_launch = true;
        Ok(profile)
    }

    pub fn existing_url(&self) -> Option<&str> {
        match &self.source {
            Source::Existing { url } => Some(url),
            Source::Local => None,
        }
    }

    pub fn observe(&mut self, verified: &VerifiedKernel) -> Result<()> {
        ensure!(
            self.instance_id
                .as_ref()
                .is_none_or(|id| id == &verified.id),
            "This connection now reaches a different ZeroLux"
        );
        self.instance_id = Some(verified.id.clone());
        if let Source::Existing { url } = &mut self.source {
            *url = verified.url.to_string();
            self.name = verified.name.clone();
        }
        Ok(())
    }
}

/// The app's own kernel: its data, its database, its address and its services.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Instance {
    /// Where the kernel keeps what is its own, usually beside its database.
    pub directory: PathBuf,
    /// Its database, when it is not `zerolux.db` in its directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<PathBuf>,
    /// Set once it has listened, so its address stays the same.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<zerolux::handoff::Network>,
    /// The private file, in the app's data, with its LiveKit settings; without one the kernel
    /// runs LiveKit itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub services: Option<String>,
}

impl Instance {
    pub fn database(&self) -> PathBuf {
        self.database
            .clone()
            .unwrap_or_else(|| self.directory.join("zerolux.db"))
    }

    /// The CLI's kernel, now this app's, with its address and its services.
    pub(crate) fn taken_over(info: &zerolux::handoff::Info, profile: &str) -> Self {
        Self {
            database: (info.database != info.directory.join("zerolux.db"))
                .then(|| info.database.clone()),
            directory: info.directory.clone(),
            network: Some(info.network.clone()),
            services: Some(format!("runtime-{profile}.json")),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Catalog {
    version: u32,
    pub selected: Option<String>,
    /// The app's own kernel, once it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<Instance>,
    pub profiles: Vec<Profile>,
}

impl Default for Catalog {
    fn default() -> Self {
        Self {
            version: VERSION,
            selected: None,
            instance: None,
            profiles: Vec::new(),
        }
    }
}

impl Catalog {
    pub fn pending_adoptions(root: &Path) -> Result<Vec<AdoptionJournal>> {
        let mut pending = Vec::new();
        for entry in std::fs::read_dir(root)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with("adoption-") || !name.ends_with(".json") {
                continue;
            }
            let journal: AdoptionJournal = serde_json::from_slice(&std::fs::read(entry.path())?)
                .context("Read the interrupted workspace transfer")?;
            ensure!(
                name == journal.filename()?,
                "The transfer journal names a different connection"
            );
            pending.push(journal);
        }
        Ok(pending)
    }

    pub async fn recover_adoptions(&mut self, root: &Path) -> Result<Vec<String>> {
        let mut resumed = Vec::new();
        for journal in Self::pending_adoptions(root)? {
            if !journal.recover(root, self).await? {
                resumed.push(journal.previous.name);
            }
        }
        Ok(resumed)
    }

    /// The saved connections; an earlier version is read as this one, and written only when
    /// something is saved.
    pub fn load(root: &Path) -> Result<Self> {
        let bytes = match std::fs::read(root.join(FILE)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Self::import_previous(root);
            }
            Err(error) => return Err(error).context("Read workspace connections"),
        };
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).context("Invalid workspace connections")?;
        let catalog = match value["version"].as_u64() {
            Some(1 | 2) => v3::upgrade(v2::upgrade(root, serde_json::from_value(value)?)?),
            Some(3) => v3::upgrade(serde_json::from_value(value)?),
            _ => serde_json::from_value(value).context("Invalid workspace connections")?,
        };
        catalog.validate()?;
        Ok(catalog)
    }

    fn import_previous(root: &Path) -> Result<Self> {
        let previous = preferences::load(root)?;
        let mut catalog = Self::default();
        // Earlier local data stays where it is: the app's kernel serves it.
        if matches!(previous, Some(SavedConnection::Local)) || root.join("zerolux.db").is_file() {
            let selected = matches!(previous, Some(SavedConnection::Local));
            let profile = Profile {
                id: Uuid::new_v4().to_string(),
                instance_id: None,
                name: "This computer".into(),
                source: Source::Local,
                legacy_browser: selected || previous.is_none(),
                app_ui: false,
                start_on_launch: false,
            };
            catalog.instance = Some(Instance {
                directory: root.to_owned(),
                database: None,
                network: None,
                services: None,
            });
            if selected {
                catalog.selected = Some(profile.id.clone());
            }
            catalog.profiles.push(profile);
        }
        if let Some(SavedConnection::Existing { url, workspace_id }) = &previous {
            let profile = Profile {
                id: Uuid::new_v4().to_string(),
                instance_id: Some(workspace_id.clone()),
                name: "Workspace".into(),
                source: Source::Existing { url: url.clone() },
                legacy_browser: true,
                app_ui: false,
                start_on_launch: false,
            };
            catalog.selected = Some(profile.id.clone());
            catalog.profiles.insert(0, profile);
        }
        Ok(catalog)
    }

    pub fn save(&self, root: &Path) -> Result<()> {
        self.validate()?;
        preferences::write_json(root, FILE, self)
    }

    pub fn profile(&self, id: &str) -> Result<&Profile> {
        self.profiles
            .iter()
            .find(|profile| profile.id == id)
            .context("This workspace connection is no longer saved")
    }

    pub fn profile_mut(&mut self, id: &str) -> Result<&mut Profile> {
        self.profiles
            .iter_mut()
            .find(|profile| profile.id == id)
            .context("This workspace connection is no longer saved")
    }

    /// This app's own kernel's connection.
    pub fn local(&self) -> Option<&Profile> {
        self.profiles
            .iter()
            .find(|profile| profile.source == Source::Local)
    }

    pub fn add_existing(&mut self, verified: &VerifiedKernel) -> Result<String> {
        ensure!(
            !self
                .profiles
                .iter()
                .any(|profile| profile.instance_id.as_ref() == Some(&verified.id)),
            "This ZeroLux is already saved"
        );
        let mut profile = Profile {
            id: Uuid::new_v4().to_string(),
            instance_id: None,
            name: String::new(),
            source: Source::Existing {
                url: verified.url.to_string(),
            },
            legacy_browser: false,
            app_ui: true,
            start_on_launch: false,
        };
        profile.observe(verified)?;
        let id = profile.id.clone();
        self.profiles.push(profile);
        Ok(id)
    }

    /// This app's own kernel, its data in `directory`; the one already saved, if any.
    pub fn add_local(&mut self, directory: PathBuf) -> String {
        if let Some(local) = self.local() {
            return local.id.clone();
        }
        let id = Uuid::new_v4().to_string();
        self.instance.get_or_insert(Instance {
            directory,
            database: None,
            network: None,
            services: None,
        });
        self.profiles.push(Profile {
            id: id.clone(),
            instance_id: None,
            name: "This computer".into(),
            source: Source::Local,
            legacy_browser: false,
            app_ui: true,
            start_on_launch: false,
        });
        id
    }

    pub fn forget(&mut self, id: &str) -> Result<()> {
        if self.profile(id)?.source == Source::Local {
            self.instance = None;
        }
        self.profiles.retain(|profile| profile.id != id);
        if self.selected.as_deref() == Some(id) {
            self.selected = None;
        }
        Ok(())
    }

    fn validate(&self) -> Result<()> {
        ensure!(
            self.version == VERSION,
            "This desktop cannot read this version of workspace connections"
        );
        let mut ids = HashSet::new();
        let mut local = 0;
        let mut legacy_browser = 0;
        for profile in &self.profiles {
            let id = Uuid::parse_str(&profile.id).context("Invalid connection ID")?;
            ensure!(
                id.to_string() == profile.id && ids.insert(&profile.id),
                "Invalid or duplicate connection ID"
            );
            ensure!(
                profile
                    .instance_id
                    .as_ref()
                    .is_none_or(|id| !id.trim().is_empty()),
                "Missing instance identity"
            );
            match &profile.source {
                Source::Existing { url } => {
                    ensure!(
                        !profile.start_on_launch,
                        "External connections cannot start with the app"
                    );
                    ensure!(
                        kernel_url(url)?.as_str() == url,
                        "Saved address must be canonical"
                    );
                    ensure!(
                        profile.instance_id.is_some(),
                        "An existing connection needs a verified identity"
                    );
                }
                Source::Local => local += 1,
            }
            legacy_browser += usize::from(profile.legacy_browser);
        }
        ensure!(
            local <= 1 && legacy_browser <= 1,
            "Only one connection can be this app's kernel or inherit previous desktop state"
        );
        ensure!(
            (local == 1) == self.instance.is_some(),
            "This app's kernel and its connection go together"
        );
        ensure!(
            self.selected.as_ref().is_none_or(|id| ids.contains(id)),
            "The selected workspace connection is missing"
        );
        if let Some(instance) = &self.instance {
            ensure!(
                instance.directory.is_absolute()
                    && instance
                        .database
                        .as_ref()
                        .is_none_or(|path| path.is_absolute()),
                "The kernel's folder must be an absolute path"
            );
            if let Some(network) = &instance.network {
                network.validate()?;
                ensure!(
                    network.port != 0,
                    "The app's kernel keeps its listening port"
                );
            }
            ensure!(
                instance.services.as_ref().is_none_or(|file| {
                    file.starts_with("runtime-")
                        && file.ends_with(".json")
                        && !file.contains(['/', '\\'])
                }),
                "Invalid private service settings"
            );
        }
        Ok(())
    }
}

/// Version 3, where each workspace of this computer had a database of its own in its folder.
/// It is read as version 4: the database of the workspace whose services the kernel used,
/// else the selected one's, else the first one's, is the app's kernel's. The others' folders
/// keep their files and leave the list. Connections to one address become one.
mod v3 {
    use super::*;

    #[derive(Deserialize)]
    #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
    pub(super) enum Source {
        Folder {
            directory: PathBuf,
            #[serde(default)]
            database: Option<PathBuf>,
        },
        Existing {
            url: String,
        },
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    pub(super) struct Profile {
        pub(super) id: String,
        pub(super) workspace_id: Option<String>,
        pub(super) name: String,
        pub(super) source: Source,
        #[serde(default)]
        pub(super) legacy_browser: bool,
        #[serde(default)]
        pub(super) app_ui: bool,
        #[serde(default)]
        pub(super) start_on_launch: bool,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    pub(super) struct Instance {
        pub(super) network: zerolux::handoff::Network,
        #[serde(default)]
        pub(super) services: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    pub(super) struct Catalog {
        #[serde(default)]
        #[allow(dead_code)]
        pub(super) version: u32,
        pub(super) selected: Option<String>,
        #[serde(default)]
        pub(super) instance: Option<Instance>,
        pub(super) profiles: Vec<Profile>,
    }

    pub(super) fn upgrade(previous: Catalog) -> super::Catalog {
        let folder = |profile: &Profile| matches!(profile.source, Source::Folder { .. });
        let services = previous
            .instance
            .as_ref()
            .and_then(|instance| instance.services.as_ref());
        let kept = previous
            .profiles
            .iter()
            .find(|profile| services == Some(&format!("runtime-{}.json", profile.id)))
            .or_else(|| {
                previous.profiles.iter().find(|profile| {
                    folder(profile) && previous.selected.as_ref() == Some(&profile.id)
                })
            })
            .or_else(|| previous.profiles.iter().find(|profile| folder(profile)))
            .map(|profile| profile.id.clone());
        let mut catalog = super::Catalog::default();
        let mut urls = HashSet::new();
        for profile in previous.profiles {
            let source = match profile.source {
                Source::Existing { url } if urls.insert(url.clone()) => {
                    super::Source::Existing { url }
                }
                Source::Folder {
                    directory,
                    database,
                } if kept.as_ref() == Some(&profile.id) => {
                    catalog.instance = Some(super::Instance {
                        directory,
                        database,
                        network: previous
                            .instance
                            .as_ref()
                            .map(|instance| instance.network.clone()),
                        services: previous
                            .instance
                            .as_ref()
                            .and_then(|instance| instance.services.clone()),
                    });
                    super::Source::Local
                }
                _ => continue,
            };
            let local = source == super::Source::Local;
            catalog.profiles.push(super::Profile {
                id: profile.id,
                instance_id: profile.workspace_id,
                name: if local {
                    "This computer".into()
                } else {
                    profile.name
                },
                source,
                legacy_browser: profile.legacy_browser,
                app_ui: profile.app_ui,
                start_on_launch: profile.start_on_launch && local,
            });
        }
        catalog.selected = previous
            .selected
            .filter(|id| catalog.profiles.iter().any(|profile| &profile.id == id))
            .or_else(|| catalog.profiles.first().map(|profile| profile.id.clone()));
        catalog
    }
}

/// Versions 1 and 2, where each workspace of this computer had a kernel and an address of its
/// own. They are read as version 3: the address of a workspace taken over from the CLI, else
/// the first one's, becomes the app's kernel's, with its services.
mod v2 {
    use super::*;

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Managed {
        directory: PathBuf,
        database: PathBuf,
        #[allow(dead_code)]
        host_id: String,
        network: zerolux::handoff::Network,
        #[serde(default)]
        private_services: bool,
    }

    #[derive(Deserialize)]
    #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
    enum Source {
        Local {
            #[serde(default)]
            legacy: bool,
        },
        Existing {
            url: String,
        },
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    pub(super) struct Profile {
        id: String,
        workspace_id: Option<String>,
        name: String,
        source: Source,
        #[serde(default)]
        legacy_browser: bool,
        #[serde(default)]
        app_ui: bool,
        #[serde(default)]
        managed: Option<Managed>,
        #[serde(default)]
        start_on_launch: bool,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    pub(super) struct Catalog {
        #[allow(dead_code)]
        version: u32,
        selected: Option<String>,
        profiles: Vec<Profile>,
    }

    /// A network change interrupted by a crash: its connection as it was before.
    #[derive(Deserialize)]
    struct NetworkJournal {
        previous: Profile,
    }

    pub(super) fn upgrade(root: &Path, mut previous: Catalog) -> Result<v3::Catalog> {
        for entry in std::fs::read_dir(root)? {
            let name = entry?.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("network-") && name.ends_with(".json") {
                let journal: NetworkJournal =
                    serde_json::from_slice(&std::fs::read(root.join(name.as_ref()))?)
                        .context("Read an interrupted network change")?;
                if let Some(profile) = previous
                    .profiles
                    .iter_mut()
                    .find(|profile| profile.id == journal.previous.id)
                {
                    *profile = journal.previous;
                }
            }
        }
        let taken_over = previous.profiles.iter().find_map(|profile| {
            let managed = profile.managed.as_ref()?;
            Some(v3::Instance {
                network: managed.network.clone(),
                services: managed
                    .private_services
                    .then(|| format!("runtime-{}.json", profile.id)),
            })
        });
        let mut profiles = Vec::new();
        for profile in previous.profiles {
            let source = match (profile.source, profile.managed) {
                (Source::Existing { url }, _) => v3::Source::Existing { url },
                (Source::Local { .. }, Some(managed)) => v3::Source::Folder {
                    database: (managed.database != managed.directory.join("zerolux.db"))
                        .then_some(managed.database),
                    directory: managed.directory,
                },
                (Source::Local { legacy }, None) => v3::Source::Folder {
                    directory: if legacy {
                        root.to_owned()
                    } else {
                        root.join("workspaces").join(&profile.id)
                    },
                    database: None,
                },
            };
            profiles.push(v3::Profile {
                id: profile.id,
                workspace_id: profile.workspace_id,
                name: profile.name,
                source,
                legacy_browser: profile.legacy_browser,
                app_ui: profile.app_ui,
                start_on_launch: profile.start_on_launch,
            });
        }
        let instance = match taken_over {
            Some(instance) => Some(instance),
            // The first workspace's address that was kept, so its windows keep their place.
            None => profiles
                .iter()
                .find_map(|profile| match &profile.source {
                    v3::Source::Folder { directory, .. } => {
                        crate::local::LocalWorkspace::port_at(directory)
                            .ok()
                            .filter(|port| *port != 0)
                    }
                    v3::Source::Existing { .. } => None,
                })
                .map(|port| v3::Instance {
                    network: zerolux::handoff::Network::local(port),
                    services: None,
                }),
        };
        Ok(v3::Catalog {
            version: 3,
            selected: previous.selected,
            instance,
            profiles,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(directory: &Path, database: &Path, workspace: &str) -> zerolux::handoff::Info {
        zerolux::handoff::Info {
            instance: Uuid::new_v4().to_string(),
            workspace_id: workspace.into(),
            workspace_name: "Company".into(),
            host_id: "host".into(),
            version: "0.0.1".into(),
            schema: zerolux::build::schema().into(),
            directory: directory.into(),
            database: database.into(),
            network: zerolux::handoff::Network::local(4310),
            external_livekit: false,
            authenticated: true,
        }
    }

    fn verified(url: &str, id: &str, name: &str) -> VerifiedKernel {
        VerifiedKernel {
            url: kernel_url(url).unwrap(),
            id: id.into(),
            name: name.into(),
        }
    }

    #[test]
    fn journals_reconcile_crashes_on_both_sides_of_commit_and_post_rename_errors() {
        for committed in [false, true] {
            let app = tempfile::tempdir().unwrap();
            let data = tempfile::tempdir().unwrap();
            let database = data.path().join("company.sqlite");
            std::fs::write(&database, b"do not restore database").unwrap();
            let mut catalog = Catalog::default();
            let id = catalog
                .add_existing(&verified("http://127.0.0.1:4310", "kept", "Company"))
                .unwrap();
            let previous = catalog.profile(&id).unwrap().clone();
            let info = info(data.path(), &database, "kept");
            let journal = AdoptionJournal {
                previous: previous.clone(),
                info: info.clone(),
                private_before: Some(serde_json::json!({"fixture": "old-private-config"})),
            };
            journal.save(app.path()).unwrap();
            let adopted = previous.adopted().unwrap();
            *catalog.profile_mut(&id).unwrap() = adopted.clone();
            catalog.instance = Some(Instance::taken_over(&info, &id));
            catalog.save(app.path()).unwrap(); // crash after rename, before IPC commit
            preferences::write_json(
                app.path(),
                &format!("runtime-{id}.json"),
                &serde_json::json!({"fixture": "new-private-config"}),
            )
            .unwrap();
            journal
                .reconcile(app.path(), &mut catalog, committed)
                .unwrap();
            let recovered = Catalog::load(app.path()).unwrap();
            assert_eq!(
                recovered.profile(&id).unwrap(),
                if committed { &adopted } else { &previous }
            );
            assert_eq!(recovered.instance.is_some(), committed);
            if committed {
                let instance = recovered.instance.clone().unwrap();
                assert_eq!(instance.database(), database);
                assert_eq!(instance.network.unwrap().port, 4310);
            }
            assert!(!app.path().join(journal.filename().unwrap()).exists());
            assert_eq!(
                std::fs::read(&database).unwrap(),
                b"do not restore database"
            );
            if !committed {
                let private: serde_json::Value = serde_json::from_slice(
                    &std::fs::read(app.path().join(format!("runtime-{id}.json"))).unwrap(),
                )
                .unwrap();
                assert_eq!(private["fixture"], "old-private-config");
            }
            // A post-rename fsync failure has already put this catalog on disk. A pre-rename
            // failure has not: recovery must distinguish them by reading the actual file.
            confirmed_save(
                app.path(),
                &recovered,
                Err(anyhow::anyhow!("fixture: fsync after rename")),
            )
            .unwrap();
            let mut other = recovered.clone();
            other.profile_mut(&id).unwrap().name = "not persisted".into();
            assert!(
                confirmed_save(
                    app.path(),
                    &other,
                    Err(anyhow::anyhow!("fixture: rename failed"))
                )
                .is_err()
            );
        }
    }

    #[test]
    fn a_catalog_is_client_state_not_a_database_or_an_implicit_kernel() {
        let root = tempfile::tempdir().unwrap();
        let mut catalog = Catalog::load(root.path()).unwrap();
        assert!(catalog.profiles.is_empty() && catalog.instance.is_none());
        let first = catalog
            .add_existing(&verified(
                "https://one.example",
                "instance-a",
                "one.example",
            ))
            .unwrap();
        assert!(
            catalog
                .add_existing(&verified("https://alias.example", "instance-a", "alias"))
                .is_err()
        );
        let local = catalog.add_local(root.path().join("instance"));
        assert_eq!(catalog.add_local(root.path().join("other")), local);
        assert_eq!(
            catalog.instance.as_ref().unwrap().database(),
            root.path().join("instance/zerolux.db")
        );
        catalog.selected = Some(first.clone());
        catalog.save(root.path()).unwrap();
        assert_eq!(Catalog::load(root.path()).unwrap(), catalog);
        assert!(!root.path().join("instance").exists());
        catalog.forget(&local).unwrap();
        assert!(catalog.instance.is_none() && catalog.local().is_none());
        catalog.forget(&first).unwrap();
        assert_eq!(catalog.selected, None);
    }

    #[test]
    fn an_address_keeps_its_instance_and_another_one_is_refused() {
        let mut catalog = Catalog::default();
        let id = catalog
            .add_existing(&verified("http://192.0.2.10:4310", "aspen", "192.0.2.10"))
            .unwrap();
        let profile = catalog.profile_mut(&id).unwrap();
        let before = profile.clone();
        assert!(
            profile
                .observe(&verified("http://192.0.2.10:4310", "birch", "192.0.2.10"))
                .is_err()
        );
        assert_eq!(profile, &before);
        profile
            .observe(&verified("http://192.0.2.11:4310", "aspen", "192.0.2.11"))
            .unwrap();
        assert_eq!(profile.existing_url(), Some("http://192.0.2.11:4310/"));
        assert_eq!(profile.name, "192.0.2.11");
    }

    #[test]
    fn version_three_keeps_the_kernels_database_and_one_connection_per_address() {
        let root = tempfile::tempdir().unwrap();
        let hq = tempfile::tempdir().unwrap();
        let [kept, other, remote, again] = std::array::from_fn(|_| Uuid::new_v4().to_string());
        let directory = hq.path().join(".zerolux");
        let v3 = serde_json::json!({
            "version": 3,
            "selected": other,
            "instance": {
                "network": {
                    "listen": "127.0.0.1", "port": 4310, "expose": "192.0.2.10",
                    "publicOrigin": null, "publicLivekitUrl": null,
                },
                "services": format!("runtime-{kept}.json"),
            },
            "profiles": [
                {
                    "id": other, "workspace_id": "birch-id", "name": "birch",
                    "source": {"kind": "folder", "directory": root.path().join("birch/.zerolux")},
                    "app_ui": true,
                },
                {
                    "id": kept, "workspace_id": "aspen-id", "name": "aspen",
                    "source": {"kind": "folder", "directory": directory},
                    "app_ui": true, "start_on_launch": true,
                },
                {
                    "id": remote, "workspace_id": "cedar-id", "name": "cedar",
                    "source": {"kind": "existing", "url": "http://192.0.2.20:4310/"},
                },
                {
                    "id": again, "workspace_id": "maple-id", "name": "maple",
                    "source": {"kind": "existing", "url": "http://192.0.2.20:4310/"},
                },
            ],
        });
        let before = serde_json::to_string(&v3).unwrap();
        std::fs::write(root.path().join(FILE), &before).unwrap();
        let catalog = Catalog::load(root.path()).unwrap();
        let instance = catalog.instance.clone().unwrap();
        assert_eq!(instance.database(), directory.join("zerolux.db"));
        let network = instance.network.unwrap();
        assert_eq!(
            (network.port, network.expose),
            (4310, Some("192.0.2.10".parse().unwrap()))
        );
        assert_eq!(instance.services, Some(format!("runtime-{kept}.json")));
        let local = catalog.local().unwrap();
        assert_eq!(local.id, kept);
        assert_eq!(local.instance_id.as_deref(), Some("aspen-id"));
        assert!(local.start_on_launch && local.app_ui);
        let ids: Vec<_> = catalog.profiles.iter().map(|p| p.id.clone()).collect();
        assert_eq!(ids, [kept.clone(), remote]);
        // The dropped workspace was selected: the list opens on what is left.
        assert_eq!(catalog.selected.as_deref(), Some(kept.as_str()));
        assert_eq!(
            std::fs::read_to_string(root.path().join(FILE)).unwrap(),
            before
        );
        catalog.save(root.path()).unwrap();
        assert_eq!(Catalog::load(root.path()).unwrap(), catalog);
    }

    #[test]
    fn version_two_reaches_one_kernel_through_version_three() {
        let root = tempfile::tempdir().unwrap();
        let repository = tempfile::tempdir().unwrap();
        let [taken, local, remote] = std::array::from_fn(|_| Uuid::new_v4().to_string());
        let directory = repository.path().join(".zerolux");
        let v2 = serde_json::json!({
            "version": 2,
            "selected": taken,
            "profiles": [
                {
                    "id": local, "workspace_id": "birch-id", "name": "birch",
                    "source": {"kind": "local", "legacy": true}, "app_ui": true,
                },
                {
                    "id": taken, "workspace_id": "aspen-id", "name": "aspen",
                    "source": {"kind": "local", "legacy": false}, "app_ui": true,
                    "start_on_launch": true,
                    "managed": {
                        "directory": directory, "database": directory.join("zerolux.db"),
                        "host_id": "host", "private_services": true,
                        "network": {
                            "listen": "127.0.0.1", "port": 4310, "expose": "192.0.2.10",
                            "publicOrigin": null, "publicLivekitUrl": null,
                        },
                    },
                },
                {
                    "id": remote, "workspace_id": "cedar-id", "name": "cedar",
                    "source": {"kind": "existing", "url": "http://192.0.2.20:4310/"},
                },
            ],
        });
        std::fs::write(root.path().join(FILE), v2.to_string()).unwrap();
        let catalog = Catalog::load(root.path()).unwrap();
        let instance = catalog.instance.clone().unwrap();
        assert_eq!(instance.directory, directory);
        assert_eq!(instance.network.unwrap().port, 4310);
        assert_eq!(instance.services, Some(format!("runtime-{taken}.json")));
        assert_eq!(catalog.local().unwrap().id, taken);
        assert_eq!(catalog.profiles.len(), 2);
        assert!(!directory.exists());
    }

    #[test]
    fn earlier_local_data_is_the_kernels_and_the_imported_connection_is_kept() {
        let root = tempfile::tempdir().unwrap();
        preferences::save(
            root.path(),
            &SavedConnection::Existing {
                url: "http://127.0.0.1:4310/".into(),
                workspace_id: "current".into(),
            },
        )
        .unwrap();
        let previous = std::fs::read(root.path().join("connection.json")).unwrap();
        std::fs::write(
            root.path().join("zerolux.db"),
            b"not opened or migrated by the catalog",
        )
        .unwrap();
        let catalog = Catalog::load(root.path()).unwrap();
        assert_eq!(catalog.profiles.len(), 2);
        let active = catalog
            .profile(catalog.selected.as_deref().unwrap())
            .unwrap();
        assert_eq!(active.instance_id.as_deref(), Some("current"));
        assert!(active.legacy_browser);
        assert_eq!(
            catalog.instance.as_ref().unwrap().database(),
            root.path().join("zerolux.db")
        );
        assert!(!catalog.local().unwrap().legacy_browser);
        catalog.save(root.path()).unwrap();
        assert_eq!(Catalog::load(root.path()).unwrap(), catalog);
        assert_eq!(
            std::fs::read(root.path().join("connection.json")).unwrap(),
            previous
        );
        assert_eq!(
            std::fs::read(root.path().join("zerolux.db")).unwrap(),
            b"not opened or migrated by the catalog"
        );
    }

    #[test]
    fn corrupt_or_newer_catalogs_are_not_reset() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(FILE);
        for body in ["broken", r#"{"version":5,"selected":null,"profiles":[]}"#] {
            std::fs::write(&path, body).unwrap();
            assert!(Catalog::load(root.path()).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), body);
        }
    }
}
