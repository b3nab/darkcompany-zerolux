use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use sqlx::sqlite::SqlitePoolOptions;
use std::time::Duration;
use zerolux::{
    api,
    model::{Actor, AgentConnection, Claim, Project, SetOwnerName, Task, Workspace},
    store::Store,
};

struct Kernel {
    dir: tempfile::TempDir,
    store: Store,
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
        let app = api::router(store.clone(), dir.path().join("web"));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            dir,
            store,
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
    async fn setup(&self, harness: &str) -> (Actor, Project, Task) {
        let actor: Actor = self
            .post(
                "/actors",
                json!({"name":harness,"harness":harness,"owner_id":self.owner.id}),
            )
            .await
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        let project: Project = self
            .post("/projects", json!({"name":"Dogfood"}))
            .await
            .json()
            .await
            .unwrap();
        let task: Task = self
            .post(
                "/tasks",
                json!({"project_id":project.id,"title":"Scoped task","assignee_id":actor.id}),
            )
            .await
            .json()
            .await
            .unwrap();
        (actor, project, task)
    }
    fn connect_body(&self, actor: &Actor, project: &Project) -> Value {
        json!({"actor_id":actor.id,"project_id":project.id,"mode":"pi_session", "session_id":"test-session", "workspace":self.dir.path()})
    }
    async fn claim(
        &self,
        actor: &Actor,
        project: &Project,
        connection: &AgentConnection,
    ) -> reqwest::Response {
        self.post(
            "/worker/claim",
            json!({"actor_id":actor.id,"project_id":project.id,"connection_id":connection.id}),
        )
        .await
    }
}
impl Drop for Kernel {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[tokio::test]
async fn hiring_does_not_connect_or_run_and_only_humans_can_own_agents() {
    let kernel = Kernel::start().await;
    for harness in ["pi", "claude-code", "codex"] {
        let (actor, _, _) = kernel.setup(harness).await;
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
    assert!(workspace.connections.is_empty());
    assert!(workspace.tasks.iter().all(|t| t.status == "draft"));
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
async fn connections_and_claims_are_exclusive_and_scoped_to_actor_project_and_workspace() {
    let kernel = Kernel::start().await;
    let (actor, project, task) = kernel.setup("pi").await;
    kernel
        .post(
            &format!("/tasks/{}/actions", task.id),
            json!({"action":"queue"}),
        )
        .await
        .error_for_status()
        .unwrap();
    assert_eq!(
        kernel
            .post(
                "/worker/claim",
                json!({"actor_id":actor.id,"project_id":project.id})
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    let (a, b) = tokio::join!(
        kernel.post("/connections", kernel.connect_body(&actor, &project)),
        kernel.post("/connections", kernel.connect_body(&actor, &project))
    );
    let connection: AgentConnection = if a.status() == StatusCode::CREATED {
        assert_eq!(b.status(), StatusCode::CONFLICT);
        a.json().await.unwrap()
    } else {
        assert_eq!(a.status(), StatusCode::CONFLICT);
        b.error_for_status().unwrap().json().await.unwrap()
    };
    let (other_actor, other_project, _) = kernel.setup("codex").await;
    let mut body = kernel.connect_body(&other_actor, &other_project);
    // A codex actor cannot attach a pi session.
    assert_eq!(
        kernel.post("/connections", body.clone()).await.status(),
        StatusCode::BAD_REQUEST
    );
    body["mode"] = json!("process");
    body["session_id"] = Value::Null;
    assert_eq!(
        kernel.post("/connections", body).await.status(),
        StatusCode::CONFLICT,
        "shared workspace must be exclusive"
    );
    assert_eq!(
        kernel
            .claim(&actor, &other_project, &connection)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        kernel
            .claim(&other_actor, &project, &connection)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let claim: Claim = kernel
        .claim(&actor, &project, &connection)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(claim.task.id, task.id);
    assert_eq!(
        claim.run.connection_id.as_deref(),
        Some(connection.id.as_str())
    );
    assert!(claim.prompt.contains(&task.id));
    assert_eq!(
        kernel.claim(&actor, &project, &connection).await.status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        kernel
            .post(
                &format!("/worker/runs/{}/heartbeat", claim.run.id),
                json!({})
            )
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        kernel
            .post(
                &format!("/connections/{}/disconnect", connection.id),
                json!({})
            )
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        kernel.store.runs(&task.id).await.unwrap()[0].status,
        "failed"
    );
    assert_eq!(
        kernel
            .post(
                &format!("/connections/{}/heartbeat", connection.id),
                json!({})
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        kernel
            .post(
                &format!("/worker/runs/{}/finish", claim.run.id),
                json!({"stdout":"late","stderr":"","exit_code":0})
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    // Disconnect is idempotent and a replacement connection never auto-retries the failed task.
    kernel
        .post(
            &format!("/connections/{}/disconnect", connection.id),
            json!({}),
        )
        .await
        .error_for_status()
        .unwrap();
    let replacement: AgentConnection = kernel
        .post("/connections", kernel.connect_body(&actor, &project))
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        kernel
            .claim(&actor, &project, &replacement)
            .await
            .json::<Option<Claim>>()
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn expired_connection_cannot_be_resurrected_and_releases_its_workspace() {
    let kernel = Kernel::start().await;
    let (actor, project, task) = kernel.setup("pi").await;
    kernel
        .post(
            &format!("/tasks/{}/actions", task.id),
            json!({"action":"queue"}),
        )
        .await;
    let connection: AgentConnection = kernel
        .post("/connections", kernel.connect_body(&actor, &project))
        .await
        .json()
        .await
        .unwrap();
    let claim: Claim = kernel
        .claim(&actor, &project, &connection)
        .await
        .json()
        .await
        .unwrap();
    let pool = SqlitePoolOptions::new()
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new().filename(kernel.dir.path().join("test.db")),
        )
        .await
        .unwrap();
    sqlx::query("UPDATE agent_connections SET lease_expires_at = 0")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        kernel
            .post(
                &format!("/worker/runs/{}/heartbeat", claim.run.id),
                json!({})
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        kernel
            .post(
                &format!("/connections/{}/heartbeat", connection.id),
                json!({})
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    kernel.store.reap_expired().await.unwrap();
    assert_eq!(
        kernel.store.runs(&task.id).await.unwrap()[0].status,
        "failed"
    );
    assert!(
        kernel
            .store
            .workspace()
            .await
            .unwrap()
            .connections
            .is_empty()
    );
    assert_eq!(
        kernel
            .post("/connections", kernel.connect_body(&actor, &project))
            .await
            .status(),
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn single_migration_supports_byoh_and_preserves_data_on_reopen() {
    let kernel = Kernel::start().await;
    let (actor, project, task) = kernel.setup("pi").await;
    kernel
        .post(
            &format!("/tasks/{}/actions", task.id),
            json!({"action":"queue"}),
        )
        .await
        .error_for_status()
        .unwrap();
    let connection: AgentConnection = kernel
        .post("/connections", kernel.connect_body(&actor, &project))
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let claim: Claim = kernel
        .claim(&actor, &project, &connection)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    kernel
        .post(
            &format!("/worker/runs/{}/finish", claim.run.id),
            json!({"stdout":"Persist this result", "stderr":"", "exit_code":0}),
        )
        .await
        .error_for_status()
        .unwrap();

    let path = kernel.dir.path().join("test.db");
    let pool = SqlitePoolOptions::new()
        .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    assert_eq!(
        sqlx::migrate!()
            .iter()
            .map(|m| m.version)
            .collect::<Vec<_>>(),
        vec![1]
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT version FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap(),
        vec![1]
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
    assert_eq!(workspace.projects[0].id, project.id);
    assert_eq!(workspace.tasks[0].id, task.id);
    assert_eq!(workspace.tasks[0].status, "review");
    assert_eq!(workspace.connections[0].id, connection.id);
    assert!(!workspace.onboarding_required);
    assert_eq!(workspace.actors.len(), 2);
    let runs = store.runs(&task.id).await.unwrap();
    assert_eq!(runs[0].stdout, "Persist this result");
    assert_eq!(runs[0].actor_id.as_deref(), Some(actor.id.as_str()));
    assert_eq!(
        runs[0].connection_id.as_deref(),
        Some(connection.id.as_str())
    );
}

#[cfg(unix)]
#[tokio::test]
async fn all_three_presets_execute_fixture_commands_without_models_or_credentials() {
    use std::os::unix::fs::PermissionsExt;
    let kernel = Kernel::start().await;
    let bin = kernel.dir.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    for executable in ["pi", "claude", "codex"] {
        let path = bin.join(executable);
        std::fs::write(
            &path,
            "#!/bin/sh\nprintf '%s\\n' \"$@\"\nprintf 'fixture' > result.txt\n",
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    for (harness, expected) in [
        ("pi", "--print"),
        ("claude-code", "--permission-prompts\nnone"),
        ("codex", "exec\n--color\nnever"),
    ] {
        let (actor, project, task) = kernel.setup(harness).await;
        kernel
            .post(
                &format!("/tasks/{}/actions", task.id),
                json!({"action":"queue"}),
            )
            .await;
        let worktree = kernel.dir.path().join(harness);
        std::fs::create_dir(&worktree).unwrap();
        let output = tokio::time::timeout(
            Duration::from_secs(10),
            tokio::process::Command::new(env!("CARGO_BIN_EXE_zerolux"))
                .args([
                    "worker",
                    "--server",
                    &kernel.url,
                    "--actor",
                    &actor.id,
                    "--project",
                    &project.id,
                    "--workspace",
                ])
                .arg(&worktree)
                .args(["--harness", harness])
                .env("PATH", &bin)
                .kill_on_drop(true)
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let runs = kernel.store.runs(&task.id).await.unwrap();
        assert!(runs[0].stdout.contains(expected));
        assert!(runs[0].stdout.contains(&task.id));
        assert!(runs[0].connection_id.is_some());
        assert_eq!(runs[0].status, "succeeded");
        assert!(
            kernel
                .store
                .workspace()
                .await
                .unwrap()
                .connections
                .is_empty()
        );
        assert_eq!(
            std::fs::read_to_string(worktree.join("result.txt")).unwrap(),
            "fixture"
        );
    }
}
