use serde_json::json;
use sqlx::{SqlitePool, sqlite::SqliteConnectOptions};
use uuid::Uuid;
use zerolux::{
    harness::Harness,
    model::*,
    store::{Error, Store},
};

struct Fixture {
    dir: tempfile::TempDir,
    store: Store,
    owner: ChatIdentity,
}

impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("chat.db")).await.unwrap();
        store
            .set_owner_name(SetOwnerName {
                name: "Owner fixture".into(),
            })
            .await
            .unwrap();
        let owner = store.chat_identity(None).await.unwrap();
        Self { dir, store, owner }
    }

    async fn hire(&self, name: &str, actor: Option<String>) -> (IssuedChatSession, ChatIdentity) {
        let issued = self
            .store
            .hire_chat_session(
                &self.owner,
                HireChatSession {
                    name: name.into(),
                    actor_id: actor,
                    harness: Harness::ClaudeCode,
                    native_session_id: Uuid::new_v4().to_string(),
                    title: format!("{name} session"),
                    workspace: self.dir.path().to_string_lossy().into_owned(),
                    native_locator: json!({"fixture":"private locator, never published"}),
                    resume: false,
                },
            )
            .await
            .unwrap();
        let identity = self.store.chat_identity(Some(&issued.token)).await.unwrap();
        self.store
            .set_chat_session_status(
                &identity,
                &issued.session.id,
                ChatSessionStatus {
                    status: "connected".into(),
                    reason: None,
                },
            )
            .await
            .unwrap();
        (issued, identity)
    }

    async fn room(&self, agents: &[&IssuedChatSession]) -> Conversation {
        self.store
            .create_conversation(
                &self.owner,
                CreateConversation {
                    kind: if agents.len() == 1 { "dm" } else { "group" }.into(),
                    title: "Chat fixture".into(),
                    members: agents
                        .iter()
                        .map(|a| ConversationMemberInput {
                            actor_id: a.actor.id.clone(),
                            session_id: Some(a.session.id.clone()),
                        })
                        .collect(),
                },
            )
            .await
            .unwrap()
    }

    async fn pool(&self) -> SqlitePool {
        SqlitePool::connect_with(
            SqliteConnectOptions::new()
                .filename(self.dir.path().join("chat.db"))
                .foreign_keys(true),
        )
        .await
        .unwrap()
    }

    async fn clear_outbox(&self) {
        for event in self.store.pending_chat_events(1000).await.unwrap() {
            self.store
                .mark_chat_event_published(&event.event_id)
                .await
                .unwrap();
        }
    }
}

fn delivery_for<'a>(message: &'a ChatMessage, agent: &IssuedChatSession) -> &'a ChatDelivery {
    message
        .deliveries
        .iter()
        .find(|d| d.actor_id == agent.actor.id)
        .unwrap()
}

fn message(text: &str) -> SendChatMessage {
    SendChatMessage {
        id: Uuid::new_v4().to_string(),
        text: text.into(),
        reply_to_delivery_id: None,
    }
}

fn receipt(status: &str) -> DeliveryReceipt {
    DeliveryReceipt {
        status: status.into(),
        native_request_id: None,
        reason: None,
    }
}

#[tokio::test]
async fn identities_are_scoped_tokens_are_not_exposed_and_stop_revokes_cached_identity() {
    let f = Fixture::new().await;
    let (aspen, aspen_id) = f.hire("aspen", None).await;
    let (birch, birch_id) = f.hire("birch", None).await;
    assert_ne!(aspen.session.id, birch.session.id);
    assert_eq!(aspen.session.workspace, birch.session.workspace);
    assert_eq!(aspen.session.harness, birch.session.harness);
    assert!(matches!(
        f.store.chat_identity(Some("invalid")).await,
        Err(Error::Unauthorized)
    ));
    let sessions = f.store.chat_sessions(&aspen_id).await.unwrap();
    assert_eq!(sessions.len(), 1);
    let public = serde_json::to_string(&sessions).unwrap();
    assert!(!public.contains(&aspen.token));
    assert!(!public.contains("private locator"));
    assert!(!public.contains("token_hash"));
    assert!(matches!(
        f.store
            .chat_session_locator(&birch_id, &aspen.session.id)
            .await,
        Err(Error::Forbidden)
    ));
    assert!(
        f.store
            .chat_session_locator(&aspen_id, &aspen.session.id)
            .await
            .unwrap()
            .is_object()
    );
    let stored: String = sqlx::query_scalar("SELECT token_hash FROM chat_sessions WHERE id=?")
        .bind(&aspen.session.id)
        .fetch_one(&f.pool().await)
        .await
        .unwrap();
    assert_eq!(stored.len(), 64);
    assert_ne!(stored, aspen.token);
    assert!(matches!(
        f.store
            .stop_chat_session(&birch_id, &aspen.session.id)
            .await,
        Err(Error::Forbidden)
    ));
    f.store
        .stop_chat_session(&f.owner, &aspen.session.id)
        .await
        .unwrap();
    f.store
        .stop_chat_session(&f.owner, &aspen.session.id)
        .await
        .unwrap();
    assert!(matches!(
        f.store.chat_identity(Some(&aspen.token)).await,
        Err(Error::Unauthorized)
    ));
    assert!(matches!(
        f.store.chat_inbox(&aspen_id).await,
        Err(Error::Unauthorized)
    ));
    assert!(matches!(
        f.store
            .set_chat_session_status(
                &f.owner,
                &aspen.session.id,
                ChatSessionStatus {
                    status: "connected".into(),
                    reason: None,
                }
            )
            .await,
        Err(Error::Conflict)
    ));
    assert!(f.store.chat_identity(Some(&birch.token)).await.is_ok());
}

#[tokio::test]
async fn stop_outcome_survives_reopen_and_repeated_stop_without_releasing_work() {
    let f = Fixture::new().await;
    let (aspen, identity) = f.hire("aspen", None).await;
    let room = f.room(&[&aspen]).await;
    let sent = f
        .store
        .send_chat_message(&f.owner, &room.id, message("Inspect"))
        .await
        .unwrap();
    let delivery = &sent.message.deliveries[0].id;
    f.store
        .dispatch_chat_delivery(&identity, delivery)
        .await
        .unwrap();
    let reason = "The link is stopped, but native cancellation could not be confirmed.";
    assert!(matches!(
        f.store
            .note_chat_stop(&identity, &aspen.session.id, reason)
            .await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        f.store
            .note_chat_stop(&f.owner, &aspen.session.id, reason)
            .await,
        Err(Error::Conflict)
    ));
    let (stopped, was_already_stopped) = f
        .store
        .stop_chat_session_with_state(&f.owner, &aspen.session.id)
        .await
        .unwrap();
    assert!(!was_already_stopped);
    f.clear_outbox().await;
    for invalid in [String::new(), "x".repeat(2_001)] {
        assert!(matches!(
            f.store
                .note_chat_stop(&f.owner, &aspen.session.id, &invalid)
                .await,
            Err(Error::Invalid(_))
        ));
    }
    f.store
        .note_chat_stop(&f.owner, &aspen.session.id, reason)
        .await
        .unwrap();
    f.store
        .note_chat_stop(&f.owner, &aspen.session.id, reason)
        .await
        .unwrap();
    let reopened = Store::open(&f.dir.path().join("chat.db")).await.unwrap();
    let (session, was_already_stopped) = reopened
        .stop_chat_session_with_state(&f.owner, &aspen.session.id)
        .await
        .unwrap();
    assert!(was_already_stopped);
    assert_eq!(session.status, "stopped");
    assert_eq!(session.stopped_at, stopped.stopped_at);
    assert_eq!(session.attention_reason.as_deref(), Some(reason));
    assert!(matches!(
        reopened.chat_identity(Some(&aspen.token)).await,
        Err(Error::Unauthorized)
    ));
    assert!(matches!(
        reopened.dispatch_chat_delivery(&identity, delivery).await,
        Err(Error::Unauthorized)
    ));
    let page = reopened
        .chat_messages(&f.owner, &room.id, 0, 100)
        .await
        .unwrap();
    assert_eq!(page.messages.len(), 1);
    assert_eq!(page.messages[0].deliveries[0].status, "uncertain");
    let events = reopened.pending_chat_events(100).await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].payload["type"], "session.changed");
    assert_eq!(events[0].payload["session_id"], aspen.session.id);
    assert!(events[0].payload.get("reason").is_none());
}

#[tokio::test]
async fn native_session_is_unique_without_reserving_the_workspace_or_creating_an_extra_actor() {
    let f = Fixture::new().await;
    let (aspen, _) = f.hire("aspen", None).await;
    let before = f.store.workspace().await.unwrap().actors.len();
    assert!(matches!(
        f.store
            .hire_chat_session(
                &f.owner,
                HireChatSession {
                    name: "duplicate".into(),
                    actor_id: None,
                    harness: Harness::ClaudeCode,
                    native_session_id: aspen.session.native_session_id.clone(),
                    title: "duplicate".into(),
                    workspace: aspen.session.workspace.clone(),
                    native_locator: json!({}),
                    resume: false,
                }
            )
            .await,
        Err(Error::Conflict)
    ));
    assert_eq!(f.store.workspace().await.unwrap().actors.len(), before);
    assert!(f.store.workspace().await.unwrap().connections.is_empty());
}

