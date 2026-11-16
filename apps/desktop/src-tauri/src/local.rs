use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    path::PathBuf,
};

/// Desktop-private state. The lock remains held until the kernel has finished shutting down.
pub struct LocalWorkspace {
    pub root: PathBuf,
    _lock: File,
}

/// An updater child must not contact the single-instance plugin before its parent exits.
/// This only waits for the existing lock; it never creates a workspace or changes its data.
pub fn wait_for_previous(root: &std::path::Path, timeout: std::time::Duration) -> Result<()> {
    let path = root.join("desktop.lock");
    let file = match OpenOptions::new().read(true).write(true).open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).context("Read the previous desktop's lock"),
    };
    let until = std::time::Instant::now() + timeout;
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(()),
            Err(error) if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() && std::time::Instant::now() < until => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(error) => return Err(error).context("The previous ZeroLux app has not closed; the update did not open another workspace"),
        }
    }
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
        lock.try_lock_exclusive()
            .context("This workspace is already open in another ZeroLux window")?;
        Ok(Self { root, _lock: lock })
    }

    /// The port a workspace's own kernel kept in its folder, before the app had one kernel
    /// for all of them; 0 for none.
    pub fn port_at(root: &std::path::Path) -> Result<u16> {
        let path = root.join("port");
        match fs::read_to_string(&path) {
            Ok(text) => {
                let port: u16 = text.trim().parse().context("Invalid desktop port file")?;
                ensure!(port != 0, "Invalid desktop port file");
                Ok(port)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
            Err(error) => Err(error).context("Read desktop port"),
        }
    }
}

/// Unix GUI launches lack version managers initialized by the user's login shell.
/// Resolve only PATH once, before threads start; Windows inherits its system environment.
pub fn runtime_path(path: Option<OsString>, home: Option<OsString>) -> Option<OsString> {
    let path = desktop_path(path, home.clone());
    #[cfg(unix)]
    let path = home
        .as_deref()
        .and_then(|home| {
            let shell = std::env::var_os("SHELL")
                .filter(|shell| !shell.is_empty())
                .unwrap_or_else(|| {
                    if cfg!(target_os = "macos") {
                        "/bin/zsh"
                    } else {
                        "/bin/sh"
                    }
                    .into()
                });
            shell_path(
                &shell,
                std::path::Path::new(home),
                path.as_deref(),
                std::time::Duration::from_secs(10),
            )
            .ok()
        })
        .or(path);
    desktop_path(path, home)
}

