//! Durable chat state. Native harness and LiveKit effects happen outside these transactions.

use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, SqliteConnection};
use uuid::Uuid;

use crate::{
    model::*,
    store::{Error, Result, Store, now_ms, text},
};

fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

fn decode<T: DeserializeOwned>(value: &str) -> Result<T> {
    serde_json::from_str(value).map_err(|e| Error::Database(sqlx::Error::Decode(Box::new(e))))
}

fn uuid(value: &str) -> Result<()> {
    Uuid::parse_str(value).map_err(|_| Error::Invalid("Expected a UUID".into()))?;
    Ok(())
}

fn reason(value: Option<String>) -> Result<Option<String>> {
    value.map(|v| text(&v, "Reason", 2_000, true)).transpose()
}

async fn identity_in(db: &mut SqliteConnection, who: &ChatIdentity) -> Result<()> {
    let valid: bool = if let Some(session) = &who.session_id {
        sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM chat_sessions s JOIN actors a ON a.id=s.actor_id
            WHERE s.id=? AND s.actor_id=? AND s.stopped_at IS NULL AND a.archived=0)",
        )
        .bind(session)
        .bind(&who.actor_id)
        .fetch_one(db)
        .await?
    } else {
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM actors WHERE id=? AND kind='human')")
            .bind(&who.actor_id)
            .fetch_one(db)
            .await?
    };
    if valid {
        Ok(())
    } else {
        Err(Error::Unauthorized)
    }
}