#[tokio::test]
async fn one_context_serves_direct_and_overlapping_groups_with_scoped_deliveries() {
    let f = Fixture::new().await;
    let (aspen, aspen_id) = f.hire("aspen", None).await;
    let (birch, birch_id) = f.hire("birch", None).await;
    let (cedar, _) = f.hire("cedar", None).await;
    let group = f.room(&[&aspen, &birch, &cedar]).await;
    let other_group = f.room(&[&birch, &aspen]).await;
    let overlapping_group = f.room(&[&aspen, &cedar]).await;
    let shared_dm = f.room(&[&aspen]).await;
    assert_ne!(group.id, other_group.id);
    assert!(group.members.iter().any(|m| m.name == "birch"));
    assert!(
        group
            .members
            .iter()
            .any(|m| m.name == "birch" && m.kind == "agent")
    );
    assert!(
        group
            .members
            .iter()
            .any(|m| m.actor_id == f.owner.actor_id && m.kind == "human")
    );
    let chats = [
        (&group, vec![&aspen, &birch, &cedar]),
        (&other_group, vec![&aspen, &birch]),
        (&overlapping_group, vec![&aspen, &cedar]),
        (&shared_dm, vec![&aspen]),
    ];
    let mut dm_delivery = None;
    for (chat, agents) in &chats {
        let sent = f
            .store
            .send_chat_message(&f.owner, &chat.id, message("For this chat"))
            .await
            .unwrap();
        let mut actual: Vec<_> = sent
            .message
            .deliveries
            .iter()
            .map(|d| (&d.actor_id, &d.session_id))
            .collect();
        let mut expected: Vec<_> = agents
            .iter()
            .map(|a| (&a.actor.id, &a.session.id))
            .collect();
        actual.sort();
        expected.sort();
        assert_eq!(actual, expected);
        if chat.id == shared_dm.id {
            dm_delivery = Some(sent.message.deliveries[0].id.clone());
        }
    }
    let inbox = f.store.chat_inbox(&aspen_id).await.unwrap();
    assert_eq!(inbox.deliveries.len(), 4);
    assert_eq!(inbox.conversations.len(), 4);
    assert!(
        inbox
            .deliveries
            .iter()
            .all(|d| d.session_id == aspen.session.id)
    );
    let dm_delivery = dm_delivery.unwrap();
    assert!(matches!(
        f.store
            .dispatch_chat_delivery(&birch_id, &dm_delivery)
            .await,
        Err(Error::Forbidden)
    ));
    f.store
        .dispatch_chat_delivery(&aspen_id, &dm_delivery)
        .await
        .unwrap();
    let mut reply = message("DM answer");
    reply.reply_to_delivery_id = Some(dm_delivery);
    assert!(matches!(
        f.store
            .send_chat_message(&aspen_id, &group.id, reply.clone())
            .await,
        Err(Error::Conflict)
    ));
    let saved = f
        .store
        .send_chat_message(&aspen_id, &shared_dm.id, reply.clone())
        .await
        .unwrap();
    assert!(saved.message.deliveries.is_empty());
    let repeated = f
        .store
        .send_chat_message(&aspen_id, &shared_dm.id, reply)
        .await
        .unwrap();
    assert!(!repeated.created);
    assert_eq!(saved.message.id, repeated.message.id);
    assert!(matches!(
        f.store
            .chat_messages(&birch_id, &shared_dm.id, 0, 100)
            .await,
        Err(Error::Forbidden)
    ));
    let (private_aspen, private_id) = f.hire("private aspen", Some(aspen.actor.id.clone())).await;
    let dm = f.room(&[&private_aspen]).await;
    assert_eq!(private_aspen.actor.id, aspen.actor.id);
    assert!(matches!(
        f.store.chat_messages(&aspen_id, &dm.id, 0, 100).await,
        Err(Error::Forbidden)
    ));
    for (chat, _) in &chats {
        assert!(matches!(
            f.store.chat_messages(&private_id, &chat.id, 0, 100).await,
            Err(Error::Forbidden)
        ));
        assert!(matches!(
            f.store
                .send_chat_message(&private_id, &chat.id, message("Not a member"))
                .await,
            Err(Error::Forbidden)
        ));
    }
    assert!(matches!(
        f.store
            .create_conversation(
                &aspen_id,
                CreateConversation {
                    kind: "group".into(),
                    title: "Unauthorized".into(),
                    members: vec![],
                }
            )
            .await,
        Err(Error::Forbidden)
    ));
}

#[tokio::test]
async fn expanding_one_of_two_equal_groups_keeps_the_other_membership_unchanged() {
    let f = Fixture::new().await;
    let (alpha, alpha_id) = f.hire("alpha", None).await;
    let (beta, _) = f.hire("beta", None).await;
    let (gamma, gamma_id) = f.hire("gamma", None).await;
    // Equal memberships are allowed at creation; adding gamma to one group
    // must leave the other unchanged.
    let team = f.room(&[&alpha, &beta]).await;
    let other = f.room(&[&beta, &alpha]).await;
    let dm = f.room(&[&gamma]).await;
    f.store
        .send_chat_message(&f.owner, &team.id, message("Before gamma joined"))
        .await
        .unwrap();

    let expanded = f
        .store
        .add_conversation_member(
            &f.owner,
            &team.id,
            ConversationMemberInput {
                actor_id: gamma.actor.id.clone(),
                session_id: Some(gamma.session.id.clone()),
            },
        )
        .await
        .unwrap();
    assert_eq!(expanded.members.len(), 4);
    assert!(expanded.members.iter().any(|m| {
        m.actor_id == gamma.actor.id && m.session_id.as_deref() == Some(&gamma.session.id)
    }));
    let inbox = f.store.chat_inbox(&alpha_id).await.unwrap();
    let unchanged = inbox
        .conversations
        .iter()
        .find(|c| c.id == other.id)
        .unwrap();
    assert_eq!(unchanged.members.len(), 3);
    assert!(
        unchanged
            .members
            .iter()
            .all(|m| m.actor_id != gamma.actor.id)
    );
    assert!(
        f.store
            .chat_inbox(&gamma_id)
            .await
            .unwrap()
            .deliveries
            .is_empty()
    );
    assert!(matches!(
        f.store.chat_messages(&gamma_id, &other.id, 0, 100).await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        f.store.chat_messages(&alpha_id, &dm.id, 0, 100).await,
        Err(Error::Forbidden)
    ));

    let sent = f
        .store
        .send_chat_message(&f.owner, &team.id, message("After gamma joined"))
        .await
        .unwrap();
    assert_eq!(sent.message.deliveries.len(), 3);
    for agent in [&alpha, &beta, &gamma] {
        assert_eq!(
            delivery_for(&sent.message, agent).session_id,
            agent.session.id
        );
    }
    let inbox = f.store.chat_inbox(&gamma_id).await.unwrap();
    assert_eq!(inbox.deliveries.len(), 1);
    assert_eq!(inbox.deliveries[0].message.id, sent.message.id);
}

#[tokio::test]
async fn a_group_accepts_sessions_from_other_chats_without_retroactive_deliveries() {
    let f = Fixture::new().await;
    let (aspen, aspen_id) = f.hire("aspen", None).await;
    let (birch, _) = f.hire("birch", None).await;
    let (cedar, cedar_id) = f.hire("cedar", None).await;
    let (busy, _) = f.hire("busy", None).await;
    let team = f.room(&[&aspen, &birch]).await;
    f.room(&[&aspen]).await;
    f.store
        .send_chat_message(&f.owner, &team.id, message("before cedar"))
        .await
        .unwrap();
    let member = |agent: &IssuedChatSession| ConversationMemberInput {
        actor_id: agent.actor.id.clone(),
        session_id: Some(agent.session.id.clone()),
    };
    assert!(matches!(
        f.store
            .add_conversation_member(&aspen_id, &team.id, member(&cedar))
            .await,
        Err(Error::Forbidden)
    ));
    f.room(&[&busy]).await;
    f.store
        .add_conversation_member(&f.owner, &team.id, member(&busy))
        .await
        .unwrap();
    let joined = f
        .store
        .add_conversation_member(&f.owner, &team.id, member(&cedar))
        .await
        .unwrap();
    assert_eq!(joined.members.len(), 5);
    let again = f
        .store
        .add_conversation_member(&f.owner, &team.id, member(&cedar))
        .await
        .unwrap();
    assert_eq!(again.members.len(), 5);
    let history = f
        .store
        .chat_messages(&cedar_id, &team.id, 0, 100)
        .await
        .unwrap();
    assert_eq!(history.messages[0].text, "before cedar");
    assert!(
        f.store
            .chat_inbox(&cedar_id)
            .await
            .unwrap()
            .deliveries
            .is_empty()
    );
    let next = f
        .store
        .send_chat_message(&aspen_id, &team.id, message("welcome"))
        .await
        .unwrap();
    assert_eq!(next.message.deliveries.len(), 3);
    for agent in [&birch, &busy, &cedar] {
        assert_eq!(
            delivery_for(&next.message, agent).session_id,
            agent.session.id
        );
    }
    let (solo, _) = f.hire("solo", None).await;
    let (late, _) = f.hire("late", None).await;
    let dm = f.room(&[&solo]).await;
    assert!(matches!(
        f.store
            .add_conversation_member(&f.owner, &dm.id, member(&late))
            .await,
        Err(Error::Invalid(_))
    ));
}

