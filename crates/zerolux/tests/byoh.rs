//! Agents hired by name, through the API, before any native session is attached to them.
use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use sqlx::sqlite::SqlitePoolOptions;
use zerolux::{
    api,
    model::{Actor, SetOwnerName, Workspace},
    store::Store,
};

struct Kernel {
    dir: tempfile::TempDir,
    owner: Actor,
    url: String,
    client: Client,
    server: tokio::task::JoinHandle<()>,
}
impl Kernel {
    async fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("test.db")).await.unwrap();
        let owner = store
            .set_owner_name(SetOwnerName {
                name: "Test owner".into(),
            })
            .await
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = api::router(store, dir.path().join("web"));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            dir,
            owner,
            url,
            client: Client::builder().no_proxy().build().unwrap(),
            server,
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
    async fn hire(&self, harness: &str) -> Actor {
        self.post(
            "/actors",
            json!({"name":harness,"harness":harness,"owner_id":self.owner.id}),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap()
    }
}
impl Drop for Kernel {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[tokio::test]
async fn hiring_names_an_agent_of_a_harness_and_only_humans_can_own_agents() {
    let kernel = Kernel::start().await;
    for harness in ["pi", "claude-code", "codex"] {
        let actor = kernel.hire(harness).await;
        assert_eq!(actor.harness.as_deref(), Some(harness));
        assert_eq!(actor.owner_id.as_deref(), Some(kernel.owner.id.as_str()));
    }
    let workspace: Workspace = kernel
        .client
        .get(format!("{}/api/workspace", kernel.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(workspace.actors.len(), 4);
    let agent_id = &workspace
        .actors
        .iter()
        .find(|a| a.kind == "agent")
        .unwrap()
        .id;
    assert_eq!(
        kernel
            .post(
                "/actors",
                json!({"name":"Invalid", "owner_id":agent_id, "harness":"pi"})
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        kernel
            .post(
                "/actors",
                json!({"name":"  ", "owner_id":kernel.owner.id, "harness":"pi"})
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        kernel
            .post(
                "/actors",
                json!({"name":"Invalid", "owner_id":kernel.owner.id, "harness":"arbitrary-shell"})
            )
            .await
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[tokio::test]
async fn the_schema_is_whole_and_the_data_outlives_a_reopen() {
    let kernel = Kernel::start().await;
    let actor = kernel.hire("pi").await;
    let path = kernel.dir.path().join("test.db");
    let pool = SqlitePoolOptions::new()
        .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT version FROM seaql_migrations ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap(),
        vec![
            "m0001_bootstrap".to_owned(),
            "m0002_auth".to_owned(),
            "m0003_agent_settings".to_owned()
        ]
    );
    assert!(
        sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&pool)
            .await
            .unwrap()
            .is_empty()
    );
    let store = Store::open(&path).await.unwrap();
    let workspace = store.workspace().await.unwrap();
    assert!(!workspace.onboarding_required);
    assert_eq!(workspace.actors.len(), 2);
    assert!(workspace.actors.iter().any(|a| a.id == actor.id));
}
