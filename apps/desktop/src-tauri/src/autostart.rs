use serde::Serialize;
use std::{path::Path, sync::Mutex};
use tauri::{Manager, WebviewWindow};
#[cfg(not(windows))]
use tauri_plugin_autostart::AutoLaunchManager as Native;
#[cfg(windows)]
use windows::Native;

// The OS registration is the preference. Refresh its executable once per launch,
// only when already enabled. A failed refresh stays pending for Settings' retry.
static ACCESS: Mutex<bool> = Mutex::new(true);
const APP_NAME: &str = "ZeroLux";
const LOGIN_ARGUMENT: &str = "--autostart";

#[derive(Debug, PartialEq, Serialize)]
pub struct Status {
    enabled: bool,
    supported: bool,
}

#[cfg(not(windows))]
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let builder = tauri_plugin_autostart::Builder::new()
        .app_name(APP_NAME)
        .arg(LOGIN_ARGUMENT);
    #[cfg(target_os = "macos")]
    let builder = builder.macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent);
    builder.build()
}

#[cfg(windows)]
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    // The Tauri plugin chooses auto-launch's Dynamic mode, which can register all
    // users when elevated. Keep this app's preference scoped to the current user.
    tauri::plugin::Builder::new("autostart")
        .setup(|app, _| {
            app.manage(Native::new(tauri::process::current_binary(&app.env())?));
            Ok(())
        })
        .build()
}

trait Backend {
    fn enabled(&self) -> Result<bool, String>;
    fn set(&self, enabled: bool) -> Result<(), String>;
}

#[cfg(not(windows))]
impl Backend for Native {
    fn enabled(&self) -> Result<bool, String> {
        self.is_enabled().map_err(|error| error.to_string())
    }

    fn set(&self, enabled: bool) -> Result<(), String> {
        if enabled {
            self.enable()
        } else {
            self.disable()
        }
        .map_err(|error| error.to_string())
    }
}

fn read(backend: &impl Backend, supported: bool) -> Result<Status, String> {
    // An isolated fixture must not read or modify the real installation's registration.
    if !supported {
        return Ok(Status {
            enabled: false,
            supported: false,
        });
    }
    Ok(Status {
        enabled: backend
            .enabled()
            .map_err(|error| format!("Read launch at login: {error}"))?,
        supported,
    })
}

fn set(backend: &impl Backend, supported: bool, enabled: bool) -> Result<Status, String> {
    if !supported {
        return Err(
            "Launch at login requires the installed app and its standard data location".into(),
        );
    }
    // Apply even if the effective state already matches: a disabled OS entry may
    // still exist, and an explicit enable also refreshes the installed app path.
    backend
        .set(enabled)
        .map_err(|error| format!("Change launch at login: {error}"))?;
    let after = read(backend, supported)?;
    if after.enabled != enabled {
        return Err("The operating system did not confirm the launch at login setting".into());
    }
    Ok(after)
}

fn refresh_enabled(
    backend: &impl Backend,
    supported: bool,
    pending: &mut bool,
) -> Result<Status, String> {
    let status = read(backend, supported)?;
    if *pending && status.enabled {
        set(backend, supported, true)
            .map_err(|error| format!("Refresh launch at login for the installed app: {error}"))?;
    }
    *pending = false;
    Ok(status)
}

fn access(app: &tauri::AppHandle, enabled: Option<bool>) -> Result<Status, String> {
    let mut pending = ACCESS
        .lock()
        .map_err(|_| "Launch at login is unavailable")?;
    let backend = app
        .try_state::<Native>()
        .ok_or("Launch at login is starting")?;
    let executable =
        tauri::process::current_binary(&app.env()).map_err(|error| error.to_string())?;
    let supported = supported(
        &executable,
        std::env::var_os("ZEROLUX_DESKTOP_DATA_DIR").is_some(),
    );
    match enabled {
        Some(enabled) => {
            let status = set(&*backend, supported, enabled)?;
            *pending = false;
            Ok(status)
        }
        None => refresh_enabled(&*backend, supported, &mut pending),
    }
}

