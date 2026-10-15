//! Bootstrap and reopen coverage uses disposable databases and synthetic rows, never harnesses.
use sea_orm::{ActiveModelTrait, EntityTrait, IntoActiveModel, Set};
use sea_orm_migration::MigratorTrait;
use zerolux::{
    db::{Migrator, connect},
    entity::{
        actors, chat_outbox, chat_sessions, conversation_members, conversations, deliveries,
        messages, tool_approvals, workspace,
    },
};

#[path = "support/db.rs"]
mod fixture;

#[tokio::test]
async fn single_bootstrap_preserves_identity_history_settings_and_stops_on_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let fixture = fixture::TestDatabase::new(directory.path().join("bootstrap.db")).await;
    let db = connect(fixture.location()).await.unwrap();
    let applied = Migrator::get_applied_migrations_read_only(&db)
        .await
        .unwrap();
    assert_eq!(
        applied
            .iter()
            .map(|migration| migration.name())
            .collect::<Vec<_>>(),
        vec!["m0001_bootstrap"]
    );
    let owner = actors::ActiveModel {
        id: Set("owner".into()),
        name: Set("Owner".into()),
        kind: Set("human".into()),
        auth_subject: Set(Some("fixture-subject".into())),
        created_at: Set(1),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let agent = actors::ActiveModel {
        id: Set("agent".into()),
        name: Set("Agent".into()),
        kind: Set("agent".into()),
        owner_id: Set(Some(owner.id.clone())),
        harness: Set(Some("pi".into())),
        model: Set(Some("fixture-model".into())),
        effort: Set(Some("high".into())),
        created_at: Set(2),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let company = workspace::ActiveModel {
        id: Set("workspace".into()),
        name: Set("Fixture".into()),
        created_at: Set(1),
        auth_secret: Set(Some("fixture-secret-not-a-credential".into())),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let session = chat_sessions::ActiveModel {
        id: Set("session".into()),
        actor_id: Set(agent.id.clone()),
        harness: Set("pi".into()),
        native_session_id: Set("saved-native-session".into()),
        title: Set("Fixture".into()),
        workspace: Set("/fixture".into()),
        native_locator_json: Set("{}".into()),
        token_hash: Set("fixture-not-a-token".into()),
        status: Set("stopped".into()),
        stopped_at: Set(Some(10)),
        activity: Set(Some("idle".into())),
        host_id: Set(Some("fixture-host".into())),
        created_at: Set(2),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let conversation = conversations::ActiveModel {
        id: Set("chat".into()),
        kind: Set("group".into()),
        title: Set("Fixture".into()),
        next_seq: Set(2),
        created_at: Set(3),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let member = conversation_members::ActiveModel {
        conversation_id: Set(conversation.id.clone()),
        actor_id: Set(agent.id.clone()),
        session_id: Set(Some(session.id.clone())),
    }
    .insert(&db)
    .await
    .unwrap();
    let message = messages::ActiveModel {
        id: Set("message".into()),
        conversation_id: Set(conversation.id.clone()),
        seq: Set(1),
        author_id: Set(owner.id.clone()),
        text: Set("Preserve this message".into()),
        created_at: Set(4),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let delivery = deliveries::ActiveModel {
        id: Set("delivery".into()),
        message_id: Set(message.id.clone()),
        actor_id: Set(agent.id.clone()),
        session_id: Set(session.id.clone()),
        status: Set("uncertain".into()),
        native_request_id: Set(Some("native-request".into())),
        last_error: Set(Some("Do not resend".into())),
        created_at: Set(4),
        updated_at: Set(5),
    }
    .insert(&db)
    .await
    .unwrap();
    let approval = tool_approvals::ActiveModel {
        id: Set("approval".into()),
        session_id: Set(session.id.clone()),
        delivery_id: Set(delivery.id.clone()),
        native_request_id: Set("approval-request".into()),
        summary: Set("Fixture".into()),
        details_json: Set("{}".into()),
        status: Set("decided".into()),
        decision: Set(Some("allow".into())),
        created_at: Set(5),
        updated_at: Set(6),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let notice = chat_outbox::ActiveModel {
        event_id: Set("notice".into()),
        payload_json: Set("{}".into()),
        recipient_actor_ids_json: Set("[\"owner\"]".into()),
        created_at: Set(6),
        published_at: Set(None),
    }
    .insert(&db)
    .await
    .unwrap();
    db.close().await.unwrap();

    let upgraded = connect(fixture.location()).await.unwrap();
    macro_rules! unchanged {
        ($entity:ident, $model:ident) => {
            assert_eq!(
                $entity::Entity::find_by_id($model.id.clone())
                    .one(&upgraded)
                    .await
                    .unwrap(),
                Some($model.clone())
            );
        };
    }
    unchanged!(actors, owner);
    unchanged!(actors, agent);
    unchanged!(workspace, company);
    unchanged!(chat_sessions, session);
    unchanged!(conversations, conversation);
    unchanged!(messages, message);
    unchanged!(deliveries, delivery);
    unchanged!(tool_approvals, approval);
    assert_eq!(
        conversation_members::Entity::find_by_id((conversation.id.clone(), agent.id.clone()))
            .one(&upgraded)
            .await
            .unwrap(),
        Some(member)
    );
    assert_eq!(
        chat_outbox::Entity::find_by_id("notice")
            .one(&upgraded)
            .await
            .unwrap(),
        Some(notice)
    );

    // The application connection enforces FKs after SQLite's private migration connection.
    assert!(
        actors::ActiveModel {
            id: Set("orphan".into()),
            name: Set("Orphan".into()),
            kind: Set("agent".into()),
            owner_id: Set(Some("missing-owner".into())),
            harness: Set(Some("pi".into())),
            created_at: Set(20),
            ..Default::default()
        }
        .insert(&upgraded)
        .await
        .is_err()
    );
    // Preserve both the CHECK and the single-owner partial unique constraint.
    for (id, kind) in [("invalid-kind", "invalid"), ("second-owner", "human")] {
        assert!(
            actors::ActiveModel {
                id: Set(id.into()),
                name: Set("Invalid".into()),
                kind: Set(kind.into()),
                created_at: Set(20),
                ..Default::default()
            }
            .insert(&upgraded)
            .await
            .is_err()
        );
    }
    // Historical Stop rows do not prevent a new link to the same native identity;
    // two simultaneously active links still cannot exist.
    let mut resumed = session.clone().into_active_model();
    resumed.id = Set("resumed".into());
    resumed.token_hash = Set("resumed-fixture-not-a-token".into());
    resumed.status = Set("connecting".into());
    resumed.stopped_at = Set(None);
    let resumed = resumed.insert(&upgraded).await.unwrap();
    let mut duplicate = resumed.into_active_model();
    duplicate.id = Set("duplicate".into());
    duplicate.token_hash = Set("duplicate-fixture-not-a-token".into());
    assert!(duplicate.insert(&upgraded).await.is_err());
    unchanged!(chat_sessions, session);
    upgraded.close().await.unwrap();
}

#[test]
fn exported_entities_include_state_constraints_for_both_dialects() {
    for backend in [
        sea_orm::DatabaseBackend::Sqlite,
        sea_orm::DatabaseBackend::Postgres,
    ] {
        let sql = zerolux::entity::schema::sql(backend);
        for name in [
            "one_bootstrap_owner",
            "one_actor_per_subject",
            "one_chat_session",
            "one_open_thread_per_root",
            "deliveries_session",
            "chat_outbox_pending",
        ] {
            assert!(sql.contains(name), "missing {name} for {backend:?}");
        }
        assert!(sql.contains("CHECK"));
        assert!(sql.contains("FOREIGN KEY"));
        assert!(sql.contains("console_events"));
        assert!(sql.contains("console_streams"));
        assert!(!sql.contains("DROP TABLE"));
    }
}