#[tokio::test]
async fn the_owner_renames_an_agent_and_names_stay_distinct() {
    let f = Fixture::new().await;
    let (aspen, aspen_id) = f.hire("aspen", None).await;
    let (birch, birch_id) = f.hire("birch", None).await;
    let room = f.room(&[&aspen, &birch]).await;
    f.clear_outbox().await;
    assert!(matches!(
        f.store
            .rename_agent(&birch_id, &birch.actor.id, "bridge")
            .await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        f.store
            .rename_agent(&f.owner, &birch.actor.id, "Aspen")
            .await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        f.store
            .rename_agent(&f.owner, &f.owner.actor_id, "bridge")
            .await,
        Err(Error::NotFound)
    ));
    let renamed = f
        .store
        .rename_agent(&f.owner, &birch.actor.id, "bridge")
        .await
        .unwrap();
    assert_eq!(renamed.name, "bridge");
    let inbox = f.store.chat_inbox(&aspen_id).await.unwrap();
    assert_eq!(inbox.conversations[0].id, room.id);
    assert!(
        inbox.conversations[0]
            .members
            .iter()
            .any(|m| m.name == "bridge")
    );
    assert_eq!(f.store.pending_chat_events(100).await.unwrap().len(), 1);
    // The session keeps working under the new name.
    f.store.chat_inbox(&birch_id).await.unwrap();
}

#[tokio::test]
async fn reading_a_message_reads_the_others_its_envelope_carried() {
    let f = Fixture::new().await;
    let (aspen, aspen_id) = f.hire("aspen", None).await;
    let room = f.room(&[&aspen]).await;
    let mut ids = Vec::new();
    for text in ["first", "second", "never attempted", "after"] {
        let sent = f
            .store
            .send_chat_message(&f.owner, &room.id, message(text))
            .await
            .unwrap();
        ids.push(sent.message.deliveries[0].id.clone());
    }
    for id in [&ids[0], &ids[1], &ids[3]] {
        f.store.dispatch_chat_delivery(&aspen_id, id).await.unwrap();
    }
    // The second envelope carried "second" and "after"; "first" went out alone and failed.
    for id in [&ids[1], &ids[3]] {
        let mut carried = receipt("uncertain");
        carried.native_request_id = Some(ids[3].clone());
        f.store
            .chat_delivery_receipt(&aspen_id, id, carried)
            .await
            .unwrap();
    }
    f.store
        .chat_delivery_receipt(&aspen_id, &ids[3], receipt("read"))
        .await
        .unwrap();
    let page = f
        .store
        .chat_messages(&f.owner, &room.id, 0, 100)
        .await
        .unwrap();
    let states: Vec<_> = page
        .messages
        .iter()
        .map(|m| m.deliveries[0].status.as_str())
        .collect();
    assert_eq!(states, ["uncertain", "read", "stored", "read"]);
    let mut late = receipt("read");
    late.reason = Some("Reported after the agent confirmed the read".into());
    let kept = f
        .store
        .chat_delivery_receipt(&aspen_id, &ids[3], late)
        .await
        .unwrap();
    assert_eq!(kept.last_error, None, "read is final");
    let updated: i64 = sqlx::query_scalar("SELECT min(updated_at) FROM deliveries")
        .fetch_one(&f.pool().await)
        .await
        .unwrap();
    assert!(updated > 1_000_000_000_000, "timestamps stay timestamps");
}