pub fn refresh(app: &tauri::AppHandle) {
    // Login registration must never prevent the workspace kernel from starting.
    // Settings exposes the same failure and can retry without restarting the app.
    if let Err(error) = access(app, None) {
        eprintln!("{error}");
    }
}

fn permitted(label: &str, url: &tauri::Url) -> bool {
    label == "manager" && crate::local::boot_page(url)
        || label.starts_with("workspace-") && crate::local::app_page(url)
}

#[cfg(any(target_os = "macos", test))]
fn macos_bundle(executable: &Path) -> Option<&Path> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (executable.is_absolute()
        && macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app"
        && contents.join("Info.plist").is_file())
    .then_some(bundle)
}

#[cfg(target_os = "macos")]
pub fn bundle_executable(executable: &Path) -> anyhow::Result<std::path::PathBuf> {
    use anyhow::{Context, ensure};
    let bundle = macos_bundle(executable).context("A macOS app bundle is required")?;
    let info: plist::Dictionary = plist::from_file(bundle.join("Contents/Info.plist"))
        .context("Read the installed app's bundle metadata")?;
    ensure!(
        info.get("CFBundleIdentifier")
            .and_then(plist::Value::as_string)
            == Some("com.darkcompany.zerolux"),
        "The macOS bundle is not ZeroLux"
    );
    let name = info
        .get("CFBundleExecutable")
        .and_then(plist::Value::as_string)
        .context("The app bundle does not name its executable")?;
    ensure!(
        Path::new(name).components().count() == 1
            && matches!(
                Path::new(name).components().next(),
                Some(std::path::Component::Normal(_))
            ),
        "The app bundle executable must be a filename"
    );
    let path = bundle.join("Contents/MacOS").join(name);
    ensure!(path.is_file(), "The app bundle executable is missing");
    Ok(path)
}

fn supported(executable: &Path, isolated: bool) -> bool {
    if isolated {
        return false;
    }
    #[cfg(target_os = "macos")]
    {
        bundle_executable(executable).is_ok_and(|path| path == executable)
    }
    #[cfg(not(target_os = "macos"))]
    {
        executable.is_absolute() && executable.is_file()
    }
}

fn control(window: &WebviewWindow, enabled: Option<bool>) -> Result<Status, String> {
    if !window
        .url()
        .is_ok_and(|url| permitted(window.label(), &url))
    {
        return Err("Launch at login is controlled from this app's own settings".into());
    }
    access(window.app_handle(), enabled)
}

#[tauri::command]
pub fn autostart_status(window: WebviewWindow) -> Result<Status, String> {
    control(&window, None)
}

#[tauri::command]
pub fn autostart_set(window: WebviewWindow, enabled: bool) -> Result<Status, String> {
    control(&window, Some(enabled))
}

#[cfg(any(windows, test))]
fn windows_executable(path: &Path) -> anyhow::Result<String> {
    use anyhow::{Context, ensure};
    let path = path.to_str().context("The app path is not valid Unicode")?;
    ensure!(
        !path.contains(['"', '\0']),
        "The app path cannot be registered for login"
    );
    // auto-launch appends arguments without quoting the executable path.
    let quoted = format!("\"{path}\"");
    ensure!(
        quoted.encode_utf16().count() + 1 + LOGIN_ARGUMENT.len() <= 260,
        "The installed app path is too long for Windows launch at login"
    );
    Ok(quoted)
}

#[cfg(any(windows, test))]
fn windows_approved(value: &[u8]) -> Result<bool, String> {
    // auto-launch 0.6 interprets the final eight bytes as Windows' disabled-at
    // timestamp. Keep the same interpretation, scoped to HKCU, and surface damage.
    if value.len() < 8 {
        return Err("Invalid Windows startup approval".into());
    }
    Ok(value.iter().rev().take(8).all(|byte| *byte == 0))
}

