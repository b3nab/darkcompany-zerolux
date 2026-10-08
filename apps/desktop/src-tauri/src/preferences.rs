use anyhow::{Context, Result, ensure};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path};

use crate::connection::kernel_url;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum Choice {
    Existing { url: String },
    Local,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum SavedConnection {
    Existing { url: String, workspace_id: String },
    Local,
}

impl SavedConnection {
    pub fn choice(&self) -> Choice {
        match self {
            Self::Existing { url, .. } => Choice::Existing { url: url.clone() },
            Self::Local => Choice::Local,
        }
    }

    pub fn expected_id(&self, url: &tauri::Url) -> Option<&str> {
        match self {
            Self::Existing {
                url: saved,
                workspace_id,
            } if saved == url.as_str() => Some(workspace_id),
            _ => None,
        }
    }
}

pub fn load(root: &Path) -> Result<Option<SavedConnection>> {
    let path = root.join("connection.json");
    let value = match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<SavedConnection>(&bytes)
            .context("Invalid desktop connection settings; they were not reset")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("Read desktop connection settings"),
    };
    if let SavedConnection::Existing { url, workspace_id } = &value {
        ensure!(
            kernel_url(url)?.as_str() == url,
            "Saved kernel URL must be canonical"
        );
        ensure!(
            !workspace_id.trim().is_empty(),
            "Saved workspace identity is missing"
        );
    }
    Ok(Some(value))
}

pub fn save(root: &Path, value: &SavedConnection) -> Result<()> {
    // Replace only host preferences, atomically. Never copy, reset or open a kernel database.
    let mut temporary = tempfile::NamedTempFile::new_in(root)?;
    temporary.write_all(&serde_json::to_vec_pretty(value)?)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(root.join("connection.json"))
        .context("Persist desktop connection settings")?;
    #[cfg(unix)]
    std::fs::File::open(root)?.sync_all()?;
    Ok(())
}

#[derive(Debug, Parser)]
#[command(name = "zerolux-desktop", about = "Open a ZeroLux workspace", group(clap::ArgGroup::new("workspace").args(["connect", "local", "choose_workspace"]).multiple(false)))]
pub struct LaunchOptions {
    /// Connect to an existing loopback kernel and remember its verified workspace identity.
    #[arg(long)]
    pub connect: Option<String>,
    /// Explicitly use the desktop's local workspace, starting its embedded kernel.
    #[arg(long)]
    pub local: bool,
    /// Show the workspace selector instead of automatically using the saved connection.
    #[arg(long)]
    pub choose_workspace: bool,
}

impl LaunchOptions {
    pub fn read() -> Self {
        // Cocoa consumes its own process-only restoration argument; it is not a desktop option.
        let mut args = std::env::args();
        let mut desktop = Vec::new();
        while let Some(arg) = args.next() {
            if cfg!(target_os = "macos") && arg == "-ApplePersistenceIgnoreState" {
                let _ = args.next();
            } else if !(cfg!(target_os = "macos") && arg.starts_with("-psn_")) {
                desktop.push(arg);
            }
        }
        Self::parse_from(desktop)
    }

    pub fn initial(&self, saved: Option<&SavedConnection>) -> Option<Choice> {
        if let Some(url) = &self.connect {
            Some(Choice::Existing { url: url.clone() })
        } else if self.local {
            Some(Choice::Local)
        } else if self.choose_workspace {
            None
        } else {
            saved.map(SavedConnection::choice)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_launch_does_not_create_a_workspace_and_choices_are_explicit() {
        let options = LaunchOptions::try_parse_from(["desktop"]).unwrap();
        assert!(options.initial(None).is_none());
        assert!(
            LaunchOptions::try_parse_from([
                "desktop",
                "--local",
                "--connect",
                "http://127.0.0.1:4310"
            ])
            .is_err()
        );
        assert_eq!(
            LaunchOptions::try_parse_from(["desktop", "--local"])
                .unwrap()
                .initial(None),
            Some(Choice::Local)
        );
    }

    #[test]
    fn saved_selection_and_identity_survive_reopen_without_opening_a_database() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()).unwrap(), None);
        let value = SavedConnection::Existing {
            url: "http://127.0.0.1:4310/".into(),
            workspace_id: "fixture-workspace".into(),
        };
        save(dir.path(), &value).unwrap();
        assert_eq!(load(dir.path()).unwrap(), Some(value.clone()));
        assert!(!dir.path().join("zerolux.db").exists());
        assert!(!dir.path().join("port").exists());
        assert_eq!(
            value.expected_id(&kernel_url("http://127.0.0.1:4310").unwrap()),
            Some("fixture-workspace")
        );
        assert_eq!(
            value.expected_id(&kernel_url("http://127.0.0.1:4311").unwrap()),
            None
        );
        assert_eq!(
            LaunchOptions::try_parse_from(["desktop"])
                .unwrap()
                .initial(Some(&value)),
            Some(value.choice())
        );
        assert!(
            LaunchOptions::try_parse_from(["desktop", "--choose-workspace"])
                .unwrap()
                .initial(Some(&value))
                .is_none()
        );
        save(dir.path(), &SavedConnection::Local).unwrap();
        assert_eq!(load(dir.path()).unwrap(), Some(SavedConnection::Local));
        std::fs::write(dir.path().join("connection.json"), "broken").unwrap();
        assert!(load(dir.path()).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("connection.json")).unwrap(),
            "broken"
        );
    }
}