#[tokio::test]
async fn a_native_batch_reads_multiple_chats_but_never_another_sessions_delivery() {
    let f = Fixture::new().await;
    let (aspen, aspen_id) = f.hire("aspen", None).await;
    let (birch, birch_id) = f.hire("birch", None).await;
    let dm = f.room(&[&aspen]).await;
    let group = f.room(&[&aspen, &birch]).await;
    let direct = f
        .store
        .send_chat_message(&f.owner, &dm.id, message("DM first"))
        .await
        .unwrap();
    let shared = f
        .store
        .send_chat_message(&f.owner, &group.id, message("Group next"))
        .await
        .unwrap();
    f.store
        .send_chat_message(&f.owner, &dm.id, message("Not in the batch"))
        .await
        .unwrap();
    let first = &delivery_for(&direct.message, &aspen).id;
    let anchor = &delivery_for(&shared.message, &aspen).id;
    let other = &delivery_for(&shared.message, &birch).id;
    for (identity, id, native) in [
        (&aspen_id, first, anchor.as_str()),
        (&aspen_id, anchor, "fixture-queue"),
        // Even the same native marker on a different link cannot inherit this read.
        (&birch_id, other, anchor.as_str()),
    ] {
        f.store.dispatch_chat_delivery(identity, id).await.unwrap();
        let mut accepted = receipt("notified");
        accepted.native_request_id = Some(native.into());
        f.store
            .chat_delivery_receipt(identity, id, accepted)
            .await
            .unwrap();
    }
    f.store
        .chat_delivery_receipt(&aspen_id, anchor, receipt("read"))
        .await
        .unwrap();
    let direct = f
        .store
        .chat_messages(&f.owner, &dm.id, 0, 100)
        .await
        .unwrap();
    assert_eq!(direct.messages[0].deliveries[0].status, "read");
    assert_eq!(direct.messages[1].deliveries[0].status, "stored");
    let shared = f
        .store
        .chat_messages(&f.owner, &group.id, 0, 100)
        .await
        .unwrap();
    assert_eq!(delivery_for(&shared.messages[0], &aspen).status, "read");
    assert_eq!(delivery_for(&shared.messages[0], &birch).status, "notified");
    let mut wrong_reply = message("Wrong chat");
    wrong_reply.reply_to_delivery_id = Some(anchor.clone());
    assert!(
        f.store
            .send_chat_message(&aspen_id, &dm.id, wrong_reply)
            .await
            .is_err()
    );
    assert!(
        f.store
            .chat_messages(&birch_id, &dm.id, 0, 100)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn renewing_an_owned_link_keeps_deliveries_approvals_and_permission_mode() {
    let f = Fixture::new().await;
    let owned = f
        .store
        .hire_chat_session(
            &f.owner,
            HireChatSession {
                name: "Owned fixture".into(),
                actor_id: None,
                harness: Harness::ClaudeCode,
                native_session_id: Uuid::new_v4().to_string(),
                title: "Owned session".into(),
                workspace: f.dir.path().to_string_lossy().into_owned(),
                native_locator: json!({"kind":"claude-runner","permission_mode":"plan"}),
                resume: false,
            },
        )
        .await
        .unwrap();
    let old_identity = f.store.chat_identity(Some(&owned.token)).await.unwrap();
    f.store
        .set_chat_session_status(
            &old_identity,
            &owned.session.id,
            ChatSessionStatus {
                status: "connected".into(),
                reason: None,
            },
        )
        .await
        .unwrap();
    let room = f.room(&[&owned]).await;
    let mut ids = Vec::new();
    for text in ["Read opener", "Attempted input", "Never attempted"] {
        let sent = f
            .store
            .send_chat_message(&f.owner, &room.id, message(text))
            .await
            .unwrap();
        ids.push(sent.message.deliveries[0].id.clone());
    }
    for id in &ids[..2] {
        f.store
            .dispatch_chat_delivery(&old_identity, id)
            .await
            .unwrap();
    }
    f.store
        .chat_delivery_receipt(&old_identity, &ids[0], receipt("read"))
        .await
        .unwrap();
    let mut approvals = Vec::new();
    for state in ["pending", "decided", "uncertain"] {
        let approval = f
            .store
            .create_chat_approval(
                &old_identity,
                CreateChatApproval {
                    id: Uuid::new_v4().to_string(),
                    delivery_id: ids[0].clone(),
                    native_request_id: format!("fixture-{state}"),
                    summary: "Fixture permission".into(),
                    details: json!({}),
                },
            )
            .await
            .unwrap();
        if state != "pending" {
            f.store
                .decide_chat_approval(&f.owner, &approval.id, "allow")
                .await
                .unwrap();
        }
        if state == "uncertain" {
            f.store
                .dispatch_chat_approval(&old_identity, &approval.id)
                .await
                .unwrap();
        }
        approvals.push(approval.id);
    }
    let before =
        serde_json::to_value(f.store.chat_approvals(&old_identity).await.unwrap()).unwrap();
    let messages = serde_json::to_value(
        f.store
            .chat_messages(&f.owner, &room.id, 0, 100)
            .await
            .unwrap(),
    )
    .unwrap();
    let renewed = f
        .store
        .renew_owned_chat_session(&f.owner, &owned.session.id)
        .await
        .unwrap();
    assert_eq!(renewed.session.id, owned.session.id);
    assert_eq!(renewed.actor.id, owned.actor.id);
    assert_eq!(
        renewed.session.native_session_id,
        owned.session.native_session_id
    );
    assert_eq!(renewed.session.status, "connecting");
    assert_ne!(renewed.token, owned.token);
    assert!(matches!(
        f.store.chat_identity(Some(&owned.token)).await,
        Err(Error::Unauthorized)
    ));
    let identity = f.store.chat_identity(Some(&renewed.token)).await.unwrap();
    assert_eq!(identity.session_id, old_identity.session_id);
    assert_eq!(
        serde_json::to_value(f.store.chat_approvals(&identity).await.unwrap()).unwrap(),
        before
    );
    assert_eq!(
        serde_json::to_value(
            f.store
                .chat_messages(&f.owner, &room.id, 0, 100)
                .await
                .unwrap()
        )
        .unwrap(),
        messages
    );
    assert_eq!(
        f.store
            .chat_session_locator(&f.owner, &renewed.session.id)
            .await
            .unwrap()["permission_mode"],
        "plan"
    );
    assert!(
        matches!(
            f.store
                .dispatch_chat_approval(&identity, &approvals[2])
                .await,
            Err(Error::Conflict)
        ),
        "an uncertain permission decision is not repeated after rotation"
    );
    assert_eq!(f.store.chat_sessions(&f.owner).await.unwrap().len(), 1);
    // A consumed delivery still belongs to this identity, including for a delayed reply.
    let mut reply = message("After the kernel returned");
    reply.reply_to_delivery_id = Some(ids[0].clone());
    f.store
        .send_chat_message(&identity, &room.id, reply)
        .await
        .unwrap();
    assert!(matches!(
        f.store
            .renew_owned_chat_session(&identity, &renewed.session.id)
            .await,
        Err(Error::Forbidden)
    ));
    f.store
        .stop_chat_session(&f.owner, &renewed.session.id)
        .await
        .unwrap();
    assert!(matches!(
        f.store
            .renew_owned_chat_session(&f.owner, &renewed.session.id)
            .await,
        Err(Error::StoppedByOwner)
    ));
    assert!(matches!(
        f.store.chat_identity(Some(&renewed.token)).await,
        Err(Error::Unauthorized)
    ));
}

#[tokio::test]
async fn owned_rotation_refuses_an_existing_terminal_link_without_changing_its_token() {
    let f = Fixture::new().await;
    let (terminal, _) = f.hire("Terminal fixture", None).await;
    assert!(matches!(
        f.store
            .renew_owned_chat_session(&f.owner, &terminal.session.id)
            .await,
        Err(Error::Invalid(_))
    ));
    assert_eq!(
        f.store
            .chat_identity(Some(&terminal.token))
            .await
            .unwrap()
            .session_id
            .as_deref(),
        Some(terminal.session.id.as_str())
    );
}

#[tokio::test]
async fn waiting_counts_the_whole_queue_of_one_session() {
    let f = Fixture::new().await;
    let (aspen, aspen_id) = f.hire("aspen", None).await;
    let (birch, _) = f.hire("birch", None).await;
    let room = f.room(&[&aspen, &birch]).await;
    let mut ids = Vec::new();
    for text in ["read", "uncertain", "stored", "stored too"] {
        let sent = f
            .store
            .send_chat_message(&f.owner, &room.id, message(text))
            .await
            .unwrap();
        ids.push(delivery_for(&sent.message, &aspen).id.clone());
    }
    for id in &ids[..2] {
        f.store.dispatch_chat_delivery(&aspen_id, id).await.unwrap();
    }
    f.store
        .chat_delivery_receipt(&aspen_id, &ids[0], receipt("read"))
        .await
        .unwrap();
    let sessions = f.store.chat_sessions(&f.owner).await.unwrap();
    let waiting = |agent: &IssuedChatSession| {
        sessions
            .iter()
            .find(|s| s.id == agent.session.id)
            .unwrap()
            .waiting
    };
    assert_eq!(waiting(&aspen), 2, "only what was never attempted");
    assert_eq!(waiting(&birch), 4, "another session has its own queue");
}

#[tokio::test]
async fn concurrent_sends_are_idempotent_and_cursor_sequence_has_no_validation_gaps() {
    let f = Fixture::new().await;
    let (aspen, aspen_id) = f.hire("aspen", None).await;
    let room = f.room(&[&aspen]).await;
    f.clear_outbox().await;
    let input = message("one request");
    let (first, second) = tokio::join!(
        f.store.send_chat_message(&f.owner, &room.id, input.clone()),
        f.store.send_chat_message(&f.owner, &room.id, input.clone()),
    );
    let first = first.unwrap();
    let second = second.unwrap();
    assert_ne!(first.created, second.created);
    assert_eq!(first.message.id, second.message.id);
    assert_eq!(first.message.seq, 1);
    assert_eq!(first.message.deliveries.len(), 1);
    assert_eq!(f.store.pending_chat_events(100).await.unwrap().len(), 1);
    let mut changed = input.clone();
    changed.text = "changed".into();
    assert!(matches!(
        f.store.send_chat_message(&f.owner, &room.id, changed).await,
        Err(Error::Conflict)
    ));
    assert!(matches!(
        f.store
            .send_chat_message(
                &f.owner,
                &room.id,
                message(&format!("{}x", " ".repeat(64 * 1024)))
            )
            .await,
        Err(Error::Invalid(_))
    ));
    let second = f
        .store
        .send_chat_message(&aspen_id, &room.id, message("receipt only"))
        .await
        .unwrap();
    assert_eq!(second.message.seq, 2);
    assert!(second.message.deliveries.is_empty());
    let page = f
        .store
        .chat_messages(&f.owner, &room.id, 0, 1)
        .await
        .unwrap();
    assert!(page.has_more);
    assert_eq!(page.next_cursor, 1);
    let page = f
        .store
        .chat_messages(&f.owner, &room.id, page.next_cursor, 1)
        .await
        .unwrap();
    assert!(!page.has_more);
    assert_eq!(page.messages[0].id, second.message.id);
    assert_eq!(page.next_cursor, 2);
}

#[tokio::test]
async fn a_rehired_context_keeps_memberships_and_can_join_another_chat() {
    let f = Fixture::new().await;
    let (aspen, _) = f.hire("aspen", None).await;
    let (birch, _) = f.hire("birch", None).await;
    let group = f.room(&[&aspen, &birch]).await;
    f.store
        .stop_chat_session(&f.owner, &aspen.session.id)
        .await
        .unwrap();
    let reattached = f
        .store
        .hire_chat_session(
            &f.owner,
            HireChatSession {
                name: "aspen".into(),
                actor_id: Some(aspen.actor.id.clone()),
                harness: Harness::ClaudeCode,
                native_session_id: aspen.session.native_session_id.clone(),
                title: "Same context".into(),
                workspace: aspen.session.workspace.clone(),
                native_locator: json!({}),
                resume: false,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        f.store.chat_identity(Some(&aspen.token)).await,
        Err(Error::Unauthorized)
    ));
    let identity = f
        .store
        .chat_identity(Some(&reattached.token))
        .await
        .unwrap();
    let dm = f.room(&[&reattached]).await;
    let conversations = f.store.conversations(&identity).await.unwrap();
    assert_eq!(conversations.len(), 2);
    for id in [&group.id, &dm.id] {
        let conversation = conversations.iter().find(|c| &c.id == id).unwrap();
        assert!(
            conversation
                .members
                .iter()
                .any(|m| m.actor_id == aspen.actor.id
                    && m.session_id.as_deref() == Some(reattached.session.id.as_str()))
        );
    }
}

#[tokio::test]
async fn exact_rehire_restores_membership_and_transfers_unread_deliveries() {
    let f = Fixture::new().await;
    let (aspen, old_identity) = f.hire("aspen", None).await;
    let room = f.room(&[&aspen]).await;
    let mut deliveries = Vec::new();
    // The read one comes first: reading a message also reads the attempted ones before it.
    for state in ["read", "stored", "uncertain", "notified"] {
        let sent = f
            .store
            .send_chat_message(&f.owner, &room.id, message(state))
            .await
            .unwrap();
        let id = sent.message.deliveries[0].id.clone();
        if state != "stored" {
            f.store
                .dispatch_chat_delivery(&old_identity, &id)
                .await
                .unwrap();
        }
        if matches!(state, "notified" | "read") {
            f.store
                .chat_delivery_receipt(&old_identity, &id, receipt(state))
                .await
                .unwrap();
        }
        deliveries.push(id);
    }
    deliveries.rotate_left(1);
    // As the runtime does before an automatic relink.
    f.store
        .stop_chat_session_marked(&f.owner, &aspen.session.id, zerolux::chat::RELINKING)
        .await
        .unwrap();
    f.clear_outbox().await;
    let new = f
        .store
        .hire_chat_session(
            &f.owner,
            HireChatSession {
                name: "aspen".into(),
                actor_id: Some(aspen.actor.id.clone()),
                harness: Harness::ClaudeCode,
                native_session_id: aspen.session.native_session_id.clone(),
                title: "Reattached".into(),
                workspace: aspen.session.workspace.clone(),
                native_locator: json!({}),
                resume: true,
            },
        )
        .await
        .unwrap();
    let identity = f.store.chat_identity(Some(&new.token)).await.unwrap();
    let inbox = f.store.chat_inbox(&identity).await.unwrap();
    assert_eq!(inbox.conversations[0].id, room.id);
    let mut unread: Vec<_> = inbox
        .deliveries
        .iter()
        .map(|d| (d.id.clone(), d.status.as_str()))
        .collect();
    unread.sort_by_key(|(id, _)| deliveries.iter().position(|d| d == id));
    assert_eq!(
        unread,
        [
            (deliveries[0].clone(), "stored"),
            (deliveries[1].clone(), "uncertain"),
            (deliveries[2].clone(), "notified"),
        ]
    );
    let page = f
        .store
        .chat_messages(&f.owner, &room.id, 0, 100)
        .await
        .unwrap();
    for (index, message) in page.messages.iter().enumerate() {
        assert_eq!(
            message.deliveries[0].session_id,
            if index > 0 {
                &new.session.id
            } else {
                &aspen.session.id
            }
            .as_str()
        );
    }
    let events = f.store.pending_chat_events(100).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|e| e.payload["type"] == "conversation.changed")
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| e.payload["type"] == "delivery.changed")
            .count(),
        3
    );
    f.store
        .set_chat_session_status(
            &identity,
            &new.session.id,
            ChatSessionStatus {
                status: "connected".into(),
                reason: None,
            },
        )
        .await
        .unwrap();
    f.store
        .dispatch_chat_delivery(&identity, &deliveries[0])
        .await
        .unwrap();
    assert!(matches!(
        f.store
            .dispatch_chat_delivery(&identity, &deliveries[0])
            .await,
        Err(Error::Conflict)
    ));
    // Attempted deliveries are never dispatched twice, but can be answered from the new link.
    for id in &deliveries[1..3] {
        assert!(matches!(
            f.store.dispatch_chat_delivery(&identity, id).await,
            Err(Error::Conflict)
        ));
    }
    assert!(matches!(
        f.store
            .dispatch_chat_delivery(&identity, &deliveries[3])
            .await,
        Err(Error::Forbidden)
    ));
    let mut reply = message("answered after the restart");
    reply.reply_to_delivery_id = Some(deliveries[2].clone());
    f.store
        .send_chat_message(&identity, &room.id, reply)
        .await
        .unwrap();
    // Read before the restart: it stays with the old link and can still be answered.
    let mut late = message("answered after reading and restarting");
    late.reply_to_delivery_id = Some(deliveries[3].clone());
    f.store
        .send_chat_message(&identity, &room.id, late)
        .await
        .unwrap();
    let (other, other_id) = f.hire("other", None).await;
    let mut foreign = message("not my delivery");
    foreign.reply_to_delivery_id = Some(deliveries[1].clone());
    assert!(matches!(
        f.store
            .send_chat_message(&other_id, &room.id, foreign)
            .await,
        Err(Error::Forbidden)
    ));
    drop(other);
    assert!(matches!(
        f.store.chat_identity(Some(&aspen.token)).await,
        Err(Error::Unauthorized)
    ));
    let next = f
        .store
        .send_chat_message(&f.owner, &room.id, message("new work"))
        .await
        .unwrap();
    assert_eq!(next.message.deliveries[0].session_id, new.session.id);
}

