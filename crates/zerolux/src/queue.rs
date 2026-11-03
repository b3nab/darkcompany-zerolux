//! A session's queue: the inputs its people write while it works, kept by ZeroLux rather than
//! by the harness. Each waits for the turn in progress to end, then starts a turn of its own,
//! one at a time, in order. Until then it is changed, taken back, put in another place or sent
//! at once. Stopping the session sends the whole queue at once, as its next turn.

use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set, sea_query::Expr,
};
use serde::Serialize;
use serde_json::json;

use crate::{
    chat::Access,
    entity::queued_inputs,
    model::{ChatIdentity, InputImage},
    store::{Error, Result, Store, now_ms},
};

/// An input waiting in a session's queue, as its people see it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Queued {
    pub id: String,
    pub text: String,
    /// The images that go with it, by their type.
    pub images: Vec<QueuedImage>,
    pub author_id: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QueuedImage {
    pub media_type: String,
}

/// What the queue gives the harness when an input's turn comes.
#[derive(Debug, Clone)]
pub struct Due {
    pub id: String,
    pub text: String,
    pub images: Vec<InputImage>,
    /// Who wrote it, as whom it is sent.
    pub author: ChatIdentity,
}

impl Due {
    /// Several inputs as one, in their order: their words apart, their images together.
    pub fn joined(inputs: Vec<Due>) -> Option<Due> {
        let first = inputs.first()?.clone();
        Some(Due {
            text: inputs
                .iter()
                .map(|input| input.text.trim())
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n"),
            images: inputs.into_iter().flat_map(|input| input.images).collect(),
            ..first
        })
    }
}

fn shown(row: queued_inputs::Model) -> Queued {
    let images: Vec<InputImage> = serde_json::from_str(&row.images_json).unwrap_or_default();
    Queued {
        id: row.id,
        text: row.text,
        images: images
            .into_iter()
            .map(|image| QueuedImage {
                media_type: image.media_type,
            })
            .collect(),
        author_id: row.author_id,
        created_at: row.created_at,
    }
}

fn due(row: queued_inputs::Model) -> Due {
    Due {
        images: serde_json::from_str(&row.images_json).unwrap_or_default(),
        author: ChatIdentity::person(&row.author_id),
        id: row.id,
        text: row.text,
    }
}

impl Store {
    fn queued_rows(&self, session: &str) -> sea_orm::Select<queued_inputs::Entity> {
        queued_inputs::Entity::find()
            .filter(queued_inputs::Column::WorkspaceId.eq(&self.workspace))
            .filter(queued_inputs::Column::SessionId.eq(session))
            .order_by_asc(queued_inputs::Column::Position)
            .order_by_asc(queued_inputs::Column::CreatedAt)
    }

    async fn queue_changed<C: sea_orm::ConnectionTrait>(
        &self,
        db: &C,
        session: &str,
    ) -> Result<()> {
        self.personal_event(
            db,
            "session.queue",
            session,
            json!({ "session_id": session }),
        )
        .await
    }

    async fn queued_in<C: sea_orm::ConnectionTrait>(
        &self,
        db: &C,
        session: &str,
        item: &str,
    ) -> Result<queued_inputs::Model> {
        queued_inputs::Entity::find_by_id((self.workspace.clone(), item.to_owned()))
            .one(db)
            .await?
            .filter(|row| row.session_id == session)
            .ok_or(Error::NotFound)
    }

    /// The session's queue, first first, for whoever may read the session.
    pub async fn queue(&self, who: &ChatIdentity, session: &str) -> Result<Vec<Queued>> {
        self.chat_session(who, session).await?;
        Ok(self
            .queued_rows(session)
            .all(&self.db)
            .await?
            .into_iter()
            .map(shown)
            .collect())
    }

    /// Whether anything waits in the session's queue.
    pub(crate) async fn has_queue(&self, session: &str) -> Result<bool> {
        Ok(self.queued_rows(session).one(&self.db).await?.is_some())
    }

    /// Whether `item` waits in the session's queue: one of ZeroLux's, rather than the harness's.
    pub(crate) async fn is_queued(&self, session: &str, item: &str) -> Result<bool> {
        Ok(self.queued_in(&self.db, session, item).await.is_ok())
    }

    /// Puts an input at the end of the session's queue.
    pub(crate) async fn enqueue(
        &self,
        who: &ChatIdentity,
        session: &str,
        text: &str,
        images: &[InputImage],
    ) -> Result<Queued> {
        let author = who.actor_id.clone().ok_or(Error::Forbidden)?;
        let tx = self.write().await?;
        self.session_access_in(&tx, who, session, Access::Write)
            .await?;
        let last = self
            .queued_rows(session)
            .all(&tx)
            .await?
            .last()
            .map_or(0, |row| row.position);
        let row = queued_inputs::ActiveModel {
            workspace_id: Set(self.workspace.clone()),
            id: Set(uuid::Uuid::new_v4().to_string()),
            session_id: Set(session.to_owned()),
            position: Set(last + 1),
            text: Set(text.to_owned()),
            images_json: Set(
                serde_json::to_string(images).map_err(|error| Error::Invalid(error.to_string()))?
            ),
            author_id: Set(author),
            created_at: Set(now_ms()),
        }
        .insert(&tx)
        .await?;
        self.queue_changed(&tx, session).await?;
        tx.commit().await?;
        Ok(shown(row))
    }

