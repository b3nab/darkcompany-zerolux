//! Client-owned connections. A profile ID, a workspace ID and its address are distinct.
//! Loading or forgetting a connection never opens, moves or deletes workspace data.
//!
//! The workspaces in folders of this computer are served by one kernel of the app, the
//! instance, at one address: each at `/w/<id>` there. Connections to other kernels keep the
//! kernel's address and the workspace's identity.
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    connection::{VerifiedWorkspace, kernel_url},
    preferences::{self, SavedConnection},
};

const FILE: &str = "workspaces.json";
const VERSION: u32 = 3;

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
        let current = catalog.profile(&self.previous.id)?;
        let adopted = self.previous.adopted(&self.info)?;
        ensure!(
            current.workspace_id == self.previous.workspace_id
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
    /// A workspace kept in a folder of this computer, usually a project's `.zerolux`, and
    /// served by the app's kernel.
    Folder {
        directory: PathBuf,
        /// Its database, when it is not `zerolux.db` in the folder.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        database: Option<PathBuf>,
    },
    Existing {
        url: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub workspace_id: Option<String>,
    /// Last observed name, not a second authority for the workspace's name.
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
    /// The same connection, its workspace now served by this app from the CLI's files.
    pub fn adopted(&self, info: &zerolux::handoff::Info) -> Result<Self> {
        ensure!(
            matches!(self.source, Source::Existing { .. }),
            "Only an existing connection can be adopted"
        );
        ensure!(
            self.workspace_id.as_deref() == Some(info.workspace_id.as_str()),
            "The adopted files belong to a different workspace"
        );
        let mut profile = self.clone();
        profile.source = Source::Folder {
            directory: info.directory.clone(),
            database: (info.database != info.directory.join("zerolux.db"))
                .then(|| info.database.clone()),
        };
        profile.start_on_launch = true;
        profile.name = info.workspace_name.clone();
        Ok(profile)
    }

    /// The folder of a workspace of this computer.
    pub fn directory(&self) -> Option<&Path> {
        match &self.source {
            Source::Folder { directory, .. } => Some(directory),
            Source::Existing { .. } => None,
        }
    }

    pub fn database(&self) -> Result<PathBuf> {
        let Source::Folder {
            directory,
            database,
        } = &self.source
        else {
            anyhow::bail!("This is not a workspace of this computer");
        };
        Ok(database
            .clone()
            .unwrap_or_else(|| directory.join("zerolux.db")))
    }

    /// A workspace of this computer whose folder is no longer where it was.
    pub fn missing(&self) -> bool {
        self.workspace_id.is_some() && self.database().is_ok_and(|database| !database.is_file())
    }

    pub fn existing_url(&self) -> Option<&str> {
        match &self.source {
            Source::Existing { url } => Some(url),
            _ => None,
        }
    }

    pub fn observe(&mut self, verified: &VerifiedWorkspace) -> Result<()> {
        ensure!(
            self.workspace_id
                .as_ref()
                .is_none_or(|id| id == &verified.id),
            "This connection now points to a different workspace"
        );
        self.workspace_id = Some(verified.id.clone());
        self.name = verified.name.clone();
        if let Source::Existing { url } = &mut self.source {
            *url = verified.url.to_string();
        }
        Ok(())
    }
}

/// The app's own kernel: its address and its services.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Instance {
    pub network: zerolux::handoff::Network,
    /// The private file, in the app's data, with this kernel's LiveKit settings; without one
    /// the kernel runs LiveKit itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub services: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Catalog {
    version: u32,
    pub selected: Option<String>,
    /// Set once the app's kernel has an address.
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
            Some(1 | 2) => v2::upgrade(root, serde_json::from_value(value)?)?,
            _ => serde_json::from_value(value).context("Invalid workspace connections")?,
        };
        catalog.validate()?;
        Ok(catalog)
    }

    fn import_previous(root: &Path) -> Result<Self> {
        let previous = preferences::load(root)?;
        let mut catalog = Self::default();
        if let Some(SavedConnection::Existing { url, workspace_id }) = &previous {
            let profile = Profile {
                id: Uuid::new_v4().to_string(),
                workspace_id: Some(workspace_id.clone()),
                name: "Workspace".into(),
                source: Source::Existing { url: url.clone() },
                legacy_browser: true,
                app_ui: false,
                start_on_launch: false,
            };
            catalog.selected = Some(profile.id.clone());
            catalog.profiles.push(profile);
        }
        // Keep earlier local data discoverable without starting a kernel or reading its DB.
        if matches!(previous, Some(SavedConnection::Local)) || root.join("zerolux.db").is_file() {
            let selected = matches!(previous, Some(SavedConnection::Local));
            let profile = Profile {
                id: Uuid::new_v4().to_string(),
                workspace_id: None,
                name: "Local workspace".into(),
                source: Source::Folder {
                    directory: root.to_owned(),
                    database: None,
                },
                legacy_browser: selected || previous.is_none(),
                app_ui: false,
                start_on_launch: false,
            };
            if selected {
                catalog.selected = Some(profile.id.clone());
            }
            catalog.profiles.push(profile);
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

    pub fn add_existing(&mut self, verified: &VerifiedWorkspace) -> Result<String> {
        ensure!(
            !self
                .profiles
                .iter()
                .any(|profile| profile.workspace_id.as_ref() == Some(&verified.id)),
            "This workspace is already saved"
        );
        let mut profile = Profile {
            id: Uuid::new_v4().to_string(),
            workspace_id: None,
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

    /// A workspace in `directory`, its `.zerolux`: a new one by this name, or the one there.
    pub fn add_folder(&mut self, name: &str, directory: PathBuf) -> Result<String> {
        let name = name.trim();
        ensure!(
            !name.is_empty() && name.len() <= 200,
            "Choose a workspace name of up to 200 bytes"
        );
        ensure!(
            !self
                .profiles
                .iter()
                .any(|profile| profile.directory() == Some(&directory)),
            "This folder's workspace is already saved"
        );
        let id = Uuid::new_v4().to_string();
        self.profiles.push(Profile {
            id: id.clone(),
            workspace_id: None,
            name: name.to_owned(),
            source: Source::Folder {
                directory,
                database: None,
            },
            legacy_browser: false,
            app_ui: true,
            start_on_launch: false,
        });
        Ok(id)
    }

    pub fn forget(&mut self, id: &str) -> Result<()> {
        self.profile(id)?;
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
        let mut directories = HashSet::new();
        let mut legacy_browser = 0;
        for profile in &self.profiles {
            let id = Uuid::parse_str(&profile.id).context("Invalid connection ID")?;
            ensure!(
                id.to_string() == profile.id && ids.insert(&profile.id),
                "Invalid or duplicate connection ID"
            );
            ensure!(
                profile
                    .workspace_id
                    .as_ref()
                    .is_none_or(|id| !id.trim().is_empty()),
                "Missing workspace identity"
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
                        profile.workspace_id.is_some(),
                        "An existing workspace needs a verified identity"
                    );
                }
                Source::Folder {
                    directory,
                    database,
                } => {
                    ensure!(
                        directory.is_absolute()
                            && database.as_ref().is_none_or(|path| path.is_absolute()),
                        "A workspace's folder must be an absolute path"
                    );
                    ensure!(
                        directories.insert(directory),
                        "Two connections name the same folder"
                    );
                }
            }
            legacy_browser += usize::from(profile.legacy_browser);
        }
        ensure!(
            legacy_browser <= 1,
            "Only one connection can inherit previous desktop state"
        );
        ensure!(
            self.selected.as_ref().is_none_or(|id| ids.contains(id)),
            "The selected workspace connection is missing"
        );
        if let Some(instance) = &self.instance {
            instance.network.validate()?;
            ensure!(
                instance.network.port != 0,
                "The app's kernel keeps its listening port"
            );
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

    pub(super) fn upgrade(root: &Path, mut previous: Catalog) -> Result<super::Catalog> {
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
            Some(Instance {
                network: managed.network.clone(),
                services: managed
                    .private_services
                    .then(|| format!("runtime-{}.json", profile.id)),
            })
        });
        let mut catalog = super::Catalog {
            selected: previous.selected,
            ..Default::default()
        };
        for profile in previous.profiles {
            let source = match (profile.source, profile.managed) {
                (Source::Existing { url }, _) => super::Source::Existing { url },
                (Source::Local { .. }, Some(managed)) => super::Source::Folder {
                    database: (managed.database != managed.directory.join("zerolux.db"))
                        .then_some(managed.database),
                    directory: managed.directory,
                },
                (Source::Local { legacy }, None) => super::Source::Folder {
                    directory: if legacy {
                        root.to_owned()
                    } else {
                        root.join("workspaces").join(&profile.id)
                    },
                    database: None,
                },
            };
            catalog.profiles.push(super::Profile {
                id: profile.id,
                workspace_id: profile.workspace_id,
                name: profile.name,
                source,
                legacy_browser: profile.legacy_browser,
                app_ui: profile.app_ui,
                start_on_launch: profile.start_on_launch,
            });
        }
        catalog.instance = match taken_over {
            Some(instance) => Some(instance),
            // The first workspace's address that was kept, so its windows keep their place.
            None => catalog
                .profiles
                .iter()
                .filter_map(|profile| profile.directory())
                .find_map(|directory| {
                    crate::local::LocalWorkspace::port_at(directory)
                        .ok()
                        .filter(|port| *port != 0)
                })
                .map(|port| Instance {
                    network: zerolux::handoff::Network::local(port),
                    services: None,
                }),
        };
        Ok(catalog)
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
            let adopted = previous.adopted(&info).unwrap();
            *catalog.profile_mut(&id).unwrap() = adopted.clone();
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
    fn adoption_preserves_profile_storage_and_external_files_and_rejects_other_identities() {
        let app = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let database = data.path().join("company.sqlite");
        std::fs::write(&database, b"existing database is not opened by the catalog").unwrap();
        std::fs::write(data.path().join("storage-file"), "kept").unwrap();
        let mut catalog = Catalog::default();
        let id = catalog
            .add_existing(&verified(
                "http://127.0.0.1:4310",
                "workspace-kept",
                "Company",
            ))
            .unwrap();
        catalog.selected = Some(id.clone());
        let previous = catalog.profile(&id).unwrap().clone();
        let mut info = info(data.path(), &database, "different-workspace");
        assert!(previous.adopted(&info).is_err());
        info.workspace_id = "workspace-kept".into();
        let adopted = previous.adopted(&info).unwrap();
        assert_eq!(adopted.id, previous.id);
        assert_eq!(adopted.workspace_id, previous.workspace_id);
        assert_eq!(adopted.legacy_browser, previous.legacy_browser);
        assert_eq!(adopted.app_ui, previous.app_ui);
        assert!(adopted.start_on_launch);
        assert_eq!(adopted.directory().unwrap(), data.path());
        assert_eq!(adopted.database().unwrap(), database);
        *catalog.profile_mut(&id).unwrap() = adopted;
        catalog.save(app.path()).unwrap();
        assert_eq!(Catalog::load(app.path()).unwrap(), catalog);
        assert_eq!(
            std::fs::read(database).unwrap(),
            b"existing database is not opened by the catalog"
        );
        assert_eq!(
            std::fs::read_to_string(data.path().join("storage-file")).unwrap(),
            "kept"
        );
        assert!(!app.path().join("workspaces").exists());
    }

    fn verified(url: &str, id: &str, name: &str) -> VerifiedWorkspace {
        VerifiedWorkspace {
            url: kernel_url(url).unwrap(),
            base: kernel_url(url).unwrap(),
            id: id.into(),
            name: name.into(),
        }
    }

    #[test]
    fn a_catalog_is_client_state_not_a_database_or_an_implicit_local_workspace() {
        let root = tempfile::tempdir().unwrap();
        let mut catalog = Catalog::load(root.path()).unwrap();
        assert!(catalog.profiles.is_empty());
        let first = catalog
            .add_existing(&verified("https://one.example", "workspace-a", "One"))
            .unwrap();
        let second = catalog
            .add_existing(&verified("https://two.example", "workspace-b", "Two"))
            .unwrap();
        assert_ne!(first, second);
        // An address can later host a different workspace. Its old bookmark and state stay
        // separate; opening the old one will still require its original workspace identity.
        let replacement = catalog
            .add_existing(&verified(
                "https://one.example",
                "workspace-c",
                "Replacement",
            ))
            .unwrap();
        assert_ne!(replacement, first);
        catalog.selected = Some(first.clone());
        catalog.save(root.path()).unwrap();
        assert_eq!(Catalog::load(root.path()).unwrap(), catalog);
        assert!(!root.path().join("zerolux.db").exists());
        assert!(!root.path().join("port").exists());
        catalog.forget(&first).unwrap();
        assert_eq!(catalog.selected, None);
        assert_eq!(catalog.profiles.len(), 2);
    }

    #[test]
    fn a_folder_holds_one_workspace_and_a_missing_one_is_never_recreated() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("aspen/.zerolux");
        let mut catalog = Catalog::default();
        let id = catalog.add_folder("aspen", folder.clone()).unwrap();
        assert!(catalog.add_folder("again", folder.clone()).is_err());
        assert!(catalog.add_folder(" ", root.path().join("birch")).is_err());
        let profile = catalog.profile_mut(&id).unwrap();
        assert_eq!(profile.database().unwrap(), folder.join("zerolux.db"));
        // Not yet created: nothing is missing, and nothing was written.
        assert!(!profile.missing());
        assert!(!folder.exists());
        profile.workspace_id = Some("aspen-id".into());
        assert!(profile.missing());
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("zerolux.db"), b"sentinel").unwrap();
        assert!(!profile.missing());
        catalog.save(root.path()).unwrap();
        assert_eq!(Catalog::load(root.path()).unwrap(), catalog);
    }

    #[test]
    fn version_two_is_read_as_one_kernel_with_the_taken_over_workspace_address() {
        let root = tempfile::tempdir().unwrap();
        let repository = tempfile::tempdir().unwrap();
        let taken = Uuid::new_v4().to_string();
        let local = Uuid::new_v4().to_string();
        let remote = Uuid::new_v4().to_string();
        std::fs::create_dir_all(root.path().join("workspaces").join(&local)).unwrap();
        std::fs::write(
            root.path().join("workspaces").join(&local).join("port"),
            "45123",
        )
        .unwrap();
        let directory = repository.path().join(".zerolux");
        let v2 = serde_json::json!({
            "version": 2,
            "selected": taken,
            "profiles": [
                {
                    "id": local, "workspace_id": "birch-id", "name": "birch",
                    "source": {"kind": "local", "legacy": false}, "app_ui": true,
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
        let before = serde_json::to_string(&v2).unwrap();
        std::fs::write(root.path().join(FILE), &before).unwrap();
        let catalog = Catalog::load(root.path()).unwrap();
        let instance = catalog.instance.clone().unwrap();
        assert_eq!(instance.network.port, 4310);
        assert_eq!(instance.network.expose, Some("192.0.2.10".parse().unwrap()));
        assert_eq!(instance.services, Some(format!("runtime-{taken}.json")));
        let aspen = catalog.profile(&taken).unwrap();
        assert_eq!(aspen.directory(), Some(directory.as_path()));
        assert_eq!(aspen.database().unwrap(), directory.join("zerolux.db"));
        assert!(aspen.start_on_launch);
        assert_eq!(
            catalog.profile(&local).unwrap().directory(),
            Some(root.path().join("workspaces").join(&local).as_path())
        );
        assert_eq!(
            catalog.profile(&remote).unwrap().existing_url(),
            Some("http://192.0.2.20:4310/")
        );
        assert_eq!(catalog.selected.as_deref(), Some(taken.as_str()));
        // Read, never rewritten until something is saved; no database is touched.
        assert_eq!(
            std::fs::read_to_string(root.path().join(FILE)).unwrap(),
            before
        );
        assert!(!directory.exists());
        catalog.save(root.path()).unwrap();
        assert_eq!(Catalog::load(root.path()).unwrap(), catalog);
    }

    #[test]
    fn without_a_taken_over_workspace_the_first_kept_address_is_the_kernels() {
        let root = tempfile::tempdir().unwrap();
        let first = Uuid::new_v4().to_string();
        std::fs::write(root.path().join("port"), "45200").unwrap();
        let v1 = serde_json::json!({
            "version": 1,
            "selected": null,
            "profiles": [{
                "id": first, "workspace_id": null, "name": "Local workspace",
                "source": {"kind": "local", "legacy": true}, "legacy_browser": true,
            }],
        });
        std::fs::write(root.path().join(FILE), v1.to_string()).unwrap();
        let catalog = Catalog::load(root.path()).unwrap();
        assert_eq!(catalog.instance.as_ref().unwrap().network.port, 45200);
        let profile = catalog.profile(&first).unwrap();
        assert_eq!(profile.directory(), Some(root.path()));
        assert!(!profile.app_ui && profile.legacy_browser);
    }

    #[test]
    fn importing_the_existing_connection_preserves_it_and_keeps_old_local_data() {
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
        let mut catalog = Catalog::load(root.path()).unwrap();
        assert_eq!(catalog.profiles.len(), 2);
        let active = catalog
            .profile(catalog.selected.as_deref().unwrap())
            .unwrap();
        assert_eq!(active.workspace_id.as_deref(), Some("current"));
        assert!(active.legacy_browser);
        let local = catalog
            .profiles
            .iter()
            .find(|p| p.directory().is_some())
            .unwrap();
        assert_eq!(local.directory(), Some(root.path()));
        assert!(!local.legacy_browser);
        let local_id = local.id.clone();
        catalog.save(root.path()).unwrap();
        assert_eq!(Catalog::load(root.path()).unwrap(), catalog);
        assert_eq!(
            std::fs::read(root.path().join("connection.json")).unwrap(),
            previous
        );
        catalog.forget(&local_id).unwrap();
        assert_eq!(
            std::fs::read(root.path().join("zerolux.db")).unwrap(),
            b"not opened or migrated by the catalog"
        );
    }

    #[test]
    fn changing_an_address_keeps_identity_and_renaming_does_not_change_the_profile() {
        let mut catalog = Catalog::default();
        let id = catalog
            .add_existing(&verified("http://127.0.0.1:4310", "ws-a", "Name"))
            .unwrap();
        assert!(
            catalog
                .add_existing(&verified("https://alias.example", "ws-a", "Name"))
                .is_err()
        );
        let profile = catalog.profile_mut(&id).unwrap();
        let before = profile.clone();
        assert!(
            profile
                .observe(&verified("https://other.example", "ws-b", "Other"))
                .is_err()
        );
        assert_eq!(profile, &before);
        profile
            .observe(&verified("https://new.example", "ws-a", "Renamed"))
            .unwrap();
        assert_eq!(profile.id, id);
        assert_eq!(profile.workspace_id.as_deref(), Some("ws-a"));
        assert_eq!(profile.name, "Renamed");
        assert_eq!(profile.existing_url(), Some("https://new.example/"));
    }

    #[test]
    fn corrupt_or_newer_catalogs_are_not_reset() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(FILE);
        for body in ["broken", r#"{"version":4,"selected":null,"profiles":[]}"#] {
            std::fs::write(&path, body).unwrap();
            assert!(Catalog::load(root.path()).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), body);
        }
    }
}