async fn owner_in(db: &mut SqliteConnection, who: &ChatIdentity) -> Result<()> {
    identity_in(db, who).await?;
    if who.is_owner() {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

/// Reading: a member, or a member of a thread's parent (its audience).
async fn access_in(
    db: &mut SqliteConnection,
    who: &ChatIdentity,
    conversation: &str,
) -> Result<()> {
    identity_in(db, who).await?;
    let allowed: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM conversation_members m
        WHERE m.conversation_id IN (?, (SELECT parent_id FROM conversations WHERE id=?))
        AND m.actor_id=? AND (? IS NULL OR m.session_id=?))",
    )
    .bind(conversation)
    .bind(conversation)
    .bind(&who.actor_id)
    .bind(&who.session_id)
    .bind(&who.session_id)
    .fetch_one(db)
    .await?;
    if allowed {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

/// A session with the number of messages that are stored for it and not yet attempted.
/// Stop notes the runtime sets on its own account; an owner's Stop replaces them.
pub const RELINKING: &str = "Relinking after a lost link; the kernel retries on its own.";
pub const LINK_FAILED: &str = "The native link could not be confirmed and its token was revoked. Check the harness before explicitly pairing again; native cancellation was not confirmed.";

const SESSIONS: &str = "SELECT s.*,(SELECT count(*) FROM deliveries d WHERE d.session_id=s.id AND d.status='stored') AS waiting FROM chat_sessions s";

async fn session_in(db: &mut SqliteConnection, id: &str) -> Result<ChatSession> {
    sqlx::query_as(&format!("{SESSIONS} WHERE s.id=?"))
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or(Error::NotFound)
}

async fn session_access(db: &mut SqliteConnection, who: &ChatIdentity, id: &str) -> Result<()> {
    identity_in(db, who).await?;
    if !who.is_owner() && who.session_id.as_deref() != Some(id) {
        return Err(Error::Forbidden);
    }
    Ok(())
}

async fn members_in(db: &mut SqliteConnection, id: &str) -> Result<Vec<ConversationMember>> {
    Ok(sqlx::query_as(
        "SELECT m.actor_id,a.name,a.kind,m.session_id FROM conversation_members m
        JOIN actors a ON a.id=m.actor_id WHERE m.conversation_id=? ORDER BY m.actor_id",
    )
    .bind(id)
    .fetch_all(db)
    .await?)
}

async fn conversation_in(db: &mut SqliteConnection, id: &str) -> Result<Conversation> {
    let (kind, title, paused, last_seq, parent_id, root_message_id, closed_at): (
        String,
        String,
        bool,
        i64,
        Option<String>,
        Option<String>,
        Option<i64>,
    ) = sqlx::query_as(
        // A thread rests with its chat: it has no pause of its own and reports the parent's.
        "SELECT c.kind,c.title,c.paused OR COALESCE(p.paused,0),c.next_seq-1,c.parent_id,c.root_message_id,c.closed_at
        FROM conversations c LEFT JOIN conversations p ON p.id=c.parent_id WHERE c.id=?",
    )
    .bind(id)
    .fetch_optional(&mut *db)
    .await?
    .ok_or(Error::NotFound)?;
    let last_message = sqlx::query_as(
        "SELECT author_id,text,created_at FROM messages WHERE conversation_id=? AND seq=?",
    )
    .bind(id)
    .bind(last_seq)
    .fetch_optional(&mut *db)
    .await?;
    Ok(Conversation {
        id: id.into(),
        kind,
        title,
        paused,
        last_seq,
        members: members_in(db, id).await?,
        parent_id,
        root_message_id,
        closed_at,
        last_message,
    })
}

/// Who may read a conversation: its members, or, for a thread, the members of its parent.
async fn audience_in(db: &mut SqliteConnection, id: &str) -> Result<Vec<ConversationMember>> {
    let parent: Option<String> =
        sqlx::query_scalar("SELECT parent_id FROM conversations WHERE id=?")
            .bind(id)
            .fetch_optional(&mut *db)
            .await?
            .flatten();
    members_in(db, parent.as_deref().unwrap_or(id)).await
}

async fn conversations_in(
    db: &mut SqliteConnection,
    who: &ChatIdentity,
) -> Result<Vec<Conversation>> {
    // What one is a member of, plus the threads of every chat one is in: their audience is
    // the chat's, so the owner reads them and an agent sees which are open before opening one.
    let ids: Vec<String> = sqlx::query_scalar("SELECT c.id FROM conversations c JOIN conversation_members m
        ON m.conversation_id IN (c.id, c.parent_id)
        WHERE m.actor_id=? AND (? IS NULL OR m.session_id=?) GROUP BY c.id ORDER BY c.created_at,c.id")
        .bind(&who.actor_id).bind(&who.session_id).bind(&who.session_id).fetch_all(&mut *db).await?;
    let mut result = Vec::with_capacity(ids.len());
    for id in ids {
        result.push(conversation_in(db, &id).await?);
    }
    Ok(result)
}

async fn event_in(
    db: &mut SqliteConnection,
    kind: &str,
    mut payload: Value,
    mut actors: Vec<String>,
) -> Result<()> {
    actors.sort();
    actors.dedup();
    let id = Uuid::new_v4().to_string();
    payload["event_id"] = json!(id);
    payload["type"] = json!(kind);
    sqlx::query("INSERT INTO chat_outbox(event_id,payload_json,recipient_actor_ids_json,created_at) VALUES (?,?,?,?)")
        .bind(id).bind(payload.to_string()).bind(json!(actors).to_string()).bind(now_ms()).execute(db).await?;
    Ok(())
}

async fn conversation_event(
    db: &mut SqliteConnection,
    kind: &str,
    id: &str,
    mut payload: Value,
) -> Result<()> {
    payload["conversation_id"] = json!(id);
    // Whoever may read the conversation learns of it: for a thread, the parent's members.
    let actors = audience_in(db, id)
        .await?
        .into_iter()
        .map(|m| m.actor_id)
        .collect();
    event_in(db, kind, payload, actors).await
}

async fn personal_event(
    db: &mut SqliteConnection,
    kind: &str,
    session_id: &str,
    payload: Value,
) -> Result<()> {
    let actors: Vec<String> = sqlx::query_scalar(
        "SELECT s.actor_id FROM chat_sessions s WHERE s.id=?
        UNION SELECT a.owner_id FROM actors a JOIN chat_sessions s ON s.actor_id=a.id WHERE s.id=?",
    )
    .bind(session_id)
    .bind(session_id)
    .fetch_all(&mut *db)
    .await?;
    event_in(db, kind, payload, actors).await
}

#[derive(FromRow)]
struct MessageRow {
    id: String,
    conversation_id: String,
    seq: i64,
    author_id: String,
    text: String,
    reply_to_delivery_id: Option<String>,
    created_at: i64,
}

async fn message_in(db: &mut SqliteConnection, id: &str) -> Result<ChatMessage> {
    let row: MessageRow = sqlx::query_as("SELECT * FROM messages WHERE id=?")
        .bind(id)
        .fetch_optional(&mut *db)
        .await?
        .ok_or(Error::NotFound)?;
    let deliveries =
        sqlx::query_as("SELECT * FROM deliveries WHERE message_id=? ORDER BY actor_id")
            .bind(id)
            .fetch_all(&mut *db)
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

async fn delivery_in(db: &mut SqliteConnection, id: &str) -> Result<ChatDelivery> {
    sqlx::query_as("SELECT * FROM deliveries WHERE id=?")
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or(Error::NotFound)
}

async fn agent_session_in(
    db: &mut SqliteConnection,
    who: &ChatIdentity,
    actor_id: &str,
    session_id: &str,
) -> Result<()> {
    let valid: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM chat_sessions s JOIN actors a ON a.id=s.actor_id
        WHERE s.id=? AND s.actor_id=? AND s.stopped_at IS NULL AND a.archived=0 AND a.owner_id=?)",
    )
    .bind(session_id)
    .bind(actor_id)
    .bind(&who.actor_id)
    .fetch_one(&mut *db)
    .await?;
    if valid {
        Ok(())
    } else {
        Err(Error::Invalid(
            "Choose an active session owned by this agent".into(),
        ))
    }
}

/// Messages that were waiting reach an agent together, in one envelope named after its last
/// delivery. Reading that one means having read the others that the same envelope carried.
async fn read_earlier_in(db: &mut SqliteConnection, delivery_id: &str) -> Result<()> {
    let earlier: Vec<(String, String)> = sqlx::query_as(
        "UPDATE deliveries SET status='read',updated_at=?2
        WHERE status IN ('uncertain','notified') AND id!=?1 AND native_request_id=?1
        AND session_id=(SELECT session_id FROM deliveries WHERE id=?1)
        RETURNING message_id,
            (SELECT conversation_id FROM messages WHERE id=deliveries.message_id)",
    )
    .bind(delivery_id)
    .bind(now_ms())
    .fetch_all(&mut *db)
    .await?;
    for (message_id, conversation_id) in earlier {
        conversation_event(
            db,
            "delivery.changed",
            &conversation_id,
            json!({"message_id":message_id}),
        )
        .await?;
    }
    Ok(())
}

/// Revokes a live session and settles its approvals. `note` is the runtime's own stop note.
async fn stop_in(db: &mut SqliteConnection, id: &str, note: Option<&str>) -> Result<()> {
    sqlx::query("UPDATE chat_sessions SET status='stopped',stopped_at=?,attention_reason=?,activity=NULL,activity_conversation_id=NULL WHERE id=?")
        .bind(now_ms()).bind(note).bind(id).execute(&mut *db).await?;
    let approvals: Vec<String> = sqlx::query_scalar(
        "UPDATE tool_approvals SET status='resolved',last_error='Agent stopped',updated_at=?
        WHERE session_id=? AND status!='resolved' RETURNING id",
    )
    .bind(now_ms())
    .bind(id)
    .fetch_all(&mut *db)
    .await?;
    for approval in approvals {
        personal_event(db, "approval.changed", id, json!({"approval_id":approval})).await?;
    }
    personal_event(db, "session.changed", id, json!({"session_id":id})).await?;
    Ok(())
}

/// The session is a member of the conversation; anything else is not its chat.
async fn ensure_member(
    db: &mut SqliteConnection,
    conversation_id: &str,
    actor_id: &str,
    session_id: &str,
) -> Result<()> {
    let member: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM conversation_members WHERE conversation_id=? AND actor_id=? AND session_id=?)",
    )
    .bind(conversation_id)
    .bind(actor_id)
    .bind(session_id)
    .fetch_one(&mut *db)
    .await?;
    if member {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

fn owns_delivery(who: &ChatIdentity, delivery: &ChatDelivery) -> Result<()> {
    if who.session_id.as_deref() == Some(&delivery.session_id) && who.actor_id == delivery.actor_id
    {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

#[derive(FromRow)]
struct ApprovalRow {
    id: String,
    actor_id: String,
    session_id: String,
    conversation_id: String,
    delivery_id: String,
    native_request_id: String,
    summary: String,
    details_json: String,
    status: String,
    decision: Option<String>,
    last_error: Option<String>,
    created_at: i64,
}

async fn approval_in(db: &mut SqliteConnection, id: &str) -> Result<ChatApproval> {
    let row: ApprovalRow = sqlx::query_as(
        "SELECT a.*,d.actor_id,m.conversation_id FROM tool_approvals a
        JOIN deliveries d ON d.id=a.delivery_id JOIN messages m ON m.id=d.message_id WHERE a.id=?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or(Error::NotFound)?;
    Ok(ChatApproval {
        id: row.id,
        actor_id: row.actor_id,
        session_id: row.session_id,
        conversation_id: row.conversation_id,
        delivery_id: row.delivery_id,
        native_request_id: row.native_request_id,
        summary: row.summary,
        details: decode(&row.details_json)?,
        status: row.status,
        decision: row.decision,
        last_error: row.last_error,
        created_at: row.created_at,
    })
}

async fn approvals_in(db: &mut SqliteConnection, who: &ChatIdentity) -> Result<Vec<ChatApproval>> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM tool_approvals WHERE ? IS NULL OR session_id=? ORDER BY created_at,id",
    )
    .bind(&who.session_id)
    .bind(&who.session_id)
    .fetch_all(&mut *db)
    .await?;
    let mut result = Vec::with_capacity(ids.len());
    for id in ids {
        result.push(approval_in(db, &id).await?);
    }
    Ok(result)
}

fn owns_approval(who: &ChatIdentity, approval: &ChatApproval) -> Result<()> {
    if who.session_id.as_deref() == Some(&approval.session_id) && who.actor_id == approval.actor_id
    {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

impl Store {
    pub async fn chat_identity(&self, token: Option<&str>) -> Result<ChatIdentity> {
        if let Some(token) = token {
            let row: Option<(String, String)> = sqlx::query_as("SELECT s.actor_id,s.id FROM chat_sessions s
                JOIN actors a ON a.id=s.actor_id WHERE s.token_hash=? AND s.stopped_at IS NULL AND a.archived=0")
                .bind(token_hash(token)).fetch_optional(&self.pool).await?;
            let (actor_id, session_id) = row.ok_or(Error::Unauthorized)?;
            Ok(ChatIdentity {
                actor_id,
                session_id: Some(session_id),
            })
        } else {
            let actor_id = sqlx::query_scalar("SELECT id FROM actors WHERE kind='human'")
                .fetch_one(&self.pool)
                .await?;
            Ok(ChatIdentity {
                actor_id,
                session_id: None,
            })
        }
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
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        owner_in(&mut tx, who).await?;
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_sessions WHERE harness=? AND native_session_id=? AND stopped_at IS NULL)")
            .bind(input.harness.id()).bind(&native_id).fetch_one(&mut *tx).await?;
        if exists {
            return Err(Error::Conflict);
        }
        // An automatic relink continues only from a session the runtime stopped for it and the
        // owner has not stopped since: checked here, where the successor is created.
        if input.resume {
            let predecessor: Option<Option<String>> = sqlx::query_scalar(
                "SELECT attention_reason FROM chat_sessions WHERE harness=? AND native_session_id=?
                ORDER BY created_at DESC LIMIT 1",
            )
            .bind(input.harness.id())
            .bind(&native_id)
            .fetch_optional(&mut *tx)
            .await?;
            if predecessor.flatten().as_deref() != Some(RELINKING) {
                return Err(Error::StoppedByOwner);
            }
        }
        let actor: Actor = if let Some(id) = input.actor_id {
            sqlx::query_as("SELECT * FROM actors WHERE id=? AND owner_id=? AND kind='agent' AND archived=0 AND harness=?")
                .bind(id).bind(&who.actor_id).bind(input.harness.id()).fetch_optional(&mut *tx).await?.ok_or(Error::Forbidden)?
        } else {
            let name = text(&input.name, "Agent name", 200, true)?;
            sqlx::query_as("INSERT INTO actors(id,name,kind,owner_id,harness,created_at) VALUES (?,?,'agent',?,?,?) RETURNING *")
                .bind(Uuid::new_v4().to_string()).bind(name).bind(&who.actor_id).bind(input.harness.id()).bind(now_ms())
                .fetch_one(&mut *tx).await?
        };
        let id = Uuid::new_v4().to_string();
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        sqlx::query("INSERT INTO chat_sessions(id,actor_id,harness,native_session_id,title,workspace,native_locator_json,token_hash,status,created_at)
            VALUES (?,?,?,?,?,?,?,?,'connecting',?)")
            .bind(&id).bind(&actor.id).bind(input.harness.id()).bind(&native_id).bind(title).bind(workspace)
            .bind(input.native_locator.to_string()).bind(token_hash(&token)).bind(now_ms()).execute(&mut *tx).await?;
        // Reattaching the exact same native context restores its existing conversations.
        // After an owner's Stop, attempted deliveries stay with the old link. After a kernel
        // restart they follow the session, so a message received before it can be answered
        // after it. Only never-attempted deliveries are dispatched: nothing is sent twice.
        let moved = if input.resume {
            "status!='read'"
        } else {
            "status='stored'"
        };
        let conversations: Vec<String> = sqlx::query_scalar(
            "UPDATE conversation_members SET session_id=?
            WHERE actor_id=? AND session_id IN (SELECT id FROM chat_sessions
                WHERE actor_id=? AND harness=? AND native_session_id=? AND stopped_at IS NOT NULL)
            RETURNING conversation_id",
        )
        .bind(&id)
        .bind(&actor.id)
        .bind(&actor.id)
        .bind(input.harness.id())
        .bind(&native_id)
        .fetch_all(&mut *tx)
        .await?;
        let messages: Vec<(String, String)> = sqlx::query_as(&format!("SELECT d.id,m.conversation_id FROM deliveries d
            JOIN messages m ON m.id=d.message_id JOIN conversation_members cm
            ON cm.conversation_id=m.conversation_id AND cm.actor_id=d.actor_id
            WHERE d.actor_id=? AND d.{moved} AND cm.session_id=? AND d.session_id IN (
                SELECT id FROM chat_sessions WHERE actor_id=? AND harness=? AND native_session_id=? AND stopped_at IS NOT NULL)"))
            .bind(&actor.id).bind(&id).bind(&actor.id).bind(input.harness.id()).bind(&native_id)
            .fetch_all(&mut *tx).await?;
        for (delivery_id, conversation_id) in messages {
            let message_id: String = sqlx::query_scalar(&format!(
                "UPDATE deliveries SET session_id=?,updated_at=?
                WHERE id=? AND {moved} RETURNING message_id"
            ))
            .bind(&id)
            .bind(now_ms())
            .bind(delivery_id)
            .fetch_one(&mut *tx)
            .await?;
            conversation_event(
                &mut tx,
                "delivery.changed",
                &conversation_id,
                json!({"message_id":message_id}),
            )
            .await?;
        }
        for conversation in conversations {
            conversation_event(&mut tx, "conversation.changed", &conversation, json!({})).await?;
        }
        personal_event(&mut tx, "session.changed", &id, json!({"session_id":id})).await?;
        let session = session_in(&mut tx, &id).await?;
        tx.commit().await?;
        Ok(IssuedChatSession {
            actor,
            session,
            token,
        })
    }

    pub async fn chat_sessions(&self, who: &ChatIdentity) -> Result<Vec<ChatSession>> {
        let mut tx = self.pool.begin().await?;
        identity_in(&mut tx, who).await?;
        Ok(sqlx::query_as(&format!(
            "{SESSIONS} WHERE ? IS NULL OR s.id=? ORDER BY s.created_at,s.id"
        ))
        .bind(&who.session_id)
        .bind(&who.session_id)
        .fetch_all(&mut *tx)
        .await?)
    }

    /// Called once when the kernel runtime starts, not on every SQLite connection/open.
    /// Persisted presence is not evidence that an adapter is still attached after restart.
    pub async fn recover_chat_sessions(&self) -> Result<()> {
        let reason = "The kernel restarted. Reconnect this session before sending more work.";
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let ids: Vec<String> = sqlx::query_scalar("UPDATE chat_sessions SET status='attention',attention_reason=?,activity=NULL,activity_conversation_id=NULL
            WHERE stopped_at IS NULL AND (status!='attention' OR attention_reason IS NULL OR attention_reason!=?)
            RETURNING id")
            .bind(reason).bind(reason).fetch_all(&mut *tx).await?;
        for id in ids {
            personal_event(&mut tx, "session.changed", &id, json!({"session_id":id})).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn chat_session_locator(&self, who: &ChatIdentity, id: &str) -> Result<Value> {
        let mut tx = self.pool.begin().await?;
        session_access(&mut tx, who, id).await?;
        let value: String =
            sqlx::query_scalar("SELECT native_locator_json FROM chat_sessions WHERE id=?")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(Error::NotFound)?;
        decode(&value)
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
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        owner_in(&mut tx, who).await?;
        let session = session_in(&mut tx, id).await?;
        if session.stopped_at.is_some() {
            return Err(Error::StoppedByOwner);
        }
        let locator: String =
            sqlx::query_scalar("SELECT native_locator_json FROM chat_sessions WHERE id=?")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
        let locator: serde_json::Value = decode(&locator)?;
        if session.harness != "claude-code" || locator["kind"] != "claude-runner" {
            return Err(Error::Invalid(
                "Only an owned Claude runner can renew this link".into(),
            ));
        }
        let actor: Actor = sqlx::query_as(
            "SELECT * FROM actors WHERE id=? AND owner_id=? AND kind='agent' AND archived=0",
        )
        .bind(&session.actor_id)
        .bind(&who.actor_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::Forbidden)?;
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        sqlx::query("UPDATE chat_sessions SET token_hash=?,status='connecting',attention_reason=NULL WHERE id=?")
            .bind(token_hash(&token)).bind(id).execute(&mut *tx).await?;
        personal_event(&mut tx, "session.changed", id, json!({"session_id":id})).await?;
        let session = session_in(&mut tx, id).await?;
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

    /// The owner's Stop. Returns whether the link was already stopped, atomically with
    /// revocation. A session the runtime had stopped on its own account loses that mark: the
    /// owner's decision is recorded and no relink revives it.
    pub async fn stop_chat_session_with_state(
        &self,
        who: &ChatIdentity,
        id: &str,
    ) -> Result<(ChatSession, bool)> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        owner_in(&mut tx, who).await?;
        let existing = session_in(&mut tx, id).await?;
        let was_already_stopped = existing.stopped_at.is_some();
        if !was_already_stopped {
            stop_in(&mut tx, id, None).await?;
        } else if existing
            .attention_reason
            .as_deref()
            .is_some_and(|reason| reason == RELINKING || reason == LINK_FAILED)
        {
            // A decision about the native context: no session of it is revived, and the
            // relink in progress ends here.
            let context: Vec<String> = sqlx::query_scalar(
                "UPDATE chat_sessions SET attention_reason=NULL
                WHERE harness=? AND native_session_id=? AND stopped_at IS NOT NULL AND attention_reason IN (?,?)
                RETURNING id",
            )
            .bind(&existing.harness)
            .bind(&existing.native_session_id)
            .bind(RELINKING)
            .bind(LINK_FAILED)
            .fetch_all(&mut *tx)
            .await?;
            for cleared in context {
                personal_event(
                    &mut tx,
                    "session.changed",
                    &cleared,
                    json!({"session_id":cleared}),
                )
                .await?;
            }
            let pending: Option<String> = sqlx::query_scalar(
                "SELECT id FROM chat_sessions WHERE harness=? AND native_session_id=? AND stopped_at IS NULL",
            )
            .bind(&existing.harness)
            .bind(&existing.native_session_id)
            .fetch_optional(&mut *tx)
            .await?;
            if let Some(pending) = pending {
                stop_in(&mut tx, &pending, None).await?;
            }
        }
        let session = session_in(&mut tx, id).await?;
        tx.commit().await?;
        Ok((session, was_already_stopped))
    }

    /// A stop on the runtime's own account, marked with `note` in the same transaction: before
    /// a relink, or after a pairing that failed. Returns true when the session was already
    /// stopped, by the owner or otherwise: then nothing is marked and nothing is relinked.
    pub async fn stop_chat_session_marked(
        &self,
        who: &ChatIdentity,
        id: &str,
        note: &str,
    ) -> Result<bool> {
        debug_assert!(note == RELINKING || note == LINK_FAILED);
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        owner_in(&mut tx, who).await?;
        let existing = session_in(&mut tx, id).await?;
        if existing.stopped_at.is_some() {
            return Ok(true);
        }
        stop_in(&mut tx, id, Some(note)).await?;
        tx.commit().await?;
        Ok(false)
    }

    /// One session of the owner's, as it is now.
    pub async fn chat_session(&self, who: &ChatIdentity, id: &str) -> Result<ChatSession> {
        let mut tx = self.pool.begin().await?;
        owner_in(&mut tx, who).await?;
        session_in(&mut tx, id).await
    }

    /// A relink that failed leaves the agent without a live session, so its latest session of
    /// that native context waits for attention again and the next relink retries, unless the
    /// owner stopped it meanwhile. The token of the stopped session stays revoked: a fresh one
    /// is issued when the link succeeds.
    pub async fn revive_chat_session(
        &self,
        who: &ChatIdentity,
        harness: &str,
        native_session_id: &str,
        reason: &str,
    ) -> Result<Option<ChatSession>> {
        let reason = text(reason, "Attention reason", 2_000, true)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        owner_in(&mut tx, who).await?;
        let live: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_sessions WHERE harness=? AND native_session_id=? AND stopped_at IS NULL)")
            .bind(harness).bind(native_session_id).fetch_one(&mut *tx).await?;
        if live {
            return Ok(None);
        }
        // Only a session the runtime stopped on its own account: an owner's Stop cleared the mark.
        let revived: Option<String> = sqlx::query_scalar(
            "UPDATE chat_sessions SET status='attention',stopped_at=NULL,attention_reason=?,token_hash=?
            WHERE id=(SELECT id FROM chat_sessions WHERE harness=? AND native_session_id=? ORDER BY created_at DESC LIMIT 1)
            AND attention_reason IN (?,?)
            RETURNING id",
        )
        .bind(reason)
        .bind(token_hash(&format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())))
        .bind(harness)
        .bind(native_session_id)
        .bind(RELINKING)
        .bind(LINK_FAILED)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(id) = revived else {
            return Ok(None);
        };
        personal_event(&mut tx, "session.changed", &id, json!({"session_id":id})).await?;
        let session = session_in(&mut tx, &id).await?;
        tx.commit().await?;
        Ok(Some(session))
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
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        owner_in(&mut tx, who).await?;
        let existing = session_in(&mut tx, id).await?;
        if existing.stopped_at.is_none() || existing.status != "stopped" {
            return Err(Error::Conflict);
        }
        if existing.attention_reason.as_deref() != Some(reason.as_str()) {
            sqlx::query("UPDATE chat_sessions SET attention_reason=? WHERE id=?")
                .bind(reason)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            personal_event(&mut tx, "session.changed", id, json!({"session_id":id})).await?;
        }
        let session = session_in(&mut tx, id).await?;
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
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        session_access(&mut tx, who, id).await?;
        let existing = session_in(&mut tx, id).await?;
        if existing.stopped_at.is_some() {
            return Err(Error::Conflict);
        }
        if existing.status != input.status || existing.attention_reason != reason {
            sqlx::query("UPDATE chat_sessions SET status=?,attention_reason=? WHERE id=?")
                .bind(input.status)
                .bind(reason)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            personal_event(&mut tx, "session.changed", id, json!({"session_id":id})).await?;
        }
        let session = session_in(&mut tx, id).await?;
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
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        session_access(&mut tx, who, id).await?;
        let existing = session_in(&mut tx, id).await?;
        if existing.stopped_at.is_some() {
            return Err(Error::Conflict);
        }
        if let Some(conversation) = &conversation {
            // Its own conversations only: a session cannot claim work on a chat it is not in.
            ensure_member(&mut tx, conversation, &existing.actor_id, id).await?;
        }
        if existing.activity != activity || existing.activity_conversation_id != conversation {
            sqlx::query(
                "UPDATE chat_sessions SET activity=?,activity_conversation_id=? WHERE id=?",
            )
            .bind(activity)
            .bind(conversation)
            .bind(id)
            .execute(&mut *tx)
            .await?;
            personal_event(&mut tx, "session.changed", id, json!({"session_id":id})).await?;
        }
        let session = session_in(&mut tx, id).await?;
        tx.commit().await?;
        Ok(session)
    }

    pub async fn conversations(&self, who: &ChatIdentity) -> Result<Vec<Conversation>> {
        let mut tx = self.pool.begin().await?;
        identity_in(&mut tx, who).await?;
        conversations_in(&mut tx, who).await
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
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        owner_in(&mut tx, who).await?;
        if !input.members.iter().any(|m| m.actor_id == who.actor_id) {
            input.members.push(ConversationMemberInput {
                actor_id: who.actor_id.clone(),
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
            if member.actor_id == who.actor_id {
                if member.session_id.is_some() {
                    return Err(Error::Invalid(
                        "Human members do not have agent sessions".into(),
                    ));
                }
                continue;
            }
            let session_id = member
                .session_id
                .as_deref()
                .ok_or_else(|| Error::Invalid("Choose a session for each agent".into()))?;
            agent_session_in(&mut tx, who, &member.actor_id, session_id).await?;
        }
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO conversations(id,kind,title,created_at) VALUES (?,?,?,?)")
            .bind(&id)
            .bind(input.kind)
            .bind(title)
            .bind(now_ms())
            .execute(&mut *tx)
            .await?;
        for member in input.members {
            sqlx::query("INSERT INTO conversation_members(conversation_id,actor_id,session_id) VALUES (?,?,?)")
                .bind(&id).bind(member.actor_id).bind(member.session_id).execute(&mut *tx).await?;
        }
        conversation_event(&mut tx, "conversation.changed", &id, json!({})).await?;
        let result = conversation_in(&mut tx, &id).await?;
        tx.commit().await?;
        Ok(result)
    }

    /// Renames an agent. Its sessions, conversations and history stay the same.
    pub async fn rename_agent(&self, who: &ChatIdentity, id: &str, name: &str) -> Result<Actor> {
        let name = text(name, "Agent name", 200, true)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        owner_in(&mut tx, who).await?;
        // Members recognize each other by name: two actors never share one.
        let taken: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM actors WHERE id!=? AND archived=0 AND lower(name)=lower(?))",
        )
        .bind(id)
        .bind(&name)
        .fetch_one(&mut *tx)
        .await?;
        if taken {
            return Err(Error::Invalid(
                "Another member already has this name".into(),
            ));
        }
        let actor: Actor = sqlx::query_as(
            "UPDATE actors SET name=? WHERE id=? AND owner_id=? AND kind='agent' AND archived=0 RETURNING *",
        )
        .bind(&name)
        .bind(id)
        .bind(&who.actor_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::NotFound)?;
        let conversations: Vec<String> =
            sqlx::query_scalar("SELECT conversation_id FROM conversation_members WHERE actor_id=?")
                .bind(id)
                .fetch_all(&mut *tx)
                .await?;
        for conversation in conversations {
            conversation_event(&mut tx, "conversation.changed", &conversation, json!({})).await?;
        }
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
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        access_in(&mut tx, who, parent).await?;
        let kind: String = sqlx::query_scalar("SELECT kind FROM conversations WHERE id=?")
            .bind(parent)
            .fetch_one(&mut *tx)
            .await?;
        if kind == "thread" {
            return Err(Error::Invalid("A thread cannot have threads".into()));
        }
        // The root: a message of the parent, named directly or through one of its deliveries.
        let root: Option<String> = sqlx::query_scalar(
            "SELECT m.id FROM messages m WHERE m.conversation_id=?
            AND (m.id=? OR m.id=(SELECT message_id FROM deliveries WHERE id=?)) LIMIT 1",
        )
        .bind(parent)
        .bind(&input.root)
        .bind(&input.root)
        .fetch_optional(&mut *tx)
        .await?;
        let root =
            root.ok_or_else(|| Error::Invalid("The root must be a message of this chat".into()))?;
        let parent_members = members_in(&mut tx, parent).await?;
        let mut roster: Vec<String> = input.participants;
        roster.push(who.actor_id.clone());
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
        let open: Option<String> = sqlx::query_scalar(
            "SELECT id FROM conversations WHERE root_message_id=? AND closed_at IS NULL",
        )
        .bind(&root)
        .fetch_optional(&mut *tx)
        .await?;
        let (id, created) = match open {
            Some(id) => (id, false),
            None => {
                let id = Uuid::new_v4().to_string();
                sqlx::query("INSERT INTO conversations(id,kind,title,created_at,parent_id,root_message_id) VALUES (?,'thread',?,?,?,?)")
                    .bind(&id).bind(title).bind(now_ms()).bind(parent).bind(&root).execute(&mut *tx).await?;
                (id, true)
            }
        };
        // Joining adds to the roster; sessions are the ones serving the parent.
        for actor in &roster {
            let session = parent_members
                .iter()
                .find(|m| &m.actor_id == actor)
                .and_then(|m| m.session_id.clone());
            sqlx::query("INSERT OR IGNORE INTO conversation_members(conversation_id,actor_id,session_id) VALUES (?,?,?)")
                .bind(&id).bind(actor).bind(session).execute(&mut *tx).await?;
        }
        conversation_event(&mut tx, "conversation.changed", &id, json!({})).await?;
        let conversation = conversation_in(&mut tx, &id).await?;
        tx.commit().await?;
        Ok(OpenedThread {
            conversation,
            created,
        })
    }

    /// Closes a thread; any participant may. Reading stays, writing stops.
    pub async fn close_thread(&self, who: &ChatIdentity, id: &str) -> Result<Conversation> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        access_in(&mut tx, who, id).await?;
        let existing = conversation_in(&mut tx, id).await?;
        if existing.parent_id.is_none() {
            return Err(Error::Invalid("Only a thread can be closed".into()));
        }
        let participant = existing.members.iter().any(|m| {
            m.actor_id == who.actor_id
                && (who.session_id.is_none() || m.session_id == who.session_id)
        });
        if !participant && !who.is_owner() {
            return Err(Error::Forbidden);
        }
        if existing.closed_at.is_none() {
            sqlx::query("UPDATE conversations SET closed_at=? WHERE id=?")
                .bind(now_ms())
                .bind(id)
                .execute(&mut *tx)
                .await?;
            conversation_event(&mut tx, "conversation.changed", id, json!({})).await?;
        }
        let conversation = conversation_in(&mut tx, id).await?;
        tx.commit().await?;
        Ok(conversation)
    }

    pub async fn add_conversation_member(
        &self,
        who: &ChatIdentity,
        id: &str,
        input: ConversationMemberInput,
    ) -> Result<Conversation> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        owner_in(&mut tx, who).await?;
        let conversation = conversation_in(&mut tx, id).await?;
        if conversation.kind != "group" {
            return Err(Error::Invalid("Only a group accepts new members".into()));
        }
        let session_id = input
            .session_id
            .as_deref()
            .ok_or_else(|| Error::Invalid("Choose a session for each agent".into()))?;
        if let Some(member) = conversation
            .members
            .iter()
            .find(|m| m.actor_id == input.actor_id)
        {
            return if member.session_id.as_deref() == Some(session_id) {
                Ok(conversation)
            } else {
                Err(Error::Conflict)
            };
        }
        agent_session_in(&mut tx, who, &input.actor_id, session_id).await?;
        sqlx::query(
            "INSERT INTO conversation_members(conversation_id,actor_id,session_id) VALUES (?,?,?)",
        )
        .bind(id)
        .bind(&input.actor_id)
        .bind(session_id)
        .execute(&mut *tx)
        .await?;
        conversation_event(&mut tx, "conversation.changed", id, json!({})).await?;
        let result = conversation_in(&mut tx, id).await?;
        tx.commit().await?;
        Ok(result)
    }

    pub async fn pause_conversation(
        &self,
        who: &ChatIdentity,
        id: &str,
        paused: bool,
    ) -> Result<Conversation> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        owner_in(&mut tx, who).await?;
        access_in(&mut tx, who, id).await?;
        let existing = conversation_in(&mut tx, id).await?;
        if existing.parent_id.is_some() {
            return Err(Error::Invalid(
                "A thread rests with its chat: pause the chat".into(),
            ));
        }
        if existing.paused != paused {
            sqlx::query("UPDATE conversations SET paused=? WHERE id=?")
                .bind(paused)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            conversation_event(&mut tx, "conversation.changed", id, json!({})).await?;
            // The threads follow: their readers learn it too.
            let threads: Vec<String> = sqlx::query_scalar(
                "SELECT id FROM conversations WHERE parent_id=? AND closed_at IS NULL",
            )
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;
            for thread in threads {
                conversation_event(&mut tx, "conversation.changed", &thread, json!({})).await?;
            }
        }
        let result = conversation_in(&mut tx, id).await?;
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
        let mut tx = self.pool.begin().await?;
        access_in(&mut tx, who, id).await?;
        let mut ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM messages WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?",
        )
        .bind(id)
        .bind(after)
        .bind(limit + 1)
        .fetch_all(&mut *tx)
        .await?;
        let has_more = ids.len() > limit as usize;
        ids.truncate(limit as usize);
        let mut messages = Vec::with_capacity(ids.len());
        for id in ids {
            messages.push(message_in(&mut tx, &id).await?);
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
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        access_in(&mut tx, who, id).await?;
        let members = members_in(&mut tx, id).await?;
        if !members.iter().any(|m| {
            m.actor_id == who.actor_id
                && (who.session_id.is_none() || m.session_id == who.session_id)
        }) {
            // The audience of a thread reads it; only its participants write in it.
            return Err(Error::Forbidden);
        }
        // Both the client ID and the correlated final reply identify a single durable message.
        let existing_id: Option<String> = sqlx::query_scalar("SELECT id FROM messages WHERE id=? OR (? IS NOT NULL AND reply_to_delivery_id=?) ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1")
            .bind(&input.id).bind(&input.reply_to_delivery_id).bind(&input.reply_to_delivery_id).bind(&input.id)
            .fetch_optional(&mut *tx).await?;
        if let Some(existing_id) = existing_id {
            let message = message_in(&mut tx, &existing_id).await?;
            if message.conversation_id != id
                || message.author_id != who.actor_id
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
        let closed: bool =
            sqlx::query_scalar("SELECT closed_at IS NOT NULL FROM conversations WHERE id=?")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
        if closed {
            return Err(Error::Invalid("This thread is closed".into()));
        }
        if let Some(reply) = &input.reply_to_delivery_id {
            let delivery = delivery_in(&mut tx, reply).await?;
            // A message read before a restart stays with the link that read it, and the same
            // native session may still answer it through its new link.
            let same_context: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM chat_sessions old JOIN chat_sessions new
                ON new.actor_id=old.actor_id AND new.harness=old.harness
                AND new.native_session_id=old.native_session_id
                WHERE old.id=? AND new.id=? AND old.actor_id=?)",
            )
            .bind(&delivery.session_id)
            .bind(&who.session_id)
            .bind(&who.actor_id)
            .fetch_one(&mut *tx)
            .await?;
            if !same_context || delivery.actor_id != who.actor_id {
                return Err(Error::Forbidden);
            }
            let original = message_in(&mut tx, &delivery.message_id).await?;
            if original.conversation_id != id || delivery.status == "stored" {
                return Err(Error::Conflict);
            }
        }
        let seq: i64 = sqlx::query_scalar(
            "UPDATE conversations SET next_seq=next_seq+1 WHERE id=? RETURNING next_seq-1",
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        let now = now_ms();
        sqlx::query("INSERT INTO messages(id,conversation_id,seq,author_id,text,reply_to_delivery_id,created_at) VALUES (?,?,?,?,?,?,?)")
            .bind(&input.id).bind(id).bind(seq).bind(&who.actor_id).bind(&input.text)
            .bind(&input.reply_to_delivery_id).bind(now)
            .execute(&mut *tx).await?;
        // Every message reaches every other agent member; each agent decides whether to reply.
        for member in members.iter().filter(|m| m.actor_id != who.actor_id) {
            let Some(session) = &member.session_id else {
                continue;
            };
            sqlx::query("INSERT INTO deliveries(id,message_id,actor_id,session_id,status,created_at,updated_at) VALUES (?,?,?,?,'stored',?,?)")
                .bind(Uuid::new_v4().to_string()).bind(&input.id).bind(&member.actor_id).bind(session).bind(now).bind(now)
                .execute(&mut *tx).await?;
        }
        if let Some(reply) = &input.reply_to_delivery_id {
            let original: String = sqlx::query_scalar("UPDATE deliveries SET status='read',last_error=NULL,updated_at=? WHERE id=? RETURNING message_id")
                .bind(now).bind(reply).fetch_one(&mut *tx).await?;
            conversation_event(
                &mut tx,
                "delivery.changed",
                id,
                json!({"message_id":original}),
            )
            .await?;
            read_earlier_in(&mut tx, reply).await?;
        }
        conversation_event(
            &mut tx,
            "message.created",
            id,
            json!({"message_id":input.id,"seq":seq}),
        )
        .await?;
        let message = message_in(&mut tx, &input.id).await?;
        tx.commit().await?;
        Ok(SavedChatMessage {
            message,
            created: true,
        })
    }

    pub async fn chat_inbox(&self, who: &ChatIdentity) -> Result<ChatInbox> {
        let mut tx = self.pool.begin().await?;
        identity_in(&mut tx, who).await?;
        let id = who.session_id.as_deref().ok_or(Error::Forbidden)?;
        let session = session_in(&mut tx, id).await?;
        let conversations = conversations_in(&mut tx, who).await?;
        // A message waiting in a paused chat, or in a closed thread, is not offered: the
        // inbox lists what may be dispatched now, so a driver never stalls on a refusal.
        let rows: Vec<ChatDelivery> = sqlx::query_as("SELECT d.* FROM deliveries d
            JOIN messages m ON m.id=d.message_id JOIN conversations c ON c.id=m.conversation_id
            LEFT JOIN conversations p ON p.id=c.parent_id
            WHERE d.session_id=? AND d.status!='read' AND EXISTS(SELECT 1 FROM conversation_members cm
            WHERE cm.conversation_id=m.conversation_id AND cm.actor_id=? AND cm.session_id=?)
            AND NOT (d.status='stored' AND (c.paused OR COALESCE(p.paused,0) OR c.closed_at IS NOT NULL))
            ORDER BY d.created_at,d.id")
            .bind(id).bind(&who.actor_id).bind(id).fetch_all(&mut *tx).await?;
        let mut deliveries = Vec::with_capacity(rows.len());
        for d in rows {
            deliveries.push(InboxDelivery {
                id: d.id,
                message: message_in(&mut tx, &d.message_id).await?,
                session_id: d.session_id,
                status: d.status,
                native_request_id: d.native_request_id,
            });
        }
        let approvals = approvals_in(&mut tx, who).await?;
        Ok(ChatInbox {
            session,
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
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        identity_in(&mut tx, who).await?;
        let delivery = delivery_in(&mut tx, id).await?;
        owns_delivery(who, &delivery)?;
        let message = message_in(&mut tx, &delivery.message_id).await?;
        access_in(&mut tx, who, &message.conversation_id).await?;
        // Nothing starts in a closed thread, nor in a thread whose chat is paused.
        let ready: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM chat_sessions s,conversations c
            LEFT JOIN conversations p ON p.id=c.parent_id
            WHERE s.id=? AND s.status='connected' AND s.stopped_at IS NULL AND c.id=? AND c.paused=0
            AND c.closed_at IS NULL AND COALESCE(p.paused,0)=0)",
        )
        .bind(&delivery.session_id)
        .bind(&message.conversation_id)
        .fetch_one(&mut *tx)
        .await?;
        if !ready || delivery.status != "stored" {
            return Err(Error::Conflict);
        }
        sqlx::query("UPDATE deliveries SET status='uncertain',updated_at=? WHERE id=?")
            .bind(now_ms())
            .bind(id)
            .execute(&mut *tx)
            .await?;
        conversation_event(
            &mut tx,
            "delivery.changed",
            &message.conversation_id,
            json!({"message_id":message.id}),
        )
        .await?;
        let result = DeliveryDispatch {
            delivery: delivery_in(&mut tx, id).await?,
            message: message_in(&mut tx, &message.id).await?,
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
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        identity_in(&mut tx, who).await?;
        let existing = delivery_in(&mut tx, id).await?;
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
            sqlx::query("UPDATE deliveries SET status=?,native_request_id=?,last_error=?,updated_at=? WHERE id=?")
                .bind(input.status).bind(native_id).bind(reason).bind(now_ms()).bind(id).execute(&mut *tx).await?;
            let message = message_in(&mut tx, &existing.message_id).await?;
            conversation_event(
                &mut tx,
                "delivery.changed",
                &message.conversation_id,
                json!({"message_id":message.id}),
            )
            .await?;
        }
        if input_status == "read" {
            read_earlier_in(&mut tx, id).await?;
        }
        let result = delivery_in(&mut tx, id).await?;
        tx.commit().await?;
        Ok(result)
    }

    pub async fn chat_approvals(&self, who: &ChatIdentity) -> Result<Vec<ChatApproval>> {
        let mut tx = self.pool.begin().await?;
        identity_in(&mut tx, who).await?;
        approvals_in(&mut tx, who).await
    }

    pub async fn create_chat_approval(
        &self,
        who: &ChatIdentity,
        input: CreateChatApproval,
    ) -> Result<ChatApproval> {
        uuid(&input.id)?;
        let native_id = text(&input.native_request_id, "Native request ID", 500, true)?;
        let summary = text(&input.summary, "Approval summary", 1_000, true)?;
        if !input.details.is_object() || input.details.to_string().len() > 64 * 1024 {
            return Err(Error::Invalid(
                "Approval details must be a JSON object of at most 64 KiB".into(),
            ));
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        identity_in(&mut tx, who).await?;
        let delivery = delivery_in(&mut tx, &input.delivery_id).await?;
        owns_delivery(who, &delivery)?;
        if delivery.status == "stored" {
            return Err(Error::Conflict);
        }
        let existing_id: Option<String> = sqlx::query_scalar("SELECT id FROM tool_approvals WHERE id=? OR (session_id=? AND native_request_id=?) ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1")
            .bind(&input.id).bind(&delivery.session_id).bind(&native_id).bind(&input.id).fetch_optional(&mut *tx).await?;
        if let Some(id) = existing_id {
            let existing = approval_in(&mut tx, &id).await?;
            if existing.session_id != delivery.session_id
                || existing.delivery_id != input.delivery_id
                || existing.native_request_id != native_id
                || existing.summary != summary
                || existing.details != input.details
            {
                return Err(Error::Conflict);
            }
            return Ok(existing);
        }
        let now = now_ms();
        sqlx::query("INSERT INTO tool_approvals(id,session_id,delivery_id,native_request_id,summary,details_json,status,created_at,updated_at)
            VALUES (?,?,?,?,?,?,'pending',?,?)")
            .bind(&input.id).bind(&delivery.session_id).bind(&input.delivery_id).bind(native_id).bind(summary)
            .bind(input.details.to_string()).bind(now).bind(now).execute(&mut *tx).await?;
        personal_event(
            &mut tx,
            "approval.changed",
            &delivery.session_id,
            json!({"approval_id":input.id}),
        )
        .await?;
        let result = approval_in(&mut tx, &input.id).await?;
        tx.commit().await?;
        Ok(result)
    }

    pub async fn decide_chat_approval(
        &self,
        who: &ChatIdentity,
        id: &str,
        decision: &str,
    ) -> Result<ChatApproval> {
        if !matches!(decision, "allow" | "deny") {
            return Err(Error::Invalid("Choose allow or deny".into()));
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        owner_in(&mut tx, who).await?;
        let existing = approval_in(&mut tx, id).await?;
        if let Some(previous) = &existing.decision {
            return if previous == decision {
                Ok(existing)
            } else {
                Err(Error::Conflict)
            };
        }
        if existing.status != "pending" {
            return Err(Error::Conflict);
        }
        sqlx::query(
            "UPDATE tool_approvals SET status='decided',decision=?,updated_at=? WHERE id=?",
        )
        .bind(decision)
        .bind(now_ms())
        .bind(id)
        .execute(&mut *tx)
        .await?;
        personal_event(
            &mut tx,
            "approval.changed",
            &existing.session_id,
            json!({"approval_id":id}),
        )
        .await?;
        let result = approval_in(&mut tx, id).await?;
        tx.commit().await?;
        Ok(result)
    }

    pub async fn dispatch_chat_approval(
        &self,
        who: &ChatIdentity,
        id: &str,
    ) -> Result<ChatApproval> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        identity_in(&mut tx, who).await?;
        let existing = approval_in(&mut tx, id).await?;
        owns_approval(who, &existing)?;
        if existing.status != "decided" {
            return Err(Error::Conflict);
        }
        sqlx::query("UPDATE tool_approvals SET status='uncertain',updated_at=? WHERE id=?")
            .bind(now_ms())
            .bind(id)
            .execute(&mut *tx)
            .await?;
        personal_event(
            &mut tx,
            "approval.changed",
            &existing.session_id,
            json!({"approval_id":id}),
        )
        .await?;
        let result = approval_in(&mut tx, id).await?;
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
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        identity_in(&mut tx, who).await?;
        let existing = approval_in(&mut tx, id).await?;
        owns_approval(who, &existing)?;
        let valid = existing.status == input.status
            || input.status == "resolved"
            || (existing.status == "uncertain" && input.status == "delivered");
        if !valid || (existing.status == "resolved" && input.status != "resolved") {
            return Err(Error::Conflict);
        }
        if existing.status != input.status || existing.last_error != reason {
            sqlx::query("UPDATE tool_approvals SET status=?,last_error=?,updated_at=?,decision_delivered_at=
                CASE WHEN ?='delivered' THEN COALESCE(decision_delivered_at,?) ELSE decision_delivered_at END WHERE id=?")
                .bind(&input.status).bind(reason).bind(now_ms()).bind(&input.status).bind(now_ms()).bind(id).execute(&mut *tx).await?;
            personal_event(
                &mut tx,
                "approval.changed",
                &existing.session_id,
                json!({"approval_id":id}),
            )
            .await?;
        }
        let result = approval_in(&mut tx, id).await?;
        tx.commit().await?;
        Ok(result)
    }

    pub async fn pending_chat_events(&self, limit: i64) -> Result<Vec<ChatEvent>> {
        if !(1..=1000).contains(&limit) {
            return Err(Error::Invalid("Invalid outbox batch size".into()));
        }
        let mut tx = self.pool.begin().await?;
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT event_id,payload_json,recipient_actor_ids_json
            FROM chat_outbox WHERE published_at IS NULL ORDER BY created_at,event_id LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&mut *tx)
        .await?;
        let mut result = Vec::with_capacity(rows.len());
        for (event_id, payload_json, recipients_json) in rows {
            let payload: Value = decode(&payload_json)?;
            let mut actor_ids: Vec<String> = decode(&recipients_json)?;
            // Rechecked at publication: whoever may read the conversation now (for a thread,
            // the parent's members), so a removed member learns nothing more.
            if let Some(conversation) = payload.get("conversation_id").and_then(Value::as_str) {
                let audience = audience_in(&mut tx, conversation).await?;
                actor_ids.retain(|id| audience.iter().any(|m| &m.actor_id == id));
            }
            result.push(ChatEvent {
                event_id,
                payload,
                actor_ids,
            });
        }
        Ok(result)
    }

    pub async fn mark_chat_event_published(&self, id: &str) -> Result<()> {
        let result = sqlx::query(
            "UPDATE chat_outbox SET published_at=COALESCE(published_at,?) WHERE event_id=?",
        )
        .bind(now_ms())
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(Error::NotFound);
        }
        Ok(())
    }
}
