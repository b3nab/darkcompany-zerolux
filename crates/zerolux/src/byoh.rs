//! Agents the owner hires by name, before any native session is attached to them.
use uuid::Uuid;

use crate::{
    model::*,
    store::{Error, Result, Store, fetch_one, now_ms, sql, text},
};

impl Store {
    pub async fn create_agent(&self, input: CreateAgent) -> Result<Actor> {
        self.require_onboarding().await?;
        let name = text(&input.name, "Agent name", 200, true)?;
        // The owner's existence is checked by the insert itself.
        let tx = self.write().await?;
        let agent = fetch_one(
            &tx,
            sql(
                &tx,
                "INSERT INTO actors (id, name, kind, owner_id, harness, created_at)
                SELECT $1, $2, 'agent', id, $3, $4 FROM actors WHERE id = $5 AND kind = 'human' AND archived = FALSE RETURNING *",
                [
                    Uuid::new_v4().to_string().into(),
                    name.into(),
                    input.harness.id().into(),
                    now_ms().into(),
                    input.owner_id.into(),
                ],
            ),
        )
        .await?
        .ok_or_else(|| Error::Invalid("An agent must belong to an existing human".into()))?;
        tx.commit().await?;
        Ok(agent)
    }
}
