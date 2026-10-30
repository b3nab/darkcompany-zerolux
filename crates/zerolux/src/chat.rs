//! Durable chat state. Native harness and LiveKit effects happen outside these transactions.
//!
//! Plain reads and writes go through the entities. Where a check and a change must be one
//! statement (claims, state transitions, moves between sessions), the SQL is explicit: both
//! databases run it as written.

use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, FromQueryResult,
    QueryFilter, QueryOrder, QuerySelect, Set,
    sea_query::{Expr, OnConflict},
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    entity::{
        actors, chat_outbox, conversation_members, conversations, deliveries, messages,
        read_positions, sessions, tool_approvals, workspace,
    },
    harness::Harness,
    model::*,
    store::{
        Error, Result, Store, execute, fetch_all, fetch_one, now_ms, random_token, scalar, sql,
        text, token_hash,
    },
};

fn decode<T: DeserializeOwned>(value: &str) -> Result<T> {
    serde_json::from_str(value).map_err(|e| Error::Database(DbErr::Json(e.to_string())))
}

fn uuid(value: &str) -> Result<()> {
    Uuid::parse_str(value).map_err(|_| Error::Invalid("Expected a UUID".into()))?;
    Ok(())
}

fn reason(value: Option<String>) -> Result<Option<String>> {
    value.map(|v| text(&v, "Reason", 2_000, true)).transpose()
}

/// A session with the number of messages that are stored for it and not yet attempted.
/// Stop notes the runtime sets on its own account; an owner's Stop replaces them.
pub const LINK_FAILED: &str =
    "The link could not be confirmed. Check the harness before pairing again.";

const SESSIONS: &str = "SELECT s.*,(SELECT count(*) FROM deliveries d
    WHERE d.workspace_id=s.workspace_id AND d.session_id=s.id AND d.status='stored') AS waiting
    FROM sessions s";

/// What one may do with a session, from reading it to deciding everything about it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Access {
    /// Its record, output, code and requests.
    Read,
    /// Also its input and turn, settings, terminals, code actions, schedules, stop and resume.
    Write,
    /// Also its title, organization, budget, sharing, requests and forks: its person's.
    Own,
}

#[derive(FromQueryResult)]
struct ConversationRow {
    kind: String,
    title: String,
    paused: bool,
    last_seq: i64,
    parent_id: Option<String>,
    root_message_id: Option<String>,
    closed_at: Option<i64>,
}

#[derive(FromQueryResult)]
struct Id {
    id: String,
}

async fn ids<C: ConnectionTrait>(db: &C, statement: sea_orm::Statement) -> Result<Vec<String>> {
    Ok(fetch_all::<Id, _>(db, statement)
        .await?
        .into_iter()
        .map(|row| row.id)
        .collect())
}

