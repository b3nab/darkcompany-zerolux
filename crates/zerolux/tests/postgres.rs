//! The bootstrap schema on PostgreSQL, against a disposable server named by
//! `ZEROLUX_TEST_POSTGRES_URL` (skipped otherwise). Every run creates and drops its own
//! database; nothing shared is touched.
use sea_orm::{ConnectionTrait, Statement};
use sqlx::Executor;
use zerolux::db::{Location, connect};

#[tokio::test]
async fn the_bootstrap_schema_applies_to_postgres_in_a_database_of_its_own() {
    let Ok(admin) = std::env::var("ZEROLUX_TEST_POSTGRES_URL") else {
        eprintln!("ZEROLUX_TEST_POSTGRES_URL not set: skipped");
        return;
    };
    let name = format!("zl_{}", uuid::Uuid::new_v4().simple());
    let control = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(&admin)
        .await
        .unwrap();
    control
        .execute(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
        .await
        .unwrap();
    let url = {
        let mut url = reqwest::Url::parse(&admin).unwrap();
        url.set_path(&format!("/{name}"));
        url.to_string()
    };
    let result = async {
        // Two kernels at once: one migrates, the other waits and finds nothing to do.
        let location = Location::Postgres(url.clone());
        let (db, again) = tokio::join!(connect(&location), connect(&location));
        let (db, again) = (db?, again?);
        let tables = db
            .query_all_raw(Statement::from_string(
                db.get_database_backend(),
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
            ))
            .await?
            .into_iter()
            .map(|row| row.try_get::<String>("", "table_name"))
            .collect::<Result<Vec<_>, _>>()?;
        let ledger = again
            .query_all_raw(Statement::from_string(
                db.get_database_backend(),
                "SELECT version FROM seaql_migrations ORDER BY version",
            ))
            .await?
            .into_iter()
            .map(|row| row.try_get::<String>("", "version"))
            .collect::<Result<Vec<_>, _>>()?;
        Ok::<_, anyhow::Error>((tables, ledger))
    }
    .await;
    control
        .execute(sqlx::AssertSqlSafe(format!(
            "DROP DATABASE {name} WITH (FORCE)"
        )))
        .await
        .unwrap();
    let (tables, ledger) = result.unwrap();
    for table in [
        "actors",
        "workspace",
        "chat_sessions",
        "conversations",
        "messages",
        "deliveries",
        "tool_approvals",
        "console_streams",
        "console_events",
        "seaql_migrations",
    ] {
        assert!(
            tables.contains(&table.to_owned()),
            "missing {table}: {tables:?}"
        );
    }
    assert!(!tables.contains(&"_sqlx_migrations".to_owned()));
    assert_eq!(ledger, vec!["m0001_bootstrap".to_owned()]);
}

#[path = "support/db.rs"]
mod db;

use serde_json::json;
use zerolux::{
    chat::RELINKING,
    harness::Harness,
    model::{ChatIdentity, CreateConversation, HireChatSession, SetOwnerName},
    store::{Error, Store},
};

async fn owner(store: &Store) -> ChatIdentity {
    store
        .set_owner_name(SetOwnerName {
            name: "Owner".into(),
        })
        .await
        .unwrap();
    store.chat_identity(None).await.unwrap()
}

fn hire(native: &str, resume: bool) -> HireChatSession {
    HireChatSession {
        name: "aspen".into(),
        actor_id: None,
        harness: Harness::ClaudeCode,
        native_session_id: native.into(),
        title: "aspen".into(),
        workspace: "/tmp".into(),
        native_locator: json!({"fixture": true}),
        resume,
    }
}

/// Two kernels bootstrapping one fresh database at once: one workspace, one owner.
#[tokio::test]
async fn concurrent_first_opens_on_postgres_create_one_workspace() {
    if std::env::var("ZEROLUX_TEST_POSTGRES_URL").is_err() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let database = db::TestDatabase::new(dir.path().join("unused.db")).await;
    let (a, b) = tokio::join!(database.open(), database.open());
    let (a, b) = (a.workspace().await.unwrap(), b.workspace().await.unwrap());
    assert_eq!(a.workspace.id, b.workspace.id);
    assert_eq!(a.actors.len(), 1);
    assert_eq!(a.actors[0].id, b.actors[0].id);
}

/// The owner's Stop and an automatic relink of the same context, interleaved: the relink
/// starts while the Stop's transaction is open, and must see its outcome, not the state
/// before it. Without one writer at a time it would read "relinking" and hire a successor.
#[tokio::test]
async fn a_relink_started_during_a_stop_sees_the_stop() {
    if std::env::var("ZEROLUX_TEST_POSTGRES_URL").is_err() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let database = db::TestDatabase::new(dir.path().join("unused.db")).await;
    let store = database.open().await;
    let owner = owner(&store).await;
    let issued = store
        .hire_chat_session(&owner, hire("native-1", false))
        .await
        .unwrap();
    assert!(
        !store
            .stop_chat_session_marked(&owner, &issued.session.id, RELINKING)
            .await
            .unwrap()
    );
    assert!(
        store
            .relink_wanted("claude-code", "native-1")
            .await
            .unwrap()
    );
    // The Stop: a write transaction that clears the relink mark, open for a while.
    let stop = store.write().await.unwrap();
    let relink = {
        let store = store.clone();
        let owner = owner.clone();
        tokio::spawn(async move {
            store
                .hire_chat_session(&owner, hire("native-1", true))
                .await
        })
    };
    // Give the relink every chance to run ahead of the commit: with writers taking turns it
    // waits here instead.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    stop.execute_raw(zerolux::store::sql(
        &stop,
        "UPDATE chat_sessions SET attention_reason=NULL WHERE id=$1",
        [issued.session.id.clone().into()],
    ))
    .await
    .unwrap();
    stop.commit().await.unwrap();
    assert!(matches!(relink.await.unwrap(), Err(Error::StoppedByOwner)));
    assert_eq!(store.chat_sessions(&owner).await.unwrap().len(), 1);
}

/// A read transaction is one snapshot: what commits meanwhile is not seen until the next.
#[tokio::test]
async fn a_read_transaction_is_one_snapshot() {
    if std::env::var("ZEROLUX_TEST_POSTGRES_URL").is_err() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let database = db::TestDatabase::new(dir.path().join("unused.db")).await;
    let store = database.open().await;
    let owner = owner(&store).await;
    let issued = store
        .hire_chat_session(&owner, hire("native-1", false))
        .await
        .unwrap();
    async fn count(tx: &sea_orm::DatabaseTransaction) -> i64 {
        tx.query_one_raw(zerolux::store::sql(
            tx,
            "SELECT count(*) AS n FROM conversations",
            [],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get_by_index::<i64>(0)
        .unwrap()
    }
    let reading = store.read().await.unwrap();
    assert_eq!(count(&reading).await, 0);
    store
        .create_conversation(
            &owner,
            CreateConversation {
                kind: "dm".into(),
                title: "Snapshot".into(),
                members: vec![zerolux::model::ConversationMemberInput {
                    actor_id: issued.actor.id.clone(),
                    session_id: Some(issued.session.id.clone()),
                }],
            },
        )
        .await
        .unwrap();
    assert_eq!(count(&reading).await, 0, "the snapshot holds");
    reading.commit().await.unwrap();
    assert_eq!(count(&store.read().await.unwrap()).await, 1);
}
