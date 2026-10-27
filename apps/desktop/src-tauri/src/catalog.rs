//! Client-owned connections. A profile ID, a workspace ID and its address are distinct.
//! Loading or forgetting a connection never opens, moves or deletes workspace data.
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Managed {
    pub directory: PathBuf,
    pub database: PathBuf,
    pub host_id: String,
    pub network: zerolux::handoff::Network,
    #[serde(default)]
    pub private_services: bool,
}

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

#[derive(Deserialize, Serialize)]
pub struct NetworkJournal {
    pub previous: Profile,
}

impl NetworkJournal {
    fn filename(&self) -> Result<String> {
        Ok(format!(
            "network-{}.json",
            Uuid::parse_str(&self.previous.id)?
        ))
    }
    pub fn save(&self, root: &Path) -> Result<()> {
        preferences::write_json(root, &self.filename()?, self)
    }
    pub fn finish(&self, root: &Path) -> Result<()> {
        remove_journal(root, &self.filename()?)
    }
    pub fn recover(&self, root: &Path, catalog: &mut Catalog) -> Result<()> {
        let current = catalog.profile(&self.previous.id)?;
        ensure!(
            current.workspace_id == self.previous.workspace_id
                && current.directory(root) == self.previous.directory(root)
                && current.database(root)? == self.previous.database(root)?,
            "An interrupted network change belongs to different workspace files"
        );
        *catalog.profile_mut(&self.previous.id)? = self.previous.clone();
        confirmed_save(root, catalog, catalog.save(root))?;
        self.finish(root)
    }
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
                && (current.source == self.previous.source || current.managed == adopted.managed),
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
    /// The earlier desktop kept its one local database directly in app-data.
    Local {
        #[serde(default)]
        legacy: bool,
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
    /// Explicitly adopted data stays in place, including its runtime identity and files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed: Option<Managed>,
    #[serde(default)]
    pub start_on_launch: bool,
}

impl Profile {
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
        profile.source = Source::Local { legacy: false };
        profile.managed = Some(Managed {
            directory: info.directory.clone(),
            database: info.database.clone(),
            host_id: info.host_id.clone(),
            network: info.network.clone(),
            private_services: true,
        });
        profile.start_on_launch = true;
        profile.name = info.workspace_name.clone();
        Ok(profile)
    }

    pub fn network(&self, root: &Path) -> Result<Option<zerolux::handoff::Network>> {
        let Some(directory) = self.directory(root) else {
            return Ok(None);
        };
        if let Some(managed) = &self.managed {
            return Ok(Some(managed.network.clone()));
        }
        Ok(Some(zerolux::handoff::Network::local(
            crate::local::LocalWorkspace::port_at(&directory)?,
        )))
    }

    pub fn directory(&self, root: &Path) -> Option<PathBuf> {
        if matches!(self.source, Source::Local { .. })
            && let Some(managed) = &self.managed
        {
            return Some(managed.directory.clone());
        }
        match self.source {
            Source::Local { legacy: true } => Some(root.to_owned()),
            Source::Local { legacy: false } => Some(root.join("workspaces").join(&self.id)),
            Source::Existing { .. } => None,
        }
    }