    /// Rewrites a waiting input.
    pub async fn edit_queued(
        &self,
        who: &ChatIdentity,
        session: &str,
        item: &str,
        text: &str,
    ) -> Result<()> {
        let tx = self.write().await?;
        self.session_access_in(&tx, who, session, Access::Write)
            .await?;
        let row = self.queued_in(&tx, session, item).await?;
        if text.trim().is_empty() && row.images_json == "[]" {
            return Err(Error::Invalid("Write something, or remove it".into()));
        }
        let mut row: queued_inputs::ActiveModel = row.into();
        row.text = Set(text.to_owned());
        row.update(&tx).await?;
        self.queue_changed(&tx, session).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Takes a waiting input out of the queue: the input itself, to be sent at once or dropped.
    pub(crate) async fn take_queued(
        &self,
        who: &ChatIdentity,
        session: &str,
        item: &str,
    ) -> Result<Due> {
        let tx = self.write().await?;
        self.session_access_in(&tx, who, session, Access::Write)
            .await?;
        let row = self.queued_in(&tx, session, item).await?;
        queued_inputs::Entity::delete_by_id((self.workspace.clone(), row.id.clone()))
            .exec(&tx)
            .await?;
        self.queue_changed(&tx, session).await?;
        tx.commit().await?;
        Ok(due(row))
    }

    /// The queue in the order given: every waiting input, each once.
    pub async fn reorder_queue(
        &self,
        who: &ChatIdentity,
        session: &str,
        ids: &[String],
    ) -> Result<()> {
        let tx = self.write().await?;
        self.session_access_in(&tx, who, session, Access::Write)
            .await?;
        let rows = self.queued_rows(session).all(&tx).await?;
        let mut known: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
        let mut asked: Vec<&str> = ids.iter().map(String::as_str).collect();
        known.sort_unstable();
        asked.sort_unstable();
        if known != asked {
            return Err(Error::Conflict);
        }
        for (position, id) in ids.iter().enumerate() {
            queued_inputs::Entity::update_many()
                .col_expr(
                    queued_inputs::Column::Position,
                    Expr::value(position as i64 + 1),
                )
                .filter(queued_inputs::Column::WorkspaceId.eq(&self.workspace))
                .filter(queued_inputs::Column::Id.eq(id))
                .exec(&tx)
                .await?;
        }
        self.queue_changed(&tx, session).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Takes everything out of the session's queue, for whoever may work in it.
    pub async fn clear_queue(&self, who: &ChatIdentity, session: &str) -> Result<()> {
        let tx = self.write().await?;
        self.session_access_in(&tx, who, session, Access::Write)
            .await?;
        queued_inputs::Entity::delete_many()
            .filter(queued_inputs::Column::WorkspaceId.eq(&self.workspace))
            .filter(queued_inputs::Column::SessionId.eq(session))
            .exec(&tx)
            .await?;
        self.queue_changed(&tx, session).await?;
        tx.commit().await?;
        Ok(())
    }

    /// The sessions with anything in their queue.
    pub(crate) async fn sessions_with_queue(&self) -> Result<Vec<String>> {
        let mut sessions: Vec<String> = queued_inputs::Entity::find()
            .filter(queued_inputs::Column::WorkspaceId.eq(&self.workspace))
            .all(&self.db)
            .await?
            .into_iter()
            .map(|row| row.session_id)
            .collect();
        sessions.sort();
        sessions.dedup();
        Ok(sessions)
    }

    /// Takes out of the session's queue its first input, or all of them.
    pub(crate) async fn take_queue(&self, session: &str, all: bool) -> Result<Vec<Due>> {
        let tx = self.write().await?;
        let rows = self.queued_rows(session).all(&tx).await?;
        let taken: Vec<_> = rows
            .into_iter()
            .take(if all { usize::MAX } else { 1 })
            .collect();
        if taken.is_empty() {
            return Ok(Vec::new());
        }
        for row in &taken {
            queued_inputs::Entity::delete_by_id((self.workspace.clone(), row.id.clone()))
                .exec(&tx)
                .await?;
        }
        self.queue_changed(&tx, session).await?;
        tx.commit().await?;
        Ok(taken.into_iter().map(due).collect())
    }

    /// Puts inputs that could not be sent back at the head of the queue, in their order.
    pub(crate) async fn put_back(&self, session: &str, inputs: &[Due]) -> Result<()> {
        let tx = self.write().await?;
        let first = self
            .queued_rows(session)
            .one(&tx)
            .await?
            .map_or(1, |row| row.position);
        let count = inputs.len() as i64;
        for (at, input) in inputs.iter().enumerate() {
            queued_inputs::ActiveModel {
                workspace_id: Set(self.workspace.clone()),
                id: Set(input.id.clone()),
                session_id: Set(session.to_owned()),
                position: Set(first - count + at as i64),
                text: Set(input.text.clone()),
                images_json: Set(serde_json::to_string(&input.images)
                    .map_err(|error| Error::Invalid(error.to_string()))?),
                author_id: Set(input.author.actor_id.clone().ok_or(Error::Forbidden)?),
                created_at: Set(now_ms()),
            }
            .insert(&tx)
            .await?;
        }
        self.queue_changed(&tx, session).await?;
        tx.commit().await?;
        Ok(())
    }
}
