use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

/// Desktop-private state. The lock remains held until the kernel has finished shutting down.
pub struct LocalWorkspace {
    pub root: PathBuf,
    _lock: File,
}

impl LocalWorkspace {
    pub fn open(root: PathBuf) -> Result<Self> {
        ensure!(
            root.is_absolute(),
            "Desktop data directory must be an absolute path"
        );
        fs::create_dir_all(&root).context("Create desktop data directory")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        }
        let path = root.join("desktop.lock");
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            ensure!(
                metadata.file_type().is_file(),
                "Desktop lock must be a regular file"
            );
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        lock.try_lock_exclusive().context(
            "This desktop workspace is already open. Close its other ZeroLux window first.",
        )?;
        Ok(Self { root, _lock: lock })
    }

    /// First launch lets the OS allocate a port; subsequent launches retain the webview origin.
    pub fn port(&self) -> Result<u16> {
        let path = self.root.join("port");
        match fs::read_to_string(&path) {
            Ok(text) => {
                let port: u16 = text
                    .trim()
                    .parse()
                    .context("Invalid desktop port file; it was not reset")?;
                ensure!(port != 0, "Invalid desktop port file; it was not reset");
                Ok(port)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
            Err(error) => Err(error).context("Read desktop port"),
        }
    }

    pub fn remember_port(&self, port: u16) -> Result<()> {
        ensure!(port != 0, "Cannot save an unbound desktop port");
        let previous = self.port()?;
        if previous != 0 {
            ensure!(previous == port, "Desktop origin must not change silently");
            return Ok(());
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.root.join("port"))?;
        writeln!(file, "{port}")?;
        file.sync_all().context("Persist desktop port")
    }
}

/// Preserve explicitly configured PATH precedence, then add conventional GUI-launch locations.
/// No shell execution, shell startup files, or runtime mutation by the kernel.
pub fn desktop_path(path: Option<OsString>, home: Option<OsString>) -> Option<OsString> {
    let mut entries: Vec<PathBuf> = path
        .as_deref()
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .collect();
    if cfg!(unix) {
        let mut additions = Vec::new();
        if let Some(home) = home {
            let home = PathBuf::from(home);
            additions.extend([
                home.join(".bun/bin"),
                home.join(".local/bin"),
                home.join(".cargo/bin"),
            ]);
        }
        additions.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ]);
        for entry in additions {
            if !entries.contains(&entry) {
                entries.push(entry);
            }
        }
    }
    std::env::join_paths(entries).ok()
}

#[cfg(unix)]
pub fn executable(name: &str) -> PathBuf {
    std::env::var_os("PATH")
        .as_deref()
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .map(|directory| directory.join(name))
        .find(|path| path.is_file())
        .and_then(|path| path.canonicalize().ok())
        .unwrap_or_else(|| PathBuf::from(name))
}

pub fn boot_page(url: &tauri::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost")
        || url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
        && url.path() == "/desktop.html"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

pub fn external_link(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

pub fn same_origin(expected: &tauri::Url, requested: &tauri::Url) -> bool {
    requested.username().is_empty()
        && requested.password().is_none()
        && expected.origin() == requested.origin()
}

pub fn resource_root(resource_dir: &Path) -> Result<PathBuf> {
    ensure!(
        resource_dir.join("web/index.html").is_file(),
        "Desktop web assets are missing. Run the desktop preparation/build again."
    );
    #[cfg(unix)]
    ensure!(
        resource_dir.join("claude/runner.js").is_file(),
        "Desktop Claude runner is missing. Run the desktop preparation/build again."
    );
    Ok(resource_dir.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lock_is_exclusive_and_released_without_deleting_its_file() {
        let dir = tempfile::tempdir().unwrap();
        let first = LocalWorkspace::open(dir.path().into()).unwrap();
        assert!(LocalWorkspace::open(dir.path().into()).is_err());
        drop(first);
        assert!(dir.path().join("desktop.lock").is_file());
        assert!(LocalWorkspace::open(dir.path().into()).is_ok());
    }
    #[test]
    fn port_survives_reopen_and_never_silently_changes() {
        let dir = tempfile::tempdir().unwrap();
        let first = LocalWorkspace::open(dir.path().into()).unwrap();
        assert_eq!(first.port().unwrap(), 0);
        first.remember_port(43219).unwrap();
        drop(first);
        let next = LocalWorkspace::open(dir.path().into()).unwrap();
        assert_eq!(next.port().unwrap(), 43219);
        assert!(next.remember_port(43220).is_err());
        next.remember_port(43219).unwrap();
        fs::write(dir.path().join("port"), "not a port").unwrap();
        assert!(next.port().is_err());
    }
    #[test]
    fn navigation_is_restricted_to_the_exact_kernel_origin() {
        let base = tauri::Url::parse("http://127.0.0.1:43219").unwrap();
        for allowed in [
            "http://127.0.0.1:43219/",
            "http://127.0.0.1:43219/chats?x=y",
        ] {
            assert!(same_origin(&base, &tauri::Url::parse(allowed).unwrap()));
        }
        for denied in [
            "http://127.0.0.1:4310",
            "https://example.invalid/",
            "http://localhost:43219/",
            "http://user@127.0.0.1:43219/",
            "file:///tmp/fixture",
        ] {
            assert!(!same_origin(&base, &tauri::Url::parse(denied).unwrap()));
        }
    }
    #[test]
    fn boot_navigation_does_not_admit_other_ports_or_credentials() {
        for value in [
            "tauri://localhost/desktop.html",
            "http://tauri.localhost/desktop.html",
        ] {
            assert!(boot_page(&tauri::Url::parse(value).unwrap()));
        }
        for value in [
            "http://tauri.localhost:8080/desktop.html",
            "tauri://localhost:8080/desktop.html",
            "http://user:secret@tauri.localhost/desktop.html",
            "tauri://user@localhost/desktop.html",
            "http://other.invalid/desktop.html",
            "tauri://localhost/other.html",
        ] {
            assert!(!boot_page(&tauri::Url::parse(value).unwrap()));
        }
    }

    #[test]
    fn only_web_links_can_leave_the_app() {
        for value in ["https://example.invalid/docs", "http://localhost:8000"] {
            assert!(external_link(&tauri::Url::parse(value).unwrap()));
        }
        for value in [
            "file:///tmp/example",
            "javascript:alert(1)",
            "data:text/html,test",
            "mailto:test@example.invalid",
            "https://user:secret@example.invalid",
        ] {
            assert!(!external_link(&tauri::Url::parse(value).unwrap()));
        }
    }

    #[cfg(unix)]
    #[test]
    fn desktop_path_preserves_overrides_and_does_not_duplicate_them() {
        let result = desktop_path(
            Some("/fixture/bin:/usr/local/bin".into()),
            Some("/fixture/home".into()),
        )
        .unwrap();
        let entries: Vec<_> = std::env::split_paths(&result).collect();
        assert_eq!(entries[0], PathBuf::from("/fixture/bin"));
        assert_eq!(
            entries
                .iter()
                .filter(|p| p.as_os_str() == "/usr/local/bin")
                .count(),
            1
        );
        assert!(entries.contains(&PathBuf::from("/fixture/home/.bun/bin")));
    }
    #[test]
    fn resources_do_not_fall_back_to_the_source_tree() {
        let dir = tempfile::tempdir().unwrap();
        assert!(resource_root(dir.path()).is_err());
    }
}