#[cfg(windows)]
mod windows {
    use super::{APP_NAME, Backend, LOGIN_ARGUMENT, windows_approved, windows_executable};
    use std::path::PathBuf;
    use windows_registry::CURRENT_USER;

    const RUN: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run";
    const APPROVED: &str =
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

    pub(super) struct Native(PathBuf);

    impl Native {
        pub(super) fn new(executable: PathBuf) -> Self {
            Self(executable)
        }
    }

    fn optional<T>(result: windows_registry::Result<T>) -> Result<Option<T>, String> {
        match result {
            Ok(value) => Ok(Some(value)),
            Err(error) => {
                let error = std::io::Error::from(error);
                if error.kind() == std::io::ErrorKind::NotFound {
                    Ok(None)
                } else {
                    Err(error.to_string())
                }
            }
        }
    }

    impl Backend for Native {
        fn enabled(&self) -> Result<bool, String> {
            // A machine-wide entry from another installation is not this user's
            // preference. Both registration and Task Manager approval stay in HKCU.
            if optional(
                CURRENT_USER
                    .open(RUN)
                    .and_then(|key| key.get_string(APP_NAME)),
            )?
            .is_none()
            {
                return Ok(false);
            }
            match optional(
                CURRENT_USER
                    .open(APPROVED)
                    .and_then(|key| key.get_value(APP_NAME)),
            )? {
                Some(value) if value.ty() == windows_registry::Type::Bytes => {
                    windows_approved(&value)
                }
                Some(_) => Err("Invalid Windows startup approval type".into()),
                None => Ok(true),
            }
        }

