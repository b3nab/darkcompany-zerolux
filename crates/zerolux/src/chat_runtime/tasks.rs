//! Tasks: commands a session runs in the background, in its folder. The session goes on, and
//! when one ends it is told, with its exit code and the end of its output, as input that
//! waits for its turn. A task outlives a restart of the kernel, which watches it again.

use std::{path::PathBuf, time::Duration};

use anyhow::{Context, Result, ensure};
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};
use serde::Serialize;
use serde_json::json;

use super::ChatRuntime;
use crate::{
    chat::Access,
    entity::tasks,
    model::{ChatIdentity, InputMode},
    store::{Error, now_ms},
};

/// Tasks a session may have running at once.
const RUNNING: usize = 10;
/// What a session is told of a task's output: its last lines, up to this many bytes.
const TOLD: usize = 4000;
/// What a read returns at most.
const READ: u64 = 256 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct Task {
    pub id: String,
    pub session_id: String,
    pub command: String,
    pub folder: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub told_at: Option<i64>,
    pub error: Option<String>,
}

impl From<tasks::Model> for Task {
    fn from(row: tasks::Model) -> Self {
        Self {
            id: row.id,
            session_id: row.session_id,
            command: row.command,
            folder: row.folder,
            status: row.status,
            exit_code: row.exit_code,
            started_at: row.started_at,
            ended_at: row.ended_at,
            told_at: row.told_at,
            error: row.error,
        }
    }
}

/// A part of a task's output, from a byte offset.
#[derive(Debug, Serialize)]
pub struct Output {
    /// Where the returned text starts.
    pub start: u64,
    pub text: String,
    /// Where to read next.
    pub next: u64,
    /// How long the output is now.
    pub end: u64,
}

impl ChatRuntime {
    fn task_file(&self, id: &str, extension: &str) -> PathBuf {
        self.tasks_dir.join(format!("{id}.{extension}"))
    }

    /// The session itself, or a person who may read or work in it, as `need` says.
    async fn task_access(&self, who: &ChatIdentity, session: &str, need: Access) -> Result<()> {
        if who.session_id.as_deref() != Some(session) {
            self.store.acting_for(who, session, need).await?;
        }
        Ok(())
    }

    async fn task_row(&self, who: &ChatIdentity, id: &str, need: Access) -> Result<tasks::Model> {
        let row = tasks::Entity::find_by_id(id)
            .one(self.store.db())
            .await?
            .ok_or(Error::NotFound)?;
        self.task_access(who, &row.session_id, need).await?;
        Ok(row)
    }

