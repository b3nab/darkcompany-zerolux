//! The processes of background commands, on the computer their session runs on: the kernel's
//! own, or a joined computer when the kernel asks it. Each keeps its output, and on Unix its exit code, in files
//! of its own, so that a ZeroLux started again knows how it ended. Both run this code.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// What a session is told of a background command's output: its last lines, up to this many bytes.
const TOLD: usize = 4000;
/// What a read returns at most.
const READ: u64 = 256 * 1024;

/// A part of a background command's output, from a byte offset.
#[derive(Debug, Serialize, Deserialize)]
pub struct Output {
    /// Where the returned text starts.
    pub start: u64,
    pub text: String,
    /// Where to read next.
    pub next: u64,
    /// How long the output is now.
    pub end: u64,
}

/// How a background command ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum Ended {
    Exited { exit_code: Option<i32> },
    Lost,
}

pub struct BackgroundProcesses {
    dir: PathBuf,
    /// The processes started by this ZeroLux, until they end.
    children: std::sync::Mutex<HashMap<String, tokio::process::Child>>,
}

impl BackgroundProcesses {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            children: Default::default(),
        }
    }

    fn file(&self, id: &str, extension: &str) -> Result<PathBuf> {
        ensure!(
            uuid::Uuid::parse_str(id).is_ok(),
            "Invalid background command"
        );
        Ok(self.dir.join(format!("{id}.{extension}")))
    }

    /// Runs `command` in `folder`, detached from this ZeroLux: its process ID.
    pub fn start(&self, id: &str, command: &str, folder: &str) -> Result<Option<u32>> {
        ensure!(
            Path::new(folder).is_dir(),
            "The session's folder is not on this computer"
        );
        crate::platform::private_dir(&self.dir)?;
        let log = crate::platform::private(std::fs::OpenOptions::new().create(true).append(true))
            .open(self.file(id, "log")?)?;
        let mut process = shell(command, &self.file(id, "exit")?);
        process
            .current_dir(folder)
            .env_remove("ZEROLUX_TOKEN")
            .env_remove("ZEROLUX_URL")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::from(log.try_clone()?))
            .stderr(std::process::Stdio::from(log))
            .kill_on_drop(false);
        crate::platform::detach(&mut process);
        let child = process
            .spawn()
            .with_context(|| format!("Cannot run the command in {folder}"))?;
        let pid = child.id();
        self.children
            .lock()
            .expect("background children")
            .insert(id.to_owned(), child);
        Ok(pid)
    }

    /// Whether a background command ended, and how: from its process here, or after a restart from the exit
    /// code its shell wrote.
    pub fn ended(&self, id: &str, pid: Option<i64>) -> Result<Option<Ended>> {
        let exit = self.file(id, "exit")?;
        let mut children = self.children.lock().expect("background children");
        if let Some(child) = children.get_mut(id) {
            return Ok(match child.try_wait() {
                Ok(None) => None,
                Ok(Some(status)) => {
                    children.remove(id);
                    Some(Ended::Exited {
                        exit_code: status.code(),
                    })
                }
                Err(_) => {
                    children.remove(id);
                    Some(Ended::Lost)
                }
            });
        }
        drop(children);
        if let Ok(text) = std::fs::read_to_string(exit) {
            return Ok(Some(Ended::Exited {
                exit_code: text.trim().parse().ok(),
            }));
        }
        let alive = pid
            .and_then(|pid| u32::try_from(pid).ok())
            .is_some_and(crate::platform::alive);
        Ok((!alive).then_some(Ended::Lost))
    }

    /// Stops a background command's process and what it started.
    pub fn stop(&self, id: &str, pid: Option<i64>) -> Result<()> {
        self.file(id, "log")?;
        let child = self
            .children
            .lock()
            .expect("background children")
            .remove(id);
        terminate(pid, child);
        Ok(())
    }

    /// A background command's output from `after`.
    pub fn output(&self, id: &str, after: u64) -> Result<Output> {
        read_output(&self.file(id, "log")?, after)
    }

    /// The end of a background command's output, as its session is told it.
    pub fn tail(&self, id: &str) -> Result<String> {
        Ok(tail(&self.file(id, "log")?))
    }

    /// What a joined computer answers when the kernel asks about a background command.
    pub fn answer(&self, op: &str, params: &Value) -> Result<Value> {
        let id = params["id"]
            .as_str()
            .context("Name the background command")?;
        let pid = params["pid"].as_i64();
        Ok(match op {
            "background.start" => json!({"pid": self.start(
                id,
                params["command"].as_str().context("Give the command")?,
                params["folder"].as_str().context("Choose a folder")?,
            )?}),
            "background.ended" => json!({"ended": self.ended(id, pid)?}),
            "background.stop" => {
                self.stop(id, pid)?;
                json!({"stopped": true})
            }
            "background.output" => json!(self.output(id, params["after"].as_u64().unwrap_or(0))?),
            "background.tail" => json!({"text": self.tail(id)?}),
            other => anyhow::bail!("This computer's ZeroLux does not know `{other}`; update it"),
        })
    }
}