fn owns_delivery(who: &ChatIdentity, delivery: &ChatDelivery) -> Result<()> {
    if who.session_id.as_deref() == Some(&delivery.session_id)
        && who.actor_id.as_deref() == Some(delivery.actor_id.as_str())
    {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

#[derive(FromQueryResult)]
struct ApprovalRow {
    id: String,
    actor_id: Option<String>,
    session_id: String,
    conversation_id: Option<String>,
    delivery_id: Option<String>,
    native_request_id: String,
    kind: String,
    summary: String,
    details_json: String,
    status: String,
    decision: Option<String>,
    scope: Option<String>,
    reason: Option<String>,
    answer_json: Option<String>,
    last_error: Option<String>,
    created_at: i64,
}

fn owns_approval(who: &ChatIdentity, approval: &ChatApproval) -> Result<()> {
    if who.session_id.as_deref() == Some(&approval.session_id) && who.actor_id == approval.actor_id
    {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

/// What the chat's statements share: each reads and writes only this workspace's rows.
impl Store {
    async fn identity_in<C: ConnectionTrait>(&self, db: &C, who: &ChatIdentity) -> Result<()> {
        let valid: bool = if let Some(session) = &who.session_id {
            scalar(
                db,
                sql(
                    db,
                    "SELECT EXISTS(SELECT 1 FROM sessions s
                    LEFT JOIN actors a ON a.workspace_id=s.workspace_id AND a.id=s.actor_id
                    WHERE s.workspace_id=$1 AND s.id=$2 AND COALESCE(s.actor_id,'')=COALESCE($3,'')
                    AND s.stopped_at IS NULL AND COALESCE(a.archived,FALSE)=FALSE)",
                    [
                        (&self.workspace).into(),
                        session.into(),
                        who.actor_id.clone().into(),
                    ],
                ),
            )
            .await?
        } else {
            actors::Entity::find_by_id(self.key(who.actor()?))
                .filter(actors::Column::Kind.eq("human"))
                .filter(actors::Column::Archived.eq(false))
                .one(db)
                .await?
                .is_some()
        };
        if valid {
            Ok(())
        } else {
            Err(Error::Unauthorized)
        }
    }

    /// The existing agent the owner hires for `harness`, or `None` for a new one named `name`
    /// (validated here) or, without a name, for a session without an agent. An agent of another
    /// harness or owner is forbidden.
    async fn hireable_in<C: ConnectionTrait>(
        &self,
        db: &C,
        who: &ChatIdentity,
        harness: Harness,
        actor_id: Option<&str>,
        name: &str,
    ) -> Result<Option<Actor>> {
        match actor_id {
            Some(id) => actors::Entity::find_by_id(self.key(id))
                .filter(actors::Column::OwnerId.eq(who.actor()?))
                .filter(actors::Column::Kind.eq("agent"))
                .filter(actors::Column::Archived.eq(false))
                .filter(actors::Column::Harness.eq(harness.id()))
                .one(db)
                .await?
                .ok_or(Error::Forbidden)
                .map(Some),
            None if name.trim().is_empty() => Ok(None),
            None => text(name, "Agent name", 200, true).map(|_| None),
        }
    }

    async fn person_in<C: ConnectionTrait>(&self, db: &C, who: &ChatIdentity) -> Result<()> {
        self.identity_in(db, who).await?;
        if who.is_person() {
            Ok(())
        } else {
            Err(Error::Forbidden)
        }
    }

    /// Reading: a member, or a member of a thread's parent (its audience).
    async fn access_in<C: ConnectionTrait>(
        &self,
        db: &C,
        who: &ChatIdentity,
        conversation: &str,
    ) -> Result<()> {
        self.identity_in(db, who).await?;
        let allowed: bool = scalar(
            db,
            sql(
                db,
                "SELECT EXISTS(SELECT 1 FROM conversation_members m WHERE m.workspace_id=$1
                AND m.conversation_id IN ($2,
                    (SELECT parent_id FROM conversations WHERE workspace_id=$1 AND id=$2))
                AND m.actor_id=$3 AND ($4 IS NULL OR m.session_id=$4))",
                [
                    (&self.workspace).into(),
                    conversation.into(),
                    who.actor_id.clone().into(),
                    who.session_id.clone().into(),
                ],
            ),
        )
        .await?;
        if allowed {
            Ok(())
        } else {
            Err(Error::Forbidden)
        }
    }

    async fn session_in<C: ConnectionTrait>(&self, db: &C, id: &str) -> Result<ChatSession> {
        fetch_one(
            db,
            sql(
                db,
                format!("{SESSIONS} WHERE s.workspace_id=$1 AND s.id=$2"),
                [(&self.workspace).into(), id.into()],
            ),
        )
        .await?
        .ok_or(Error::NotFound)
    }

    /// The row behind a session, for what the API never shows (locator, token hash).
    async fn session_row_in<C: ConnectionTrait>(
        &self,
        db: &C,
        id: &str,
    ) -> Result<sessions::Model> {
        sessions::Entity::find_by_id(self.key(id))
            .one(db)
            .await?
            .ok_or(Error::NotFound)
    }

    /// A person has their own sessions and those shared with the workspace; a session reads
    /// itself and steers the sessions it delegates work to.
    async fn access_of<C: ConnectionTrait>(
        &self,
        db: &C,
        who: &ChatIdentity,
        id: &str,
    ) -> Result<Option<Access>> {
        self.identity_in(db, who).await?;
        let session = self.session_row_in(db, id).await?;
        Ok(match &who.session_id {
            Some(me) if me == id => Some(Access::Read),
            Some(me) if session.parent_session_id.as_ref() == Some(me) => Some(Access::Write),
            Some(_) => None,
            None if who.actor_id.as_ref() == Some(&session.owner_id) => Some(Access::Own),
            None => match session.shared.as_deref() {
                Some("write") => Some(Access::Write),
                Some("read") => Some(Access::Read),
                _ => None,
            },
        })
    }

    async fn session_access_in<C: ConnectionTrait>(
        &self,
        db: &C,
        who: &ChatIdentity,
        id: &str,
        need: Access,
    ) -> Result<()> {
        match self.access_of(db, who, id).await? {
            Some(access) if access >= need => Ok(()),
            _ => Err(Error::Forbidden),
        }
    }

    /// The session itself, as its integration reports on it, or its person.
    async fn reporter_in<C: ConnectionTrait>(
        &self,
        db: &C,
        who: &ChatIdentity,
        id: &str,
    ) -> Result<()> {
        self.identity_in(db, who).await?;
        if who.session_id.as_deref() == Some(id) {
            Ok(())
        } else {
            self.session_access_in(db, who, id, Access::Own).await
        }
    }

    /// The person whose session it is.
    async fn own_in<C: ConnectionTrait>(&self, db: &C, who: &ChatIdentity, id: &str) -> Result<()> {
        self.person_in(db, who).await?;
        self.session_access_in(db, who, id, Access::Own).await
    }

    async fn members_in<C: ConnectionTrait>(
        &self,
        db: &C,
        id: &str,
    ) -> Result<Vec<ConversationMember>> {
        fetch_all(
            db,
            sql(
                db,
                "SELECT m.actor_id,a.name,a.kind,m.session_id FROM conversation_members m
                JOIN actors a ON a.workspace_id=m.workspace_id AND a.id=m.actor_id
                WHERE m.workspace_id=$1 AND m.conversation_id=$2 ORDER BY m.actor_id",
                [(&self.workspace).into(), id.into()],
            ),
        )
        .await
    }

    async fn conversation_in<C: ConnectionTrait>(&self, db: &C, id: &str) -> Result<Conversation> {
        // A thread rests with its chat: it has no pause of its own and reports the parent's.
        let row: ConversationRow = fetch_one(
            db,
            sql(
                db,
                                "SELECT c.kind,c.title,(c.paused OR COALESCE(p.paused,FALSE)) AS paused,c.next_seq-1 AS last_seq,
                c.parent_id,c.root_message_id,c.closed_at FROM conversations c
                LEFT JOIN conversations p ON p.workspace_id=c.workspace_id AND p.id=c.parent_id
                WHERE c.workspace_id=$1 AND c.id=$2",
                [(&self.workspace).into(), id.into()],
            ),
        )
        .await?
        .ok_or(Error::NotFound)?;
        let last_message = fetch_one(
            db,
            sql(
                db,
                "SELECT author_id,text,created_at FROM messages
                WHERE workspace_id=$1 AND conversation_id=$2 AND seq=$3",
                [(&self.workspace).into(), id.into(), row.last_seq.into()],
            ),
        )
        .await?;
        Ok(Conversation {
            id: id.into(),
            kind: row.kind,
            title: row.title,
            paused: row.paused,
            last_seq: row.last_seq,
            members: self.members_in(db, id).await?,
            parent_id: row.parent_id,
            root_message_id: row.root_message_id,
            closed_at: row.closed_at,
            last_message,
        })
    }

    /// Who may read a conversation: its members, or, for a thread, the members of its parent.
    async fn audience_in<C: ConnectionTrait>(
        &self,
        db: &C,
        id: &str,
    ) -> Result<Vec<ConversationMember>> {
        let parent = conversations::Entity::find_by_id(self.key(id))
            .one(db)
            .await?
            .and_then(|c| c.parent_id);
        self.members_in(db, parent.as_deref().unwrap_or(id)).await
    }

    async fn conversations_in<C: ConnectionTrait>(
        &self,
        db: &C,
        who: &ChatIdentity,
    ) -> Result<Vec<Conversation>> {
        // What one is a member of, plus the threads of every chat one is in: their audience is
        // the chat's, so the owner reads them and an agent sees which are open before opening one.
        let ids = ids(
            db,
            sql(
                db,
                "SELECT c.id FROM conversations c JOIN conversation_members m
                ON m.workspace_id=c.workspace_id AND m.conversation_id IN (c.id, c.parent_id)
                WHERE c.workspace_id=$1 AND m.actor_id=$2 AND ($3 IS NULL OR m.session_id=$3)
                GROUP BY c.id, c.created_at ORDER BY c.created_at,c.id",
                [
                    (&self.workspace).into(),
                    who.actor_id.clone().into(),
                    who.session_id.clone().into(),
                ],
            ),
        )
        .await?;
        let mut result = Vec::with_capacity(ids.len());
        for id in ids {
            result.push(self.conversation_in(db, &id).await?);
        }
        Ok(result)
    }

    async fn event_in<C: ConnectionTrait>(
        &self,
        db: &C,
        kind: &str,
        mut payload: Value,
        mut actors: Vec<String>,
    ) -> Result<()> {
        actors.sort();
        actors.dedup();
        let id = Uuid::new_v4().to_string();
        payload["event_id"] = json!(id);
        payload["type"] = json!(kind);
        chat_outbox::ActiveModel {
            workspace_id: Set(self.workspace.clone()),
            event_id: Set(id),
            payload_json: Set(payload.to_string()),
            recipient_actor_ids_json: Set(json!(actors).to_string()),
            created_at: Set(now_ms()),
            published_at: Set(None),
        }
        .insert(db)
        .await?;
        Ok(())
    }

    async fn conversation_event<C: ConnectionTrait>(
        &self,
        db: &C,
        kind: &str,
        id: &str,
        mut payload: Value,
    ) -> Result<()> {
        payload["conversation_id"] = json!(id);
        // Whoever may read the conversation learns of it: for a thread, the parent's members.
        let actors = self
            .audience_in(db, id)
            .await?
            .into_iter()
            .map(|m| m.actor_id)
            .collect();
        self.event_in(db, kind, payload, actors).await
    }

    async fn personal_event<C: ConnectionTrait>(
        &self,
        db: &C,
        kind: &str,
        session_id: &str,
        payload: Value,
    ) -> Result<()> {
        #[derive(FromQueryResult)]
        struct Recipient {
            actor_id: Option<String>,
        }
        let actors = fetch_all::<Recipient, _>(
            db,
            sql(
                db,
                                "SELECT COALESCE(s.actor_id,s.id) AS actor_id FROM sessions s
                WHERE s.workspace_id=$1 AND s.id=$2
                UNION SELECT COALESCE(p.actor_id,p.id) AS actor_id FROM sessions p
                JOIN sessions s ON s.workspace_id=p.workspace_id AND s.parent_session_id=p.id
                WHERE s.workspace_id=$1 AND s.id=$2
                UNION SELECT h.id AS actor_id FROM actors h JOIN sessions s ON h.workspace_id=s.workspace_id
                AND (h.id=s.owner_id OR (s.shared IS NOT NULL AND h.kind='human' AND h.archived=FALSE))
                WHERE s.workspace_id=$1 AND s.id=$2",
                [(&self.workspace).into(), session_id.into()],
            ),
        )
        .await?
        .into_iter()
        .filter_map(|r| r.actor_id)
        .collect();
        self.event_in(db, kind, payload, actors).await
    }

    async fn message_in<C: ConnectionTrait>(&self, db: &C, id: &str) -> Result<ChatMessage> {
        let row = messages::Entity::find_by_id(self.key(id))
            .one(db)
            .await?
            .ok_or(Error::NotFound)?;
        let deliveries = deliveries::Entity::find()
            .filter(deliveries::Column::WorkspaceId.eq(&self.workspace))
            .filter(deliveries::Column::MessageId.eq(id))
            .order_by_asc(deliveries::Column::ActorId)
            .all(db)
            .await?;
        Ok(ChatMessage {
            id: row.id,
            conversation_id: row.conversation_id,
            seq: row.seq,
            author_id: row.author_id,
            text: row.text,
            reply_to_delivery_id: row.reply_to_delivery_id,
            created_at: row.created_at,
            deliveries,
        })
    }

    async fn delivery_in<C: ConnectionTrait>(&self, db: &C, id: &str) -> Result<ChatDelivery> {
        deliveries::Entity::find_by_id(self.key(id))
            .one(db)
            .await?
            .ok_or(Error::NotFound)
    }

    /// A chat member: a person of the workspace, or any person's agent through one of its active
    /// sessions. Chats are shared; an agent's requests still go to its own person.
    async fn member_in<C: ConnectionTrait>(
        &self,
        db: &C,
        member: &ConversationMemberInput,
    ) -> Result<()> {
        let valid: bool = match &member.session_id {
            None => {
                scalar(
                    db,
                    sql(
                        db,
                        "SELECT EXISTS(SELECT 1 FROM actors
                    WHERE workspace_id=$1 AND id=$2 AND kind='human' AND archived=FALSE)",
                        [(&self.workspace).into(), member.actor_id.clone().into()],
                    ),
                )
                .await?
            }
            Some(session_id) => {
                scalar(
                    db,
                    sql(
                        db,
                        "SELECT EXISTS(SELECT 1 FROM sessions s
                    JOIN actors a ON a.workspace_id=s.workspace_id AND a.id=s.actor_id
                    WHERE s.workspace_id=$1 AND s.id=$2 AND s.actor_id=$3 AND s.stopped_at IS NULL
                    AND a.archived=FALSE)",
                        [
                            (&self.workspace).into(),
                            session_id.clone().into(),
                            member.actor_id.clone().into(),
                        ],
                    ),
                )
                .await?
            }
        };
        if valid {
            Ok(())
        } else {
            Err(Error::Invalid(
                "Choose a person, or an active session of the agent".into(),
            ))
        }
    }

    /// Messages that were waiting reach an agent together, in one envelope named after its last
    /// delivery. Reading that one means having read the others that the same envelope carried.
    async fn read_earlier_in<C: ConnectionTrait>(&self, db: &C, delivery_id: &str) -> Result<()> {
        let earlier: Vec<ChatDelivery> = fetch_all(
            db,
            sql(
                db,
                "UPDATE deliveries SET status='read',updated_at=$3
                WHERE workspace_id=$1 AND status IN ('uncertain','notified') AND id!=$2
                AND native_request_id=$2
                AND session_id=(SELECT session_id FROM deliveries WHERE workspace_id=$1 AND id=$2)
                RETURNING *",
                [
                    (&self.workspace).into(),
                    delivery_id.into(),
                    now_ms().into(),
                ],
            ),
        )
        .await?;
        for delivery in earlier {
            let message = self.message_in(db, &delivery.message_id).await?;
            self.conversation_event(
                db,
                "delivery.changed",
                &message.conversation_id,
                json!({"message_id":message.id}),
            )
            .await?;
        }
        Ok(())
    }

    /// Revokes a live session and settles its approvals. `note` is the runtime's own stop note.
    async fn stop_in<C: ConnectionTrait>(
        &self,
        db: &C,
        id: &str,
        note: Option<&str>,
    ) -> Result<()> {
        sessions::Entity::update_many()
            .col_expr(sessions::Column::Status, Expr::value("stopped"))
            .col_expr(sessions::Column::StoppedAt, Expr::value(Some(now_ms())))
            .col_expr(sessions::Column::AttentionReason, Expr::value(note))
            .col_expr(sessions::Column::Activity, Expr::value(None::<String>))
            .col_expr(
                sessions::Column::ActivityConversationId,
                Expr::value(None::<String>),
            )
            .filter(sessions::Column::WorkspaceId.eq(&self.workspace))
            .filter(sessions::Column::Id.eq(id))
            .exec(db)
            .await?;
        self.resolve_approvals_in(db, id, "Agent stopped").await?;
        self.personal_event(db, "session.changed", id, json!({"session_id":id}))
            .await?;
        Ok(())
    }

    /// Every open request of the session ends: its link no longer answers them.
    async fn resolve_approvals_in<C: ConnectionTrait>(
        &self,
        db: &C,
        id: &str,
        reason: &str,
    ) -> Result<()> {
        let approvals = ids(
            db,
            sql(
                db,
                "UPDATE tool_approvals SET status='resolved',last_error=$4,updated_at=$2
                WHERE workspace_id=$1 AND session_id=$3 AND status!='resolved' RETURNING id",
                [
                    (&self.workspace).into(),
                    now_ms().into(),
                    id.into(),
                    reason.into(),
                ],
            ),
        )
        .await?;
        for approval in approvals {
            self.personal_event(db, "approval.changed", id, json!({"approval_id":approval}))
                .await?;
        }
        Ok(())
    }

    /// The session is a member of the conversation; anything else is not its chat.
    async fn ensure_member<C: ConnectionTrait>(
        &self,
        db: &C,
        conversation_id: &str,
        actor_id: &str,
        session_id: &str,
    ) -> Result<()> {
        let member = conversation_members::Entity::find_by_id((
            self.workspace.clone(),
            conversation_id.to_owned(),
            actor_id.to_owned(),
        ))
        .filter(conversation_members::Column::SessionId.eq(session_id))
        .one(db)
        .await?
        .is_some();
        if member {
            Ok(())
        } else {
            Err(Error::Forbidden)
        }
    }

    async fn approval_in<C: ConnectionTrait>(&self, db: &C, id: &str) -> Result<ChatApproval> {
        let row: ApprovalRow = fetch_one(
            db,
            sql(
                db,
                "SELECT a.*,s.actor_id,m.conversation_id FROM tool_approvals a
                JOIN sessions s ON s.workspace_id=a.workspace_id AND s.id=a.session_id
                LEFT JOIN deliveries d ON d.workspace_id=a.workspace_id AND d.id=a.delivery_id
                LEFT JOIN messages m ON m.workspace_id=d.workspace_id AND m.id=d.message_id
                WHERE a.workspace_id=$1 AND a.id=$2",
                [(&self.workspace).into(), id.into()],
            ),
        )
        .await?
        .ok_or(Error::NotFound)?;
        Ok(ChatApproval {
            id: row.id,
            actor_id: row.actor_id,
            session_id: row.session_id,
            conversation_id: row.conversation_id,
            delivery_id: row.delivery_id,
            native_request_id: row.native_request_id,
            kind: row.kind,
            summary: row.summary,
            details: decode(&row.details_json)?,
            status: row.status,
            decision: row.decision,
            scope: row.scope,
            reason: row.reason,
            answer: row.answer_json.as_deref().map(decode).transpose()?,
            last_error: row.last_error,
            created_at: row.created_at,
        })
    }

    /// A session's own requests; for a person, those of the sessions they may read.
    async fn approvals_in<C: ConnectionTrait>(
        &self,
        db: &C,
        who: &ChatIdentity,
    ) -> Result<Vec<ChatApproval>> {
        let mut query = tool_approvals::Entity::find()
            .filter(tool_approvals::Column::WorkspaceId.eq(&self.workspace));
        query = match &who.session_id {
            Some(session) => query.filter(tool_approvals::Column::SessionId.eq(session)),
            None => query.filter(
                tool_approvals::Column::SessionId.in_subquery(
                    sea_orm::sea_query::Query::select()
                        .column(sessions::Column::Id)
                        .from(sessions::Entity)
                        .and_where(sessions::Column::WorkspaceId.eq(&self.workspace))
                        .cond_where(
                            sea_orm::Condition::any()
                                .add(sessions::Column::OwnerId.eq(who.actor()?))
                                .add(sessions::Column::Shared.is_not_null()),
                        )
                        .to_owned(),
                ),
            ),
        };
        let rows = query
            .order_by_asc(tool_approvals::Column::CreatedAt)
            .order_by_asc(tool_approvals::Column::Id)
            .all(db)
            .await?;
        let mut result = Vec::with_capacity(rows.len());
        for row in rows {
            result.push(self.approval_in(db, &row.id).await?);
        }
        Ok(result)
    }
}

impl Store {
    pub async fn chat_identity(&self, token: Option<&str>) -> Result<ChatIdentity> {
        if let Some(token) = token {
            let session: Option<sessions::Model> = fetch_one(
                &self.db,
                sql(
                    &self.db,
                    "SELECT s.* FROM sessions s
                    LEFT JOIN actors a ON a.workspace_id=s.workspace_id AND a.id=s.actor_id
                    WHERE s.workspace_id=$1 AND s.token_hash=$2 AND s.stopped_at IS NULL
                    AND COALESCE(a.archived,FALSE)=FALSE",
                    [(&self.workspace).into(), token_hash(token).into()],
                ),
            )
            .await?;
            let session = session.ok_or(Error::Unauthorized)?;
            Ok(ChatIdentity {
                actor_id: session.actor_id,
                session_id: Some(session.id),
            })
        } else {
            // Without a token: the workspace's owner, as a kernel without sign-in serves them.
            Ok(ChatIdentity::person(&self.owner().await?.id))
        }
    }