        fn set(&self, enabled: bool) -> Result<(), String> {
            if enabled {
                auto_launch::AutoLaunchBuilder::new()
                    .set_app_name(APP_NAME)
                    .set_app_path(&windows_executable(&self.0).map_err(|error| error.to_string())?)
                    .set_args(&[LOGIN_ARGUMENT])
                    .set_windows_enable_mode(auto_launch::WindowsEnableMode::CurrentUser)
                    .build()
                    .and_then(|backend| backend.enable())
                    .map_err(|error| error.to_string())
            } else {
                // auto-launch 0.6 disable() attempts HKLM even with CurrentUser.
                // Delete only our user's Run value; never touch another account.
                optional(
                    CURRENT_USER
                        .options()
                        .write()
                        .open(RUN)
                        .and_then(|key| key.remove_value(APP_NAME)),
                )?;
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[derive(Default)]
    struct Fake {
        enabled: Cell<bool>,
        reads: Cell<usize>,
        writes: RefCell<Vec<bool>>,
        read_error: Option<&'static str>,
        error: Option<&'static str>,
        ignored: bool,
    }

    impl Backend for Fake {
        fn enabled(&self) -> Result<bool, String> {
            self.reads.set(self.reads.get() + 1);
            if let Some(error) = self.read_error {
                return Err(error.into());
            }
            Ok(self.enabled.get())
        }
        fn set(&self, enabled: bool) -> Result<(), String> {
            if let Some(error) = self.error {
                return Err(error.into());
            }
            self.writes.borrow_mut().push(enabled);
            if !self.ignored {
                self.enabled.set(enabled);
            }
            Ok(())
        }
    }

    #[test]
    fn status_reads_os_changes_and_never_enables() {
        let os = Fake::default();
        assert!(!read(&os, true).unwrap().enabled);
        os.enabled.set(true);
        assert!(read(&os, true).unwrap().enabled);
        assert!(os.writes.borrow().is_empty());
    }

    #[test]
    fn refresh_updates_an_enabled_registration_once_without_changing_the_preference() {
        let os = Fake {
            enabled: Cell::new(true),
            ..Fake::default()
        };
        let mut pending = true;
        assert!(refresh_enabled(&os, true, &mut pending).unwrap().enabled);
        assert!(!pending);
        assert_eq!(*os.writes.borrow(), [true]);
        assert!(refresh_enabled(&os, true, &mut pending).unwrap().enabled);
        assert_eq!(*os.writes.borrow(), [true]);
        os.enabled.set(false);
        assert!(!refresh_enabled(&os, true, &mut pending).unwrap().enabled);
        assert_eq!(*os.writes.borrow(), [true]);
    }

    #[test]
    fn refresh_never_enables_disabled_settings_or_reads_the_real_os_for_fixtures() {
        let disabled = Fake::default();
        let mut pending = true;
        assert!(
            !refresh_enabled(&disabled, true, &mut pending)
                .unwrap()
                .enabled
        );
        assert!(disabled.writes.borrow().is_empty());
        let fixture = Fake {
            enabled: Cell::new(true),
            read_error: Some("must not read the real OS"),
            ..Fake::default()
        };
        let mut pending = true;
        assert!(
            !refresh_enabled(&fixture, false, &mut pending)
                .unwrap()
                .supported
        );
        assert_eq!(fixture.reads.get(), 0);
        assert!(fixture.writes.borrow().is_empty());
    }

    #[test]
    fn failed_refresh_preserves_the_os_preference_and_can_be_retried() {
        let mut os = Fake {
            enabled: Cell::new(true),
            error: Some("permission denied"),
            ..Fake::default()
        };
        let mut pending = true;
        assert!(
            refresh_enabled(&os, true, &mut pending)
                .unwrap_err()
                .contains("permission denied")
        );
        assert!(pending);
        assert!(os.enabled.get());
        assert!(os.writes.borrow().is_empty());
        os.error = None;
        assert!(refresh_enabled(&os, true, &mut pending).unwrap().enabled);
        assert!(!pending);
        assert_eq!(*os.writes.borrow(), [true]);

        os.read_error = Some("registration unavailable");
        pending = true;
        assert!(refresh_enabled(&os, true, &mut pending).is_err());
        assert!(pending);
        assert_eq!(*os.writes.borrow(), [true]);
    }

    #[test]
    fn changes_are_explicit_idempotent_and_read_back() {
        let os = Fake::default();
        assert!(set(&os, true, true).unwrap().enabled);
        assert!(set(&os, true, true).unwrap().enabled);
        assert!(!set(&os, true, false).unwrap().enabled);
        assert_eq!(*os.writes.borrow(), [true, true, false]);
        let ignored = Fake {
            ignored: true,
            ..Fake::default()
        };
        assert!(set(&ignored, true, true).is_err());
        assert!(!ignored.enabled.get());
        assert_eq!(*ignored.writes.borrow(), [true]);
    }

    #[test]
    fn os_errors_and_unsupported_builds_never_report_success() {
        let os = Fake {
            error: Some("permission denied"),
            ..Fake::default()
        };
        assert!(
            set(&os, true, true)
                .unwrap_err()
                .contains("permission denied")
        );
        assert!(!read(&os, true).unwrap().enabled);
        assert_eq!(
            read(&os, false).unwrap(),
            Status {
                enabled: false,
                supported: false
            }
        );
        assert!(set(&os, false, true).is_err());
        assert!(set(&os, false, false).is_err());
        assert!(os.writes.borrow().is_empty());
    }

    #[test]
    fn only_packaged_settings_can_control_os_startup() {
        for origin in ["tauri://localhost", "http://tauri.localhost"] {
            let manager = tauri::Url::parse(&format!("{origin}/desktop.html")).unwrap();
            let workspace = tauri::Url::parse(&format!("{origin}/account")).unwrap();
            assert!(permitted("manager", &manager));
            assert!(permitted("workspace-one", &workspace));
            assert!(!permitted("manager", &workspace));
            assert!(!permitted("workspace-one", &manager));
            assert!(!permitted("tray", &workspace));
            assert!(!permitted("extension-one", &workspace));
        }
        for url in [
            "https://example.org/account",
            "http://127.0.0.1:4310/account",
            "tauri://other/account",
            "http://tauri.localhost:81/account",
        ] {
            assert!(
                !permitted("workspace-one", &tauri::Url::parse(url).unwrap()),
                "{url}"
            );
        }
    }

    #[test]
    fn macos_requires_a_real_bundle_and_isolation_always_disables_autostart() {
        let root = tempfile::tempdir().unwrap();
        let bundle = root.path().join("A real app.app");
        let macos = bundle.join("Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        let executable = macos.join("zerolux-desktop");
        std::fs::write(&executable, "fake executable").unwrap();
        assert!(macos_bundle(&executable).is_none());
        std::fs::write(bundle.join("Contents/Info.plist"), "fake metadata").unwrap();
        assert_eq!(macos_bundle(&executable), Some(bundle.as_path()));
        assert!(!supported(&executable, true));
        let unbundled = root.path().join("zerolux-desktop");
        std::fs::write(&unbundled, "fake executable").unwrap();
        assert!(macos_bundle(&unbundled).is_none());
        assert!(macos_bundle(Path::new("Relative.app/Contents/MacOS/app")).is_none());
    }

    #[test]
    fn windows_login_preserves_executable_paths_with_spaces() {
        let executable =
            windows_executable(Path::new(r"C:\Program Files\ZeroLux\zerolux-desktop.exe")).unwrap();
        assert_eq!(
            format!("{executable} {LOGIN_ARGUMENT}"),
            r#""C:\Program Files\ZeroLux\zerolux-desktop.exe" --autostart"#
        );
        assert!(windows_executable(Path::new("app\" --extra")).is_err());
        assert!(windows_executable(Path::new("app\0.exe")).is_err());
        let limit = 260 - LOGIN_ARGUMENT.len() - 3;
        assert!(windows_executable(Path::new(&"a".repeat(limit))).is_ok());
        assert!(windows_executable(Path::new(&"a".repeat(limit + 1))).is_err());
    }

    #[test]
    fn windows_task_manager_approval_and_disabled_entries_are_explicit() {
        let mut value = [0u8; 12];
        value[0] = 2;
        assert!(windows_approved(&value).unwrap());
        value[0] = 3;
        value[4] = 123;
        assert!(!windows_approved(&value).unwrap());
        assert!(windows_approved(&[0; 7]).is_err());
        let os = Fake::default();
        assert!(!set(&os, true, false).unwrap().enabled);
        assert_eq!(*os.writes.borrow(), [false]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bundle_metadata_identifies_the_app_and_updated_executable() {
        let root = tempfile::tempdir().unwrap();
        let bundle = root.path().join("ZeroLux.app");
        let macos = bundle.join("Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        let old = macos.join("old-binary");
        let updated = macos.join("new-binary");
        std::fs::write(&updated, b"fake executable").unwrap();
        let mut info = plist::Dictionary::new();
        info.insert(
            "CFBundleIdentifier".into(),
            "com.darkcompany.zerolux".into(),
        );
        info.insert("CFBundleExecutable".into(), "new-binary".into());
        plist::to_file_xml(bundle.join("Contents/Info.plist"), &info).unwrap();
        assert_eq!(bundle_executable(&old).unwrap(), updated);
        assert!(supported(&updated, false));
        assert!(!supported(&old, false));
        for invalid in ["../new-binary", "/bin/sh", "", "."] {
            info.insert("CFBundleExecutable".into(), invalid.into());
            plist::to_file_xml(bundle.join("Contents/Info.plist"), &info).unwrap();
            assert!(bundle_executable(&old).is_err());
        }
        info.insert("CFBundleExecutable".into(), "new-binary".into());
        info.insert("CFBundleIdentifier".into(), "another.app".into());
        plist::to_file_xml(bundle.join("Contents/Info.plist"), &info).unwrap();
        assert!(bundle_executable(&old).is_err());
    }
}
