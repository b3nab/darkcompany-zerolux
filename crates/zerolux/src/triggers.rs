//! Input a session receives when something it waits for happens: for now, the end of the CI
//! runs of its current commit, as GitHub's `gh` reports them in the session's folder.

use std::path::Path;

use anyhow::Context;
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};
use serde::{Deserialize, Serialize};

use crate::{
    chat::Access,
    entity::triggers,
    model::ChatIdentity,
    store::{Error, Result, Store, now_ms, text},
};

#[derive(Debug, Clone, Serialize)]
pub struct Trigger {
    pub id: String,
    pub session_id: String,
    pub event: String,
    pub failures_only: bool,
    pub prompt: String,
    pub enabled: bool,
    pub last_run_at: Option<i64>,
    pub last_error: Option<String>,
    pub created_at: i64,
}

impl From<triggers::Model> for Trigger {
    fn from(row: triggers::Model) -> Self {
        Self {
            id: row.id,
            session_id: row.session_id,
            event: row.event,
            failures_only: row.failures_only,
            prompt: row.prompt,
            enabled: row.enabled,
            last_run_at: row.last_run_at,
            last_error: row.last_error,
            created_at: row.created_at,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewTrigger {
    pub event: String,
    #[serde(default = "yes")]
    pub failures_only: bool,
    #[serde(default)]
    pub prompt: String,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriggerChange {
    pub failures_only: Option<bool>,
    pub prompt: Option<String>,
    pub enabled: Option<bool>,
}

fn prompt(value: &str) -> Result<String> {
    text(value, "Prompt", 64 * 1024, false)
}

/// How the CI runs of a commit ended: what a session is told, once they all have.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ended {
    /// The commit and its runs, as they ended: told once.
    pub seen: String,
    pub failed: bool,
    /// What happened, as data.
    pub report: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Run {
    database_id: u64,
    status: String,
    conclusion: String,
    workflow_name: String,
    url: String,
}

/// The CI runs of `sha` on `branch`, as `gh run list` gives them: none while any still runs
/// or when there is none.
pub fn ended(sha: &str, branch: &str, runs: &str) -> Result<Option<Ended>> {
    let runs: Vec<Run> = serde_json::from_str(runs)
        .map_err(|error| Error::Invalid(format!("gh answered with something else: {error}")))?;
    if runs.is_empty() || runs.iter().any(|run| run.status != "completed") {
        return Ok(None);
    }
    let bad = |run: &Run| {
        matches!(
            run.conclusion.as_str(),
            "failure" | "timed_out" | "startup_failure" | "action_required"
        )
    };
    let failed = runs.iter().any(bad);
    let mut ids: Vec<u64> = runs.iter().map(|run| run.database_id).collect();
    ids.sort_unstable();
    let short = &sha[..sha.len().min(10)];
    let mut report = format!(
        "CI {} for commit {short} on {branch}:",
        if failed { "failed" } else { "passed" }
    );
    for run in &runs {
        report.push_str(&format!(
            "\n- {}: {} {}",
            run.workflow_name, run.conclusion, run.url
        ));
    }
    Ok(Some(Ended {
        seen: format!(
            "{sha}:{}",
            ids.iter().map(u64::to_string).collect::<Vec<_>>().join(",")
        ),
        failed,
        report,
    }))
}

/// How the CI runs of the folder's current commit ended, if they all have.
pub async fn ci(folder: &Path) -> anyhow::Result<Option<Ended>> {
    let sha = crate::workspace_git::head(folder).await?;
    let branch = crate::workspace_git::branch(folder).await?;
    let output = crate::workspace_git::gh(
        folder,
        &[
            "run",
            "list",
            "--commit",
            &sha,
            "--limit",
            "50",
            "--json",
            "databaseId,status,conclusion,workflowName,url",
        ],
    )
    .await?;
    if !output.status.success() {
        anyhow::bail!(
            "{}",
            String::from_utf8_lossy(&output.stderr).trim().to_owned()
        );
    }
    let runs = String::from_utf8(output.stdout).context("gh answered with something else")?;
    Ok(ended(&sha, &branch, &runs)?)
}

impl Store {
    async fn trigger_writer(&self, who: &ChatIdentity, id: &str) -> Result<()> {
        match self.session_access(who, id).await? {
            Some(access) if who.is_person() && access >= Access::Write => Ok(()),
            _ => Err(Error::Forbidden),
        }
    }

    async fn trigger_row(&self, who: &ChatIdentity, id: &str) -> Result<triggers::Model> {
        let row = triggers::Entity::find_by_id(self.key(id))
            .one(self.db())
            .await?
            .ok_or(Error::NotFound)?;
        self.trigger_writer(who, &row.session_id).await?;
        Ok(row)
    }

    /// The triggers of a session.
    pub async fn triggers(&self, who: &ChatIdentity, session: &str) -> Result<Vec<Trigger>> {
        if !who.is_person() {
            return Err(Error::Forbidden);
        }
        self.chat_session(who, session).await?;
        Ok(triggers::Entity::find()
            .filter(triggers::Column::WorkspaceId.eq(&self.workspace))
            .filter(triggers::Column::SessionId.eq(session))
            .order_by_asc(triggers::Column::CreatedAt)
            .all(self.db())
            .await?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    pub async fn create_trigger(
        &self,
        who: &ChatIdentity,
        session: &str,
        input: NewTrigger,
    ) -> Result<Trigger> {
        self.trigger_writer(who, session).await?;
        if input.event != "ci" {
            return Err(Error::Invalid("A session waits for its CI: `ci`".into()));
        }
        Ok(triggers::ActiveModel {
            workspace_id: Set(self.workspace.clone()),
            id: Set(uuid::Uuid::new_v4().to_string()),
            session_id: Set(session.to_owned()),
            event: Set(input.event),
            failures_only: Set(input.failures_only),
            prompt: Set(prompt(&input.prompt)?),
            enabled: Set(true),
            last_seen: Set(None),
            last_run_at: Set(None),
            last_error: Set(None),
            created_at: Set(now_ms()),
        }
        .insert(self.db())
        .await?
        .into())
    }

    pub async fn change_trigger(
        &self,
        who: &ChatIdentity,
        id: &str,
        input: TriggerChange,
    ) -> Result<Trigger> {
        let row = self.trigger_row(who, id).await?;
        if input.failures_only.is_none() && input.prompt.is_none() && input.enabled.is_none() {
            return Err(Error::Invalid("Nothing to change".into()));
        }
        let mut change = triggers::ActiveModel {
            workspace_id: Set(row.workspace_id),
            id: Set(row.id),
            ..Default::default()
        };
        if let Some(failures_only) = input.failures_only {
            change.failures_only = Set(failures_only);
        }
        if let Some(text) = &input.prompt {
            change.prompt = Set(prompt(text)?);
        }
        if let Some(enabled) = input.enabled {
            change.enabled = Set(enabled);
        }
        Ok(change.update(self.db()).await?.into())
    }

    pub async fn delete_trigger(&self, who: &ChatIdentity, id: &str) -> Result<()> {
        self.trigger_row(who, id).await?;
        triggers::Entity::delete_by_id(self.key(id))
            .exec(self.db())
            .await?;
        Ok(())
    }

    /// The triggers that wait.
    pub(crate) async fn enabled_triggers(&self) -> Result<Vec<triggers::Model>> {
        Ok(triggers::Entity::find()
            .filter(triggers::Column::WorkspaceId.eq(&self.workspace))
            .filter(triggers::Column::Enabled.eq(true))
            .all(self.db())
            .await?)
    }

    /// What a trigger last saw and told, or why it could not.
    pub(crate) async fn trigger_saw(
        &self,
        id: &str,
        seen: Option<String>,
        told_at: Option<i64>,
        error: Option<String>,
    ) -> Result<()> {
        let mut change = triggers::ActiveModel {
            workspace_id: Set(self.workspace.clone()),
            id: Set(id.to_owned()),
            last_error: Set(error),
            ..Default::default()
        };
        if let Some(seen) = seen {
            change.last_seen = Set(Some(seen));
        }
        if let Some(at) = told_at {
            change.last_run_at = Set(Some(at));
        }
        change.update(self.db()).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_end_together_and_say_what_failed() {
        let running = r#"[{"databaseId":2,"status":"in_progress","conclusion":"","workflowName":"Test","url":"https://ci/2"},
            {"databaseId":1,"status":"completed","conclusion":"success","workflowName":"Build","url":"https://ci/1"}]"#;
        assert_eq!(ended("abcdef1234567", "main", running).unwrap(), None);
        assert_eq!(ended("abcdef1234567", "main", "[]").unwrap(), None);
        let done = r#"[{"databaseId":2,"status":"completed","conclusion":"failure","workflowName":"Test","url":"https://ci/2"},
            {"databaseId":1,"status":"completed","conclusion":"success","workflowName":"Build","url":"https://ci/1"}]"#;
        let ended = ended("abcdef1234567", "main", done).unwrap().unwrap();
        assert!(ended.failed);
        assert_eq!(ended.seen, "abcdef1234567:1,2");
        assert_eq!(
            ended.report,
            "CI failed for commit abcdef1234 on main:\n- Test: failure https://ci/2\n- Build: success https://ci/1"
        );
        assert!(super::ended("a", "main", "not json").is_err());
    }
}
