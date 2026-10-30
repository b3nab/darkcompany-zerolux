use std::path::Path;

use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use sha2::Digest;
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use zerolux::{
    api,
    db::Location,
    model::{Actor, Workspace},
    store::{Instance, Store, now_ms},
};

/// A new workspace in the database at `path`, made with its owner, as an account makes it.
async fn create(path: &Path) -> String {
    Instance::open(&Location::Sqlite(path.to_owned()))
        .await
        .unwrap()
        .create_workspace("owner-account", "Ada Lovelace", "Workspace", None)
        .await
        .unwrap()
        .id
}

async fn open(path: &Path, workspace: &str) -> Store {
    Instance::open(&Location::Sqlite(path.to_owned()))
        .await
        .unwrap()
        .store(workspace)
}

struct Server {
    workspace: String,
    owner_id: String,
    url: String,
    client: Client,
    task: tokio::task::JoinHandle<()>,
}
impl Server {
    async fn create(path: &Path) -> Self {
        Self::open(path, &create(path).await).await
    }

    async fn open(path: &Path, workspace: &str) -> Self {
        let store = open(path, workspace).await;
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
        let app = api::router(store, path.with_extension("web"));
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            workspace: workspace.to_owned(),
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
    let instance = Instance::open(&Location::Sqlite(path.to_owned()))
        .await
        .unwrap();
    let pool = SqlitePoolOptions::new()
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(true)
                .foreign_keys(true),
        )
        .await
        .unwrap();
    drop(instance);
    pool
}