#[cfg(unix)]
fn shell_path(
    shell: &std::ffi::OsStr,
    home: &std::path::Path,
    path: Option<&std::ffi::OsStr>,
    timeout: std::time::Duration,
) -> std::io::Result<OsString> {
    use std::{
        io::{Read, Seek},
        os::unix::ffi::OsStringExt,
        process::{Command, Stdio},
        time::Instant,
    };

    // Only PATH is requested, between markers; banners never enter the resulting value.
    let marker = format!("zerolux-{}", uuid::Uuid::new_v4());
    let script = format!(
        "/usr/bin/printf '\\0{marker}\\0'; /usr/bin/printenv PATH; /usr/bin/printf '\\0{marker}\\0'"
    );
    // A file avoids waiting on a pipe kept open by a shell startup's background child.
    let mut output = tempfile::tempfile()?;
    let mut command = Command::new(shell);
    if matches!(
        std::path::Path::new(shell)
            .file_name()
            .and_then(|name| name.to_str()),
        Some("csh" | "tcsh")
    ) {
        command.arg("-ic");
    } else {
        command.args(["-i", "-l", "-c"]);
    }
    command
        .arg(script)
        .current_dir(home)
        .env("HOME", home)
        .env("DISABLE_AUTO_UPDATE", "true")
        .stdin(Stdio::null())
        .stdout(output.try_clone()?)
        .stderr(Stdio::null());
    if let Some(path) = path {
        command.env("PATH", path);
    }
    let mut child = command.spawn()?;
    let until = Instant::now() + timeout;
    const LIMIT: u64 = 1024 * 1024;
    let result = (|| {
        loop {
            if output.metadata()?.len() > LIMIT {
                return Err(std::io::Error::other("Shell PATH output is too large"));
            }
            if let Some(status) = child.try_wait()? {
                if !status.success() {
                    return Err(std::io::Error::other("Shell PATH resolution failed"));
                }
                break;
            }
            if Instant::now() >= until {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "Shell PATH resolution timed out",
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        output.rewind()?;
        let mut bytes = Vec::new();
        output.take(LIMIT).read_to_end(&mut bytes)?;
        let marker = format!("\0{marker}\0").into_bytes();
        let invalid = || std::io::Error::other("Shell did not return a PATH");
        let start = bytes
            .windows(marker.len())
            .position(|part| part == marker)
            .ok_or_else(invalid)?
            + marker.len();
        let bytes = &bytes[start..];
        let end = bytes
            .windows(marker.len())
            .position(|part| part == marker)
            .ok_or_else(invalid)?;
        let path = bytes[..end].strip_suffix(b"\n").unwrap_or(&bytes[..end]);
        if path.is_empty() || path.contains(&0) {
            return Err(invalid());
        }
        Ok(OsString::from_vec(path.to_vec()))
    })();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

/// Preserve PATH precedence, then add conventional install locations a GUI launch may lack.
pub fn desktop_path(path: Option<OsString>, home: Option<OsString>) -> Option<OsString> {
    let mut entries: Vec<PathBuf> = path
        .as_deref()
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .collect();
    let mut additions = Vec::new();
    if let Some(home) = home {
        let home = PathBuf::from(home);
        additions.extend([
            home.join(".bun/bin"),
            home.join(".local/bin"),
            home.join(".cargo/bin"),
            // pi's own installer puts its launcher here.
            home.join(".pi/agent/bin"),
        ]);
    }
    if cfg!(windows) {
        // npm's global commands: Claude Code, Codex or pi installed with npm.
        additions.extend(std::env::var_os("APPDATA").map(|data| PathBuf::from(data).join("npm")));
    } else {
        additions.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ]);
    }
    for entry in additions {
        if !entries.contains(&entry) {
            entries.push(entry);
        }
    }
    std::env::join_paths(entries).ok()
}

pub fn app_origin(url: &tauri::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost")
        || url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

pub fn boot_page(url: &tauri::Url) -> bool {
    app_origin(url) && url.path() == "/desktop.html"
}

pub fn app_page(url: &tauri::Url) -> bool {
    app_origin(url) && url.path() != "/desktop.html"
}

/// Preserve only a route inside the packaged app, never a kernel or external origin.
pub fn app_route(path: &str) -> Option<String> {
    let base = tauri::Url::parse("http://tauri.localhost/").expect("app origin");
    let url = base.join(path).ok()?;
    if !same_origin(&base, &url) || !app_page(&url) {
        return None;
    }
    Some(route(&url))
}

/// Where a page of the app is: its path, query and fragment.
pub fn route(url: &tauri::Url) -> String {
    format!(
        "{}{}{}",
        url.path(),
        url.query().map(|q| format!("?{q}")).unwrap_or_default(),
        url.fragment().map(|f| format!("#{f}")).unwrap_or_default()
    )
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_wait_does_not_open_or_create_another_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        wait_for_previous(&missing, std::time::Duration::ZERO).unwrap();
        assert!(!missing.exists());
        let parent = LocalWorkspace::open(dir.path().into()).unwrap();
        assert!(wait_for_previous(dir.path(), std::time::Duration::ZERO).is_err());
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            drop(parent);
        });
        wait_for_previous(dir.path(), std::time::Duration::from_secs(2)).unwrap();
        release.join().unwrap();
        LocalWorkspace::open(dir.path().into()).unwrap();
        assert!(!dir.path().join("zerolux.db").exists());
    }
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
    fn a_kept_port_is_read_and_a_broken_one_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(LocalWorkspace::port_at(dir.path()).unwrap(), 0);
        fs::write(dir.path().join("port"), "43219\n").unwrap();
        assert_eq!(LocalWorkspace::port_at(dir.path()).unwrap(), 43219);
        fs::write(dir.path().join("port"), "not a port").unwrap();
        assert!(LocalWorkspace::port_at(dir.path()).is_err());
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
    fn packaged_routes_cannot_escape_to_a_kernel_or_the_manager() {
        assert_eq!(
            app_route("/chats/one?tab=all#message"),
            Some("/chats/one?tab=all#message".into())
        );
        for path in [
            "https://outside.example/",
            "//outside.example/",
            "http://127.0.0.1:4310/",
            "/desktop.html",
            "javascript:alert(1)",
        ] {
            assert!(app_route(path).is_none());
        }
        for url in ["tauri://localhost/chats", "http://tauri.localhost/projects"] {
            assert!(app_page(&url.parse().unwrap()));
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

    #[test]
    fn desktop_path_preserves_overrides_and_does_not_duplicate_them() {
        let home = PathBuf::from("/fixture/home");
        let given =
            std::env::join_paths([PathBuf::from("/fixture/bin"), home.join(".bun/bin")]).unwrap();
        let result = desktop_path(Some(given), Some(home.clone().into())).unwrap();
        let entries: Vec<_> = std::env::split_paths(&result).collect();
        assert_eq!(entries[0], PathBuf::from("/fixture/bin"));
        let bun = home.join(".bun/bin");
        assert_eq!(entries.iter().filter(|p| **p == bun).count(), 1);
        assert!(entries.contains(&home.join(".pi/agent/bin")));
    }

    #[cfg(unix)]
    fn executable(path: &std::path::Path, script: &str) {
        use std::os::unix::fs::PermissionsExt;
        fs::write(path, script).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn shell_path_runs_a_launcher_using_its_version_manager_runtime() {
        use std::{process::Command, time::Duration};
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join("runtime with spaces/bin");
        let empty = home.path().join("empty");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir(&empty).unwrap();
        executable(&bin.join("node"), "#!/bin/sh\nprintf '%s\\n' \"$1\"\n");
        let launcher = home.path().join("pi");
        executable(&launcher, "#!/usr/bin/env node\n");
        assert!(
            !Command::new(&launcher)
                .env_clear()
                .env("PATH", &empty)
                .output()
                .unwrap()
                .status
                .success()
        );

        let shell = home.path().join("shell");
        executable(
            &shell,
            "#!/bin/sh\n[ \"$1\" = -i ] && [ \"$2\" = -l ] && [ \"$3\" = -c ] || exit 8\n[ . -ef \"$HOME\" ] || exit 9\nexport PATH=\"$HOME/runtime with spaces/bin:/usr/bin:/bin\"\nprintf 'startup banner\\n'\n/bin/sh -c \"$4\"\nprintf 'logout banner\\n'\n",
        );
        let path = shell_path(
            shell.as_os_str(),
            home.path(),
            Some(empty.as_os_str()),
            Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(std::env::split_paths(&path).next(), Some(bin));
        let result = Command::new(&launcher)
            .env_clear()
            .env("PATH", path)
            .output()
            .unwrap();
        assert!(result.status.success());
        assert_eq!(
            String::from_utf8(result.stdout).unwrap().trim(),
            launcher.to_str().unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn shell_path_rejects_failure_and_bounds_a_stuck_startup() {
        use std::time::Duration;
        let home = tempfile::tempdir().unwrap();
        let empty = home.path().join("empty");
        fs::create_dir(&empty).unwrap();
        let shell = home.path().join("shell");
        executable(&shell, "#!/bin/sh\nexit 7\n");
        assert!(
            shell_path(
                shell.as_os_str(),
                home.path(),
                Some(empty.as_os_str()),
                Duration::from_secs(1)
            )
            .is_err()
        );
        executable(&shell, "#!/bin/sh\nwhile :; do :; done\n");
        let error = shell_path(
            shell.as_os_str(),
            home.path(),
            Some(empty.as_os_str()),
            Duration::from_millis(50),
        )
        .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        executable(&shell, "#!/bin/sh\nprintf 'unframed output'\n");
        assert!(
            shell_path(
                shell.as_os_str(),
                home.path(),
                Some(empty.as_os_str()),
                Duration::from_secs(1)
            )
            .is_err()
        );
    }
}
