use std::path::Path;

use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use zerolux::{
    api,
    model::{Actor, Project, Task, Workspace},
    store::{Error, Store, now_ms},
};

struct Server {
    store: Store,
    owner_id: String,
    url: String,
    client: Client,
    task: tokio::task::JoinHandle<()>,
}
impl Server {
    async fn open(path: &Path) -> Self {
        let store = Store::open(path).await.unwrap();
        let owner_id = store
            .workspace()
            .await
            .unwrap()
            .actors
            .into_iter()
            .find(|actor| actor.kind == "human")
            .unwrap()
            .id;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = api::router(store.clone(), path.with_extension("web"));
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            store,
            owner_id,
            url,
            task,
            client: Client::builder().no_proxy().build().unwrap(),
        }
    }
    async fn post(&self, path: &str, body: Value) -> reqwest::Response {
        self.client
            .post(format!("{}/api{path}", self.url))
            .json(&body)
            .send()
            .await
            .unwrap()
    }
    async fn workspace(&self) -> Workspace {
        self.client
            .get(format!("{}/api/workspace", self.url))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    async fn name_owner(&self) {
        self.post("/onboarding/owner", json!({"name":"Ada Lovelace"}))
            .await
            .error_for_status()
            .unwrap();
    }
    async fn hire(&self) -> Actor {
        self.post(
            "/actors",
            json!({"name":"pi", "harness":"pi", "owner_id":self.owner_id}),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn migrated_database(path: &Path) -> SqlitePool {
    let store = Store::open(path).await.unwrap();
    let pool = SqlitePoolOptions::new()
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(true)
                .foreign_keys(true),
        )
        .await
        .unwrap();
    drop(store);
    pool
}

#[tokio::test]
async fn first_run_requires_owner_name_and_has_no_placeholder_agent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("new.db");
    let server = Server::open(&path).await;
    let workspace = server.workspace().await;
    assert!(workspace.onboarding_required);
    assert_eq!(workspace.actors.len(), 1);
    assert_eq!(workspace.actors[0].kind, "human");
    assert_eq!(
        uuid::Uuid::parse_str(&workspace.actors[0].id)
            .unwrap()
            .get_version_num(),
        4
    );
    assert!(workspace.projects.is_empty());
    assert!(workspace.connections.is_empty());
    for (route, body) in [
        ("/projects", json!({"name":"Blocked"})),
        (
            "/actors",
            json!({"name":"pi", "harness":"pi", "owner_id":server.owner_id}),
        ),
        (
            "/tasks",
            json!({"project_id":"missing", "title":"Blocked", "assignee_id":"local-agent"}),
        ),
        ("/tasks/missing/actions", json!({"action":"queue"})),
        ("/tasks/missing/assignee", json!({"assignee_id":"missing"})),
        (
            "/connections",
            json!({"project_id":"missing", "actor_id":"local-agent", "mode":"process", "workspace":dir.path()}),
        ),
        (
            "/worker/claim",
            json!({"project_id":"missing", "actor_id":"local-agent"}),
        ),
    ] {
        let response = server.post(route, body).await;
        assert_eq!(response.status(), StatusCode::CONFLICT, "{route}");
        assert!(response.text().await.unwrap().contains("Set your name"));
    }
    for name in [
        "".to_owned(),
        " \t\n\u{2003}".to_owned(),
        " Local owner ".to_owned(),
        "LOCAL OWNER".to_owned(),
        "x".repeat(201),
        "😀".repeat(51),
        "Ada\nInjected".to_owned(),
    ] {
        assert_eq!(
            server
                .post("/onboarding/owner", json!({"name":name}))
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert!(server.workspace().await.onboarding_required);
    }
    let owner: Actor = server
        .post("/onboarding/owner", json!({"name":"  Élodie 李  "}))
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(owner.name, "Élodie 李");
    assert_eq!(owner.id, workspace.actors[0].id);
    let project: Project = server
        .post("/projects", json!({"name":"Ready"}))
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let actor = server.hire().await;
    assert_eq!(actor.owner_id.as_deref(), Some(owner.id.as_str()));
    assert!(!actor.archived);
    assert_eq!(server.post("/tasks", json!({"project_id":project.id,"title":"No placeholder", "assignee_id":"local-agent"})).await.status(), StatusCode::BAD_REQUEST);
    let reopened = Store::open(&path).await.unwrap().workspace().await.unwrap();
    assert!(!reopened.onboarding_required);
    assert_eq!(
        reopened
            .actors
            .iter()
            .find(|a| a.id == owner.id)
            .unwrap()
            .name,
        "Élodie 李"
    );
    assert!(!reopened.actors.iter().any(|a| a.id == "local-agent"));
}

#[tokio::test]
async fn owner_uuid_is_unique_per_database_and_stable_across_concurrent_opens() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("concurrent.db");
    // Migrate once: exercise concurrent owner initialization, not concurrent SQLx DDL.
    let pool = SqlitePoolOptions::new()
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    sqlx::migrate!().run(&pool).await.unwrap();
    pool.close().await;
    let (a, b) = tokio::join!(Store::open(&path), Store::open(&path));
    let a = a.unwrap().workspace().await.unwrap();
    let b = b.unwrap().workspace().await.unwrap();
    assert_eq!(a.actors.len(), 1);
    assert_eq!(b.actors.len(), 1);
    assert_eq!(a.actors[0].id, b.actors[0].id);
    let id = uuid::Uuid::parse_str(&a.actors[0].id).unwrap();
    assert_eq!(id.get_version_num(), 4);
    assert_eq!(id.get_variant(), uuid::Variant::RFC4122);
    let independent = Store::open(&dir.path().join("other.db"))
        .await
        .unwrap()
        .workspace()
        .await
        .unwrap();
    assert_ne!(a.actors[0].id, independent.actors[0].id);
    let pool = migrated_database(&path).await;
    assert!(
        sqlx::query("INSERT INTO actors (id, name, kind) VALUES (?, 'Second owner', 'human')")
            .bind(uuid::Uuid::new_v4().to_string())
            .execute(&pool)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn renaming_owner_preserves_uuid_and_existing_agent_ownership() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rename.db");
    let server = Server::open(&path).await;
    server.name_owner().await;
    let agent = server.hire().await;
    let owner: Actor = server
        .post("/onboarding/owner", json!({"name":"Updated name"}))
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(owner.id, server.owner_id);
    assert_eq!(owner.name, "Updated name");
    let reopened = Store::open(&path).await.unwrap().workspace().await.unwrap();
    assert!(!reopened.onboarding_required);
    assert_eq!(reopened.actors.len(), 2);
    assert_eq!(
        reopened
            .actors
            .iter()
            .find(|a| a.kind == "human")
            .unwrap()
            .id,
        owner.id
    );
    assert_eq!(
        reopened
            .actors
            .iter()
            .find(|a| a.id == agent.id)
            .unwrap()
            .owner_id
            .as_deref(),
        Some(owner.id.as_str())
    );
    assert_eq!(
        server
            .post(
                "/actors",
                json!({"name":"Invalid", "harness":"pi", "owner_id":"local-human"})
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn archived_agents_preserve_history_and_require_explicit_reassignment() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("archived.db");
    let pool = migrated_database(&path).await;
    // Explicit fixture only: the kernel never seeds an agent or imports old databases.
    sqlx::query("INSERT INTO actors (id, name, kind, owner_id, archived) SELECT 'local-agent', 'Archived fixture', 'agent', id, 1 FROM actors WHERE kind = 'human'").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO projects VALUES ('project', 'Existing project', '', 1)")
        .execute(&pool)
        .await
        .unwrap();
    for status in ["draft", "queued", "failed", "review", "running", "done"] {
        sqlx::query("INSERT INTO tasks VALUES (?, 'project', 'Keep me', '', 'local-agent', ?, 'Human feedback', 1, 2)")
            .bind(status).bind(status).execute(&pool).await.unwrap();
    }
    let now = now_ms();
    sqlx::query("INSERT INTO agent_connections (id, actor_id, project_id, mode, workspace, connected_at, lease_expires_at) VALUES ('live', 'local-agent', 'project', 'process', ?, ?, ?)")
        .bind(dir.path().to_string_lossy().as_ref()).bind(now).bind(now + 90_000).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO runs (id, task_id, status, stdout, exit_code, started_at, finished_at, lease_expires_at, actor_id) VALUES ('history', 'review', 'succeeded', 'Keep this result', 0, 1, 2, 2, 'local-agent')").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO runs (id, task_id, status, started_at, lease_expires_at, connection_id, actor_id) VALUES ('active-run', 'running', 'running', ?, ?, 'live', 'local-agent')")
        .bind(now).bind(now + 90_000).execute(&pool).await.unwrap();
    let server = Server::open(&path).await;
    let workspace = server.workspace().await;
    assert!(workspace.onboarding_required);
    assert_eq!(workspace.tasks.len(), 6);
    assert!(
        workspace
            .actors
            .iter()
            .find(|a| a.id == "local-agent")
            .unwrap()
            .archived
    );
    assert_eq!(
        server.store.runs("review").await.unwrap()[0].stdout,
        "Keep this result"
    );
    // Onboarding does not cut off an already running task's heartbeat or result delivery.
    assert_eq!(
        server
            .post("/worker/runs/active-run/heartbeat", json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        server
            .post(
                "/worker/runs/active-run/finish",
                json!({"stdout":"Completed before onboarding", "stderr":"", "exit_code":0})
            )
            .await
            .status(),
        StatusCode::OK
    );
    server.name_owner().await;
    let agent = server.hire().await;
    assert_eq!(
        server
            .post(
                "/tasks",
                json!({"project_id":"project", "title":"Invalid", "assignee_id":"local-agent"})
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(server.post("/connections", json!({"actor_id":"local-agent","project_id":"project","mode":"process","workspace":dir.path()})).await.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        server
            .post(
                "/worker/claim",
                json!({"actor_id":"local-agent","project_id":"project","connection_id":"live"})
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        server
            .post("/tasks/queued/actions", json!({"action":"queue"}))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        server
            .post(
                "/tasks/review/actions",
                json!({"action":"request_changes", "note":"Needs work"})
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        server
            .post(
                "/tasks/review/assignee",
                json!({"assignee_id":server.owner_id})
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        server
            .post(
                "/tasks/review/assignee",
                json!({"assignee_id":"local-agent"})
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    for status in ["draft", "queued", "failed", "review"] {
        let task: Task = server
            .post(
                &format!("/tasks/{status}/assignee"),
                json!({"assignee_id":agent.id}),
            )
            .await
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(task.status, "draft");
        assert_eq!(task.assignee_id, agent.id);
        assert_eq!(task.review_note, "Human feedback");
        assert_eq!(task.id, status);
    }
    assert_eq!(
        server.store.runs("review").await.unwrap()[0]
            .actor_id
            .as_deref(),
        Some("local-agent")
    );
    assert_eq!(
        server.store.runs("review").await.unwrap()[0].stdout,
        "Keep this result"
    );
    assert_eq!(
        server
            .post("/tasks/done/assignee", json!({"assignee_id":agent.id}))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    // Finished historical work can still be reviewed without silently relabeling its author.
    assert_eq!(
        server
            .post("/tasks/running/actions", json!({"action":"approve"}))
            .await
            .status(),
        StatusCode::OK
    );
    assert!(
        sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&pool)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn reopening_preserves_archived_connection_history_and_owner_name() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let pool = migrated_database(&path).await;
    sqlx::query("INSERT INTO actors (id, name, kind, owner_id, archived) SELECT 'local-agent', 'Archived fixture', 'agent', id, 1 FROM actors WHERE kind = 'human'").execute(&pool).await.unwrap();
    sqlx::query("UPDATE actors SET name = 'Existing custom name' WHERE kind = 'human'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO projects VALUES ('project', 'Old project', '', 1)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agent_connections VALUES ('old', 'local-agent', 'project', 'process', '/old-workspace', NULL, 1, 2, 2)").execute(&pool).await.unwrap();
    let workspace = Store::open(&path).await.unwrap().workspace().await.unwrap();
    assert_eq!(
        workspace
            .actors
            .iter()
            .find(|a| a.kind == "human")
            .unwrap()
            .name,
        "Existing custom name"
    );
    assert!(workspace.onboarding_required);
    assert!(
        workspace
            .actors
            .iter()
            .find(|a| a.id == "local-agent")
            .unwrap()
            .archived
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM agent_connections")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    assert!(
        sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&pool)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn incompatible_migration_metadata_is_rejected_without_resetting_data() {
    for (change, expected) in [
        (
            "UPDATE _sqlx_migrations SET checksum = x'00' WHERE version = 1",
            sqlx::migrate::MigrateError::VersionMismatch(1),
        ),
        (
            "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (2, 'Unknown migration', 1, x'00', 0)",
            sqlx::migrate::MigrateError::VersionMissing(2),
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("incompatible.db");
        let pool = migrated_database(&path).await;
        sqlx::query("INSERT INTO projects VALUES ('keep', 'Do not delete me', '', 1)")
            .execute(&pool)
            .await
            .unwrap();
        // Simulate migration metadata that does not match this build.
        sqlx::query(change).execute(&pool).await.unwrap();
        let metadata = sqlx::query_as::<_, (i64, Vec<u8>)>(
            "SELECT version, checksum FROM _sqlx_migrations ORDER BY version",
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        match Store::open(&path).await {
            Err(Error::Migration(error)) => assert_eq!(error.to_string(), expected.to_string()),
            Err(error) => panic!("Expected migration validation failure, got {error}"),
            Ok(_) => panic!("An incompatible database must not be opened"),
        }
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT name FROM projects WHERE id = 'keep'")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "Do not delete me"
        );
        assert_eq!(
            sqlx::query_as::<_, (i64, Vec<u8>)>(
                "SELECT version, checksum FROM _sqlx_migrations ORDER BY version"
            )
            .fetch_all(&pool)
            .await
            .unwrap(),
            metadata
        );
    }
}

#[test]
fn worker_requires_an_explicit_actor_instead_of_defaulting_to_placeholder() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_zerolux"))
        .args([
            "worker",
            "--project",
            "test",
            "--workspace",
            "/tmp",
            "--harness",
            "pi",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("--actor"));
}