#[tokio::test]
async fn a_new_workspace_has_its_named_owner_and_no_placeholder_agent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("new.db");
    let server = Server::create(&path).await;
    let workspace = server.workspace().await;
    // The owner is the account that made it, named after it: there is nothing to set up.
    assert!(!workspace.onboarding_required);
    assert_eq!(workspace.actors.len(), 1);
    assert_eq!(workspace.actors[0].kind, "human");
    assert_eq!(workspace.actors[0].name, "Ada Lovelace");
    assert_eq!(workspace.actors[0].role.as_deref(), Some("owner"));
    assert_eq!(
        uuid::Uuid::parse_str(&workspace.actors[0].id)
            .unwrap()
            .get_version_num(),
        4
    );
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
        assert_eq!(server.workspace().await.actors[0].name, "Ada Lovelace");
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
    let actor = server.hire().await;
    assert_eq!(actor.owner_id.as_deref(), Some(owner.id.as_str()));
    assert!(!actor.archived);
    let reopened = open(&path, &server.workspace)
        .await
        .workspace()
        .await
        .unwrap();
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
async fn concurrent_first_opens_make_one_instance_and_each_workspace_has_one_owner() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("concurrent.db");
    let location = Location::Sqlite(path.clone());
    // Nothing exists yet: both opens migrate and make the instance at once.
    let (a, b) = tokio::join!(Instance::open(&location), Instance::open(&location));
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a.id(), b.id());
    assert_eq!(a.auth_secret(), b.auth_secret());
    let id = uuid::Uuid::parse_str(a.id()).unwrap();
    assert_eq!(id.get_version_num(), 4);
    assert_eq!(id.get_variant(), uuid::Variant::RFC4122);
    let independent = Instance::open(&Location::Sqlite(dir.path().join("other.db")))
        .await
        .unwrap();
    assert_ne!(a.id(), independent.id());
    // Each workspace is born with its owner, in the same instant, by the same transaction.
    let first = a
        .create_workspace("owner-account", "Owner", "First", None)
        .await
        .unwrap();
    let second = b
        .create_workspace("owner-account", "Owner", "Second", None)
        .await
        .unwrap();
    let first = a.store(&first.id).workspace().await.unwrap();
    let second = b.store(&second.id).workspace().await.unwrap();
    assert_eq!(first.workspace.created_at, first.actors[0].created_at);
    assert_ne!(first.actors[0].id, second.actors[0].id);
    let pool = migrated_database(&path).await;
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM instance")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 1);
    // The schema itself refuses a second owner of a workspace.
    assert!(
        sqlx::query(
            "INSERT INTO actors (workspace_id, id, name, kind, role, created_at)
            VALUES (?, ?, 'Second owner', 'human', 'owner', 1)"
        )
        .bind(&first.workspace.id)
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
    let server = Server::create(&path).await;
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
    let reopened = open(&path, &server.workspace)
        .await
        .workspace()
        .await
        .unwrap();
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
        // An agent is hired by its own person.
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn the_workspace_and_every_actor_carry_a_creation_date() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("dates.db");
    let before = now_ms();
    let server = Server::create(&path).await;
    let workspace = server.workspace().await;
    // Day 1: created with its owner, named as its owner named it.
    assert_eq!(workspace.workspace.name, "Workspace");
    assert!(workspace.workspace.created_at >= before);
    assert_eq!(
        uuid::Uuid::parse_str(&workspace.workspace.id)
            .unwrap()
            .get_version_num(),
        4
    );
    let owner = &workspace.actors[0];
    assert!(owner.created_at >= before);
    // The health endpoint names the company without a device token.
    let health: Value = server
        .client
        .get(format!("{}/api/health", server.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health["workspace"]["id"], json!(workspace.workspace.id));
    assert_eq!(health["workspace"]["name"], json!("Workspace"));

    server.name_owner().await;
    let agent = server.hire().await;
    assert!(agent.created_at >= owner.created_at);

    // Renaming is explicit and validated; the date never moves.
    let renamed: Value = server
        .post("/workspace", json!({"name":"Dark Company"}))
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(renamed["workspace"]["name"], json!("Dark Company"));
    assert_eq!(
        renamed["workspace"]["created_at"],
        json!(workspace.workspace.created_at)
    );
    for bad in ["", "   ", "a\u{0}b"] {
        assert_eq!(
            server
                .post("/workspace", json!({"name":bad}))
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    // Reopening keeps the same workspace row: identity and day 1 are never regenerated.
    let id = server.workspace.clone();
    drop(server);
    let reopened = Server::open(&path, &id).await.workspace().await;
    assert_eq!(reopened.workspace.id, workspace.workspace.id);
    assert_eq!(reopened.workspace.name, "Dark Company");
    assert_eq!(
        reopened.workspace.created_at,
        workspace.workspace.created_at
    );
}

#[tokio::test]
async fn only_the_owner_renames_the_workspace_and_names_are_bytes_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rename.db");
    let server = Server::create(&path).await;
    server.name_owner().await;
    let agent = server.hire().await;
    // An agent session, with the token the kernel would have issued to it.
    let pool = migrated_database(&path).await;
    let token = "agent-token";
    let hash = format!("{:x}", sha2::Sha256::digest(token.as_bytes()));
    sqlx::query("INSERT INTO sessions (workspace_id, id, actor_id, harness, native_session_id, title, workspace, native_locator_json, token_hash, status, created_at, owner_id)
        VALUES (?, 's1', ?, 'pi', 'native', 'pi', '/w', '{}', ?, 'connected', 1, ?)")
        .bind(&server.workspace)
        .bind(&agent.id)
        .bind(&hash)
        .bind(agent.owner_id.as_deref())
        .execute(&pool)
        .await
        .unwrap();
    let forbidden = server
        .client
        .post(format!("{}/api/workspace", server.url))
        .bearer_auth(token)
        .json(&json!({"name":"Hijacked"}))
        .send()
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
    let unknown = server
        .client
        .post(format!("{}/api/workspace", server.url))
        .bearer_auth("no-such-token")
        .json(&json!({"name":"Hijacked"}))
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(server.workspace().await.workspace.name, "Workspace");

    // Spaces and Unicode are names; the bound is 200 bytes after trimming, not 200 characters.
    for name in ["Società  Oscura", "黒い会社", &"é".repeat(100)] {
        let renamed: Value = server
            .post("/workspace", json!({"name": format!("  {name}  ")}))
            .await
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(renamed["workspace"]["name"], json!(name));
    }
    assert_eq!(
        server
            .post("/workspace", json!({"name": "é".repeat(101)}))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        server
            .post("/workspace", json!({"name": "a".repeat(201)}))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn carried_over_dates_survive_reopen_rename_and_relink() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("carried.db");
    let server = Server::create(&path).await;
    server.name_owner().await;
    let agent = server.hire().await;
    let id = server.workspace.clone();
    drop(server);
    // What a data pass writes for rows that predate the dates: the dates it found.
    let pool = migrated_database(&path).await;
    sqlx::query("UPDATE workspace SET created_at = 1000")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE actors SET created_at = 1000 WHERE kind = 'human'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE actors SET created_at = 2000 WHERE id = ?")
        .bind(&agent.id)
        .execute(&pool)
        .await
        .unwrap();
    // A date is never optional.
    assert!(
        sqlx::query("UPDATE actors SET created_at = NULL WHERE id = ?")
            .bind(&agent.id)
            .execute(&pool)
            .await
            .is_err()
    );
    pool.close().await;

    let server = Server::open(&path, &id).await;
    let dated = |workspace: &Workspace| {
        let owner = workspace.actors.iter().find(|a| a.kind == "human").unwrap();
        let hired = workspace.actors.iter().find(|a| a.id == agent.id).unwrap();
        (
            workspace.workspace.created_at,
            owner.created_at,
            hired.created_at,
        )
    };
    let expected = (1000, 1000, 2000);
    assert_eq!(dated(&server.workspace().await), expected);
    // Renaming the owner, the agent and the workspace moves no date.
    server
        .post("/onboarding/owner", json!({"name":"Ada Byron"}))
        .await
        .error_for_status()
        .unwrap();
    server
        .post("/workspace", json!({"name":"Analytical Engines"}))
        .await
        .error_for_status()
        .unwrap();
    server
        .post(
            &format!("/actors/{}/name", agent.id),
            json!({"name":"pi two"}),
        )
        .await
        .error_for_status()
        .unwrap();
    assert_eq!(dated(&server.workspace().await), expected);
    // A newly hired agent, after the carried-over ones, gets the current time.
    let fresh = server.hire().await;
    assert!(fresh.created_at > 2000);
}

#[tokio::test]
async fn a_database_of_a_newer_kernel_is_refused_without_change() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("newer.db");
    let pool = migrated_database(&path).await;
    sqlx::query("INSERT INTO seaql_migrations (version, applied_at) VALUES ('m9999_unknown', 0)")
        .execute(&pool)
        .await
        .unwrap();
    let before =
        sqlx::query_scalar::<_, String>("SELECT version FROM seaql_migrations ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap();
    match Instance::open(&Location::Sqlite(path.clone())).await {
        Err(error) => assert!(error.to_string().contains("m9999_unknown"), "{error}"),
        Ok(_) => panic!("A database of a newer kernel must not be opened"),
    }
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT version FROM seaql_migrations ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap(),
        before
    );
}