    /// Whether the owner may hire `actor_id`, or name a new agent, for `harness`: the checks
    /// of `hire_chat_session`, before anything native is started for it.
    pub async fn check_hire(
        &self,
        who: &ChatIdentity,
        harness: Harness,
        actor_id: Option<&str>,
        name: &str,
    ) -> Result<()> {
        self.require_onboarding().await?;
        let tx = self.read().await?;
        self.person_in(&tx, who).await?;
        self.hireable_in(&tx, who, harness, actor_id, name).await?;
        Ok(())
    }

    pub async fn hire_chat_session(
        &self,
        who: &ChatIdentity,
        input: HireChatSession,
    ) -> Result<IssuedChatSession> {
        self.require_onboarding().await?;
        let native_id = text(&input.native_session_id, "Native session ID", 500, true)?;
        let title = text(&input.title, "Session title", 500, true)?;
        let workspace = text(&input.workspace, "Workspace", 4096, true)?;
        if !input.native_locator.is_object() || input.native_locator.to_string().len() > 16_384 {
            return Err(Error::Invalid("Invalid native session locator".into()));
        }
        let tx = self.write().await?;
        self.person_in(&tx, who).await?;
        let actor = match self
            .hireable_in(
                &tx,
                who,
                input.harness,
                input.actor_id.as_deref(),
                &input.name,
            )
            .await?
        {
            Some(actor) => Some(actor),
            None if input.name.trim().is_empty() => None,
            None => Some(
                actors::ActiveModel {
                    workspace_id: Set(self.workspace.clone()),
                    id: Set(Uuid::new_v4().to_string()),
                    name: Set(input.name.trim().to_owned()),
                    kind: Set("agent".into()),
                    owner_id: Set(Some(who.actor()?.to_owned())),
                    harness: Set(Some(input.harness.id().to_owned())),
                    archived: Set(false),
                    name_confirmed: Set(false),
                    created_at: Set(now_ms()),
                    auth_subject: Set(None),
                    model: Set(None),
                    effort: Set(None),
                    permission_mode: Set(None),
                    approval_policy: Set(None),
                    sandbox: Set(None),
                    invited_by: Set(None),
                    role: Set(None),
                }
                .insert(&tx)
                .await?,
            ),
        };
        let actor_id = actor.as_ref().map(|actor| actor.id.clone());
        // One row per native session: a relink, a recovery or the owner's new decision
        // continues it, with a new token; the previous one stops working at once.
        let existing = sessions::Entity::find()
            .filter(sessions::Column::WorkspaceId.eq(&self.workspace))
            .filter(sessions::Column::Harness.eq(input.harness.id()))
            .filter(sessions::Column::NativeSessionId.eq(&native_id))
            .one(&tx)
            .await?;
        let token = random_token();
        let id = match existing {
            Some(row) => {
                // An automatic relink continues only a session the owner has not stopped; an
                // explicit hire of a session that is still linked is a conflict.
                match (input.resume, row.stopped_at.is_some()) {
                    (true, true) => return Err(Error::StoppedByOwner),
                    (false, false) => return Err(Error::Conflict),
                    _ => {}
                }
                if who.actor_id.as_ref() != Some(&row.owner_id) {
                    return Err(Error::Forbidden);
                }
                // A session works for one agent; one without may be given to an agent.
                if row.actor_id.is_some() && row.actor_id != actor_id {
                    return Err(Error::Conflict);
                }
                sessions::ActiveModel {
                    workspace_id: Set(self.workspace.clone()),
                    id: Set(row.id.clone()),
                    // The owner's decision names the agent; a relink keeps the session's.
                    actor_id: if input.resume {
                        sea_orm::ActiveValue::NotSet
                    } else {
                        Set(actor_id.clone())
                    },
                    workspace: Set(workspace),
                    native_locator_json: Set(input.native_locator.to_string()),
                    token_hash: Set(token_hash(&token)),
                    status: Set("connecting".into()),
                    attention_reason: Set(None),
                    stopped_at: Set(None),
                    activity: Set(None),
                    activity_conversation_id: Set(None),
                    host_id: Set(self.host.clone()),
                    ..Default::default()
                }
                .update(&tx)
                .await?;
                // Questions of the previous link's native process are no longer its to answer.
                self.resolve_approvals_in(&tx, &row.id, "Link replaced")
                    .await?;
                row.id
            }
            None if input.resume => return Err(Error::StoppedByOwner),
            None => {
                let id = Uuid::new_v4().to_string();
                sessions::ActiveModel {
                    workspace_id: Set(self.workspace.clone()),
                    id: Set(id.clone()),
                    actor_id: Set(actor_id.clone()),
                    harness: Set(input.harness.id().to_owned()),
                    native_session_id: Set(native_id.clone()),
                    title: Set(title),
                    workspace: Set(workspace),
                    native_locator_json: Set(input.native_locator.to_string()),
                    token_hash: Set(token_hash(&token)),
                    status: Set("connecting".into()),
                    attention_reason: Set(None),
                    created_at: Set(now_ms()),
                    stopped_at: Set(None),
                    activity: Set(None),
                    activity_conversation_id: Set(None),
                    host_id: Set(self.host.clone()),
                    pinned_at: Set(None),
                    archived_at: Set(None),
                    budget_cents: Set(None),
                    parent_session_id: Set(None),
                    owner_id: Set(who.actor()?.to_owned()),
                    shared: Set(None),
                    created: Set(false),
                }
                .insert(&tx)
                .await?;
                id
            }
        };
        self.personal_event(&tx, "session.changed", &id, json!({"session_id":id}))
            .await?;
        let session = self.session_in(&tx, &id).await?;
        tx.commit().await?;
        Ok(IssuedChatSession {
            actor,
            session,
            token,
        })
    }

    /// The workspace's people: whom notices about the workspace itself reach.
    pub async fn everyone(&self) -> Result<Vec<String>> {
        Ok(actors::Entity::find()
            .filter(actors::Column::WorkspaceId.eq(&self.workspace))
            .filter(actors::Column::Kind.eq("human"))
            .filter(actors::Column::Archived.eq(false))
            .all(&self.db)
            .await?
            .into_iter()
            .map(|actor| actor.id)
            .collect())
    }

    /// Whom notices about a session reach: its person, or every person when it is shared.
    pub async fn readers(&self, session_id: &str) -> Result<Vec<String>> {
        ids(
            &self.db,
            sql(
                &self.db,
                                "SELECT h.id FROM actors h JOIN sessions s ON h.workspace_id=s.workspace_id
                AND (h.id=s.owner_id OR (s.shared IS NOT NULL AND h.kind='human' AND h.archived=FALSE))
                WHERE s.workspace_id=$1 AND s.id=$2",
                [(&self.workspace).into(), session_id.into()],
            ),
        )
        .await
    }

    /// A session's row, for reading its native record: whoever may read the session.
    pub(crate) async fn observed_session(
        &self,
        who: &ChatIdentity,
        id: &str,
    ) -> Result<sessions::Model> {
        let tx = self.read().await?;
        self.session_access_in(&tx, who, id, Access::Read).await?;
        self.session_row_in(&tx, id).await
    }

    /// A person's own sessions and those shared with the workspace; for a session, itself and
    /// the sessions it delegates work to.
    pub async fn sessions(&self, who: &ChatIdentity) -> Result<Vec<ChatSession>> {
        let tx = self.read().await?;
        self.identity_in(&tx, who).await?;
        let (filter, value) = match &who.session_id {
            Some(session) => ("s.id=$2 OR s.parent_session_id=$2", session.clone()),
            None => (
                "s.owner_id=$2 OR s.shared IS NOT NULL",
                who.actor()?.to_owned(),
            ),
        };
        fetch_all(
            &tx,
            sql(
                &tx,
                format!(
                    "{SESSIONS} WHERE s.workspace_id=$1 AND ({filter}) ORDER BY s.created_at,s.id"
                ),
                [(&self.workspace).into(), value.into()],
            ),
        )
        .await
    }

    /// Every session this kernel hosts or knows of, for the kernel's own work on them.
    pub(crate) async fn all_sessions(&self) -> Result<Vec<ChatSession>> {
        fetch_all(
            &self.db,
            sql(
                &self.db,
                format!("{SESSIONS} WHERE s.workspace_id=$1 ORDER BY s.created_at,s.id"),
                [(&self.workspace).into()],
            ),
        )
        .await
    }

    /// The person whose session it is, as the kernel acts for them on it.
    pub async fn session_person(&self, id: &str) -> Result<ChatIdentity> {
        Ok(ChatIdentity::person(
            &self.session_row_in(&self.db, id).await?.owner_id,
        ))
    }

    /// What `who` may do with a session; none when it is not theirs to see.
    pub async fn session_access(&self, who: &ChatIdentity, id: &str) -> Result<Option<Access>> {
        let tx = self.read().await?;
        self.access_of(&tx, who, id).await
    }

