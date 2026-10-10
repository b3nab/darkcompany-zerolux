use anyhow::{Context, Result, ensure};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path};

use crate::connection::kernel_url;

/// The previous single-connection format is read only, for a conservative registry import.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum SavedConnection {
    Existing { url: String, workspace_id: String },
    Local,
}

pub fn load(root: &Path) -> Result<Option<SavedConnection>> {
    let value = match std::fs::read(root.join("connection.json")) {
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

pub fn write_json(root: &Path, filename: &str, value: &impl Serialize) -> Result<()> {
    // Replace only host preferences, atomically. Never copy, reset or open a kernel database.
    let mut temporary = tempfile::NamedTempFile::new_in(root)?;
    temporary.write_all(&serde_json::to_vec_pretty(value)?)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(root.join(filename))
        .context("Persist desktop connection settings")?;
    #[cfg(unix)]
    std::fs::File::open(root)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
pub fn save(root: &Path, value: &SavedConnection) -> Result<()> {
    write_json(root, "connection.json", value)
}

#[derive(Debug, Parser)]
#[command(name = "zerolux-desktop", about = "Open a ZeroLux workspace", group(clap::ArgGroup::new("workspace").args(["connect", "local", "choose_workspace"]).multiple(false)))]
pub struct LaunchOptions {
    /// Open a saved connection at this address, or verify and add a new connection.
    #[arg(long)]
    pub connect: Option<String>,
    /// Open the first saved app-managed workspace, or create one if none is saved.
    #[arg(long)]
    pub local: bool,
    /// Show the workspace manager without starting the selected workspace.
    #[arg(long)]
    pub choose_workspace: bool,
}

impl LaunchOptions {
    pub fn read() -> Self {
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_overrides_are_explicit_and_mutually_exclusive() {
        let options = LaunchOptions::try_parse_from(["desktop"]).unwrap();
        assert!(options.connect.is_none());
        assert!(!options.local && !options.choose_workspace);
        assert!(
            LaunchOptions::try_parse_from(["desktop", "--local", "--choose-workspace"]).is_err()
        );
        assert!(
            LaunchOptions::try_parse_from([
                "desktop",
                "--connect",
                "https://example.org",
                "--local"
            ])
            .is_err()
        );
        assert!(LaunchOptions::try_parse_from(["desktop", "--unknown"]).is_err());
        let options = LaunchOptions::try_parse_from(["desktop", "--choose-workspace"]).unwrap();
        assert!(options.choose_workspace);
    }

    #[test]
    fn legacy_preferences_are_read_without_opening_or_resetting_data() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(load(directory.path()).unwrap(), None);
        let existing = SavedConnection::Existing {
            url: "http://127.0.0.1:4310/".into(),
            workspace_id: "original-id".into(),
        };
        std::fs::write(directory.path().join("zerolux.db"), b"not a database").unwrap();
        save(directory.path(), &existing).unwrap();
        assert_eq!(load(directory.path()).unwrap(), Some(existing));
        assert_eq!(
            std::fs::read(directory.path().join("zerolux.db")).unwrap(),
            b"not a database"
        );
        std::fs::write(directory.path().join("connection.json"), b"broken").unwrap();
        assert!(load(directory.path()).is_err());
        assert_eq!(
            std::fs::read(directory.path().join("connection.json")).unwrap(),
            b"broken"
        );
    }
}
