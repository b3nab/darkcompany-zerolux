//! Where a person's harnesses keep their accounts, settings and sessions on a host. Its own
//! person uses the computer's: the user's `~/.claude`, `~/.codex` and `~/.pi`. Anyone else the
//! host is open to has folders of their own under the kernel's data, so their sessions run
//! with their accounts and never with the computer's.

use std::path::{Path, PathBuf};

use serde_json::Value;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Homes {
    /// None for the computer's own.
    root: Option<PathBuf>,
}

impl Homes {
    /// The computer's own harness folders.
    pub fn own() -> Self {
        Self::default()
    }

    /// A guest's folders, under `root`.
    pub fn guest(root: PathBuf) -> Self {
        Self { root: Some(root) }
    }

    /// The folders a session runs with, as its native locator records them.
    pub fn of_locator(locator: &Value) -> Self {
        Self {
            root: locator["home"].as_str().map(PathBuf::from),
        }
    }

    /// Recorded in a session's native locator, so it runs with the same folders again.
    pub fn record(&self, locator: &mut Value) {
        if let Some(root) = &self.root {
            locator["home"] = Value::String(root.to_string_lossy().into_owned());
        }
    }

    pub fn is_guest(&self) -> bool {
        self.root.is_some()
    }

    pub fn root(&self) -> Option<&Path> {
        self.root.as_deref()
    }

    /// Claude Code's configuration folder, for `CLAUDE_CONFIG_DIR`.
    pub fn claude(&self) -> Option<PathBuf> {
        self.root.as_ref().map(|root| root.join("claude"))
    }

    /// Codex's home, for `CODEX_HOME`.
    pub fn codex(&self) -> Option<PathBuf> {
        self.root.as_ref().map(|root| root.join("codex"))
    }

    /// pi's agent folder, for `PI_CODING_AGENT_DIR`.
    pub fn pi(&self) -> Option<PathBuf> {
        self.root.as_ref().map(|root| root.join("pi"))
    }

    /// What a harness process of this person's is started with; nothing for the computer's own,
    /// whose processes keep the kernel's environment.
    pub fn env(&self) -> Vec<(&'static str, PathBuf)> {
        let mut env = Vec::new();
        if let Some(claude) = self.claude() {
            env.push(("CLAUDE_CONFIG_DIR", claude));
        }
        if let Some(codex) = self.codex() {
            env.push(("CODEX_HOME", codex));
        }
        if let Some(pi) = self.pi() {
            env.push(("PI_CODING_AGENT_DIR", pi));
        }
        env
    }

    /// The guest's folders exist, private to the kernel's user.
    pub fn prepare(&self) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        for dir in [Some(root.clone()), self.claude(), self.codex(), self.pi()]
            .into_iter()
            .flatten()
        {
            std::fs::create_dir_all(&dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_guest_runs_with_folders_of_their_own_and_the_owner_with_the_computers() {
        assert!(Homes::own().env().is_empty());
        let dir = tempfile::tempdir().unwrap();
        let guest = Homes::guest(dir.path().join("person"));
        guest.prepare().unwrap();
        let env = guest.env();
        assert_eq!(
            env[0],
            ("CLAUDE_CONFIG_DIR", dir.path().join("person/claude"))
        );
        assert_eq!(env[1], ("CODEX_HOME", dir.path().join("person/codex")));
        assert_eq!(
            env[2],
            ("PI_CODING_AGENT_DIR", dir.path().join("person/pi"))
        );
        assert!(dir.path().join("person/pi").is_dir());
        let mut locator = serde_json::json!({"endpoint": "unix:///x"});
        guest.record(&mut locator);
        assert_eq!(Homes::of_locator(&locator), guest);
        assert_eq!(Homes::of_locator(&serde_json::json!({})), Homes::own());
    }
}
