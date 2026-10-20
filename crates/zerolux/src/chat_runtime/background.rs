//! Background commands: commands a session runs in the background, in its folder, on the
//! computer it runs on. The session goes on, and when one ends it is told, with its exit code
//! and the end of its output, as input that waits for its turn. A background command outlives
//! a restart of the kernel, which watches it again.

use std::time::Duration;

use anyhow::{Result, ensure};
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};
use serde::Serialize;
use serde_json::{Value, json};

use super::ChatRuntime;
use crate::{
    background_processes::{Ended, Output},
    chat::Access,
    entity::background_commands as commands,
    model::{ChatIdentity, InputMode},
    store::{Error, now_ms},
};

/// Background commands a session may have running at once.
const RUNNING: usize = 10;

#[derive(Debug, Clone, Serialize)]
pub struct BackgroundCommand {
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

impl From<commands::Model> for BackgroundCommand {
    fn from(row: commands::Model) -> Self {
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

impl ChatRuntime {
    /// The joined computer a session's background commands run on, or none for the kernel's.
    async fn background_host(&self, session: &str) -> Result<Option<String>> {
        let row = crate::entity::sessions::Entity::find_by_id(session)
            .one(self.store.db())
            .await?
            .ok_or(Error::NotFound)?;
        Ok(row
            .host_id
            .filter(|host| Some(host.as_str()) != self.store.host()))
    }

    /// Asks a background command's joined computer about it.
    async fn ask_background(
        &self,
        host: &str,
        op: &str,
        row: &commands::Model,
        params: Value,
    ) -> Result<Value> {
        let mut params = params;
        params["id"] = json!(row.id);
        params["pid"] = json!(row.pid);
        self.hosts.call(host, op, params).await
    }

    /// The session itself, or a person who may read or work in it, as `need` says.
    async fn background_access(
        &self,
        who: &ChatIdentity,
        session: &str,
        need: Access,
    ) -> Result<()> {
        if who.session_id.as_deref() != Some(session) {
            self.store.acting_for(who, session, need).await?;
        }
        Ok(())
    }

    async fn background_row(
        &self,
        who: &ChatIdentity,
        id: &str,
        need: Access,
    ) -> Result<commands::Model> {
        let row = commands::Entity::find_by_id(id)
            .one(self.store.db())
            .await?
            .ok_or(Error::NotFound)?;
        self.background_access(who, &row.session_id, need).await?;
        Ok(row)
    }

    /// Runs `command` in the background, in the session's folder, for `who`: the session
    /// itself or a person who may work in it.
    pub async fn start_background(
        &self,
        who: &ChatIdentity,
        session: &str,
        command: &str,
    ) -> Result<BackgroundCommand> {
        self.background_access(who, session, Access::Write).await?;
        let owner = self.store.session_person(session).await?;
        let command = command.trim();
        ensure!(
            !command.is_empty() && command.len() <= 8 * 1024,
            Error::Invalid("A background command is 1 to 8192 bytes".into())
        );
        let session = self.store.chat_session(&owner, session).await?;
        let running = commands::Entity::find()
            .filter(commands::Column::SessionId.eq(&session.id))
            .filter(commands::Column::Status.eq("running"))
            .all(self.store.db())
            .await?
            .len();
        ensure!(
            running < RUNNING,
            Error::Invalid(format!(
                "A session runs up to {RUNNING} background commands at once"
            ))
        );
        let id = uuid::Uuid::new_v4().to_string();
        let pid = match self.remote_host(&session) {
            None => self
                .background_processes
                .start(&id, command, &session.workspace)
                .map(|pid| pid.map(i64::from))?,
            Some(host) => self
                .hosts
                .call(
                    &host,
                    "background.start",
                    json!({"id": id, "command": command, "folder": session.workspace}),
                )
                .await?["pid"]
                .as_i64(),
        };
        let row = commands::ActiveModel {
            id: Set(id.clone()),
            session_id: Set(session.id.clone()),
            command: Set(command.to_owned()),
            folder: Set(session.workspace.clone()),
            status: Set("running".into()),
            pid: Set(pid),
            exit_code: Set(None),
            started_at: Set(now_ms()),
            ended_at: Set(None),
            told_at: Set(None),
            error: Set(None),
        }
        .insert(self.store.db())
        .await?;
        self.background_changed(&row).await;
        Ok(row.into())
    }

    /// A session's background commands, newest first.
    pub async fn background_commands(
        &self,
        who: &ChatIdentity,
        session: &str,
    ) -> Result<Vec<BackgroundCommand>> {
        self.background_access(who, session, Access::Read).await?;
        Ok(commands::Entity::find()
            .filter(commands::Column::SessionId.eq(session))
            .order_by_desc(commands::Column::StartedAt)
            .all(self.store.db())
            .await?
            .into_iter()
            .map(BackgroundCommand::from)
            .collect())
    }

    /// A background command, and its output from `after`.
    pub async fn background_command(
        &self,
        who: &ChatIdentity,
        id: &str,
        after: u64,
    ) -> Result<(BackgroundCommand, Output)> {
        let row = self.background_row(who, id, Access::Read).await?;
        let output = match self.background_host(&row.session_id).await? {
            None => self.background_processes.output(id, after)?,
            Some(host) => serde_json::from_value(
                self.ask_background(&host, "background.output", &row, json!({"after": after}))
                    .await?,
            )?,
        };
        Ok((row.into(), output))
    }

    /// Stops a running background command and what it started. The session is not told of it.
    pub async fn stop_background(&self, who: &ChatIdentity, id: &str) -> Result<BackgroundCommand> {
        let row = self.background_row(who, id, Access::Write).await?;
        ensure!(
            row.status == "running",
            Error::Invalid("The command is not running".into())
        );
        match self.background_host(&row.session_id).await? {
            None => self.background_processes.stop(id, row.pid)?,
            Some(host) => {
                self.ask_background(&host, "background.stop", &row, json!({}))
                    .await?;
            }
        }
        let row = commands::ActiveModel {
            id: Set(row.id.clone()),
            status: Set("stopped".into()),
            ended_at: Set(Some(now_ms())),
            ..Default::default()
        }
        .update(self.store.db())
        .await?;
        self.background_changed(&row).await;
        Ok(row.into())
    }

    /// Looks at the running background commands: those that ended are recorded, and their sessions told.
    pub async fn check_background(&self) -> Result<()> {
        let running = commands::Entity::find()
            .filter(commands::Column::Status.eq("running"))
            .all(self.store.db())
            .await?;
        for row in running {
            let Some(exit) = self.ended(&row).await else {
                continue;
            };
            let (status, code) = match exit {
                Ended::Exited { exit_code } => ("exited", exit_code),
                Ended::Lost => ("lost", None),
            };
            let row = commands::ActiveModel {
                id: Set(row.id.clone()),
                status: Set(status.into()),
                exit_code: Set(code),
                ended_at: Set(Some(now_ms())),
                ..Default::default()
            }
            .update(self.store.db())
            .await?;
            self.background_changed(&row).await;
            self.tell_background(&row).await?;
        }
        Ok(())
    }

    /// Whether a running background command ended, and how. One on a joined computer that is away, or
    /// does not answer, is still running as far as is known.
    async fn ended(&self, row: &commands::Model) -> Option<Ended> {
        let host = match self.background_host(&row.session_id).await {
            Ok(host) => host,
            Err(error) => {
                tracing::warn!(command = %row.id, error = format!("{error:#}"), "Background command not checked");
                return None;
            }
        };
        let ended = match host {
            None => self.background_processes.ended(&row.id, row.pid),
            Some(host) => {
                if !self.hosts.online(&host).await {
                    return None;
                }
                self.ask_background(&host, "background.ended", row, json!({}))
                    .await
                    .and_then(|answer| Ok(serde_json::from_value(answer["ended"].clone())?))
            }
        };
        ended
            .inspect_err(|error| {
                tracing::warn!(command = %row.id, error = format!("{error:#}"), "Background command not checked");
            })
            .ok()
            .flatten()
    }

    /// The session hears how a background command ended, as input that waits for its turn. Never told
    /// twice: an uncertain delivery is recorded, not repeated.
    async fn tell_background(&self, row: &commands::Model) -> Result<()> {
        let owner = self.store.session_person(&row.session_id).await?;
        let seconds = (row.ended_at.unwrap_or(row.started_at) - row.started_at) / 1000;
        let ended = match (row.status.as_str(), row.exit_code) {
            ("exited", Some(code)) => format!("exit code {code}"),
            _ => "exit code unknown".to_owned(),
        };
        let tail = match self.background_host(&row.session_id).await? {
            None => self.background_processes.tail(&row.id)?,
            Some(host) => self
                .ask_background(&host, "background.tail", row, json!({}))
                .await
                .map(|answer| answer["text"].as_str().unwrap_or_default().to_owned())
                .unwrap_or_default(),
        };
        let text = format!(
            "[ZeroLux] Background command {} ended: {ended}, after {seconds} s.\n$ {}\n```\n{tail}\n```",
            row.id, row.command
        );
        let sent = self
            .input(&owner, &row.session_id, &text, InputMode::Queue, &[])
            .await;
        let (told, error) = match sent {
            Ok(()) => (Some(now_ms()), None),
            Err(error) => (None, Some(format!("{error:#}"))),
        };
        commands::ActiveModel {
            id: Set(row.id.clone()),
            told_at: Set(told),
            error: Set(error),
            ..Default::default()
        }
        .update(self.store.db())
        .await?;
        Ok(())
    }

    /// The people who may read its session hear that a background command changed.
    async fn background_changed(&self, row: &commands::Model) {
        if let Ok(people) = self.store.readers(&row.session_id).await {
            let _ = self
                .livekit
                .notify(
                    &json!({"type": "background_command.changed", "background_command_id": row.id,
                        "session_id": row.session_id, "status": row.status}),
                    &people,
                )
                .await;
        }
    }
}

/// Watches the running background commands every two seconds.
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
        if let Err(error) = runtime.check_background().await {
            tracing::warn!(
                error = format!("{error:#}"),
                "Background commands not checked"
            );
        }
    }
}

impl ChatRuntime {
    /// An agent hears `text` in the session it works in, its newest running one, as input that
    /// waits for its turn: the session's ID. None running: refused, never kept for later.
    pub async fn tell_agent(&self, actor_id: &str, text: &str) -> Result<String> {
        use crate::entity::sessions;
        let session = sessions::Entity::find()
            .filter(sessions::Column::ActorId.eq(actor_id))
            .filter(sessions::Column::StoppedAt.is_null())
            .filter(sessions::Column::Status.is_in(["connected", "attention"]))
            .order_by_desc(sessions::Column::CreatedAt)
            .one(self.store.db())
            .await?
            .ok_or_else(|| Error::Invalid("The agent has no running session".into()))?;
        let owner = self.store.session_person(&session.id).await?;
        self.input(&owner, &session.id, text, InputMode::Queue, &[])
            .await?;
        Ok(session.id)
    }
}