    pub fn database(&self, root: &Path) -> Result<PathBuf> {
        let database = match &self.managed {
            Some(managed) => managed.database.clone(),
            None => self
                .directory(root)
                .context("This is not an app-managed workspace")?
                .join("zerolux.db"),
        };
        ensure!(
            self.workspace_id.is_none() || database.is_file(),
            "This local workspace's database is missing"
        );
        Ok(database)
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Catalog {
    version: u32,
    pub selected: Option<String>,
    pub profiles: Vec<Profile>,
}

impl Default for Catalog {
    fn default() -> Self {
        Self {
            version: 2,
            selected: None,
            profiles: Vec::new(),
        }
    }
}

impl Catalog {
    pub fn recover_networks(&mut self, root: &Path) -> Result<()> {
        for entry in std::fs::read_dir(root)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with("network-") || !name.ends_with(".json") {
                continue;
            }
            let journal: NetworkJournal = serde_json::from_slice(&std::fs::read(entry.path())?)?;
            ensure!(
                name == journal.filename()?,
                "The network journal names a different connection"
            );
            journal.recover(root, self)?;
        }
        Ok(())
    }

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

    pub fn load(root: &Path) -> Result<Self> {
        let mut catalog: Self = match std::fs::read(root.join(FILE)) {
            Ok(bytes) => serde_json::from_slice(&bytes).context("Invalid workspace connections")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Self::import_previous(root)?
            }
            Err(error) => return Err(error).context("Read workspace connections"),
        };
        if catalog.version == 1 {
            catalog.version = 2;
        }
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
                managed: None,
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
                source: Source::Local { legacy: true },
                legacy_browser: selected || previous.is_none(),
                app_ui: false,
                managed: None,
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
            managed: None,
            start_on_launch: false,
        };
        profile.observe(verified)?;
        let id = profile.id.clone();
        self.profiles.push(profile);
        Ok(id)
    }

    pub fn add_local(&mut self, name: &str) -> Result<String> {
        let name = name.trim();
        ensure!(
            !name.is_empty() && name.len() <= 200,
            "Choose a workspace name of up to 200 bytes"
        );
        let id = Uuid::new_v4().to_string();
        self.profiles.push(Profile {
            id: id.clone(),
            workspace_id: None,
            name: name.to_owned(),
            source: Source::Local { legacy: false },
            legacy_browser: false,
            app_ui: true,
            managed: None,
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
            self.version == 2,
            "This desktop cannot read this version of workspace connections"
        );
        let mut ids = HashSet::new();
        let mut legacy_local = 0;
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
                        profile.managed.is_none() && !profile.start_on_launch,
                        "External connections cannot own local runtime settings"
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
                Source::Local { legacy: true } => legacy_local += 1,
                Source::Local { .. } => {}
            }
            if let Some(managed) = &profile.managed {
                ensure!(
                    managed.directory.is_absolute()
                        && managed.database.is_absolute()
                        && !managed.host_id.trim().is_empty(),
                    "Managed workspace paths and host identity are required"
                );
                managed.network.validate()?;
                ensure!(
                    managed.network.port != 0,
                    "A managed workspace keeps its listening port"
                );
            }
            legacy_browser += usize::from(profile.legacy_browser);
        }
        ensure!(
            legacy_local <= 1 && legacy_browser <= 1,
            "Only one connection can inherit previous desktop state"
        );
        ensure!(
            self.selected.as_ref().is_none_or(|id| ids.contains(id)),
            "The selected workspace connection is missing"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            let info = zerolux::handoff::Info {
                instance: Uuid::new_v4().to_string(),
                workspace_id: "kept".into(),
                workspace_name: "Company".into(),
                host_id: "host".into(),
                version: "0.0.1".into(),
                schema: zerolux::build::schema().into(),
                directory: data.path().into(),
                database: database.clone(),
                network: zerolux::handoff::Network::local(4310),
                external_livekit: false,
                authenticated: true,
            };
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
            if committed {
                let network = NetworkJournal {
                    previous: adopted.clone(),
                };
                network.save(app.path()).unwrap();
                catalog
                    .profile_mut(&id)
                    .unwrap()
                    .managed
                    .as_mut()
                    .unwrap()
                    .network
                    .port = 5432;
                catalog.save(app.path()).unwrap();
                catalog.recover_networks(app.path()).unwrap();
                assert_eq!(catalog.profile(&id).unwrap(), &adopted);
            }
        }
    }

    #[test]
    fn adoption_preserves_profile_storage_and_external_files_and_rejects_other_identities() {
        let app = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let database = data.path().join("company.sqlite");
        std::fs::write(&database, b"existing database is not opened by the catalog").unwrap();
        std::fs::write(data.path().join("host-id"), "host-kept").unwrap();
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
        let mut info = zerolux::handoff::Info {
            instance: "instance".into(),
            workspace_id: "different-workspace".into(),
            workspace_name: "Company".into(),
            host_id: "host-kept".into(),
            version: "0.0.1".into(),
            schema: zerolux::build::schema().into(),
            directory: data.path().to_owned(),
            database: database.clone(),
            network: zerolux::handoff::Network::local(4310),
            external_livekit: false,
            authenticated: true,
        };
        assert!(previous.adopted(&info).is_err());
        info.workspace_id = "workspace-kept".into();
        let adopted = previous.adopted(&info).unwrap();
        assert_eq!(adopted.id, previous.id);
        assert_eq!(adopted.workspace_id, previous.workspace_id);
        assert_eq!(adopted.legacy_browser, previous.legacy_browser);
        assert_eq!(adopted.app_ui, previous.app_ui);
        assert!(adopted.start_on_launch);
        assert_eq!(adopted.directory(app.path()).unwrap(), data.path());
        assert_eq!(adopted.database(app.path()).unwrap(), database);
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
        let wire = serde_json::to_value(info.network).unwrap();
        assert!(wire.get("publicOrigin").is_some() && wire.get("publicLivekitUrl").is_some());
        assert!(
            serde_json::to_value(catalog.profile(&id).unwrap())
                .unwrap()
                .get("start_on_launch")
                .is_some()
        );
    }

    fn verified(url: &str, id: &str, name: &str) -> VerifiedWorkspace {
        VerifiedWorkspace {
            url: kernel_url(url).unwrap(),
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
    fn old_profiles_require_draft_import_but_new_profiles_use_packaged_storage() {
        let root = tempfile::tempdir().unwrap();
        let mut catalog = Catalog::default();
        let id = catalog.add_local("Saved").unwrap();
        assert!(catalog.profile(&id).unwrap().app_ui);
        let mut old = serde_json::to_value(&catalog).unwrap();
        old["version"] = 1.into();
        old["profiles"][0].as_object_mut().unwrap().remove("app_ui");
        let before = old.to_string();
        std::fs::write(root.path().join(FILE), &before).unwrap();
        let imported = Catalog::load(root.path()).unwrap();
        assert_eq!(imported.version, 2);
        assert!(!imported.profile(&id).unwrap().app_ui);
        assert_eq!(
            std::fs::read_to_string(root.path().join(FILE)).unwrap(),
            before
        );
        assert!(!root.path().join("workspaces").exists());
    }

    #[test]
    fn a_pinned_local_database_is_never_silently_recreated() {
        let root = tempfile::tempdir().unwrap();
        let mut catalog = Catalog::default();
        let id = catalog.add_local("Local").unwrap();
        let profile = catalog.profile_mut(&id).unwrap();
        let database = profile.database(root.path()).unwrap();
        assert!(!database.exists());
        profile.workspace_id = Some("existing-workspace".into());
        assert!(profile.database(root.path()).is_err());
        assert!(!database.exists());
        std::fs::create_dir_all(database.parent().unwrap()).unwrap();
        std::fs::write(&database, b"sentinel: do not open as SQLite").unwrap();
        assert_eq!(profile.database(root.path()).unwrap(), database);
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
            .find(|p| p.directory(root.path()).is_some())
            .unwrap();
        assert_eq!(local.directory(root.path()).as_deref(), Some(root.path()));
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
    fn local_profiles_have_separate_stable_directories_and_no_implicit_processes() {
        let root = tempfile::tempdir().unwrap();
        let mut catalog = Catalog::default();
        let a = catalog.add_local("Research").unwrap();
        let b = catalog.add_local("Experiments").unwrap();
        let first = catalog.profile(&a).unwrap().directory(root.path()).unwrap();
        let second = catalog.profile(&b).unwrap().directory(root.path()).unwrap();
        assert_ne!(first, second);
        assert!(!first.exists() && !second.exists());
        catalog.save(root.path()).unwrap();
        assert_eq!(
            Catalog::load(root.path())
                .unwrap()
                .profile(&a)
                .unwrap()
                .directory(root.path()),
            Some(first)
        );
    }

    #[test]
    fn corrupt_or_newer_catalogs_are_not_reset() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(FILE);
        for body in ["broken", r#"{"version":3,"selected":null,"profiles":[]}"#] {
            std::fs::write(&path, body).unwrap();
            assert!(Catalog::load(root.path()).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), body);
        }
    }
}
