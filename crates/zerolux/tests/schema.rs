//! Bootstrap and reopen coverage uses disposable databases and synthetic rows, never harnesses.
use sea_orm::{ActiveModelTrait, EntityTrait, IntoActiveModel, Set};
use sea_orm_migration::MigratorTrait;
use zerolux::{
    db::{Migrator, connect},
    entity::{
        actors, chat_outbox, conversation_members, conversations, deliveries, messages, sessions,
        tool_approvals, workspace,
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
    let company = workspace::ActiveModel {
        id: Set("workspace".into()),
        name: Set("Fixture".into()),
        created_at: Set(1),
        folder: Set("/fixture/.zerolux".into()),
    }
    .insert(&db)
    .await
    .unwrap();
    let other = workspace::ActiveModel {
        id: Set("other".into()),
        name: Set("Other".into()),
        created_at: Set(1),
        folder: Set("workspaces/other".into()),
    }
    .insert(&db)
    .await
    .unwrap();
    let w = || Set(company.id.clone());
    let owner = actors::ActiveModel {
        workspace_id: w(),
        id: Set("owner".into()),
        name: Set("Owner".into()),
        kind: Set("human".into()),
        auth_subject: Set(Some("fixture-subject".into())),
        role: Set(Some("owner".into())),
        created_at: Set(1),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let agent = actors::ActiveModel {
        workspace_id: w(),
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
    let session = sessions::ActiveModel {
        workspace_id: w(),
        id: Set("session".into()),
        actor_id: Set(Some(agent.id.clone())),
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
        owner_id: Set(owner.id.clone()),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let conversation = conversations::ActiveModel {
        workspace_id: w(),
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
        workspace_id: w(),
        conversation_id: Set(conversation.id.clone()),
        actor_id: Set(agent.id.clone()),
        session_id: Set(Some(session.id.clone())),
    }
    .insert(&db)
    .await
    .unwrap();
    let message = messages::ActiveModel {
        workspace_id: w(),
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
        workspace_id: w(),
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
        workspace_id: w(),
        id: Set("approval".into()),
        session_id: Set(session.id.clone()),
        delivery_id: Set(Some(delivery.id.clone())),
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
        workspace_id: w(),
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
                $entity::Entity::find_by_id(($model.workspace_id.clone(), $model.id.clone()))
                    .one(&upgraded)
                    .await
                    .unwrap(),
                Some($model.clone())
            );
        };
    }
    unchanged!(actors, owner);
    unchanged!(actors, agent);
    assert_eq!(
        workspace::Entity::find_by_id(company.id.clone())
            .one(&upgraded)
            .await
            .unwrap(),
        Some(company.clone())
    );
    unchanged!(sessions, session);
    unchanged!(conversations, conversation);
    unchanged!(messages, message);
    unchanged!(deliveries, delivery);
    unchanged!(tool_approvals, approval);
    assert_eq!(
        conversation_members::Entity::find_by_id((
            company.id.clone(),
            conversation.id.clone(),
            agent.id.clone()
        ))
        .one(&upgraded)
        .await
        .unwrap(),
        Some(member.clone())
    );
    assert_eq!(
        chat_outbox::Entity::find_by_id((company.id.clone(), "notice".to_owned()))
            .one(&upgraded)
            .await
            .unwrap(),
        Some(notice)
    );

    // The application connection enforces FKs after SQLite's private migration connection.
    assert!(
        actors::ActiveModel {
            workspace_id: w(),
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
    // Preserve the CHECKs (a person has a role, an agent none) and the single-owner and
    // one-person-per-account partial unique constraints.
    for (id, kind, role, subject) in [
        ("invalid-kind", "invalid", None, None),
        ("no-role", "human", None, None),
        ("agent-role", "agent", Some("member"), None),
        ("invalid-role", "human", Some("admin"), None),
        ("second-owner", "human", Some("owner"), None),
        (
            "same-account",
            "human",
            Some("member"),
            Some("fixture-subject"),
        ),
    ] {
        assert!(
            actors::ActiveModel {
                workspace_id: w(),
                id: Set(id.into()),
                name: Set("Invalid".into()),
                kind: Set(kind.into()),
                owner_id: Set((kind == "agent").then(|| owner.id.clone())),
                harness: Set((kind == "agent").then(|| "pi".to_owned())),
                role: Set(role.map(str::to_owned)),
                auth_subject: Set(subject.map(str::to_owned)),
                created_at: Set(20),
                ..Default::default()
            }
            .insert(&upgraded)
            .await
            .is_err(),
            "{id}"
        );
    }
    // Another workspace's people: the same account, an owner of their own; never linked to
    // this workspace's rows, even by mistake.
    let elsewhere = actors::ActiveModel {
        workspace_id: Set(other.id.clone()),
        id: Set("elsewhere".into()),
        name: Set("Owner".into()),
        kind: Set("human".into()),
        auth_subject: Set(Some("fixture-subject".into())),
        role: Set(Some("owner".into())),
        created_at: Set(20),
        ..Default::default()
    }
    .insert(&upgraded)
    .await
    .unwrap();
    assert!(
        actors::ActiveModel {
            workspace_id: Set(other.id.clone()),
            id: Set("borrowed".into()),
            name: Set("Borrowed".into()),
            kind: Set("agent".into()),
            owner_id: Set(Some(owner.id.clone())),
            harness: Set(Some("pi".into())),
            created_at: Set(20),
            ..Default::default()
        }
        .insert(&upgraded)
        .await
        .is_err()
    );
    let mut crossing = message.clone().into_active_model();
    crossing.id = Set("crossing".into());
    crossing.seq = Set(2);
    crossing.author_id = Set(elsewhere.id.clone());
    assert!(crossing.insert(&upgraded).await.is_err());
    let mut moved = member.clone().into_active_model();
    moved.workspace_id = Set(other.id.clone());
    assert!(moved.insert(&upgraded).await.is_err());
    // One row per native session in a workspace: a second one is refused, live or not.
    let mut second = session.clone().into_active_model();
    second.id = Set("second".into());
    second.token_hash = Set("second-fixture-not-a-token".into());
    assert!(second.clone().insert(&upgraded).await.is_err());
    unchanged!(sessions, session);
    // Another workspace has its own sessions, of its own people.
    second.workspace_id = Set(other.id.clone());
    second.actor_id = Set(None);
    second.owner_id = Set(elsewhere.id.clone());
    second.insert(&upgraded).await.unwrap();
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
            "one_workspace_owner",
            "one_actor_per_subject",
            "sessions_native_session",
            "one_open_thread_per_root",
            "deliveries_session",
            "chat_outbox_pending",
        ] {
            assert!(sql.contains(name), "missing {name} for {backend:?}");
        }
        assert!(sql.contains("CHECK"));
        assert!(sql.contains("FOREIGN KEY"));
        assert!(!sql.contains("DROP TABLE"));
    }
}
