//! Input the owner has a session receive on a schedule: a cron pattern in the kernel host's
//! time and the words to send, queued after the session's turn when it is working.

use std::str::FromStr;

use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set, sea_query::Expr,
};
use serde::{Deserialize, Serialize};

use crate::{
    chat::Access,
    entity::schedules,
    model::ChatIdentity,
    store::{Error, Result, Store, now_ms, text},
};

#[derive(Debug, Clone, Serialize)]
pub struct Schedule {
    pub id: String,
    pub session_id: String,
    pub cron: String,
    pub prompt: String,
    pub enabled: bool,
    pub next_run_at: Option<i64>,
    pub last_run_at: Option<i64>,
    pub last_error: Option<String>,
    pub created_at: i64,
}

impl From<schedules::Model> for Schedule {
    fn from(row: schedules::Model) -> Self {
        Self {
            id: row.id,
            session_id: row.session_id,
            cron: row.cron,
            prompt: row.prompt,
            enabled: row.enabled,
            next_run_at: row.next_run_at,
            last_run_at: row.last_run_at,
            last_error: row.last_error,
            created_at: row.created_at,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewSchedule {
    pub cron: String,
    pub prompt: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScheduleChange {
    pub cron: Option<String>,
    pub prompt: Option<String>,
    pub enabled: Option<bool>,
}

/// The next time a cron pattern names after `after`, in ms, in the kernel host's time.
pub fn next_run(cron: &str, after: i64) -> Result<i64> {
    let pattern = croner::Cron::from_str(cron.trim())
        .map_err(|error| Error::Invalid(format!("Not a cron pattern: {error}")))?;
    let after = chrono::DateTime::from_timestamp_millis(after)
        .ok_or_else(|| Error::Invalid("Invalid time".into()))?
        .with_timezone(&chrono::Local);
    let next = pattern
        .find_next_occurrence(&after, false)
        .map_err(|error| Error::Invalid(format!("The cron pattern never comes: {error}")))?;
    Ok(next.timestamp_millis())
}

fn prompt(value: &str) -> Result<String> {
    text(value, "Prompt", 64 * 1024, true)
}

impl Store {
    /// A person who may write to the session.
    async fn writer(&self, who: &ChatIdentity, id: &str) -> Result<()> {
        match self.session_access(who, id).await? {
            Some(access) if who.is_person() && access >= Access::Write => Ok(()),
            _ => Err(Error::Forbidden),
        }
    }

    async fn schedule_row(&self, who: &ChatIdentity, id: &str) -> Result<schedules::Model> {
        let row = schedules::Entity::find_by_id(id)
            .one(self.db())
            .await?
            .ok_or(Error::NotFound)?;
        self.writer(who, &row.session_id).await?;
        Ok(row)
    }

    /// The schedules of a session, or of every session one may read.
    pub async fn schedules(
        &self,
        who: &ChatIdentity,
        session: Option<&str>,
    ) -> Result<Vec<Schedule>> {
        if !who.is_person() {
            return Err(Error::Forbidden);
        }
        let readable = match session {
            Some(session) => {
                self.chat_session(who, session).await?;
                vec![session.to_owned()]
            }
            None => self
                .sessions(who)
                .await?
                .into_iter()
                .map(|s| s.id)
                .collect(),
        };
        Ok(schedules::Entity::find()
            .filter(schedules::Column::SessionId.is_in(readable))
            .order_by_asc(schedules::Column::CreatedAt)
            .all(self.db())
            .await?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    pub async fn create_schedule(
        &self,
        who: &ChatIdentity,
        session: &str,
        input: NewSchedule,
    ) -> Result<Schedule> {
        self.writer(who, session).await?;
        let prompt = prompt(&input.prompt)?;
        let now = now_ms();
        let next = next_run(&input.cron, now)?;
        Ok(schedules::ActiveModel {
            id: Set(uuid::Uuid::new_v4().to_string()),
            session_id: Set(session.to_owned()),
            cron: Set(input.cron.trim().to_owned()),
            prompt: Set(prompt),
            enabled: Set(true),
            next_run_at: Set(Some(next)),
            last_run_at: Set(None),
            last_error: Set(None),
            created_at: Set(now),
        }
        .insert(self.db())
        .await?
        .into())
    }

    pub async fn change_schedule(
        &self,
        who: &ChatIdentity,
        id: &str,
        input: ScheduleChange,
    ) -> Result<Schedule> {
        let row = self.schedule_row(who, id).await?;
        let cron = input
            .cron
            .as_deref()
            .map(str::trim)
            .unwrap_or(&row.cron)
            .to_owned();
        let enabled = input.enabled.unwrap_or(row.enabled);
        let next = if enabled {
            Some(next_run(&cron, now_ms())?)
        } else {
            None
        };
        let mut change = schedules::ActiveModel {
            id: Set(row.id.clone()),
            cron: Set(cron),
            enabled: Set(enabled),
            next_run_at: Set(next),
            ..Default::default()
        };
        if let Some(text) = &input.prompt {
            change.prompt = Set(prompt(text)?);
        }
        Ok(change.update(self.db()).await?.into())
    }

    pub async fn delete_schedule(&self, who: &ChatIdentity, id: &str) -> Result<()> {
        self.schedule_row(who, id).await?;
        let deleted = schedules::Entity::delete_by_id(id)
            .exec(self.db())
            .await?
            .rows_affected;
        if deleted == 0 {
            return Err(Error::NotFound);
        }
        Ok(())
    }

    /// Schedules whose time has come.
    pub(crate) async fn due_schedules(&self, now: i64) -> Result<Vec<Schedule>> {
        Ok(schedules::Entity::find()
            .filter(schedules::Column::Enabled.eq(true))
            .filter(schedules::Column::NextRunAt.lte(now))
            .all(self.db())
            .await?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    /// A run done, or failed, and the next one.
    pub(crate) async fn schedule_ran(
        &self,
        id: &str,
        at: i64,
        error: Option<String>,
    ) -> Result<()> {
        let Some(row) = schedules::Entity::find_by_id(id).one(self.db()).await? else {
            return Ok(());
        };
        let next = next_run(&row.cron, at).ok();
        schedules::Entity::update_many()
            .col_expr(schedules::Column::LastRunAt, Expr::value(Some(at)))
            .col_expr(schedules::Column::LastError, Expr::value(error))
            .col_expr(schedules::Column::NextRunAt, Expr::value(next))
            .filter(schedules::Column::Id.eq(id))
            .exec(self.db())
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_next_run_follows_the_pattern_and_bad_patterns_are_refused() {
        let start = 1_792_000_000_000;
        let next = next_run("*/15 * * * *", start).unwrap();
        assert!(next > start && next - start <= 15 * 60 * 1000);
        assert_eq!(
            chrono::DateTime::from_timestamp_millis(next)
                .unwrap()
                .timestamp()
                % 60,
            0
        );
        assert!(next_run("not a pattern", start).is_err());
        assert!(next_run("* * * * * * * *", start).is_err());
    }
}
