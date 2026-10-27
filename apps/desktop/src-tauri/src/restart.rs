use anyhow::{Context, Result};
use std::{
    ffi::OsString,
    os::unix::process::CommandExt,
    path::Path,
    process::{Child, Command},
};
use tauri::Manager;

/// Start the replacement before destroying the old app's UI. Its startup waits for
/// the old desktop lock before registering single-instance or opening any window.
pub fn restart(app: &tauri::AppHandle) -> Result<()> {
    let environment = app.env();
    let executable =
        tauri::process::current_binary(&environment).context("Locate the updated desktop app")?;
    #[cfg(target_os = "macos")]
    let executable = crate::autostart::bundle_executable(&executable)?;
    spawn(&executable, arguments(environment.args_os))?;
    Ok(())
}

fn spawn(executable: &Path, arguments: impl IntoIterator<Item = OsString>) -> Result<Child> {
    Command::new(executable)
        .args(arguments)
        // launchd kills the old job's remaining process group at exit. The new app
        // must own a different group, even when its parent started at login.
        .process_group(0)
        .spawn()
        .context("Start the updated desktop app")
}

fn arguments(arguments: impl IntoIterator<Item = OsString>) -> Vec<OsString> {
    let mut arguments = arguments.into_iter().skip(1);
    let mut restart = Vec::new();
    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("--connect" | "-ApplePersistenceIgnoreState") => {
                let _ = arguments.next();
            }
            Some(
                "--autostart" | "--background" | "--local" | "--choose-workspace"
                | "--wait-for-parent",
            ) => {}
            Some(value) if value.starts_with("--connect=") || value.starts_with("-psn_") => {}
            _ => restart.push(argument),
        }
    }
    restart.push("--wait-for-parent".into());
    restart
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_restore_takes_precedence_over_one_time_launch_options() {
        let args = [
            "app",
            "--autostart",
            "--connect",
            "https://example.org",
            "--local",
            "--choose-workspace",
            "--wait-for-parent",
            "-psn_0_123",
            "-ApplePersistenceIgnoreState",
            "YES",
        ];
        assert_eq!(
            arguments(args.map(OsString::from)),
            [OsString::from("--wait-for-parent")]
        );
        assert_eq!(
            arguments(["app", "--connect=https://example.org", "--background"].map(OsString::from)),
            [OsString::from("--wait-for-parent")]
        );
    }

    #[test]
    fn replacement_process_gets_its_own_group() {
        let root = tempfile::tempdir().unwrap();
        let result = root.path().join("process-group");
        // Only a temporary shell process is launched, never ZeroLux or an agent.
        let args = vec![
            "-c".into(),
            "printf '%s ' \"$$\" > \"$1\"; ps -o pgid= -p \"$$\" >> \"$1\"".into(),
            "fixture".into(),
            result.as_os_str().to_owned(),
        ];
        let mut child = spawn(Path::new("/bin/sh"), args).unwrap();
        assert!(child.wait().unwrap().success());
        let data = std::fs::read_to_string(result).unwrap();
        let ids: Vec<u32> = data
            .split_whitespace()
            .map(|value| value.parse().unwrap())
            .collect();
        assert_eq!(ids, [child.id(), child.id()]);
    }

    #[test]
    fn failed_spawn_is_returned_without_exiting_the_current_process() {
        let root = tempfile::tempdir().unwrap();
        assert!(spawn(&root.path().join("missing-app"), []).is_err());
        assert!(root.path().is_dir());
    }
}