#[tokio::test]
async fn simultaneous_rehire_by_different_actors_cannot_duplicate_one_native_session() {
    let f = Fixture::new().await;
    let (aspen, _) = f.hire("aspen", None).await;
    let (birch, _) = f.hire("birch", None).await;
    f.store
        .stop_chat_session_marked(&f.owner, &aspen.session.id, zerolux::chat::RELINKING)
        .await
        .unwrap();
    let input = |actor: &str| HireChatSession {
        name: "reattach".into(),
        actor_id: Some(actor.into()),
        harness: Harness::ClaudeCode,
        native_session_id: aspen.session.native_session_id.clone(),
        title: "Reattached".into(),
        workspace: aspen.session.workspace.clone(),
        native_locator: json!({}),
        resume: true,
    };
    let (a, b) = tokio::join!(
        f.store.hire_chat_session(&f.owner, input(&aspen.actor.id)),
        f.store.hire_chat_session(&f.owner, input(&birch.actor.id)),
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert!(matches!(a, Err(Error::Conflict)) || matches!(b, Err(Error::Conflict)));
    let sessions = f.store.chat_sessions(&f.owner).await.unwrap();
    assert_eq!(
        sessions
            .iter()
            .filter(|s| s.native_session_id == aspen.session.native_session_id
                && s.stopped_at.is_none())
            .count(),
        1
    );
}

#[tokio::test]
async fn runtime_recovery_marks_live_sessions_attention_without_changing_stopped_or_deliveries() {
    let f = Fixture::new().await;
    let (aspen, aspen_id) = f.hire("aspen", None).await;
    let (birch, _) = f.hire("birch", None).await;
    let room = f.room(&[&aspen]).await;
    let stored = f
        .store
        .send_chat_message(&f.owner, &room.id, message("not attempted"))
        .await
        .unwrap();
    let uncertain = f
        .store
        .send_chat_message(&f.owner, &room.id, message("attempted"))
        .await
        .unwrap();
    f.store
        .dispatch_chat_delivery(&aspen_id, &uncertain.message.deliveries[0].id)
        .await
        .unwrap();
    let stopped = f
        .store
        .stop_chat_session(&f.owner, &birch.session.id)
        .await
        .unwrap();
    f.clear_outbox().await;
    f.store.recover_chat_sessions().await.unwrap();
    let sessions = f.store.chat_sessions(&f.owner).await.unwrap();
    let active = sessions.iter().find(|s| s.id == aspen.session.id).unwrap();
    assert_eq!(active.status, "attention");
    assert!(
        active
            .attention_reason
            .as_deref()
            .unwrap()
            .contains("restarted")
    );
    let after_stop = sessions.iter().find(|s| s.id == stopped.id).unwrap();
    assert_eq!(after_stop.status, "stopped");
    assert_eq!(after_stop.stopped_at, stopped.stopped_at);
    assert!(matches!(
        f.store
            .dispatch_chat_delivery(&aspen_id, &stored.message.deliveries[0].id)
            .await,
        Err(Error::Conflict)
    ));
    let page = f
        .store
        .chat_messages(&f.owner, &room.id, 0, 100)
        .await
        .unwrap();
    assert_eq!(page.messages[0].deliveries[0].status, "stored");
    assert_eq!(page.messages[1].deliveries[0].status, "uncertain");
    let events = f.store.pending_chat_events(100).await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].payload["type"], "session.changed");
    f.store.recover_chat_sessions().await.unwrap();
    assert_eq!(f.store.pending_chat_events(100).await.unwrap().len(), 1);
}

#[tokio::test]
async fn failure_between_message_and_delivery_rolls_back_message_sequence_and_outbox() {
    let f = Fixture::new().await;
    let (aspen, _) = f.hire("aspen", None).await;
    let room = f.room(&[&aspen]).await;
    f.clear_outbox().await;
    let pool = f.pool().await;
    sqlx::query("CREATE TRIGGER reject_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT,'fixture fault'); END")
        .execute(&pool).await.unwrap();
    let input = message("atomic request");
    assert!(matches!(
        f.store
            .send_chat_message(&f.owner, &room.id, input.clone())
            .await,
        Err(Error::Database(_))
    ));
    assert!(
        f.store
            .chat_messages(&f.owner, &room.id, 0, 100)
            .await
            .unwrap()
            .messages
            .is_empty()
    );
    assert!(f.store.pending_chat_events(100).await.unwrap().is_empty());
    sqlx::query("DROP TRIGGER reject_delivery")
        .execute(&pool)
        .await
        .unwrap();
    let sent = f
        .store
        .send_chat_message(&f.owner, &room.id, input)
        .await
        .unwrap();
    assert_eq!(sent.message.seq, 1);
    assert_eq!(sent.message.deliveries.len(), 1);
    assert_eq!(f.store.pending_chat_events(100).await.unwrap().len(), 1);
}

#[tokio::test]
async fn publication_recovers_same_small_event_and_never_dispatches_inference() {
    let f = Fixture::new().await;
    let (aspen, _) = f.hire("aspen", None).await;
    let room = f.room(&[&aspen]).await;
    f.clear_outbox().await;
    let large = "x".repeat(32 * 1024);
    let sent = f
        .store
        .send_chat_message(&f.owner, &room.id, message(&large))
        .await
        .unwrap();
    let events = f.store.pending_chat_events(100).await.unwrap();
    assert_eq!(events.len(), 1);
    assert!(events[0].payload.to_string().len() < 1024);
    assert_eq!(events[0].payload["message_id"], sent.message.id);
    assert!(events[0].payload.get("text").is_none());
    let reopened = Store::open(&f.dir.path().join("chat.db")).await.unwrap();
    let again = reopened.pending_chat_events(100).await.unwrap();
    assert_eq!(again[0].event_id, events[0].event_id);
    reopened
        .mark_chat_event_published(&again[0].event_id)
        .await
        .unwrap();
    reopened
        .mark_chat_event_published(&again[0].event_id)
        .await
        .unwrap();
    assert!(reopened.pending_chat_events(100).await.unwrap().is_empty());
    let page = reopened
        .chat_messages(&f.owner, &room.id, 0, 100)
        .await
        .unwrap();
    assert_eq!(page.messages[0].text, large);
    assert_eq!(page.messages[0].deliveries[0].status, "stored");
}