    /// Called once when the kernel runtime starts, not on every database open, for the
    /// sessions of this host only: another kernel's are its own to recover. Persisted
    /// presence is not evidence that an adapter is still attached after restart.
    pub async fn recover_sessions(&self) -> Result<()> {
        let reason = "The kernel restarted. Reconnect this session before sending more work.";
        let tx = self.write().await?;
        let ids = ids(
            &tx,
            sql(
                &tx,
                                "UPDATE sessions SET status='attention',attention_reason=$1,activity=NULL,activity_conversation_id=NULL
                WHERE workspace_id=$3 AND stopped_at IS NULL
                AND (status!='attention' OR attention_reason IS NULL OR attention_reason!=$1)
                AND (($2 IS NULL AND host_id IS NULL) OR host_id=$2)
                RETURNING id",
                [reason.into(), self.host.clone().into(), (&self.workspace).into()],
            ),
        )
        .await?;
        for id in ids {
            self.personal_event(&tx, "session.changed", &id, json!({"session_id":id}))
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn chat_session_locator(&self, who: &ChatIdentity, id: &str) -> Result<Value> {
        let tx = self.read().await?;
        self.reporter_in(&tx, who, id).await?;
        decode(&self.session_row_in(&tx, id).await?.native_locator_json)
    }

    /// Record host-local continuity metadata only while the same issued link remains wanted.
    pub(crate) async fn remember_pi_locator(
        &self,
        id: &str,
        native: &str,
        locator: &Value,
    ) -> Result<()> {
        if !locator.is_object() || locator.to_string().len() > 16_384 {
            return Err(Error::Invalid("Invalid pi locator".into()));
        }
        let tx = self.write().await?;
        let changed = sessions::Entity::update_many()
            .col_expr(
                sessions::Column::NativeLocatorJson,
                Expr::value(locator.to_string()),
            )
            .filter(sessions::Column::WorkspaceId.eq(&self.workspace))
            .filter(sessions::Column::Id.eq(id))
            .filter(sessions::Column::Harness.eq("pi"))
            .filter(sessions::Column::NativeSessionId.eq(native))
            .filter(sessions::Column::StoppedAt.is_null())
            .exec(&tx)
            .await?
            .rows_affected;
        if changed != 1 {
            return Err(Error::StoppedByOwner);
        }
        tx.commit().await?;
        Ok(())
    }

    /// Rotate a prepared, live owned runner's credential without replacing its identity.
    /// The caller must first obtain the runner's prepare ACK; Stop wins atomically here.
    /// Unlike terminal relinking, deliveries (including Read) and pending approvals stay
    /// on the same session, so its still-running native query can finish them after bind.
    pub async fn renew_owned_chat_session(
        &self,
        who: &ChatIdentity,
        id: &str,
    ) -> Result<IssuedChatSession> {
        let tx = self.write().await?;
        self.own_in(&tx, who, id).await?;
        let session = self.session_in(&tx, id).await?;
        if session.stopped_at.is_some() {
            return Err(Error::StoppedByOwner);
        }
        let locator: Value = decode(&self.session_row_in(&tx, id).await?.native_locator_json)?;
        if session.harness != "claude-code" || locator["kind"] != "claude-runner" {
            return Err(Error::Invalid(
                "Only an owned Claude runner can renew this link".into(),
            ));
        }
        let actor = match &session.actor_id {
            Some(actor) => Some(
                actors::Entity::find_by_id(self.key(actor))
                    .filter(actors::Column::OwnerId.eq(who.actor()?))
                    .filter(actors::Column::Kind.eq("agent"))
                    .filter(actors::Column::Archived.eq(false))
                    .one(&tx)
                    .await?
                    .ok_or(Error::Forbidden)?,
            ),
            None => None,
        };
        let token = random_token();
        sessions::Entity::update_many()
            .col_expr(sessions::Column::TokenHash, Expr::value(token_hash(&token)))
            .col_expr(sessions::Column::Status, Expr::value("connecting"))
            .col_expr(
                sessions::Column::AttentionReason,
                Expr::value(None::<String>),
            )
            .filter(sessions::Column::WorkspaceId.eq(&self.workspace))
            .filter(sessions::Column::Id.eq(id))
            .exec(&tx)
            .await?;
        self.personal_event(&tx, "session.changed", id, json!({"session_id":id}))
            .await?;
        let session = self.session_in(&tx, id).await?;
        tx.commit().await?;
        Ok(IssuedChatSession {
            actor,
            session,
            token,
        })
    }

    pub async fn stop_chat_session(&self, who: &ChatIdentity, id: &str) -> Result<ChatSession> {
        Ok(self.stop_chat_session_with_state(who, id).await?.0)
    }

    /// The owner's Stop. Returns whether the session was already stopped, atomically with
    /// revocation. Only the owner stops a session: no relink or recovery continues it.
    pub async fn stop_chat_session_with_state(
        &self,
        who: &ChatIdentity,
        id: &str,
    ) -> Result<(ChatSession, bool)> {
        let tx = self.write().await?;
        self.own_in(&tx, who, id).await?;
        let existing = self.session_in(&tx, id).await?;
        let was_already_stopped = existing.stopped_at.is_some();
        if !was_already_stopped {
            self.stop_in(&tx, id, None).await?;
        }
        let session = self.session_in(&tx, id).await?;
        tx.commit().await?;
        Ok((session, was_already_stopped))
    }

    /// A link that could not be confirmed: its token is revoked and the session waits for
    /// attention with `reason`, so the runtime tries again. Returns true when the owner had
    /// stopped it: then nothing changes and nothing is retried.
    pub async fn fail_chat_link(&self, who: &ChatIdentity, id: &str, reason: &str) -> Result<bool> {
        let reason = text(reason, "Attention reason", 2_000, true)?;
        let tx = self.write().await?;
        self.own_in(&tx, who, id).await?;
        if self.session_in(&tx, id).await?.stopped_at.is_some() {
            return Ok(true);
        }
        sessions::ActiveModel {
            workspace_id: Set(self.workspace.clone()),
            id: Set(id.to_owned()),
            token_hash: Set(token_hash(&random_token())),
            status: Set("attention".into()),
            attention_reason: Set(Some(reason)),
            activity: Set(None),
            activity_conversation_id: Set(None),
            ..Default::default()
        }
        .update(&tx)
        .await?;
        self.personal_event(&tx, "session.changed", id, json!({"session_id":id}))
            .await?;
        tx.commit().await?;
        Ok(false)
    }

    /// The session goes on in another native session of its harness, one that replaces a
    /// native session that never had a message. Not for a session the owner stopped.
    pub async fn replace_native_session(
        &self,
        who: &ChatIdentity,
        id: &str,
        native_session_id: &str,
    ) -> Result<()> {
        let native_session_id = text(native_session_id, "Native session ID", 500, true)?;
        let tx = self.write().await?;
        self.own_in(&tx, who, id).await?;
        if self.session_in(&tx, id).await?.stopped_at.is_some() {
            return Err(Error::StoppedByOwner);
        }
        sessions::ActiveModel {
            workspace_id: Set(self.workspace.clone()),
            id: Set(id.to_owned()),
            native_session_id: Set(native_session_id),
            ..Default::default()
        }
        .update(&tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Whether the native context may still be relinked: a session of it the owner has
    /// not stopped. Checked before any native call that would start work, as
    /// `hire_chat_session` checks it again when it issues the new token.
    pub async fn relink_wanted(&self, harness: &str, native_session_id: &str) -> Result<bool> {
        Ok(sessions::Entity::find()
            .filter(sessions::Column::WorkspaceId.eq(&self.workspace))
            .filter(sessions::Column::Harness.eq(harness))
            .filter(sessions::Column::NativeSessionId.eq(native_session_id))
            .filter(sessions::Column::StoppedAt.is_null())
            .one(&self.db)
            .await?
            .is_some())
    }

    /// One session, as it is now, for whoever may read it.
    pub async fn chat_session(&self, who: &ChatIdentity, id: &str) -> Result<ChatSession> {
        let tx = self.read().await?;
        self.session_access_in(&tx, who, id, Access::Read).await?;
        self.session_in(&tx, id).await
    }

    /// ZeroLux started the session's native session itself.
    pub(crate) async fn mark_created(&self, session: &mut ChatSession) -> Result<()> {
        sessions::Entity::update_many()
            .col_expr(sessions::Column::Created, Expr::value(true))
            .filter(sessions::Column::WorkspaceId.eq(&self.workspace))
            .filter(sessions::Column::Id.eq(&session.id))
            .exec(&self.db)
            .await?;
        session.created = true;
        Ok(())
    }

    /// A session that runs on a joined computer: the kernel neither starts nor relinks it here.
    pub(crate) async fn place_session(&self, id: &str, host: &str) -> Result<()> {
        sessions::Entity::update_many()
            .col_expr(sessions::Column::HostId, Expr::value(Some(host.to_owned())))
            .filter(sessions::Column::WorkspaceId.eq(&self.workspace))
            .filter(sessions::Column::Id.eq(id))
            .exec(&self.db)
            .await?;
        Ok(())
    }

    /// A session its person started for another one, to delegate work to it.
    pub async fn delegate(&self, child: &str, parent: &str) -> Result<ChatSession> {
        let tx = self.write().await?;
        sessions::Entity::update_many()
            .col_expr(
                sessions::Column::ParentSessionId,
                Expr::value(Some(parent.to_owned())),
            )
            .filter(sessions::Column::WorkspaceId.eq(&self.workspace))
            .filter(sessions::Column::Id.eq(child))
            .exec(&tx)
            .await?;
        self.personal_event(&tx, "session.changed", child, json!({"session_id":child}))
            .await?;
        let session = self.session_in(&tx, child).await?;
        tx.commit().await?;
        Ok(session)
    }

    /// Who acts on a session when `who` may do `need` with it: its person, for whom the
    /// people it is shared with and the session that delegates work to it act.
    pub async fn acting_for(
        &self,
        who: &ChatIdentity,
        id: &str,
        need: Access,
    ) -> Result<ChatIdentity> {
        let tx = self.read().await?;
        self.session_access_in(&tx, who, id, need).await?;
        Ok(ChatIdentity::person(
            &self.session_row_in(&tx, id).await?.owner_id,
        ))
    }

    /// The owner names, pins or archives a session.
    pub async fn change_session(
        &self,
        who: &ChatIdentity,
        id: &str,
        input: SessionChange,
    ) -> Result<ChatSession> {
        let title = input
            .title
            .map(|title| text(&title, "Session title", 500, true))
            .transpose()?;
        if title.is_none()
            && input.pinned.is_none()
            && input.archived.is_none()
            && input.budget_usd.is_none()
            && input.shared.is_none()
        {
            return Err(Error::Invalid("Nothing to change".into()));
        }
        let shared = input
            .shared
            .map(|shared| match shared.as_deref() {
                None | Some("read" | "write") => Ok(shared),
                Some(_) => Err(Error::Invalid(
                    "Share a session to read, to write, or not at all".into(),
                )),
            })
            .transpose()?;
        let budget = input
            .budget_usd
            .map(|usd| {
                if !usd.is_finite() || !(0.0..=1_000_000.0).contains(&usd) {
                    return Err(Error::Invalid(
                        "A budget from 0 to 1,000,000 dollars".into(),
                    ));
                }
                Ok((usd > 0.0).then(|| (usd * 100.0).round() as i64))
            })
            .transpose()?;
        let tx = self.write().await?;
        self.own_in(&tx, who, id).await?;
        let existing = self.session_in(&tx, id).await?;
        let now = now_ms();
        let mut update = sessions::Entity::update_many()
            .filter(sessions::Column::WorkspaceId.eq(&self.workspace))
            .filter(sessions::Column::Id.eq(id));
        if let Some(title) = title {
            update = update.col_expr(sessions::Column::Title, Expr::value(title));
        }
        if let Some(pinned) = input.pinned {
            let at = pinned.then(|| existing.pinned_at.unwrap_or(now));
            update = update.col_expr(sessions::Column::PinnedAt, Expr::value(at));
        }
        if let Some(archived) = input.archived {
            let at = archived.then(|| existing.archived_at.unwrap_or(now));
            update = update.col_expr(sessions::Column::ArchivedAt, Expr::value(at));
        }
        if let Some(cents) = budget {
            update = update.col_expr(sessions::Column::BudgetCents, Expr::value(cents));
        }
        if let Some(shared) = shared {
            update = update.col_expr(sessions::Column::Shared, Expr::value(shared));
        }
        update.exec(&tx).await?;
        self.personal_event(&tx, "session.changed", id, json!({"session_id":id}))
            .await?;
        let session = self.session_in(&tx, id).await?;
        tx.commit().await?;
        Ok(session)
    }

    /// Persist a public, credential-free stop outcome supplied by the runtime.
    /// This never reactivates the link or retries any native operation.
    pub async fn note_chat_stop(
        &self,
        who: &ChatIdentity,
        id: &str,
        reason: &str,
    ) -> Result<ChatSession> {
        let reason = text(reason, "Stop reason", 2_000, true)?;
        let tx = self.write().await?;
        self.own_in(&tx, who, id).await?;
        let existing = self.session_in(&tx, id).await?;
        if existing.stopped_at.is_none() || existing.status != "stopped" {
            return Err(Error::Conflict);
        }
        if existing.attention_reason.as_deref() != Some(reason.as_str()) {
            sessions::Entity::update_many()
                .col_expr(sessions::Column::AttentionReason, Expr::value(Some(reason)))
                .filter(sessions::Column::WorkspaceId.eq(&self.workspace))
                .filter(sessions::Column::Id.eq(id))
                .exec(&tx)
                .await?;
            self.personal_event(&tx, "session.changed", id, json!({"session_id":id}))
                .await?;
        }
        let session = self.session_in(&tx, id).await?;
        tx.commit().await?;
        Ok(session)
    }

    pub async fn set_chat_session_status(
        &self,
        who: &ChatIdentity,
        id: &str,
        input: ChatSessionStatus,
    ) -> Result<ChatSession> {
        if !matches!(input.status.as_str(), "connected" | "attention") {
            return Err(Error::Invalid(
                "Session status must be connected or attention".into(),
            ));
        }
        let reason = reason(input.reason)?;
        let tx = self.write().await?;
        self.reporter_in(&tx, who, id).await?;
        let existing = self.session_in(&tx, id).await?;
        if existing.stopped_at.is_some() {
            return Err(Error::Conflict);
        }
        if existing.status != input.status || existing.attention_reason != reason {
            sessions::Entity::update_many()
                .col_expr(sessions::Column::Status, Expr::value(input.status))
                .col_expr(sessions::Column::AttentionReason, Expr::value(reason))
                .filter(sessions::Column::WorkspaceId.eq(&self.workspace))
                .filter(sessions::Column::Id.eq(id))
                .exec(&tx)
                .await?;
            self.personal_event(&tx, "session.changed", id, json!({"session_id":id}))
                .await?;
        }
        let session = self.session_in(&tx, id).await?;
        tx.commit().await?;
        Ok(session)
    }

    /// Reported by the adapter of a live link. None means that the harness gave no evidence.
    /// `conversation` is the chat the current turn is about: only while working, and only
    /// when every input of the turn belongs to it; the clients show the agent at work there.
    pub async fn set_chat_session_activity(
        &self,
        who: &ChatIdentity,
        id: &str,
        activity: Option<String>,
        conversation: Option<String>,
    ) -> Result<ChatSession> {
        if !matches!(activity.as_deref(), None | Some("working" | "idle")) {
            return Err(Error::Invalid(
                "Session activity must be working, idle or null".into(),
            ));
        }
        let conversation = conversation.filter(|_| activity.as_deref() == Some("working"));
        let tx = self.write().await?;
        self.reporter_in(&tx, who, id).await?;
        let existing = self.session_in(&tx, id).await?;
        if existing.stopped_at.is_some() {
            return Err(Error::Conflict);
        }
        if let Some(conversation) = &conversation {
            // Its own conversations only: a session cannot claim work on a chat it is not in.
            let actor = existing.actor_id.as_deref().ok_or(Error::Forbidden)?;
            self.ensure_member(&tx, conversation, actor, id).await?;
        }
        if existing.activity != activity || existing.activity_conversation_id != conversation {
            sessions::Entity::update_many()
                .col_expr(sessions::Column::Activity, Expr::value(activity))
                .col_expr(
                    sessions::Column::ActivityConversationId,
                    Expr::value(conversation),
                )
                .filter(sessions::Column::WorkspaceId.eq(&self.workspace))
                .filter(sessions::Column::Id.eq(id))
                .exec(&tx)
                .await?;
            self.personal_event(&tx, "session.changed", id, json!({"session_id":id}))
                .await?;
        }
        let session = self.session_in(&tx, id).await?;
        tx.commit().await?;
        Ok(session)
    }

    pub async fn conversations(&self, who: &ChatIdentity) -> Result<Vec<Conversation>> {
        let tx = self.read().await?;
        self.identity_in(&tx, who).await?;
        self.conversations_in(&tx, who).await
    }

    pub async fn create_conversation(
        &self,
        who: &ChatIdentity,
        mut input: CreateConversation,
    ) -> Result<Conversation> {
        self.require_onboarding().await?;
        let title = text(&input.title, "Conversation title", 200, true)?;
        if !matches!(input.kind.as_str(), "dm" | "group") {
            return Err(Error::Invalid(
                "Conversation kind must be dm or group".into(),
            ));
        }
        let tx = self.write().await?;
        self.person_in(&tx, who).await?;
        let me = who.actor()?.to_owned();
        if !input.members.iter().any(|m| m.actor_id == me) {
            input.members.push(ConversationMemberInput {
                actor_id: me.clone(),
                session_id: None,
            });
        }
        input.members.sort_by(|a, b| a.actor_id.cmp(&b.actor_id));
        if input.members.len() < 2
            || (input.kind == "dm" && input.members.len() != 2)
            || input
                .members
                .windows(2)
                .any(|pair| pair[0].actor_id == pair[1].actor_id)
        {
            return Err(Error::Invalid(
                "Choose distinct members; a DM has exactly two".into(),
            ));
        }
        for member in &input.members {
            self.member_in(&tx, member).await?;
        }
        let id = Uuid::new_v4().to_string();
        conversations::ActiveModel {
            workspace_id: Set(self.workspace.clone()),
            id: Set(id.clone()),
            kind: Set(input.kind),
            title: Set(title),
            paused: Set(false),
            next_seq: Set(1),
            created_at: Set(now_ms()),
            parent_id: Set(None),
            root_message_id: Set(None),
            closed_at: Set(None),
        }
        .insert(&tx)
        .await?;
        for member in input.members {
            conversation_members::ActiveModel {
                workspace_id: Set(self.workspace.clone()),
                conversation_id: Set(id.clone()),
                actor_id: Set(member.actor_id),
                session_id: Set(member.session_id),
            }
            .insert(&tx)
            .await?;
        }
        self.conversation_event(&tx, "conversation.changed", &id, json!({}))
            .await?;
        let result = self.conversation_in(&tx, &id).await?;
        tx.commit().await?;
        Ok(result)
    }

    /// Renames an agent. Its sessions, conversations and history stay the same.
    pub async fn rename_agent(&self, who: &ChatIdentity, id: &str, name: &str) -> Result<Actor> {
        let name = text(name, "Agent name", 200, true)?;
        let tx = self.write().await?;
        self.person_in(&tx, who).await?;
        // Members recognize each other by name: two actors never share one.
        let taken: bool = scalar(
            &tx,
            sql(
                &tx,
                "SELECT EXISTS(SELECT 1 FROM actors
                WHERE workspace_id=$1 AND id!=$2 AND archived=FALSE AND lower(name)=lower($3))",
                [(&self.workspace).into(), id.into(), (&name).into()],
            ),
        )
        .await?;
        if taken {
            return Err(Error::Invalid(
                "Another member already has this name".into(),
            ));
        }
        let actor = actors::Entity::update_many()
            .col_expr(actors::Column::Name, Expr::value(name))
            .filter(actors::Column::WorkspaceId.eq(&self.workspace))
            .filter(actors::Column::Id.eq(id))
            .filter(actors::Column::OwnerId.eq(who.actor()?))
            .filter(actors::Column::Kind.eq("agent"))
            .filter(actors::Column::Archived.eq(false))
            .exec_with_returning(&tx)
            .await?
            .pop()
            .ok_or(Error::NotFound)?;
        let memberships = conversation_members::Entity::find()
            .filter(conversation_members::Column::WorkspaceId.eq(&self.workspace))
            .filter(conversation_members::Column::ActorId.eq(id))
            .all(&tx)
            .await?;
        for membership in memberships {
            self.conversation_event(
                &tx,
                "conversation.changed",
                &membership.conversation_id,
                json!({}),
            )
            .await?;
        }
        tx.commit().await?;
        Ok(actor)
    }

    pub(crate) async fn settings_actor(&self, who: &ChatIdentity, id: &str) -> Result<Actor> {
        let tx = self.read().await?;
        self.person_in(&tx, who).await?;
        let actor = actors::Entity::find_by_id(self.key(id))
            .filter(actors::Column::OwnerId.eq(who.actor()?))
            .filter(actors::Column::Kind.eq("agent"))
            .filter(actors::Column::Archived.eq(false))
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        tx.commit().await?;
        Ok(actor)
    }

    /// Record a confirmed native snapshot on that session, for its relaunch. A late reply
    /// cannot change a stopped session.
    pub(crate) async fn observe_native_settings(
        &self,
        session_id: &str,
        native_id: &str,
        values: &AgentSettings,
    ) -> Result<()> {
        let tx = self.write().await?;
        let session = sessions::Entity::find_by_id(self.key(session_id))
            .filter(sessions::Column::NativeSessionId.eq(native_id))
            .filter(sessions::Column::StoppedAt.is_null())
            .one(&tx)
            .await?
            .ok_or(Error::StoppedByOwner)?;
        // Only what this kernel's own controls read reaches here: its host's sessions, and
        // those of the computers joined to it.
        let mut locator: Value = decode(&session.native_locator_json)?;
        let value = serde_json::to_value(values)
            .map_err(|e| Error::Database(DbErr::Json(e.to_string())))?;
        if locator["settings"] != value {
            locator["settings"] = value;
            sessions::Entity::update_many()
                .filter(sessions::Column::WorkspaceId.eq(&self.workspace))
                .filter(sessions::Column::Id.eq(session_id))
                .col_expr(
                    sessions::Column::NativeLocatorJson,
                    Expr::value(locator.to_string()),
                )
                .exec(&tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// What an agent's new sessions start with, set by the owner. The harness's own settings
    /// go only to that harness; names are the harnesses' own values.
    pub async fn set_agent_settings(
        &self,
        who: &ChatIdentity,
        id: &str,
        input: AgentSettings,
    ) -> Result<Actor> {
        let tx = self.write().await?;
        self.person_in(&tx, who).await?;
        let actor = actors::Entity::find_by_id(self.key(id))
            .filter(actors::Column::OwnerId.eq(who.actor()?))
            .filter(actors::Column::Kind.eq("agent"))
            .filter(actors::Column::Archived.eq(false))
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        let harness = actor.harness.as_deref().unwrap_or_default();
        if input.collaboration_mode.is_some() {
            return Err(Error::Invalid("Plan mode is set per Codex session".into()));
        }
        let value = |field: Option<String>,
                     label: &str,
                     allowed: &[&str]|
         -> Result<Option<Option<String>>> {
            let Some(value) = field else {
                return Ok(None);
            };
            let value = value.trim().to_owned();
            if value.is_empty() {
                return Ok(Some(None));
            }
            if !allowed.is_empty() && !allowed.contains(&value.as_str()) {
                return Err(Error::Invalid(format!(
                    "{label} must be one of {}",
                    allowed.join(", ")
                )));
            }
            text(&value, label, 200, true)?;
            Ok(Some(Some(value)))
        };
        let mut update = actors::Entity::update_many()
            .filter(actors::Column::WorkspaceId.eq(&self.workspace))
            .filter(actors::Column::Id.eq(id));
        let mut changed = false;
        if let Some(model) = value(input.model, "Model", &[])? {
            update = update.col_expr(actors::Column::Model, Expr::value(model));
            changed = true;
        }
        if let Some(effort) = value(input.effort, "Effort", &[])? {
            update = update.col_expr(actors::Column::Effort, Expr::value(effort));
            changed = true;
        }
        if let Some(mode) = value(
            input.permission_mode,
            "Permission mode",
            &["default", "acceptEdits", "plan", "auto"],
        )? {
            if harness != "claude-code" && mode.is_some() {
                return Err(Error::Invalid(
                    "Permission mode is Claude Code's setting".into(),
                ));
            }
            update = update.col_expr(actors::Column::PermissionMode, Expr::value(mode));
            changed = true;
        }
        if let Some(policy) = value(
            input.approval_policy,
            "Approval policy",
            &["untrusted", "on-request", "never"],
        )? {
            if harness != "codex" && policy.is_some() {
                return Err(Error::Invalid("Approval policy is Codex's setting".into()));
            }
            update = update.col_expr(actors::Column::ApprovalPolicy, Expr::value(policy));
            changed = true;
        }
        if let Some(sandbox) = value(
            input.sandbox,
            "Sandbox",
            &["read-only", "workspace-write", "danger-full-access"],
        )? {
            if harness != "codex" && sandbox.is_some() {
                return Err(Error::Invalid("Sandbox is Codex's setting".into()));
            }
            update = update.col_expr(actors::Column::Sandbox, Expr::value(sandbox));
            changed = true;
        }
        if !changed {
            return Ok(actor);
        }
        let actor = update
            .exec_with_returning(&tx)
            .await?
            .pop()
            .ok_or(Error::NotFound)?;
        tx.commit().await?;
        Ok(actor)
    }

    /// Opens a thread under `parent` rooted at a message, or joins the open one rooted there:
    /// one transaction, so two callers meet in the same thread with both rosters merged. The
    /// caller and every participant must be agents of the parent; anything else refuses the
    /// whole request. The audience is the parent's; participants are the thread's members.
    pub async fn open_thread(
        &self,
        who: &ChatIdentity,
        parent: &str,
        input: OpenThread,
    ) -> Result<OpenedThread> {
        let title = text(&input.title, "Thread title", 200, true)?;
        let tx = self.write().await?;
        self.access_in(&tx, who, parent).await?;
        let chat = conversations::Entity::find_by_id(self.key(parent))
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        if chat.kind == "thread" {
            return Err(Error::Invalid("A thread cannot have threads".into()));
        }
        // The root: a message of the parent, named directly or through one of its deliveries.
        let root = ids(
            &tx,
            sql(
                &tx,
                "SELECT m.id FROM messages m WHERE m.workspace_id=$1 AND m.conversation_id=$2
                AND (m.id=$3
                    OR m.id=(SELECT message_id FROM deliveries WHERE workspace_id=$1 AND id=$3))
                LIMIT 1",
                [
                    (&self.workspace).into(),
                    parent.into(),
                    (&input.root).into(),
                ],
            ),
        )
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| Error::Invalid("The root must be a message of this chat".into()))?;
        let parent_members = self.members_in(&tx, parent).await?;
        let mut roster: Vec<String> = input.participants;
        roster.push(who.actor()?.to_owned());
        roster.sort();
        roster.dedup();
        for actor in &roster {
            let member = parent_members
                .iter()
                .find(|m| &m.actor_id == actor)
                .ok_or_else(|| Error::Invalid(format!("{actor} is not in this chat")))?;
            if member.kind != "agent" {
                return Err(Error::Invalid("Threads are between agents".into()));
            }
        }
        let open = conversations::Entity::find()
            .filter(conversations::Column::WorkspaceId.eq(&self.workspace))
            .filter(conversations::Column::RootMessageId.eq(&root))
            .filter(conversations::Column::ClosedAt.is_null())
            .one(&tx)
            .await?;
        let (id, created) = match open {
            Some(thread) => (thread.id, false),
            None => {
                let id = Uuid::new_v4().to_string();
                conversations::ActiveModel {
                    workspace_id: Set(self.workspace.clone()),
                    id: Set(id.clone()),
                    kind: Set("thread".into()),
                    title: Set(title),
                    paused: Set(false),
                    next_seq: Set(1),
                    created_at: Set(now_ms()),
                    parent_id: Set(Some(parent.to_owned())),
                    root_message_id: Set(Some(root)),
                    closed_at: Set(None),
                }
                .insert(&tx)
                .await?;
                (id, true)
            }
        };
        // Joining adds to the roster; sessions are the ones serving the parent.
        for actor in &roster {
            let session = parent_members
                .iter()
                .find(|m| &m.actor_id == actor)
                .and_then(|m| m.session_id.clone());
            conversation_members::Entity::insert(conversation_members::ActiveModel {
                workspace_id: Set(self.workspace.clone()),
                conversation_id: Set(id.clone()),
                actor_id: Set(actor.clone()),
                session_id: Set(session),
            })
            .on_conflict(
                OnConflict::columns([
                    conversation_members::Column::WorkspaceId,
                    conversation_members::Column::ConversationId,
                    conversation_members::Column::ActorId,
                ])
                .do_nothing()
                .to_owned(),
            )
            .exec_without_returning(&tx)
            .await?;
        }
        self.conversation_event(&tx, "conversation.changed", &id, json!({}))
            .await?;
        let conversation = self.conversation_in(&tx, &id).await?;
        tx.commit().await?;
        Ok(OpenedThread {
            conversation,
            created,
        })
    }

    /// Closes a thread; any participant may. Reading stays, writing stops.
    /// Record the one shutdown request before issuing it. A lost reply, including a
    /// kernel crash, must never become a second automatic native shutdown request.
    pub(crate) async fn claim_integration_update(
        &self,
        session_id: &str,
        native_id: &str,
        instance_id: &str,
        revision: &str,
    ) -> Result<bool> {
        let tx = self.write().await?;
        let session = sessions::Entity::find_by_id(self.key(session_id))
            .filter(sessions::Column::NativeSessionId.eq(native_id))
            .filter(sessions::Column::StoppedAt.is_null())
            .one(&tx)
            .await?
            .ok_or(Error::StoppedByOwner)?;
        if session.host_id.as_deref() != self.host() {
            return Err(Error::Forbidden);
        }
        let mut locator: Value = decode(&session.native_locator_json)?;
        let intent = json!({"instance_id":instance_id,"revision":revision});
        if locator["integration_update"] == intent {
            return Ok(false);
        }
        locator["integration_update"] = intent;
        sessions::Entity::update_many()
            .filter(sessions::Column::WorkspaceId.eq(&self.workspace))
            .filter(sessions::Column::Id.eq(session_id))
            .col_expr(
                sessions::Column::NativeLocatorJson,
                Expr::value(locator.to_string()),
            )
            .exec(&tx)
            .await?;
        tx.commit().await?;
        Ok(true)
    }

    pub async fn close_thread(&self, who: &ChatIdentity, id: &str) -> Result<Conversation> {
        let tx = self.write().await?;
        self.access_in(&tx, who, id).await?;
        let existing = self.conversation_in(&tx, id).await?;
        if existing.parent_id.is_none() {
            return Err(Error::Invalid("Only a thread can be closed".into()));
        }
        let participant = existing.members.iter().any(|m| {
            who.actor_id.as_deref() == Some(m.actor_id.as_str())
                && (who.session_id.is_none() || m.session_id == who.session_id)
        });
        if !participant && !who.is_person() {
            return Err(Error::Forbidden);
        }
        if existing.closed_at.is_none() {
            conversations::Entity::update_many()
                .col_expr(conversations::Column::ClosedAt, Expr::value(Some(now_ms())))
                .filter(conversations::Column::WorkspaceId.eq(&self.workspace))
                .filter(conversations::Column::Id.eq(id))
                .exec(&tx)
                .await?;
            self.conversation_event(&tx, "conversation.changed", id, json!({}))
                .await?;
        }
        let conversation = self.conversation_in(&tx, id).await?;
        tx.commit().await?;
        Ok(conversation)
    }

    pub async fn add_conversation_member(
        &self,
        who: &ChatIdentity,
        id: &str,
        input: ConversationMemberInput,
    ) -> Result<Conversation> {
        let tx = self.write().await?;
        self.person_in(&tx, who).await?;
        let conversation = self.conversation_in(&tx, id).await?;
        if conversation.kind != "group" {
            return Err(Error::Invalid("Only a group accepts new members".into()));
        }
        self.access_in(&tx, who, id).await?;
        if let Some(member) = conversation
            .members
            .iter()
            .find(|m| m.actor_id == input.actor_id)
        {
            return if member.session_id == input.session_id {
                Ok(conversation)
            } else {
                Err(Error::Conflict)
            };
        }
        self.member_in(&tx, &input).await?;
        conversation_members::ActiveModel {
            workspace_id: Set(self.workspace.clone()),
            conversation_id: Set(id.to_owned()),
            actor_id: Set(input.actor_id),
            session_id: Set(input.session_id),
        }
        .insert(&tx)
        .await?;
        self.conversation_event(&tx, "conversation.changed", id, json!({}))
            .await?;
        let result = self.conversation_in(&tx, id).await?;
        tx.commit().await?;
        Ok(result)
    }

    pub async fn pause_conversation(
        &self,
        who: &ChatIdentity,
        id: &str,
        paused: bool,
    ) -> Result<Conversation> {
        let tx = self.write().await?;
        self.person_in(&tx, who).await?;
        self.access_in(&tx, who, id).await?;
        let existing = self.conversation_in(&tx, id).await?;
        if existing.parent_id.is_some() {
            return Err(Error::Invalid(
                "A thread rests with its chat: pause the chat".into(),
            ));
        }
        if existing.paused != paused {
            conversations::Entity::update_many()
                .col_expr(conversations::Column::Paused, Expr::value(paused))
                .filter(conversations::Column::WorkspaceId.eq(&self.workspace))
                .filter(conversations::Column::Id.eq(id))
                .exec(&tx)
                .await?;
            self.conversation_event(&tx, "conversation.changed", id, json!({}))
                .await?;
            // The threads follow: their readers learn it too.
            let threads = conversations::Entity::find()
                .filter(conversations::Column::WorkspaceId.eq(&self.workspace))
                .filter(conversations::Column::ParentId.eq(id))
                .filter(conversations::Column::ClosedAt.is_null())
                .all(&tx)
                .await?;
            for thread in threads {
                self.conversation_event(&tx, "conversation.changed", &thread.id, json!({}))
                    .await?;
            }
        }
        let result = self.conversation_in(&tx, id).await?;
        tx.commit().await?;
        Ok(result)
    }

    pub async fn chat_messages(
        &self,
        who: &ChatIdentity,
        id: &str,
        after: i64,
        limit: i64,
    ) -> Result<MessagePage> {
        if after < 0 || !(1..=100).contains(&limit) {
            return Err(Error::Invalid(
                "Use a non-negative cursor and a limit from 1 to 100".into(),
            ));
        }
        let tx = self.read().await?;
        self.access_in(&tx, who, id).await?;
        let mut rows = messages::Entity::find()
            .filter(messages::Column::WorkspaceId.eq(&self.workspace))
            .filter(messages::Column::ConversationId.eq(id))
            .filter(messages::Column::Seq.gt(after))
            .order_by_asc(messages::Column::Seq)
            .limit(limit as u64 + 1)
            .all(&tx)
            .await?;
        let has_more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        let mut messages = Vec::with_capacity(rows.len());
        for row in rows {
            messages.push(self.message_in(&tx, &row.id).await?);
        }
        let next_cursor = messages.last().map_or(after, |m| m.seq);
        Ok(MessagePage {
            messages,
            next_cursor,
            has_more,
        })
    }

    pub async fn send_chat_message(
        &self,
        who: &ChatIdentity,
        id: &str,
        input: SendChatMessage,
    ) -> Result<SavedChatMessage> {
        self.require_onboarding().await?;
        uuid(&input.id)?;
        // Preserve intentional whitespace, but count every stored UTF-8 byte toward the limit.
        if input.text.trim().is_empty() || input.text.len() > 64 * 1024 {
            return Err(Error::Invalid(
                "Message must contain text and fit within 64 KiB".into(),
            ));
        }
        let tx = self.write().await?;
        self.access_in(&tx, who, id).await?;
        let members = self.members_in(&tx, id).await?;
        if !members.iter().any(|m| {
            who.actor_id.as_deref() == Some(m.actor_id.as_str())
                && (who.session_id.is_none() || m.session_id == who.session_id)
        }) {
            // The audience of a thread reads it; only its participants write in it.
            return Err(Error::Forbidden);
        }
        // Both the client ID and the correlated final reply identify a single durable message.
        let existing_id = ids(
            &tx,
            sql(
                &tx,
                "SELECT id FROM messages
                WHERE workspace_id=$1 AND (id=$2 OR ($3 IS NOT NULL AND reply_to_delivery_id=$3))
                ORDER BY CASE WHEN id=$2 THEN 0 ELSE 1 END LIMIT 1",
                [
                    (&self.workspace).into(),
                    (&input.id).into(),
                    input.reply_to_delivery_id.clone().into(),
                ],
            ),
        )
        .await?
        .into_iter()
        .next();
        if let Some(existing_id) = existing_id {
            let message = self.message_in(&tx, &existing_id).await?;
            if message.conversation_id != id
                || who.actor_id.as_deref() != Some(message.author_id.as_str())
                || message.text != input.text
                || message.reply_to_delivery_id != input.reply_to_delivery_id
            {
                return Err(Error::Conflict);
            }
            return Ok(SavedChatMessage {
                message,
                created: false,
            });
        }
        // A retry of a message already saved returned above; a new one cannot enter a closed thread.
        let conversation = conversations::Entity::find_by_id(self.key(id))
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        if conversation.closed_at.is_some() {
            return Err(Error::Invalid("This thread is closed".into()));
        }
        if let Some(reply) = &input.reply_to_delivery_id {
            let delivery = self.delivery_in(&tx, reply).await?;
            // A message read before a restart stays with the link that read it, and the same
            // native session may still answer it through its new link.
            let same_context: bool = scalar(
                &tx,
                sql(
                    &tx,
                    "SELECT EXISTS(SELECT 1 FROM sessions old JOIN sessions new
                    ON new.workspace_id=old.workspace_id AND new.actor_id=old.actor_id
                    AND new.harness=old.harness AND new.native_session_id=old.native_session_id
                    WHERE old.workspace_id=$4 AND old.id=$1 AND new.id=$2 AND old.actor_id=$3)",
                    [
                        (&delivery.session_id).into(),
                        who.session_id.clone().into(),
                        who.actor()?.into(),
                        (&self.workspace).into(),
                    ],
                ),
            )
            .await?;
            if !same_context || who.actor_id.as_deref() != Some(delivery.actor_id.as_str()) {
                return Err(Error::Forbidden);
            }
            let original = self.message_in(&tx, &delivery.message_id).await?;
            if original.conversation_id != id || delivery.status == "stored" {
                return Err(Error::Conflict);
            }
        }
        let seq: i64 = scalar(
            &tx,
            sql(
                &tx,
                "UPDATE conversations SET next_seq=next_seq+1
                WHERE workspace_id=$1 AND id=$2 RETURNING next_seq-1",
                [(&self.workspace).into(), id.into()],
            ),
        )
        .await?;
        let now = now_ms();
        messages::ActiveModel {
            workspace_id: Set(self.workspace.clone()),
            id: Set(input.id.clone()),
            conversation_id: Set(id.to_owned()),
            seq: Set(seq),
            author_id: Set(who.actor()?.to_owned()),
            text: Set(input.text.clone()),
            reply_to_delivery_id: Set(input.reply_to_delivery_id.clone()),
            created_at: Set(now),
        }
        .insert(&tx)
        .await?;
        // Every message reaches every other agent member; each agent decides whether to reply.
        for member in members
            .iter()
            .filter(|m| who.actor_id.as_deref() != Some(m.actor_id.as_str()))
        {
            let Some(session) = &member.session_id else {
                continue;
            };
            deliveries::ActiveModel {
                workspace_id: Set(self.workspace.clone()),
                id: Set(Uuid::new_v4().to_string()),
                message_id: Set(input.id.clone()),
                actor_id: Set(member.actor_id.clone()),
                session_id: Set(session.clone()),
                status: Set("stored".into()),
                native_request_id: Set(None),
                last_error: Set(None),
                created_at: Set(now),
                updated_at: Set(now),
            }
            .insert(&tx)
            .await?;
        }
        if let Some(reply) = &input.reply_to_delivery_id {
            let original = deliveries::Entity::update_many()
                .col_expr(deliveries::Column::Status, Expr::value("read"))
                .col_expr(deliveries::Column::LastError, Expr::value(None::<String>))
                .col_expr(deliveries::Column::UpdatedAt, Expr::value(now))
                .filter(deliveries::Column::WorkspaceId.eq(&self.workspace))
                .filter(deliveries::Column::Id.eq(reply))
                .exec_with_returning(&tx)
                .await?
                .pop()
                .ok_or(Error::NotFound)?;
            self.conversation_event(
                &tx,
                "delivery.changed",
                id,
                json!({"message_id":original.message_id}),
            )
            .await?;
            self.read_earlier_in(&tx, reply).await?;
        }
        self.conversation_event(
            &tx,
            "message.created",
            id,
            json!({"message_id":input.id,"seq":seq}),
        )
        .await?;
        let message = self.message_in(&tx, &input.id).await?;
        tx.commit().await?;
        Ok(SavedChatMessage {
            message,
            created: true,
        })
    }

    pub async fn chat_inbox(&self, who: &ChatIdentity) -> Result<ChatInbox> {
        let tx = self.read().await?;
        self.identity_in(&tx, who).await?;
        let id = who.session_id.as_deref().ok_or(Error::Forbidden)?;
        let session = self.session_in(&tx, id).await?;
        let conversations = self.conversations_in(&tx, who).await?;
        // A message waiting in a paused chat is not offered: the inbox lists what may be
        // dispatched now, so a driver never stalls on a refusal. Closing a thread stops new
        // messages, not the ones written before it: those are still delivered.
        let rows: Vec<ChatDelivery> = fetch_all(
            &tx,
            sql(
                &tx,
                                "SELECT d.* FROM deliveries d
                JOIN messages m ON m.workspace_id=d.workspace_id AND m.id=d.message_id
                JOIN conversations c ON c.workspace_id=m.workspace_id AND c.id=m.conversation_id
                LEFT JOIN conversations p ON p.workspace_id=c.workspace_id AND p.id=c.parent_id
                WHERE d.workspace_id=$3 AND d.session_id=$1 AND d.status!='read'
                AND EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=d.workspace_id
                AND cm.conversation_id=m.conversation_id AND cm.actor_id=$2 AND cm.session_id=$1)
                AND NOT (d.status='stored' AND (c.paused OR COALESCE(p.paused,FALSE)))
                ORDER BY d.created_at,d.id",
                [id.into(), who.actor_id.clone().into(), (&self.workspace).into()],
            ),
        )
        .await?;
        let mut deliveries = Vec::with_capacity(rows.len());
        for d in rows {
            deliveries.push(InboxDelivery {
                id: d.id,
                message: self.message_in(&tx, &d.message_id).await?,
                session_id: d.session_id,
                status: d.status,
                native_request_id: d.native_request_id,
            });
        }
        let approvals = self.approvals_in(&tx, who).await?;
        let workspace = workspace::Entity::find_by_id(&self.workspace)
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        Ok(ChatInbox {
            session,
            workspace,
            conversations,
            deliveries,
            approvals,
        })
    }

    pub async fn dispatch_chat_delivery(
        &self,
        who: &ChatIdentity,
        id: &str,
    ) -> Result<DeliveryDispatch> {
        let tx = self.write().await?;
        self.identity_in(&tx, who).await?;
        let delivery = self.delivery_in(&tx, id).await?;
        owns_delivery(who, &delivery)?;
        let message = self.message_in(&tx, &delivery.message_id).await?;
        self.access_in(&tx, who, &message.conversation_id).await?;
        // Nothing starts in a paused chat, nor in a thread whose chat is paused. A closed
        // thread still delivers what was written before it closed.
        let ready: bool = scalar(
            &tx,
            sql(
                &tx,
                                "SELECT EXISTS(SELECT 1 FROM sessions s,conversations c
                LEFT JOIN conversations p ON p.workspace_id=c.workspace_id AND p.id=c.parent_id
                WHERE s.workspace_id=$3 AND s.id=$1 AND s.status='connected' AND s.stopped_at IS NULL
                AND c.workspace_id=$3 AND c.id=$2 AND c.paused=FALSE AND COALESCE(p.paused,FALSE)=FALSE)",
                [
                    (&delivery.session_id).into(),
                    (&message.conversation_id).into(),
                    (&self.workspace).into(),
                ],
            ),
        )
        .await?;
        if !ready || delivery.status != "stored" {
            return Err(Error::Conflict);
        }
        deliveries::Entity::update_many()
            .col_expr(deliveries::Column::Status, Expr::value("uncertain"))
            .col_expr(deliveries::Column::UpdatedAt, Expr::value(now_ms()))
            .filter(deliveries::Column::WorkspaceId.eq(&self.workspace))
            .filter(deliveries::Column::Id.eq(id))
            .exec(&tx)
            .await?;
        self.conversation_event(
            &tx,
            "delivery.changed",
            &message.conversation_id,
            json!({"message_id":message.id}),
        )
        .await?;
        let result = DeliveryDispatch {
            delivery: self.delivery_in(&tx, id).await?,
            message: self.message_in(&tx, &message.id).await?,
        };
        tx.commit().await?;
        Ok(result)
    }

    pub async fn chat_delivery_receipt(
        &self,
        who: &ChatIdentity,
        id: &str,
        input: DeliveryReceipt,
    ) -> Result<ChatDelivery> {
        if !matches!(input.status.as_str(), "notified" | "read" | "uncertain") {
            return Err(Error::Invalid("Unknown delivery receipt".into()));
        }
        let reason = reason(input.reason)?;
        let input_status = input.status.clone();
        let native_id = input
            .native_request_id
            .map(|id| text(&id, "Native request ID", 500, true))
            .transpose()?;
        let tx = self.write().await?;
        self.identity_in(&tx, who).await?;
        let existing = self.delivery_in(&tx, id).await?;
        owns_delivery(who, &existing)?;
        let valid = existing.status == input.status
            || (existing.status == "uncertain"
                && matches!(input.status.as_str(), "notified" | "read"))
            // A native queue can lose what it accepted: the delivery is uncertain again.
            || (existing.status == "notified" && matches!(input.status.as_str(), "read" | "uncertain"));
        if !valid
            || (existing.native_request_id.is_some()
                && native_id.is_some()
                && existing.native_request_id != native_id)
        {
            return Err(Error::Conflict);
        }
        let native_id = native_id.or(existing.native_request_id.clone());
        // Read is final: what an adapter reports afterwards does not rewrite it.
        if existing.status != "read"
            && (existing.status != input.status
                || existing.native_request_id != native_id
                || existing.last_error != reason)
        {
            deliveries::Entity::update_many()
                .col_expr(deliveries::Column::Status, Expr::value(input.status))
                .col_expr(deliveries::Column::NativeRequestId, Expr::value(native_id))
                .col_expr(deliveries::Column::LastError, Expr::value(reason))
                .col_expr(deliveries::Column::UpdatedAt, Expr::value(now_ms()))
                .filter(deliveries::Column::WorkspaceId.eq(&self.workspace))
                .filter(deliveries::Column::Id.eq(id))
                .exec(&tx)
                .await?;
            let message = self.message_in(&tx, &existing.message_id).await?;
            self.conversation_event(
                &tx,
                "delivery.changed",
                &message.conversation_id,
                json!({"message_id":message.id}),
            )
            .await?;
        }
        if input_status == "read" {
            self.read_earlier_in(&tx, id).await?;
        }
        let result = self.delivery_in(&tx, id).await?;
        tx.commit().await?;
        Ok(result)
    }

    pub async fn chat_approvals(&self, who: &ChatIdentity) -> Result<Vec<ChatApproval>> {
        let tx = self.read().await?;
        self.identity_in(&tx, who).await?;
        self.approvals_in(&tx, who).await
    }

    pub async fn create_chat_approval(
        &self,
        who: &ChatIdentity,
        input: CreateChatApproval,
    ) -> Result<ChatApproval> {
        uuid(&input.id)?;
        let native_id = text(&input.native_request_id, "Native request ID", 500, true)?;
        let summary = text(&input.summary, "Approval summary", 1_000, true)?;
        crate::requests::check_request(&input.kind, &input.details)?;
        let tx = self.write().await?;
        self.identity_in(&tx, who).await?;
        // The session asks for itself; a chat delivery, when one started the turn, must be its own.
        let session_id = who.session_id.clone().ok_or(Error::Forbidden)?;
        if let Some(delivery_id) = &input.delivery_id {
            let delivery = self.delivery_in(&tx, delivery_id).await?;
            owns_delivery(who, &delivery)?;
            if delivery.status == "stored" {
                return Err(Error::Conflict);
            }
        }
        let existing_id = ids(
            &tx,
            sql(
                &tx,
                "SELECT id FROM tool_approvals WHERE workspace_id=$4
                AND (id=$1 OR (session_id=$2 AND native_request_id=$3))
                ORDER BY CASE WHEN id=$1 THEN 0 ELSE 1 END LIMIT 1",
                [
                    (&input.id).into(),
                    (&session_id).into(),
                    (&native_id).into(),
                    (&self.workspace).into(),
                ],
            ),
        )
        .await?
        .into_iter()
        .next();
        if let Some(id) = existing_id {
            let existing = self.approval_in(&tx, &id).await?;
            if existing.session_id != session_id
                || existing.delivery_id != input.delivery_id
                || existing.native_request_id != native_id
                || existing.kind != input.kind
                || existing.summary != summary
                || existing.details != input.details
            {
                return Err(Error::Conflict);
            }
            return Ok(existing);
        }
        let now = now_ms();
        tool_approvals::ActiveModel {
            workspace_id: Set(self.workspace.clone()),
            id: Set(input.id.clone()),
            session_id: Set(session_id.clone()),
            delivery_id: Set(input.delivery_id),
            native_request_id: Set(native_id),
            kind: Set(input.kind.clone()),
            summary: Set(summary),
            details_json: Set(input.details.to_string()),
            status: Set("pending".into()),
            decision: Set(None),
            scope: Set(None),
            reason: Set(None),
            answer_json: Set(None),
            last_error: Set(None),
            created_at: Set(now),
            updated_at: Set(now),
            decision_delivered_at: Set(None),
        }
        .insert(&tx)
        .await?;
        self.personal_event(
            &tx,
            "approval.changed",
            &session_id,
            json!({"approval_id":input.id}),
        )
        .await?;
        let result = self.approval_in(&tx, &input.id).await?;
        tx.commit().await?;
        Ok(result)
    }

    /// The owner's decision on a permission: allowed this once, for the session or always,
    /// as far as the harness offers (`details.scopes`); or denied, with a reason the session
    /// hears. The same decision again is no change.
    pub async fn decide_chat_approval(
        &self,
        who: &ChatIdentity,
        id: &str,
        input: ApprovalDecision,
    ) -> Result<ChatApproval> {
        let decision = input.decision.as_str();
        if !matches!(decision, "allow" | "deny") {
            return Err(Error::Invalid("Choose allow or deny".into()));
        }
        let scope = match (decision, input.scope.as_deref()) {
            ("allow", scope) => Some(scope.unwrap_or("once").to_owned()),
            (_, None) => None,
            _ => {
                return Err(Error::Invalid(
                    "Only an allowed permission has a scope".into(),
                ));
            }
        };
        let reason = match (decision, input.reason.map(|given| given.trim().to_owned())) {
            ("deny", Some(given)) if !given.is_empty() => {
                Some(text(&given, "Reason", 2_000, true)?)
            }
            ("allow", Some(given)) if !given.is_empty() => {
                return Err(Error::Invalid("Only a denial has a reason".into()));
            }
            _ => None,
        };
        let tx = self.write().await?;
        let existing = self.approval_in(&tx, id).await?;
        // A session's requests are its person's to decide.
        self.own_in(&tx, who, &existing.session_id).await?;
        if existing.kind != "permission" {
            return Err(Error::Invalid("Answer this request instead".into()));
        }
        if let Some(scope) = &scope {
            let offered = existing.details["scopes"]
                .as_array()
                .map(|scopes| scopes.iter().any(|offered| offered == scope.as_str()))
                .unwrap_or(scope == "once");
            if !offered {
                return Err(Error::Invalid(format!(
                    "This harness does not offer to allow it {}",
                    match scope.as_str() {
                        "session" => "for the session",
                        "always" => "always",
                        _ => "once",
                    }
                )));
            }
        }
        if let Some(previous) = &existing.decision {
            return if previous == decision && existing.scope == scope && existing.reason == reason {
                Ok(existing)
            } else {
                Err(Error::Conflict)
            };
        }
        if existing.status != "pending" {
            return Err(Error::Conflict);
        }
        tool_approvals::Entity::update_many()
            .col_expr(tool_approvals::Column::Status, Expr::value("decided"))
            .col_expr(
                tool_approvals::Column::Decision,
                Expr::value(Some(decision)),
            )
            .col_expr(tool_approvals::Column::Scope, Expr::value(scope))
            .col_expr(tool_approvals::Column::Reason, Expr::value(reason))
            .col_expr(tool_approvals::Column::UpdatedAt, Expr::value(now_ms()))
            .filter(tool_approvals::Column::WorkspaceId.eq(&self.workspace))
            .filter(tool_approvals::Column::Id.eq(id))
            .exec(&tx)
            .await?;
        self.personal_event(
            &tx,
            "approval.changed",
            &existing.session_id,
            json!({"approval_id":id}),
        )
        .await?;
        let result = self.approval_in(&tx, id).await?;
        tx.commit().await?;
        Ok(result)
    }

    /// The owner's answer to a question or a form. The same answer again is no change.
    pub async fn answer_chat_approval(
        &self,
        who: &ChatIdentity,
        id: &str,
        answer: Value,
    ) -> Result<ChatApproval> {
        let tx = self.write().await?;
        let existing = self.approval_in(&tx, id).await?;
        // A session's requests are its person's to decide.
        self.own_in(&tx, who, &existing.session_id).await?;
        crate::requests::check_answer(&existing.kind, &existing.details, &answer)?;
        if let Some(previous) = &existing.answer {
            return if previous == &answer {
                Ok(existing)
            } else {
                Err(Error::Conflict)
            };
        }
        if existing.status != "pending" {
            return Err(Error::Conflict);
        }
        tool_approvals::Entity::update_many()
            .col_expr(tool_approvals::Column::Status, Expr::value("decided"))
            .col_expr(
                tool_approvals::Column::AnswerJson,
                Expr::value(Some(answer.to_string())),
            )
            .col_expr(tool_approvals::Column::UpdatedAt, Expr::value(now_ms()))
            .filter(tool_approvals::Column::WorkspaceId.eq(&self.workspace))
            .filter(tool_approvals::Column::Id.eq(id))
            .exec(&tx)
            .await?;
        self.personal_event(
            &tx,
            "approval.changed",
            &existing.session_id,
            json!({"approval_id":id}),
        )
        .await?;
        let result = self.approval_in(&tx, id).await?;
        tx.commit().await?;
        Ok(result)
    }

    pub async fn dispatch_chat_approval(
        &self,
        who: &ChatIdentity,
        id: &str,
    ) -> Result<ChatApproval> {
        let tx = self.write().await?;
        self.identity_in(&tx, who).await?;
        let existing = self.approval_in(&tx, id).await?;
        owns_approval(who, &existing)?;
        if existing.status != "decided" {
            return Err(Error::Conflict);
        }
        tool_approvals::Entity::update_many()
            .col_expr(tool_approvals::Column::Status, Expr::value("uncertain"))
            .col_expr(tool_approvals::Column::UpdatedAt, Expr::value(now_ms()))
            .filter(tool_approvals::Column::WorkspaceId.eq(&self.workspace))
            .filter(tool_approvals::Column::Id.eq(id))
            .exec(&tx)
            .await?;
        self.personal_event(
            &tx,
            "approval.changed",
            &existing.session_id,
            json!({"approval_id":id}),
        )
        .await?;
        let result = self.approval_in(&tx, id).await?;
        tx.commit().await?;
        Ok(result)
    }

    pub async fn chat_approval_receipt(
        &self,
        who: &ChatIdentity,
        id: &str,
        input: ApprovalReceipt,
    ) -> Result<ChatApproval> {
        if !matches!(
            input.status.as_str(),
            "delivered" | "uncertain" | "resolved"
        ) {
            return Err(Error::Invalid("Unknown approval receipt".into()));
        }
        let reason = reason(input.reason)?;
        let tx = self.write().await?;
        self.identity_in(&tx, who).await?;
        let existing = self.approval_in(&tx, id).await?;
        owns_approval(who, &existing)?;
        let valid = existing.status == input.status
            || input.status == "resolved"
            || (existing.status == "uncertain" && input.status == "delivered");
        if !valid || (existing.status == "resolved" && input.status != "resolved") {
            return Err(Error::Conflict);
        }
        if existing.status != input.status || existing.last_error != reason {
            let now = now_ms();
            execute(
                &tx,
                sql(
                    &tx,
                                        "UPDATE tool_approvals SET status=$1,last_error=$2,updated_at=$3,decision_delivered_at=
                    CASE WHEN $1='delivered' THEN COALESCE(decision_delivered_at,$3) ELSE decision_delivered_at END
                    WHERE workspace_id=$5 AND id=$4",
                    [
                        (&input.status).into(),
                        reason.into(),
                        now.into(),
                        id.into(),
                        (&self.workspace).into(),
                    ],
                ),
            )
            .await?;
            self.personal_event(
                &tx,
                "approval.changed",
                &existing.session_id,
                json!({"approval_id":id}),
            )
            .await?;
        }
        let result = self.approval_in(&tx, id).await?;
        tx.commit().await?;
        Ok(result)
    }

    pub async fn pending_chat_events(&self, limit: i64) -> Result<Vec<ChatEvent>> {
        if !(1..=1000).contains(&limit) {
            return Err(Error::Invalid("Invalid outbox batch size".into()));
        }
        let tx = self.read().await?;
        let rows = chat_outbox::Entity::find()
            .filter(chat_outbox::Column::WorkspaceId.eq(&self.workspace))
            .filter(chat_outbox::Column::PublishedAt.is_null())
            .order_by_asc(chat_outbox::Column::CreatedAt)
            .order_by_asc(chat_outbox::Column::EventId)
            .limit(limit as u64)
            .all(&tx)
            .await?;
        let mut result = Vec::with_capacity(rows.len());
        for row in rows {
            let payload: Value = decode(&row.payload_json)?;
            let mut actor_ids: Vec<String> = decode(&row.recipient_actor_ids_json)?;
            // Rechecked at publication: whoever may read the conversation now (for a thread,
            // the parent's members), so a removed member learns nothing more.
            if let Some(conversation) = payload.get("conversation_id").and_then(Value::as_str) {
                let audience = self.audience_in(&tx, conversation).await?;
                actor_ids.retain(|id| audience.iter().any(|m| &m.actor_id == id));
            }
            result.push(ChatEvent {
                event_id: row.event_id,
                payload,
                actor_ids,
            });
        }
        Ok(result)
    }

    pub async fn mark_chat_event_published(&self, id: &str) -> Result<()> {
        let tx = self.write().await?;
        let marked = execute(
            &tx,
            sql(
                &tx,
                "UPDATE chat_outbox SET published_at=COALESCE(published_at,$1)
                WHERE workspace_id=$3 AND event_id=$2",
                [now_ms().into(), id.into(), (&self.workspace).into()],
            ),
        )
        .await?;
        if marked == 0 {
            return Err(Error::NotFound);
        }
        tx.commit().await?;
        Ok(())
    }
}

/// How far each person has read, the same on all their devices.
impl Store {
    /// A person's read positions: each chat's seq and each session's time, by kind and id.
    pub async fn read_positions(
        &self,
        who: &ChatIdentity,
    ) -> Result<std::collections::HashMap<(String, String), i64>> {
        let Some(actor) = who.actor_id.as_deref().filter(|_| who.is_person()) else {
            return Ok(Default::default());
        };
        Ok(read_positions::Entity::find()
            .filter(read_positions::Column::WorkspaceId.eq(&self.workspace))
            .filter(read_positions::Column::ActorId.eq(actor))
            .all(&self.db)
            .await?
            .into_iter()
            .map(|row| ((row.kind, row.subject_id), row.position))
            .collect())
    }

    /// A workspace from before read positions were kept: what its people had then counts as
    /// read, once, rather than every chat and session showing as new.
    pub async fn adopt_read_positions(&self) -> Result<()> {
        let tx = self.write().await?;
        let kept: i64 = scalar(
            &tx,
            sql(
                &tx,
                "SELECT COUNT(*) FROM read_positions WHERE workspace_id=$1",
                [(&self.workspace).into()],
            ),
        )
        .await?;
        if kept > 0 {
            return Ok(());
        }
        let now = now_ms();
        execute(
            &tx,
            sql(
                &tx,
                "INSERT INTO read_positions (workspace_id,actor_id,kind,subject_id,position,updated_at)
                SELECT a.workspace_id,a.id,'conversation',c.id,
                    COALESCE((SELECT MAX(m.seq) FROM messages m
                    WHERE m.workspace_id=c.workspace_id AND m.conversation_id=c.id),0),$1
                FROM actors a JOIN conversations c ON c.workspace_id=a.workspace_id
                WHERE a.workspace_id=$2 AND a.kind='human'",
                [now.into(), (&self.workspace).into()],
            ),
        )
        .await?;
        execute(
            &tx,
            sql(
                &tx,
                "INSERT INTO read_positions (workspace_id,actor_id,kind,subject_id,position,updated_at)
                SELECT a.workspace_id,a.id,'session',s.id,$1,$1
                FROM actors a JOIN sessions s ON s.workspace_id=a.workspace_id
                WHERE a.workspace_id=$2 AND a.kind='human'",
                [now.into(), (&self.workspace).into()],
            ),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// A person read a chat up to `seq`, or saw a session's work up to `at`: only forward,
    /// and never past what there is. Their other devices hear of it. The position now.
    pub async fn mark_read(
        &self,
        who: &ChatIdentity,
        kind: &str,
        id: &str,
        position: i64,
    ) -> Result<i64> {
        if !who.is_person() {
            return Err(Error::Forbidden);
        }
        let actor = who.actor()?.to_owned();
        let tx = self.write().await?;
        self.identity_in(&tx, who).await?;
        let most = match kind {
            "conversation" => {
                self.conversations_in(&tx, who)
                    .await?
                    .into_iter()
                    .find(|conversation| conversation.id == id)
                    .ok_or(Error::NotFound)?
                    .last_seq
            }
            "session" => {
                self.session_access_in(&tx, who, id, Access::Read).await?;
                now_ms()
            }
            _ => return Err(Error::Invalid("Read a conversation or a session".into())),
        };
        let wanted = position.clamp(0, most);
        let held = read_positions::Entity::find_by_id((
            self.workspace.clone(),
            actor.clone(),
            kind.to_owned(),
            id.to_owned(),
        ))
        .one(&tx)
        .await?;
        let now = match held {
            Some(row) if row.position >= wanted => row.position,
            held => {
                let row = read_positions::ActiveModel {
                    workspace_id: Set(self.workspace.clone()),
                    actor_id: Set(actor.clone()),
                    kind: Set(kind.to_owned()),
                    subject_id: Set(id.to_owned()),
                    position: Set(wanted),
                    updated_at: Set(now_ms()),
                };
                if held.is_some() {
                    row.update(&tx).await?;
                } else {
                    row.insert(&tx).await?;
                }
                self.event_in(
                    &tx,
                    "read.changed",
                    json!({"kind": kind, "id": id, "position": wanted}),
                    vec![actor],
                )
                .await?;
                wanted
            }
        };
        tx.commit().await?;
        Ok(now)
    }
}