    /// Runs `command` in the background, in the session's folder, for `who`: the session
    /// itself or a person who may work in it.
    pub async fn start_task(
        &self,
        who: &ChatIdentity,
        session: &str,
        command: &str,
    ) -> Result<Task> {
        self.task_access(who, session, Access::Write).await?;
        let owner = self.store.session_person(session).await?;
        let command = command.trim();
        ensure!(
            !command.is_empty() && command.len() <= 8 * 1024,
            Error::Invalid("A task's command is 1 to 8192 bytes".into())
        );
        let session = self.store.chat_session(&owner, session).await?;
        ensure!(
            self.remote_host(&session).is_none(),
            Error::Invalid("Tasks run on the kernel's computer only".into())
        );
        let running = tasks::Entity::find()
            .filter(tasks::Column::SessionId.eq(&session.id))
            .filter(tasks::Column::Status.eq("running"))
            .all(self.store.db())
            .await?
            .len();
        ensure!(
            running < RUNNING,
            Error::Invalid(format!("A session runs up to {RUNNING} tasks at once"))
        );
        crate::platform::private_dir(&self.tasks_dir)?;
        let id = uuid::Uuid::new_v4().to_string();
        let log = crate::platform::private(std::fs::OpenOptions::new().create(true).append(true))
            .open(self.task_file(&id, "log"))?;
        let mut process = shell(command, &self.task_file(&id, "exit"));
        process
            .current_dir(&session.workspace)
            .env_remove("ZEROLUX_TOKEN")
            .env_remove("ZEROLUX_URL")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::from(log.try_clone()?))
            .stderr(std::process::Stdio::from(log))
            .kill_on_drop(false);
        crate::platform::detach(&mut process);
        let child = process
            .spawn()
            .with_context(|| format!("Cannot run the task in {}", session.workspace))?;
        let row = tasks::ActiveModel {
            id: Set(id.clone()),
            session_id: Set(session.id.clone()),
            command: Set(command.to_owned()),
            folder: Set(session.workspace.clone()),
            status: Set("running".into()),
            pid: Set(child.id().map(i64::from)),
            exit_code: Set(None),
            started_at: Set(now_ms()),
            ended_at: Set(None),
            told_at: Set(None),
            error: Set(None),
        }
        .insert(self.store.db())
        .await?;
        self.task_children
            .lock()
            .expect("task children")
            .insert(id, child);
        self.task_changed(&row).await;
        Ok(row.into())
    }

    /// A session's tasks, newest first.
    pub async fn tasks(&self, who: &ChatIdentity, session: &str) -> Result<Vec<Task>> {
        self.task_access(who, session, Access::Read).await?;
        Ok(tasks::Entity::find()
            .filter(tasks::Column::SessionId.eq(session))
            .order_by_desc(tasks::Column::StartedAt)
            .all(self.store.db())
            .await?
            .into_iter()
            .map(Task::from)
            .collect())
    }

    /// A task, and its output from `after`.
    pub async fn task(&self, who: &ChatIdentity, id: &str, after: u64) -> Result<(Task, Output)> {
        let row = self.task_row(who, id, Access::Read).await?;
        let output = read_output(&self.task_file(id, "log"), after)?;
        Ok((row.into(), output))
    }

    /// Stops a running task and what it started. The session is not told of it.
    pub async fn stop_task(&self, who: &ChatIdentity, id: &str) -> Result<Task> {
        let row = self.task_row(who, id, Access::Write).await?;
        ensure!(
            row.status == "running",
            Error::Invalid("The task is not running".into())
        );
        let child = self.task_children.lock().expect("task children").remove(id);
        terminate(row.pid, child);
        let row = tasks::ActiveModel {
            id: Set(row.id.clone()),
            status: Set("stopped".into()),
            ended_at: Set(Some(now_ms())),
            ..Default::default()
        }
        .update(self.store.db())
        .await?;
        self.task_changed(&row).await;
        Ok(row.into())
    }

    /// Looks at the running tasks: those that ended are recorded, and their sessions told.
    pub async fn check_tasks(&self) -> Result<()> {
        let running = tasks::Entity::find()
            .filter(tasks::Column::Status.eq("running"))
            .all(self.store.db())
            .await?;
        for row in running {
            let Some(exit) = self.ended(&row) else {
                continue;
            };
            let (status, code) = match exit {
                Ended::Exited(code) => ("exited", code),
                Ended::Lost => ("lost", None),
            };
            let row = tasks::ActiveModel {
                id: Set(row.id.clone()),
                status: Set(status.into()),
                exit_code: Set(code),
                ended_at: Set(Some(now_ms())),
                ..Default::default()
            }
            .update(self.store.db())
            .await?;
            self.task_changed(&row).await;
            self.tell_task(&row).await?;
        }
        Ok(())
    }

    /// Whether a running task ended, and how: from its process here, or after a restart
    /// from the exit code its shell wrote.
    fn ended(&self, row: &tasks::Model) -> Option<Ended> {
        let mut children = self.task_children.lock().expect("task children");
        if let Some(child) = children.get_mut(&row.id) {
            return match child.try_wait() {
                Ok(None) => None,
                Ok(Some(status)) => {
                    children.remove(&row.id);
                    Some(Ended::Exited(status.code()))
                }
                Err(_) => {
                    children.remove(&row.id);
                    Some(Ended::Lost)
                }
            };
        }
        drop(children);
        if let Ok(text) = std::fs::read_to_string(self.task_file(&row.id, "exit")) {
            return Some(Ended::Exited(text.trim().parse().ok()));
        }
        let alive = row
            .pid
            .and_then(|pid| u32::try_from(pid).ok())
            .is_some_and(crate::platform::alive);
        (!alive).then_some(Ended::Lost)
    }

    /// The session hears how a task ended, as input that waits for its turn. Never told
    /// twice: an uncertain delivery is recorded, not repeated.
    async fn tell_task(&self, row: &tasks::Model) -> Result<()> {
        let owner = self.store.session_person(&row.session_id).await?;
        let seconds = (row.ended_at.unwrap_or(row.started_at) - row.started_at) / 1000;
        let ended = match (row.status.as_str(), row.exit_code) {
            ("exited", Some(code)) => format!("exit code {code}"),
            _ => "exit code unknown".to_owned(),
        };
        let tail = tail(&self.task_file(&row.id, "log"));
        let text = format!(
            "[ZeroLux] Task {} ended: {ended}, after {seconds} s.\n$ {}\n```\n{tail}\n```",
            row.id, row.command
        );
        let sent = self
            .input(&owner, &row.session_id, &text, InputMode::Queue, &[])
            .await;
        let (told, error) = match sent {
            Ok(()) => (Some(now_ms()), None),
            Err(error) => (None, Some(format!("{error:#}"))),
        };
        tasks::ActiveModel {
            id: Set(row.id.clone()),
            told_at: Set(told),
            error: Set(error),
            ..Default::default()
        }
        .update(self.store.db())
        .await?;
        Ok(())
    }

    /// The people who may read its session hear that a task changed.
    async fn task_changed(&self, row: &tasks::Model) {
        if let Ok(people) = self.store.readers(&row.session_id).await {
            let _ = self
                .livekit
                .notify(
                    &json!({"type": "task.changed", "task_id": row.id,
                        "session_id": row.session_id, "status": row.status}),
                    &people,
                )
                .await;
        }
    }
}

enum Ended {
    Exited(Option<i32>),
    Lost,
}

/// The command in the system's shell. On Unix the shell writes its exit code beside its
/// output, so that a kernel started again knows how it ended.
fn shell(command: &str, exit: &std::path::Path) -> tokio::process::Command {
    #[cfg(unix)]
    {
        let mut process = tokio::process::Command::new("/bin/sh");
        process
            .arg("-c")
            .arg(r#"/bin/sh -c "$1"; code=$?; echo "$code" > "$2"; exit "$code""#)
            .arg("zerolux-task")
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

/// Stops a task's process and what it started.
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

fn read_output(path: &std::path::Path, after: u64) -> Result<Output> {
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

/// The end of a task's output, as its session is told it.
fn tail(path: &std::path::Path) -> String {
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

/// Watches the running tasks every two seconds.
pub async fn watch(runtime: std::sync::Weak<ChatRuntime>) {
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let Some(runtime) = runtime.upgrade() else {
            return;
        };
        if *runtime.stop.borrow() {
            return;
        }
        if let Err(error) = runtime.check_tasks().await {
            tracing::warn!(error = format!("{error:#}"), "Tasks not checked");
        }
    }
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
}