#[tokio::test]
async fn pause_and_dispatch_are_atomic_and_an_uncertain_delivery_is_not_retried_after_reopen() {
    let f = Fixture::new().await;
    let (aspen, aspen_id) = f.hire("aspen", None).await;
    let (birch, birch_id) = f.hire("birch", None).await;
    let room = f.room(&[&aspen, &birch]).await;
    let sent = f
        .store
        .send_chat_message(&f.owner, &room.id, message("reaches everyone"))
        .await
        .unwrap();
    assert_eq!(sent.message.deliveries.len(), 2);
    let id = &delivery_for(&sent.message, &aspen).id;
    assert!(matches!(
        f.store.dispatch_chat_delivery(&birch_id, id).await,
        Err(Error::Forbidden)
    ));
    f.store
        .pause_conversation(&f.owner, &room.id, true)
        .await
        .unwrap();
    assert!(matches!(
        f.store.dispatch_chat_delivery(&aspen_id, id).await,
        Err(Error::Conflict)
    ));
    f.store
        .pause_conversation(&f.owner, &room.id, false)
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        f.store.dispatch_chat_delivery(&aspen_id, id),
        f.store.dispatch_chat_delivery(&aspen_id, id)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let reopened = Store::open(&f.dir.path().join("chat.db")).await.unwrap();
    assert_eq!(
        reopened.chat_inbox(&aspen_id).await.unwrap().deliveries[0].status,
        "uncertain"
    );
    assert!(matches!(
        reopened.dispatch_chat_delivery(&aspen_id, id).await,
        Err(Error::Conflict)
    ));
    let accepted = reopened
        .chat_delivery_receipt(
            &aspen_id,
            id,
            DeliveryReceipt {
                status: "notified".into(),
                native_request_id: Some("native-turn-1".into()),
                reason: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(accepted.status, "notified");
    // A native queue can lose what it accepted; that never makes the delivery dispatchable.
    let lost = reopened
        .chat_delivery_receipt(&aspen_id, id, receipt("uncertain"))
        .await
        .unwrap();
    assert_eq!(lost.status, "uncertain");
    assert!(matches!(
        reopened.dispatch_chat_delivery(&aspen_id, id).await,
        Err(Error::Conflict)
    ));
    assert!(matches!(
        reopened
            .chat_delivery_receipt(
                &aspen_id,
                id,
                DeliveryReceipt {
                    status: "read".into(),
                    native_request_id: Some("another-turn".into()),
                    reason: None,
                }
            )
            .await,
        Err(Error::Conflict)
    ));
    reopened
        .chat_delivery_receipt(&aspen_id, id, receipt("read"))
        .await
        .unwrap();
    assert!(matches!(
        reopened
            .chat_delivery_receipt(&aspen_id, id, receipt("notified"))
            .await,
        Err(Error::Conflict)
    ));
    assert!(
        reopened
            .chat_inbox(&aspen_id)
            .await
            .unwrap()
            .deliveries
            .is_empty()
    );
}

#[tokio::test]
async fn explicit_reply_and_final_fallback_share_one_message_and_only_the_recipient_can_reply() {
    let f = Fixture::new().await;
    let (aspen, aspen_id) = f.hire("aspen", None).await;
    let (birch, birch_id) = f.hire("birch", None).await;
    let room = f.room(&[&aspen, &birch]).await;
    let sent = f
        .store
        .send_chat_message(&f.owner, &room.id, message("question"))
        .await
        .unwrap();
    let delivery = &delivery_for(&sent.message, &aspen).id;
    let mut reply = message("answer");
    reply.reply_to_delivery_id = Some(delivery.clone());
    assert!(matches!(
        f.store
            .send_chat_message(&aspen_id, &room.id, reply.clone())
            .await,
        Err(Error::Conflict)
    ));
    f.store
        .dispatch_chat_delivery(&aspen_id, delivery)
        .await
        .unwrap();
    assert!(matches!(
        f.store
            .send_chat_message(&birch_id, &room.id, reply.clone())
            .await,
        Err(Error::Forbidden)
    ));
    let first = f
        .store
        .send_chat_message(&aspen_id, &room.id, reply.clone())
        .await
        .unwrap();
    reply.id = Uuid::new_v4().to_string();
    let fallback = f
        .store
        .send_chat_message(&aspen_id, &room.id, reply.clone())
        .await
        .unwrap();
    assert!(!fallback.created);
    assert_eq!(first.message.id, fallback.message.id);
    assert_eq!(first.message.deliveries.len(), 1);
    assert_eq!(delivery_for(&first.message, &birch).status, "stored");
    reply.text = "different fallback".into();
    assert!(matches!(
        f.store.send_chat_message(&aspen_id, &room.id, reply).await,
        Err(Error::Conflict)
    ));
    let page = f
        .store
        .chat_messages(&f.owner, &room.id, 0, 100)
        .await
        .unwrap();
    assert_eq!(page.messages.len(), 2);
    assert_eq!(delivery_for(&page.messages[0], &aspen).status, "read");
    assert_eq!(delivery_for(&page.messages[0], &birch).status, "stored");
}

#[tokio::test]
async fn approvals_require_owner_decision_and_native_dispatch_is_never_replayed() {
    let f = Fixture::new().await;
    let (aspen, aspen_id) = f.hire("aspen", None).await;
    let (birch, birch_id) = f.hire("birch", None).await;
    let room = f.room(&[&aspen, &birch]).await;
    let sent = f
        .store
        .send_chat_message(&f.owner, &room.id, message("request"))
        .await
        .unwrap();
    let delivery = &delivery_for(&sent.message, &aspen).id;
    f.store
        .dispatch_chat_delivery(&aspen_id, delivery)
        .await
        .unwrap();
    let approval = f
        .store
        .create_chat_approval(
            &aspen_id,
            CreateChatApproval {
                id: Uuid::new_v4().to_string(),
                delivery_id: delivery.clone(),
                native_request_id: "native-approval".into(),
                summary: "Read a fixture file".into(),
                details: json!({"path":"fixture.txt"}),
            },
        )
        .await
        .unwrap();
    assert_eq!(approval.status, "pending");
    assert!(approval.decision.is_none());
    assert!(f.store.chat_approvals(&birch_id).await.unwrap().is_empty());
    assert!(matches!(
        f.store
            .decide_chat_approval(&aspen_id, &approval.id, "allow")
            .await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        f.store
            .dispatch_chat_approval(&aspen_id, &approval.id)
            .await,
        Err(Error::Conflict)
    ));
    f.store
        .decide_chat_approval(&f.owner, &approval.id, "deny")
        .await
        .unwrap();
    f.store
        .decide_chat_approval(&f.owner, &approval.id, "deny")
        .await
        .unwrap();
    assert!(matches!(
        f.store
            .decide_chat_approval(&f.owner, &approval.id, "allow")
            .await,
        Err(Error::Conflict)
    ));
    assert_eq!(
        f.store.chat_inbox(&aspen_id).await.unwrap().approvals[0]
            .decision
            .as_deref(),
        Some("deny")
    );
    let (a, b) = tokio::join!(
        f.store.dispatch_chat_approval(&aspen_id, &approval.id),
        f.store.dispatch_chat_approval(&aspen_id, &approval.id)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let reopened = Store::open(&f.dir.path().join("chat.db")).await.unwrap();
    assert!(matches!(
        reopened
            .dispatch_chat_approval(&aspen_id, &approval.id)
            .await,
        Err(Error::Conflict)
    ));
    let result = reopened
        .chat_approval_receipt(
            &aspen_id,
            &approval.id,
            ApprovalReceipt {
                status: "delivered".into(),
                reason: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(result.decision.as_deref(), Some("deny"));
    assert!(matches!(
        reopened
            .chat_approval_receipt(
                &aspen_id,
                &approval.id,
                ApprovalReceipt {
                    status: "uncertain".into(),
                    reason: None,
                }
            )
            .await,
        Err(Error::Conflict)
    ));
    let closed = reopened
        .create_chat_approval(
            &aspen_id,
            CreateChatApproval {
                id: Uuid::new_v4().to_string(),
                delivery_id: delivery.clone(),
                native_request_id: "native-cancelled".into(),
                summary: "Cancelled prompt".into(),
                details: json!({}),
            },
        )
        .await
        .unwrap();
    let closed = reopened
        .chat_approval_receipt(
            &aspen_id,
            &closed.id,
            ApprovalReceipt {
                status: "resolved".into(),
                reason: Some("Runtime cancelled its request".into()),
            },
        )
        .await
        .unwrap();
    assert!(closed.decision.is_none());
    assert!(matches!(
        reopened
            .decide_chat_approval(&f.owner, &closed.id, "allow")
            .await,
        Err(Error::Conflict)
    ));
    let events = reopened.pending_chat_events(1000).await.unwrap();
    for event in events
        .iter()
        .filter(|e| e.payload["type"] == "approval.changed")
    {
        assert!(!event.actor_ids.contains(&birch.actor.id));
        assert!(event.payload.get("details").is_none());
    }
}

#[tokio::test]
async fn outbox_rechecks_membership_before_notifying_a_removed_member() {
    let f = Fixture::new().await;
    let (aspen, _) = f.hire("aspen", None).await;
    let room = f.room(&[&aspen]).await;
    f.clear_outbox().await;
    f.store
        .send_chat_message(&f.owner, &room.id, message("membership fixture"))
        .await
        .unwrap();
    sqlx::query("DELETE FROM conversation_members WHERE conversation_id=? AND actor_id=?")
        .bind(&room.id)
        .bind(&aspen.actor.id)
        .execute(&f.pool().await)
        .await
        .unwrap();
    let events = f.store.pending_chat_events(100).await.unwrap();
    assert_eq!(events[0].actor_ids, vec![f.owner.actor_id.clone()]);
}

/// A relink that fails must not lose the agent: its latest session of that native context
/// waits for attention again, with the revoked token still refused. An owner's Stop on any
/// session the runtime stopped for the relink ends that: nothing of the context is revived.
#[tokio::test]
async fn a_failed_relink_revives_the_latest_session_unless_the_owner_stopped_it() {
    let f = Fixture::new().await;
    let (cedar, _) = f.hire("cedar", None).await;
    let native = cedar.session.native_session_id.clone();
    assert!(
        !f.store
            .stop_chat_session_marked(&f.owner, &cedar.session.id, zerolux::chat::RELINKING)
            .await
            .unwrap()
    );
    // The relink's own session, stopped when pairing failed: the one to revive.
    let relink = |resume: bool| {
        f.store.hire_chat_session(
            &f.owner,
            HireChatSession {
                name: "".into(),
                actor_id: Some(cedar.actor.id.clone()),
                harness: Harness::ClaudeCode,
                native_session_id: native.clone(),
                title: "cedar session".into(),
                workspace: cedar.session.workspace.clone(),
                native_locator: json!({"fixture":"x"}),
                resume,
            },
        )
    };
    let again = relink(true).await.unwrap();
    assert!(
        !f.store
            .stop_chat_session_marked(&f.owner, &again.session.id, zerolux::chat::LINK_FAILED)
            .await
            .unwrap()
    );
    assert_eq!(
        f.store
            .chat_session(&f.owner, &again.session.id)
            .await
            .unwrap()
            .attention_reason
            .as_deref(),
        Some(zerolux::chat::LINK_FAILED),
        "stop and mark are one transaction"
    );
    let revived = f
        .store
        .revive_chat_session(&f.owner, "claude-code", &native, "Pi was busy; retrying.")
        .await
        .unwrap()
        .expect("revived");
    assert_eq!(revived.id, again.session.id);
    assert_eq!(revived.status, "attention");
    assert!(revived.stopped_at.is_none());
    assert_eq!(
        revived.attention_reason.as_deref(),
        Some("Pi was busy; retrying.")
    );
    assert!(matches!(
        f.store.chat_identity(Some(&again.token)).await,
        Err(Error::Unauthorized)
    ));
    // Live already: nothing to revive.
    assert!(
        f.store
            .revive_chat_session(&f.owner, "claude-code", &native, "again")
            .await
            .unwrap()
            .is_none()
    );

    // The owner's Stop on the session stopped for the relink, while the new one is pairing.
    assert!(
        !f.store
            .stop_chat_session_marked(&f.owner, &revived.id, zerolux::chat::RELINKING)
            .await
            .unwrap()
    );
    let pending = relink(true).await.unwrap();
    let (_, already) = f
        .store
        .stop_chat_session_with_state(&f.owner, &revived.id)
        .await
        .unwrap();
    assert!(already, "the runtime had stopped it");
    let sessions = f.store.chat_sessions(&f.owner).await.unwrap();
    let pending = sessions
        .iter()
        .find(|s| s.id == pending.session.id)
        .unwrap();
    assert!(pending.stopped_at.is_some(), "the relink in progress ends");
    assert!(
        sessions.iter().all(|s| s.attention_reason.is_none()),
        "no runtime mark survives the owner's decision"
    );
    assert!(
        f.store
            .revive_chat_session(&f.owner, "claude-code", &native, "retry")
            .await
            .unwrap()
            .is_none()
    );
    // An owner's Stop on a session the owner stopped changes nothing.
    let (_, already) = f
        .store
        .stop_chat_session_with_state(&f.owner, &cedar.session.id)
        .await
        .unwrap();
    assert!(already);
}

/// Between the runtime's stop and the creation of its successor, the owner's Stop wins: the
/// successor of an automatic relink is refused where it would be created. An explicit Hire
/// by the owner is a new decision and still works.
#[tokio::test]
async fn an_owner_stop_before_the_successor_exists_refuses_the_automatic_relink() {
    let f = Fixture::new().await;
    let (cedar, _) = f.hire("cedar", None).await;
    let relink = |resume: bool| {
        f.store.hire_chat_session(
            &f.owner,
            HireChatSession {
                name: "cedar".into(),
                actor_id: Some(cedar.actor.id.clone()),
                harness: Harness::ClaudeCode,
                native_session_id: cedar.session.native_session_id.clone(),
                title: "cedar session".into(),
                workspace: cedar.session.workspace.clone(),
                native_locator: json!({"fixture":"x"}),
                resume,
            },
        )
    };
    f.store
        .stop_chat_session_marked(&f.owner, &cedar.session.id, zerolux::chat::RELINKING)
        .await
        .unwrap();
    f.store
        .stop_chat_session(&f.owner, &cedar.session.id)
        .await
        .unwrap();
    assert!(matches!(relink(true).await, Err(Error::StoppedByOwner)));
    assert!(
        f.store
            .chat_sessions(&f.owner)
            .await
            .unwrap()
            .iter()
            .all(|s| s.stopped_at.is_some())
    );
    relink(false).await.unwrap();
}

/// While working, a session may say which chat its turn is about: one of its own chats,
/// and only while it works; idle or unknown clears it.
#[tokio::test]
async fn activity_names_a_chat_only_while_working_and_only_its_own() {
    let f = Fixture::new().await;
    let (cedar, cedar_id) = f.hire("cedar", None).await;
    let (maple, _) = f.hire("maple", None).await;
    let room = f.room(&[&cedar]).await;
    let other = f.room(&[&maple]).await;
    let session = f
        .store
        .set_chat_session_activity(
            &cedar_id,
            &cedar.session.id,
            Some("working".into()),
            Some(room.id.clone()),
        )
        .await
        .unwrap();
    assert_eq!(
        session.activity_conversation_id.as_deref(),
        Some(room.id.as_str())
    );
    assert!(matches!(
        f.store
            .set_chat_session_activity(
                &cedar_id,
                &cedar.session.id,
                Some("working".into()),
                Some(other.id.clone()),
            )
            .await,
        Err(Error::Forbidden)
    ));
    let session = f
        .store
        .set_chat_session_activity(
            &cedar_id,
            &cedar.session.id,
            Some("idle".into()),
            Some(room.id),
        )
        .await
        .unwrap();
    assert_eq!(session.activity.as_deref(), Some("idle"));
    assert!(session.activity_conversation_id.is_none());
}

/// Threads: opened once per root and joined by everyone else, with rosters merged in one
/// transaction; a roster with an outsider is refused whole; the audience is the parent's,
/// so one session serves threads of different participants; the owner reads but does not
/// receive; the final reply to the parent stays available.
#[tokio::test]
async fn threads_open_or_join_at_a_root_with_the_parents_audience() {
    let f = Fixture::new().await;
    let (a, a_id) = f.hire("a", None).await;
    let (b, b_id) = f.hire("b", None).await;
    let (c, _) = f.hire("c", None).await;
    let (d, _) = f.hire("d", None).await;
    let (e, e_id) = f.hire("e", None).await;
    let (outsider, _) = f.hire("outsider", None).await;
    let team = f.room(&[&a, &b, &c, &d, &e]).await;
    let root = f
        .store
        .send_chat_message(
            &f.owner,
            &team.id,
            SendChatMessage {
                id: Uuid::new_v4().to_string(),
                text: "Please plan the release".into(),
                reply_to_delivery_id: None,
            },
        )
        .await
        .unwrap();
    let a_delivery = root
        .message
        .deliveries
        .iter()
        .find(|d| d.actor_id == a.actor.id)
        .unwrap()
        .id
        .clone();
    // A opens at the root through its delivery; B opens at the same root by message id.
    let first = f
        .store
        .open_thread(
            &a_id,
            &team.id,
            OpenThread {
                root: a_delivery,
                title: "release plan".into(),
                participants: vec![c.actor.id.clone()],
            },
        )
        .await
        .unwrap();
    assert!(first.created);
    let second = f
        .store
        .open_thread(
            &b_id,
            &team.id,
            OpenThread {
                root: root.message.id.clone(),
                title: "release schedule".into(),
                participants: vec![d.actor.id.clone()],
            },
        )
        .await
        .unwrap();
    assert!(!second.created);
    assert_eq!(second.conversation.id, first.conversation.id);
    assert_eq!(second.conversation.title, "release plan");
    let mut roster: Vec<_> = second
        .conversation
        .members
        .iter()
        .map(|m| m.name.clone())
        .collect();
    roster.sort();
    assert_eq!(roster, ["a", "b", "c", "d"]);
    // An outsider in the roster refuses the whole request: nothing joins.
    assert!(matches!(
        f.store
            .open_thread(
                &a_id,
                &team.id,
                OpenThread {
                    root: root.message.id.clone(),
                    title: "x".into(),
                    participants: vec![outsider.actor.id.clone()],
                },
            )
            .await,
        Err(Error::Invalid(_))
    ));
    // One send: one delivery per other participant, none for the owner.
    let thread_id = first.conversation.id.clone();
    let said = f
        .store
        .send_chat_message(
            &a_id,
            &thread_id,
            SendChatMessage {
                id: Uuid::new_v4().to_string(),
                text: "Proposal: ship Friday".into(),
                reply_to_delivery_id: None,
            },
        )
        .await
        .unwrap();
    let mut recipients: Vec<_> = said
        .message
        .deliveries
        .iter()
        .map(|d| d.actor_id.clone())
        .collect();
    recipients.sort();
    let mut expected = vec![b.actor.id.clone(), c.actor.id.clone(), d.actor.id.clone()];
    expected.sort();
    assert_eq!(recipients, expected);
    // An agent of the parent who is not a participant reads the thread (the audience is the
    // parent's) and cannot write in it.
    let page = f
        .store
        .chat_messages(&e_id, &thread_id, 0, 10)
        .await
        .unwrap();
    assert_eq!(page.messages.len(), 1);
    assert!(matches!(
        f.store
            .send_chat_message(
                &e_id,
                &thread_id,
                SendChatMessage {
                    id: Uuid::new_v4().to_string(),
                    text: "may I".into(),
                    reply_to_delivery_id: None,
                },
            )
            .await,
        Err(Error::Forbidden)
    ));
    // The non-participant sees the thread listed among their conversations, open.
    assert!(
        f.store
            .conversations(&e_id)
            .await
            .unwrap()
            .iter()
            .any(|c| c.id == thread_id && c.closed_at.is_none())
    );
    // The owner reads the thread without being a participant; writing in it is refused.
    let page = f
        .store
        .chat_messages(&f.owner, &thread_id, 0, 10)
        .await
        .unwrap();
    assert_eq!(page.messages.len(), 1);
    assert!(matches!(
        f.store
            .send_chat_message(
                &f.owner,
                &thread_id,
                SendChatMessage {
                    id: Uuid::new_v4().to_string(),
                    text: "me too".into(),
                    reply_to_delivery_id: None,
                },
            )
            .await,
        Err(Error::Forbidden)
    ));
    assert!(
        f.store
            .conversations(&f.owner)
            .await
            .unwrap()
            .iter()
            .any(|c| c.id == thread_id && c.parent_id.as_deref() == Some(team.id.as_str()))
    );
    // The same session serves two threads of different participants: the audience is the
    // parent's, so no other audience is known. A second thread needs another root.
    let other_root = f
        .store
        .send_chat_message(
            &f.owner,
            &team.id,
            SendChatMessage {
                id: Uuid::new_v4().to_string(),
                text: "And the docs?".into(),
                reply_to_delivery_id: None,
            },
        )
        .await
        .unwrap();
    f.store
        .open_thread(
            &a_id,
            &team.id,
            OpenThread {
                root: other_root.message.id.clone(),
                title: "docs".into(),
                participants: vec![b.actor.id.clone()],
            },
        )
        .await
        .unwrap();
    // The final reply to the parent's delivery is still A's to give, after the thread.
    let a_root_delivery = root
        .message
        .deliveries
        .iter()
        .find(|d| d.actor_id == a.actor.id)
        .unwrap()
        .id
        .clone();
    f.store
        .dispatch_chat_delivery(&a_id, &a_root_delivery)
        .await
        .unwrap();
    f.store
        .chat_delivery_receipt(
            &a_id,
            &a_root_delivery,
            DeliveryReceipt {
                status: "notified".into(),
                reason: None,
                native_request_id: None,
            },
        )
        .await
        .unwrap();
    f.store
        .send_chat_message(
            &a_id,
            &team.id,
            SendChatMessage {
                id: Uuid::new_v4().to_string(),
                text: "We ship Friday".into(),
                reply_to_delivery_id: Some(a_root_delivery),
            },
        )
        .await
        .unwrap();
    // Closing: a participant may; afterwards writing stops, reading stays.
    let closed = f.store.close_thread(&b_id, &thread_id).await.unwrap();
    assert!(closed.closed_at.is_some());
    assert!(matches!(
        f.store
            .send_chat_message(
                &a_id,
                &thread_id,
                SendChatMessage {
                    id: Uuid::new_v4().to_string(),
                    text: "late".into(),
                    reply_to_delivery_id: None,
                },
            )
            .await,
        Err(Error::Invalid(_))
    ));
    // A retry of the message saved before the close returns it unchanged.
    let retried = f
        .store
        .send_chat_message(
            &a_id,
            &thread_id,
            SendChatMessage {
                id: said.message.id.clone(),
                text: "Proposal: ship Friday".into(),
                reply_to_delivery_id: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(retried.message.seq, said.message.seq);
    // Closed: a new thread may open at the same root.
    let again = f
        .store
        .open_thread(
            &a_id,
            &team.id,
            OpenThread {
                root: root.message.id.clone(),
                title: "release plan, part two".into(),
                participants: vec![],
            },
        )
        .await
        .unwrap();
    assert!(again.created);
}

#[tokio::test]
async fn a_thread_rests_with_its_chat_and_dispatches_nothing_once_closed() {
    let f = Fixture::new().await;
    let (a, a_id) = f.hire("a", None).await;
    let (b, b_id) = f.hire("b", None).await;
    let team = f.room(&[&a, &b]).await;
    let root = f
        .store
        .send_chat_message(
            &f.owner,
            &team.id,
            SendChatMessage {
                id: Uuid::new_v4().to_string(),
                text: "Plan it".into(),
                reply_to_delivery_id: None,
            },
        )
        .await
        .unwrap();
    let thread = f
        .store
        .open_thread(
            &a_id,
            &team.id,
            OpenThread {
                root: root.message.id.clone(),
                title: "plan".into(),
                participants: vec![b.actor.id.clone()],
            },
        )
        .await
        .unwrap()
        .conversation;
    let say = |text: &str| SendChatMessage {
        id: Uuid::new_v4().to_string(),
        text: text.into(),
        reply_to_delivery_id: None,
    };
    let first = f
        .store
        .send_chat_message(&a_id, &thread.id, say("one"))
        .await
        .unwrap();
    // Published to the thread's audience: the owner reads it live, like the participants.
    let published = f.store.pending_chat_events(1000).await.unwrap();
    let event = published
        .iter()
        .find(|e| {
            e.payload["type"] == "message.created" && e.payload["message_id"] == first.message.id
        })
        .unwrap();
    assert!(event.actor_ids.contains(&f.owner.actor_id));
    assert!(event.actor_ids.contains(&b.actor.id));
    let first = first.message.deliveries[0].id.clone();
    // Pausing the chat pauses its threads; a thread has no pause of its own.
    f.store
        .pause_conversation(&f.owner, &team.id, true)
        .await
        .unwrap();
    let paused =
        |all: Vec<Conversation>| all.into_iter().find(|c| c.id == thread.id).unwrap().paused;
    assert!(paused(f.store.conversations(&b_id).await.unwrap()));
    let offered = |inbox: ChatInbox, id: &str| inbox.deliveries.iter().any(|d| d.id == id);
    assert!(!offered(f.store.chat_inbox(&b_id).await.unwrap(), &first));
    assert!(matches!(
        f.store.dispatch_chat_delivery(&b_id, &first).await,
        Err(Error::Conflict)
    ));
    assert!(matches!(
        f.store
            .pause_conversation(&f.owner, &thread.id, false)
            .await,
        Err(Error::Invalid(_))
    ));
    f.store
        .pause_conversation(&f.owner, &team.id, false)
        .await
        .unwrap();
    assert!(!paused(f.store.conversations(&b_id).await.unwrap()));
    assert!(offered(f.store.chat_inbox(&b_id).await.unwrap(), &first));
    f.store.dispatch_chat_delivery(&b_id, &first).await.unwrap();
    // A delivery stored before Close never starts a turn after it.
    let second = f
        .store
        .send_chat_message(&a_id, &thread.id, say("two"))
        .await
        .unwrap();
    let second = second.message.deliveries[0].id.clone();
    f.store.close_thread(&a_id, &thread.id).await.unwrap();
    assert!(!offered(f.store.chat_inbox(&b_id).await.unwrap(), &second));
    assert!(matches!(
        f.store.dispatch_chat_delivery(&b_id, &second).await,
        Err(Error::Conflict)
    ));
}

#[tokio::test]
async fn every_listed_chat_carries_its_newest_message() {
    let f = Fixture::new().await;
    let (a, a_id) = f.hire("a", None).await;
    let (b, _) = f.hire("b", None).await;
    let room = f.room(&[&a, &b]).await;
    // Empty: nothing to preview.
    assert!(room.last_message.is_none());
    let listed = f.store.conversations(&f.owner).await.unwrap();
    assert!(listed.iter().all(|c| c.last_message.is_none()));

    let send = |who: ChatIdentity, text: &str| {
        let (store, text, room) = (f.store.clone(), text.to_owned(), room.id.clone());
        async move {
            store
                .send_chat_message(
                    &who,
                    &room,
                    SendChatMessage {
                        id: Uuid::new_v4().to_string(),
                        text,
                        reply_to_delivery_id: None,
                    },
                )
                .await
                .unwrap()
                .message
        }
    };
    let first = send(f.owner.clone(), "Hello agent").await;
    let listed = f.store.conversations(&f.owner).await.unwrap();
    let chat = listed.iter().find(|c| c.id == room.id).unwrap();
    let last = chat.last_message.as_ref().unwrap();
    assert_eq!(
        (&last.author_id, &last.text, last.created_at),
        (
            &f.owner.actor_id,
            &"Hello agent".to_owned(),
            first.created_at
        )
    );
    assert_eq!(chat.last_seq, first.seq);

    // The newest wins, whoever wrote it, and the agent reads the same preview.
    let second = send(a_id.clone(), "Hello owner").await;
    for who in [&f.owner, &a_id] {
        let listed = f.store.conversations(who).await.unwrap();
        let chat = listed.iter().find(|c| c.id == room.id).unwrap();
        let last = chat.last_message.as_ref().unwrap();
        assert_eq!(
            (&last.author_id, &last.text, last.created_at),
            (&a.actor.id, &"Hello owner".to_owned(), second.created_at)
        );
        assert_eq!(chat.last_seq, second.seq);
    }

    // A thread previews its own messages, not its parent's; empty until someone writes in it.
    let thread = f
        .store
        .open_thread(
            &a_id,
            &room.id,
            OpenThread {
                root: second.id.clone(),
                title: "aside".into(),
                participants: vec![b.actor.id.clone()],
            },
        )
        .await
        .unwrap();
    let listed = f.store.conversations(&f.owner).await.unwrap();
    assert!(
        listed
            .iter()
            .find(|c| c.id == thread.conversation.id)
            .unwrap()
            .last_message
            .is_none()
    );
    f.store
        .send_chat_message(
            &a_id,
            &thread.conversation.id,
            SendChatMessage {
                id: Uuid::new_v4().to_string(),
                text: "In the thread".into(),
                reply_to_delivery_id: None,
            },
        )
        .await
        .unwrap();
    let listed = f.store.conversations(&f.owner).await.unwrap();
    let in_thread = listed
        .iter()
        .find(|c| c.id == thread.conversation.id)
        .unwrap();
    assert_eq!(
        in_thread.last_message.as_ref().unwrap().text,
        "In the thread"
    );
    let parent = listed.iter().find(|c| c.id == room.id).unwrap();
    assert_eq!(parent.last_message.as_ref().unwrap().text, "Hello owner");
}