/// The command in the system's shell. On Unix the shell writes its exit code beside its
/// output, so that a ZeroLux started again knows how it ended.
fn shell(command: &str, exit: &Path) -> tokio::process::Command {
    #[cfg(unix)]
    {
        let mut process = tokio::process::Command::new("/bin/sh");
        process
            .arg("-c")
            .arg(r#"/bin/sh -c "$1"; code=$?; echo "$code" > "$2"; exit "$code""#)
            .arg("zerolux-background")
            .arg(command)
            .arg(exit);
        process
    }
    #[cfg(windows)]
    {
        let _ = exit;
        let shell = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
        let mut process = tokio::process::Command::new(shell);
        process
            .args(["/d", "/s", "/c"])
            .raw_arg(format!("\"{command}\""));
        process
    }
}

/// Stops a background command's process and what it started.
fn terminate(pid: Option<i64>, child: Option<tokio::process::Child>) {
    #[cfg(unix)]
    {
        let _ = child;
        if let Some(pid) = pid.and_then(|pid| i32::try_from(pid).ok()) {
            // Its own process group, from its own session, and the process itself.
            for target in [-pid, pid] {
                let _ = nix::sys::signal::kill(
                    nix::unistd::Pid::from_raw(target),
                    nix::sys::signal::Signal::SIGTERM,
                );
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(pid) = pid {
            let _ = std::process::Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .output();
        }
        if let Some(mut child) = child {
            let _ = child.start_kill();
        }
    }
}

fn read_output(path: &Path, after: u64) -> Result<Output> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Output {
                start: 0,
                text: String::new(),
                next: 0,
                end: 0,
            });
        }
        Err(error) => return Err(error.into()),
    };
    let end = file.metadata()?.len();
    let start = after.min(end);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(READ).read_to_end(&mut bytes)?;
    // Up to the last whole character: one cut at the end waits for the next read.
    let whole = match std::str::from_utf8(&bytes) {
        Ok(_) => bytes.len(),
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        Err(_) => bytes.len(),
    };
    let text = String::from_utf8_lossy(&bytes[..whole]).into_owned();
    let next = start + whole as u64;
    Ok(Output {
        start,
        text,
        next,
        end,
    })
}

fn tail(path: &Path) -> String {
    let end = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    let text = read_output(path, end.saturating_sub(TOLD as u64 * 2))
        .map(|output| output.text)
        .unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    let mut kept = lines[lines.len().saturating_sub(40)..].join("\n");
    if kept.len() > TOLD {
        let mut cut = kept.len() - TOLD;
        while !kept.is_char_boundary(cut) {
            cut += 1;
        }
        kept.drain(..cut);
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_is_read_from_an_offset_and_told_by_its_end() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.log");
        assert_eq!(read_output(&path, 0).unwrap().end, 0);
        let lines: String = (1..=100).map(|n| format!("line {n}\n")).collect();
        std::fs::write(&path, &lines).unwrap();
        let first = read_output(&path, 0).unwrap();
        assert_eq!(first.text, lines);
        assert_eq!(first.next, lines.len() as u64);
        assert_eq!(read_output(&path, 5).unwrap().text, lines[5..]);
        let told = tail(&path);
        assert!(told.starts_with("line 61\n") && told.ends_with("line 100"));
    }

    #[test]
    fn a_background_command_is_named_by_its_id_only() {
        let dir = tempfile::tempdir().unwrap();
        let processes = BackgroundProcesses::new(dir.path().to_path_buf());
        assert!(processes.output("../secret", 0).is_err());
        assert!(processes.tail("a/b").is_err());
    }
}
