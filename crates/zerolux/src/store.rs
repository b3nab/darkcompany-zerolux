use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use sqlx::{
    Sqlite, SqlitePool, Transaction,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use uuid::Uuid;

use crate::model::*;

pub const LEASE_MS: i64 = 90_000;
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Invalid or revoked agent token")]
    Unauthorized,
    #[error("This identity cannot access this operation")]
    Forbidden,
    #[error("{0}")]
    Invalid(String),
    #[error("Set your name to complete owner onboarding first")]
    OnboardingRequired,
    #[error("Not found")]
    NotFound,
    #[error("The requested operation conflicts with the current state; refresh and try again")]
    Conflict,
    #[error("The owner stopped this session while it was being relinked")]
    StoppedByOwner,
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Migration(#[from] sqlx::migrate::MigrateError),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone)]
pub struct Store {
    pub(crate) pool: SqlitePool,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before Unix epoch")
        .as_millis() as i64
}

pub(crate) fn text(value: &str, label: &str, max: usize, required: bool) -> Result<String> {
    let value = value.trim();
    if (required && value.is_empty()) || value.len() > max {
        return Err(Error::Invalid(format!(
            "{label} must be {}1–{max} bytes",
            if required { "" } else { "empty or " }
        )));
    }
    Ok(value.to_owned())
}

impl Store {
    /// Two processes may open a new database at once. SQLite reports the switch to WAL as
    /// locked without waiting, so opening waits and tries again.
    pub async fn open(path: &Path) -> Result<Self> {
        let mut attempts = 0;
        loop {
            match Self::open_once(path).await {
                Err(Error::Database(sqlx::Error::Database(error)))
                    if attempts < 50 && error.message().contains("locked") =>
                {
                    attempts += 1;
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                opened => return opened,
            }
        }
    }

    async fn open_once(path: &Path) -> Result<Self> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        // One atomic insert each makes initialization safe across concurrent opens.
        // Existing identity, name, dates and ownership links are never regenerated.
        let now = now_ms();
        sqlx::query(
            "INSERT INTO workspace (id, name, created_at)
            SELECT ?, 'Workspace', ?
            WHERE NOT EXISTS (SELECT 1 FROM workspace)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(now)
        .execute(&pool)
        .await?;
        sqlx::query(
            "INSERT INTO actors (id, name, kind, created_at)
            SELECT ?, 'Local owner', 'human', ?
            WHERE NOT EXISTS (SELECT 1 FROM actors WHERE kind = 'human')",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(now)
        .execute(&pool)
        .await?;
        let store = Self { pool };
        store.reap_expired().await?;
        Ok(store)
    }

    pub async fn set_owner_name(&self, input: SetOwnerName) -> Result<Actor> {
        let name = text(&input.name, "Your name", 200, true)?;
        if name.eq_ignore_ascii_case("Local owner") || name.chars().any(char::is_control) {
            return Err(Error::Invalid(
                "Enter your name without placeholders or control characters".into(),
            ));
        }
        Ok(sqlx::query_as(
            "UPDATE actors SET name = ?, name_confirmed = 1 WHERE kind = 'human' RETURNING *",
        )
        .bind(name)
        .fetch_one(&self.pool)
        .await?)
    }

    pub async fn workspace_info(&self) -> Result<WorkspaceInfo> {
        Ok(sqlx::query_as("SELECT * FROM workspace")
            .fetch_one(&self.pool)
            .await?)
    }

    pub async fn set_workspace_name(&self, input: SetWorkspaceName) -> Result<WorkspaceInfo> {
        let name = text(&input.name, "Workspace name", 200, true)?;
        if name.chars().any(char::is_control) {
            return Err(Error::Invalid(
                "Enter the workspace name without control characters".into(),
            ));
        }
        Ok(sqlx::query_as("UPDATE workspace SET name = ? RETURNING *")
            .bind(name)
            .fetch_one(&self.pool)
            .await?)
    }

    pub(crate) async fn require_onboarding(&self) -> Result<()> {
        let confirmed: bool =
            sqlx::query_scalar("SELECT name_confirmed FROM actors WHERE kind = 'human'")
                .fetch_one(&self.pool)
                .await?;
        if !confirmed {
            return Err(Error::OnboardingRequired);
        }
        Ok(())
    }

    pub async fn reassign_task(&self, id: &str, input: ReassignTask) -> Result<Task> {
        self.require_onboarding().await?;
        // Move work from a retired (archived) agent to a hired one explicitly. Never move running/done work or auto-queue it.
        sqlx::query_as("UPDATE tasks SET assignee_id = ?, status = 'draft', updated_at = ?
            WHERE id = ? AND status IN ('draft', 'queued', 'failed', 'review')
            AND EXISTS(SELECT 1 FROM actors old WHERE old.id = tasks.assignee_id AND old.archived = 1)
            AND EXISTS(SELECT 1 FROM actors new WHERE new.id = ? AND new.kind = 'agent' AND new.archived = 0)
            RETURNING *")
            .bind(&input.assignee_id).bind(now_ms()).bind(id).bind(&input.assignee_id)
            .fetch_optional(&self.pool).await?.ok_or(Error::Conflict)
    }

    pub async fn workspace(&self) -> Result<Workspace> {
        let mut tx = self.pool.begin().await?;
        let workspace = sqlx::query_as("SELECT * FROM workspace")
            .fetch_one(&mut *tx)
            .await?;
        let actors = sqlx::query_as("SELECT * FROM actors ORDER BY kind DESC, name")
            .fetch_all(&mut *tx)
            .await?;
        let projects = sqlx::query_as("SELECT * FROM projects ORDER BY created_at, id")
            .fetch_all(&mut *tx)
            .await?;
        let tasks = sqlx::query_as("SELECT * FROM tasks ORDER BY created_at, id")
            .fetch_all(&mut *tx)
            .await?;
        let connections = sqlx::query_as(
            "SELECT * FROM agent_connections WHERE disconnected_at IS NULL ORDER BY connected_at",
        )
        .fetch_all(&mut *tx)
        .await?;
        let onboarding_required =
            sqlx::query_scalar("SELECT NOT name_confirmed FROM actors WHERE kind = 'human'")
                .fetch_one(&mut *tx)
                .await?;
        tx.commit().await?;
        Ok(Workspace {
            workspace,
            actors,
            projects,
            tasks,
            connections,
            onboarding_required,
        })
    }

    pub async fn create_project(&self, input: CreateProject) -> Result<Project> {
        self.require_onboarding().await?;
        let name = text(&input.name, "Project name", 200, true)?;
        let description = text(&input.description, "Description", 20_000, false)?;
        Ok(sqlx::query_as("INSERT INTO projects (id, name, description, created_at) VALUES (?, ?, ?, ?) RETURNING *")
            .bind(Uuid::new_v4().to_string()).bind(name).bind(description).bind(now_ms())
            .fetch_one(&self.pool).await?)
    }

    pub async fn create_task(&self, input: CreateTask) -> Result<Task> {
        self.require_onboarding().await?;
        let title = text(&input.title, "Task title", 200, true)?;
        let description = text(&input.description, "Description", 20_000, false)?;
        let now = now_ms();
        sqlx::query_as("INSERT INTO tasks (id, project_id, title, description, assignee_id, status, created_at, updated_at)
            SELECT ?, ?, ?, ?, id, 'draft', ?, ? FROM actors
            WHERE id = ? AND kind = 'agent' AND archived = 0 AND EXISTS (SELECT 1 FROM projects WHERE id = ?)
            RETURNING *")
            .bind(Uuid::new_v4().to_string()).bind(&input.project_id).bind(title).bind(description)
            .bind(now).bind(now).bind(input.assignee_id).bind(&input.project_id)
            .fetch_optional(&self.pool).await?
            .ok_or_else(|| Error::Invalid("Choose an existing project and agent".into()))
    }

    pub async fn act(&self, id: &str, input: TaskAction) -> Result<Task> {
        self.require_onboarding().await?;
        if !matches!(input.action, Action::Approve) {
            let retired: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM tasks JOIN actors ON actors.id = tasks.assignee_id WHERE tasks.id = ? AND actors.archived = 1)")
                .bind(id).fetch_one(&self.pool).await?;
            if retired {
                return Err(Error::Invalid(
                    "This task belongs to a retired agent: assign a hired agent before queueing it"
                        .into(),
                ));
            }
        }
        let note = text(
            &input.note,
            "Review note",
            20_000,
            matches!(input.action, Action::RequestChanges),
        )?;
        let (next, allowed_a, allowed_b) = match input.action {
            Action::Queue => ("queued", "draft", "failed"),
            Action::Approve => ("done", "review", "review"),
            Action::RequestChanges => ("queued", "review", "review"),
        };
        sqlx::query_as("UPDATE tasks SET status = ?, review_note = CASE WHEN ? = '' THEN review_note ELSE ? END, updated_at = ?
            WHERE id = ? AND status IN (?, ?) RETURNING *")
            .bind(next).bind(&note).bind(&note).bind(now_ms()).bind(id).bind(allowed_a).bind(allowed_b)
            .fetch_optional(&self.pool).await?.ok_or(Error::Conflict)
    }

    pub async fn runs(&self, task_id: &str) -> Result<Vec<Run>> {
        if !sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM tasks WHERE id = ?)")
            .bind(task_id)
            .fetch_one(&self.pool)
            .await?
        {
            return Err(Error::NotFound);
        }
        Ok(
            sqlx::query_as("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, id")
                .bind(task_id)
                .fetch_all(&self.pool)
                .await?,
        )
    }

    pub async fn claim(&self, input: ClaimRequest) -> Result<Option<Claim>> {
        self.require_onboarding().await?;
        let mut tx = self.pool.begin().await?;
        // First statement takes SQLite's write lock. Concurrent workers cannot claim the same task.
        Self::reap_in(&mut tx).await?;
        let project: Project = sqlx::query_as("SELECT * FROM projects WHERE id = ?")
            .bind(&input.project_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Error::NotFound)?;
        let actor: Actor =
            sqlx::query_as("SELECT * FROM actors WHERE id = ? AND kind = 'agent' AND archived = 0")
                .bind(&input.actor_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| Error::Invalid("Worker actor must be an existing agent".into()))?;
        let now = now_ms();
        if let Some(connection_id) = &input.connection_id {
            let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agent_connections
                WHERE id = ? AND actor_id = ? AND project_id = ? AND disconnected_at IS NULL AND lease_expires_at > ?)")
                .bind(connection_id).bind(&input.actor_id).bind(&input.project_id).bind(now).fetch_one(&mut *tx).await?;
            let busy: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM runs WHERE connection_id = ? AND status = 'running')",
            )
            .bind(connection_id)
            .fetch_one(&mut *tx)
            .await?;
            if !valid || busy {
                return Err(Error::Conflict);
            }
        } else {
            return Err(Error::Invalid(
                "Connect this agent before claiming tasks".into(),
            ));
        }
        let task: Option<Task> = sqlx::query_as(
            "UPDATE tasks SET status = 'running', updated_at = ? WHERE id = (
            SELECT id FROM tasks WHERE project_id = ? AND assignee_id = ? AND status = 'queued'
            ORDER BY created_at, id LIMIT 1) RETURNING *",
        )
        .bind(now)
        .bind(input.project_id)
        .bind(input.actor_id)
        .fetch_optional(&mut *tx)
        .await?;
        let claim = if let Some(task) = task {
            let run = sqlx::query_as(
                "INSERT INTO runs (id, task_id, status, started_at, lease_expires_at, connection_id, actor_id)
                VALUES (?, ?, 'running', ?, ?, ?, ?) RETURNING *",
            )
            .bind(Uuid::new_v4().to_string())
            .bind(&task.id)
            .bind(now)
            .bind(now + LEASE_MS)
            .bind(input.connection_id)
            .bind(actor.id)
            .fetch_one(&mut *tx)
            .await?;
            let prompt = crate::byoh::task_prompt(&project, &task);
            Some(Claim {
                task,
                run,
                project,
                prompt,
            })
        } else {
            None
        };
        tx.commit().await?;
        Ok(claim)
    }

    pub async fn heartbeat(&self, run_id: &str) -> Result<()> {
        let now = now_ms();
        let mut tx = self.pool.begin().await?;
        let connection_id: Option<String> = sqlx::query_scalar("UPDATE runs SET lease_expires_at = ?
            WHERE id = ? AND status = 'running' AND lease_expires_at > ? AND
            (connection_id IS NULL OR EXISTS(SELECT 1 FROM agent_connections c WHERE c.id = runs.connection_id AND c.disconnected_at IS NULL AND c.lease_expires_at > ?))
            RETURNING connection_id")
            .bind(now + LEASE_MS).bind(run_id).bind(now).bind(now).fetch_optional(&mut *tx).await?.ok_or(Error::Conflict)?;
        if let Some(id) = connection_id {
            sqlx::query("UPDATE agent_connections SET lease_expires_at = ? WHERE id = ?")
                .bind(now + LEASE_MS)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn finish(&self, run_id: &str, input: FinishRun) -> Result<Run> {
        if input.stdout.len() > MAX_OUTPUT_BYTES || input.stderr.len() > MAX_OUTPUT_BYTES {
            return Err(Error::Invalid("Output exceeds 64 KiB per stream".into()));
        }
        if let Some(reason) = &input.failure_reason {
            text(reason, "Failure reason", 2_000, true)?;
        }
        let succeeded = input.exit_code == Some(0) && input.failure_reason.is_none();
        let mut tx = self.pool.begin().await?;
        let now = now_ms();
        let run: Run = sqlx::query_as("UPDATE runs SET status = ?, stdout = ?, stderr = ?, exit_code = ?, failure_reason = ?, finished_at = ?
            WHERE id = ? AND status = 'running' AND lease_expires_at > ? AND
            (connection_id IS NULL OR EXISTS(SELECT 1 FROM agent_connections c WHERE c.id = runs.connection_id AND c.disconnected_at IS NULL AND c.lease_expires_at > ?)) RETURNING *")
            .bind(if succeeded { "succeeded" } else { "failed" })
            .bind(input.stdout).bind(input.stderr).bind(input.exit_code).bind(input.failure_reason)
            .bind(now).bind(run_id).bind(now).bind(now).fetch_optional(&mut *tx).await?.ok_or(Error::Conflict)?;
        let result = sqlx::query(
            "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = 'running'",
        )
        .bind(if succeeded { "review" } else { "failed" })
        .bind(now)
        .bind(&run.task_id)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            return Err(Error::Conflict);
        }
        tx.commit().await?;
        Ok(run)
    }

    pub async fn reap_expired(&self) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        Self::reap_in(&mut tx).await?;
        tx.commit().await?;
        Ok(())
    }

    pub(crate) async fn reap_in(tx: &mut Transaction<'_, Sqlite>) -> Result<()> {
        let now = now_ms();
        sqlx::query("UPDATE agent_connections SET disconnected_at = ? WHERE disconnected_at IS NULL AND lease_expires_at <= ?")
            .bind(now).bind(now).execute(&mut **tx).await?;
        let task_ids: Vec<String> = sqlx::query_scalar(
            "UPDATE runs SET status = 'failed', finished_at = ?,
            failure_reason = 'Worker lease expired or connection closed. Inspect the workspace before retrying.'
            WHERE status = 'running' AND (lease_expires_at <= ? OR connection_id IN
                (SELECT id FROM agent_connections WHERE disconnected_at IS NOT NULL)) RETURNING task_id",
        )
        .bind(now)
        .bind(now)
        .fetch_all(&mut **tx)
        .await?;
        for id in task_ids {
            sqlx::query("UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'running'")
                .bind(now).bind(id).execute(&mut **tx).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn expired_runs_fail_without_automatic_retry() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("test.db")).await.unwrap();
        let owner = store
            .set_owner_name(SetOwnerName {
                name: "Test owner".into(),
            })
            .await
            .unwrap();
        let agent = store
            .create_agent(CreateAgent {
                name: "Fixture".into(),
                owner_id: owner.id,
                harness: crate::harness::Harness::Pi,
            })
            .await
            .unwrap();
        let project = store
            .create_project(CreateProject {
                name: "ZeroLux".into(),
                description: "".into(),
            })
            .await
            .unwrap();
        let task = store
            .create_task(CreateTask {
                project_id: project.id.clone(),
                title: "Test".into(),
                description: "".into(),
                assignee_id: agent.id.clone(),
            })
            .await
            .unwrap();
        store
            .act(
                &task.id,
                TaskAction {
                    action: Action::Queue,
                    note: "".into(),
                },
            )
            .await
            .unwrap();
        let connection = store
            .connect_agent(ConnectAgent {
                actor_id: agent.id.clone(),
                project_id: project.id.clone(),
                mode: "process".into(),
                workspace: dir.path().to_string_lossy().into_owned(),
                session_id: None,
            })
            .await
            .unwrap();
        let claim = store
            .claim(ClaimRequest {
                project_id: project.id.clone(),
                actor_id: agent.id.clone(),
                connection_id: Some(connection.id.clone()),
            })
            .await
            .unwrap()
            .unwrap();
        sqlx::query("UPDATE runs SET lease_expires_at = 0 WHERE id = ?")
            .bind(&claim.run.id)
            .execute(&store.pool)
            .await
            .unwrap();
        assert!(matches!(
            store.heartbeat(&claim.run.id).await,
            Err(Error::Conflict)
        ));
        assert!(matches!(
            store
                .finish(
                    &claim.run.id,
                    FinishRun {
                        stdout: "".into(),
                        stderr: "".into(),
                        exit_code: Some(0),
                        failure_reason: None
                    }
                )
                .await,
            Err(Error::Conflict)
        ));
        store.reap_expired().await.unwrap();
        assert_eq!(store.workspace().await.unwrap().tasks[0].status, "failed");
        assert!(
            store
                .claim(ClaimRequest {
                    project_id: project.id,
                    actor_id: agent.id,
                    connection_id: Some(connection.id),
                })
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(store.runs(&task.id).await.unwrap()[0].status, "failed");
    }
}
