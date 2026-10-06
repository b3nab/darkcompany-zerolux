use crate::{
    model::*,
    store::{Error, LEASE_MS, Result, Store, now_ms, text},
};
use uuid::Uuid;

pub(crate) fn task_prompt(project: &Project, task: &Task) -> String {
    format!(
        "You are an agent working on a ZeroLux task in the explicitly selected local workspace.\n\
        Only perform the assigned task. Do not commit, push, merge, deploy, or claim human approval.\n\
        Follow repository instructions. End with a summary, changed files, tests run, and remaining risks.\n\
        A successful run submits the work for human review; it does not complete the task.\n\n\
        Project: {}\nProject context:\n{}\n\nTask ID: {}\nTitle: {}\nTask description:\n{}\n\nHuman review feedback:\n{}\n",
        project.name, project.description, task.id, task.title, task.description, task.review_note
    )
}

impl Store {
    pub async fn create_agent(&self, input: CreateAgent) -> Result<Actor> {
        self.require_onboarding().await?;
        let name = text(&input.name, "Agent name", 200, true)?;
        sqlx::query_as(
            "INSERT INTO actors (id, name, kind, owner_id, harness, created_at)
            SELECT ?, ?, 'agent', id, ?, ? FROM actors WHERE id = ? AND kind = 'human' AND archived = 0 RETURNING *",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(name)
        .bind(input.harness.id())
        .bind(now_ms())
        .bind(input.owner_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::Invalid("An agent must belong to an existing human".into()))
    }

    pub async fn connect_agent(&self, input: ConnectAgent) -> Result<AgentConnection> {
        self.require_onboarding().await?;
        if !matches!(input.mode.as_str(), "process" | "pi_session") {
            return Err(Error::Invalid(
                "Connection mode must be process or pi_session".into(),
            ));
        }
        if input.mode == "pi_session" {
            text(
                input.session_id.as_deref().unwrap_or(""),
                "Pi session ID",
                200,
                true,
            )?;
        } else if input.session_id.is_some() {
            return Err(Error::Invalid(
                "A process connection cannot attach an existing session".into(),
            ));
        }
        text(&input.workspace, "Workspace", 4096, true)?;
        let workspace = std::path::Path::new(&input.workspace);
        if !workspace.is_absolute() {
            return Err(Error::Invalid("Workspace must be an absolute path".into()));
        }
        let workspace = tokio::fs::canonicalize(workspace).await.map_err(|_| {
            Error::Invalid("Workspace must exist on the local kernel machine".into())
        })?;
        if !workspace.is_dir() {
            return Err(Error::Invalid("Workspace must be a directory".into()));
        }
        let workspace = workspace.to_string_lossy().into_owned();
        let mut tx = self.pool.begin().await?;
        Self::reap_in(&mut tx).await?;
        let actor: Actor =
            sqlx::query_as("SELECT * FROM actors WHERE id = ? AND kind = 'agent' AND archived = 0")
                .bind(&input.actor_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(Error::NotFound)?;
        if input.mode == "pi_session" && actor.harness.as_deref() != Some("pi") {
            return Err(Error::Invalid(
                "Only a pi agent can attach a pi session".into(),
            ));
        }
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?)")
            .bind(&input.project_id)
            .fetch_one(&mut *tx)
            .await?;
        if !exists {
            return Err(Error::NotFound);
        }
        let busy: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agent_connections
            WHERE disconnected_at IS NULL AND (actor_id = ? OR workspace = ? OR (mode = 'pi_session' AND session_id = ?)))
            OR EXISTS(SELECT 1 FROM runs JOIN tasks ON tasks.id = runs.task_id WHERE runs.status = 'running' AND tasks.assignee_id = ?)")
            .bind(&input.actor_id).bind(&workspace).bind(&input.session_id).bind(&input.actor_id).fetch_one(&mut *tx).await?;
        if busy {
            return Err(Error::Conflict);
        }
        let now = now_ms();
        let connection = sqlx::query_as(
            "INSERT INTO agent_connections
            (id, actor_id, project_id, mode, workspace, session_id, connected_at, lease_expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(input.actor_id)
        .bind(input.project_id)
        .bind(input.mode)
        .bind(workspace)
        .bind(input.session_id)
        .bind(now)
        .bind(now + LEASE_MS)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(connection)
    }

    pub async fn connection_heartbeat(&self, id: &str) -> Result<()> {
        let now = now_ms();
        let result = sqlx::query(
            "UPDATE agent_connections SET lease_expires_at = ?
            WHERE id = ? AND disconnected_at IS NULL AND lease_expires_at > ?",
        )
        .bind(now + LEASE_MS)
        .bind(id)
        .bind(now)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            return Err(Error::Conflict);
        }
        Ok(())
    }

    pub async fn disconnect_agent(&self, id: &str) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query("UPDATE agent_connections SET disconnected_at = COALESCE(disconnected_at, ?) WHERE id = ?")
            .bind(now_ms()).bind(id).execute(&mut *tx).await?;
        if result.rows_affected() != 1 {
            return Err(Error::NotFound);
        }
        Self::reap_in(&mut tx).await?;
        tx.commit().await?;
        Ok(())
    }
}
