use std::{collections::HashMap, path::Path, time::Duration};
use tokio::sync::Mutex;

use reqwest::{Client, Response, StatusCode};
use serde_json::{Value, json};
use tempfile::TempDir;
use zerolux::{
    api,
    model::{Actor, AgentConnection, Claim, Project, Run, SetOwnerName, Task},
    store::Store,
};

struct Kernel {
    dir: TempDir,
    store: Store,
    owner: Actor,
    url: String,
    client: Client,
    server: tokio::task::JoinHandle<()>,
    connections: Mutex<HashMap<String, String>>,
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
        let router = api::router(store.clone(), dir.path().join("web"));
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            dir,
            store,
            owner,
            url,
            client: Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
            server,
            connections: Mutex::new(HashMap::new()),
        }
    }
    async fn post(&self, path: &str, body: Value) -> Response {
        self.client
            .post(format!("{}{path}", self.url))
            .json(&body)
            .send()
            .await
            .unwrap()
    }
    async fn task(&self) -> (Project, Task) {
        let project: Project = self
            .post(
                "/api/projects",
                json!({"name":"ZeroLux", "description":"Dogfood"}),
            )
            .await
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        let agent: Actor = self
            .post(
                "/api/actors",
                json!({"name":"Fixture", "harness":"pi", "owner_id":self.owner.id}),
            )
            .await
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        let task: Task = self.post("/api/tasks", json!({"project_id":project.id, "title":"First improvement", "description":"Write result.txt", "assignee_id":agent.id})).await.error_for_status().unwrap().json().await.unwrap();
        (project, task)
    }
    async fn act(&self, task: &Task, action: &str, note: &str) -> Response {
        self.post(
            &format!("/api/tasks/{}/actions", task.id),
            json!({"action":action, "note":note}),
        )
        .await
    }
    async fn actor_id(&self, project: &Project) -> String {
        self.store
            .workspace()
            .await
            .unwrap()
            .tasks
            .into_iter()
            .find(|task| task.project_id == project.id)
            .unwrap()
            .assignee_id
    }
    async fn claim(&self, project: &Project) -> Option<Claim> {
        let actor_id = self.actor_id(project).await;
        let mut connections = self.connections.lock().await;
        let connection_id = if let Some(id) = connections.get(&project.id) {
            id.clone()
        } else {
            let workspace = self.dir.path().join(&project.id);
            std::fs::create_dir_all(&workspace).unwrap();
            let connection: AgentConnection = self.post("/api/connections", json!({"actor_id":actor_id, "project_id":project.id, "mode":"process", "workspace":workspace})).await.error_for_status().unwrap().json().await.unwrap();
            connections.insert(project.id.clone(), connection.id.clone());
            connection.id
        };
        drop(connections);
        let response = self.post("/api/worker/claim", json!({"project_id":project.id, "actor_id":actor_id, "connection_id":connection_id})).await;
        if response.status() == StatusCode::CONFLICT {
            return None;
        }
        response.error_for_status().unwrap().json().await.unwrap()
    }
    async fn finish(&self, id: &str) -> Response {
        self.post(
            &format!("/api/worker/runs/{id}/finish"),
            json!({"stdout":"Verified", "stderr":"", "exit_code":0, "failure_reason":null}),
        )
        .await
    }
    #[cfg(unix)]
    async fn worker(
        &self,
        project: &Project,
        workspace: &Path,
        args: &[&str],
    ) -> std::process::Output {
        let actor_id = self.actor_id(project).await;
        tokio::time::timeout(
            Duration::from_secs(15),
            tokio::process::Command::new(env!("CARGO_BIN_EXE_zerolux"))
                .args([
                    "worker",
                    "--server",
                    &self.url,
                    "--project",
                    &project.id,
                    "--actor",
                    &actor_id,
                    "--workspace",
                ])
                .arg(workspace)
                .args(args)
                .kill_on_drop(true)
                .output(),
        )
        .await
        .unwrap()
        .unwrap()
    }
}
impl Drop for Kernel {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[tokio::test]
async fn claims_are_exclusive_scoped_and_require_explicit_queueing() {
    let kernel = Kernel::start().await;
    let (project, task) = kernel.task().await;
    assert!(
        kernel.claim(&project).await.is_none(),
        "draft must not execute"
    );
    assert_eq!(
        kernel.act(&task, "approve", "").await.status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        kernel.act(&task, "queue", "").await.status(),
        StatusCode::OK
    );
    assert_eq!(
        kernel.act(&task, "queue", "").await.status(),
        StatusCode::CONFLICT
    );
    let (other, _) = kernel.task().await;
    assert!(
        kernel.claim(&other).await.is_none(),
        "cannot claim another project's tasks"
    );
    let (a, b) = tokio::join!(kernel.claim(&project), kernel.claim(&project));
    assert_eq!(usize::from(a.is_some()) + usize::from(b.is_some()), 1);
    let claim = a.or(b).unwrap();
    assert_eq!(
        kernel.act(&task, "approve", "").await.status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        kernel
            .act(&task, "request_changes", "Fix it")
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(kernel.store.runs(&task.id).await.unwrap().len(), 1);
    assert_eq!(kernel.finish(&claim.run.id).await.status(), StatusCode::OK);
    assert_eq!(
        kernel.finish(&claim.run.id).await.status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        kernel
            .post(
                &format!("/api/worker/runs/{}/heartbeat", claim.run.id),
                json!({})
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        kernel.act(&task, "request_changes", "  ").await.status(),
        StatusCode::BAD_REQUEST
    );
    let revised: Task = kernel
        .act(&task, "request_changes", "Add tests")
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(revised.status, "queued");
    let second = kernel.claim(&project).await.unwrap();
    assert_eq!(second.task.review_note, "Add tests");
    assert_ne!(second.run.id, claim.run.id);
    assert_eq!(kernel.finish(&second.run.id).await.status(), StatusCode::OK);
    let done: Task = kernel
        .act(&task, "approve", "Reviewed diff and tests")
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(done.status, "done");
    assert_eq!(
        kernel.act(&task, "queue", "").await.status(),
        StatusCode::CONFLICT
    );
    let reopened = Store::open(&kernel.dir.path().join("test.db"))
        .await
        .unwrap();
    assert_eq!(reopened.runs(&task.id).await.unwrap().len(), 2);
    assert_eq!(
        reopened
            .workspace()
            .await
            .unwrap()
            .tasks
            .iter()
            .find(|t| t.id == task.id)
            .unwrap()
            .status,
        "done"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn real_worker_executes_in_the_selected_directory_and_submits_for_review() {
    let kernel = Kernel::start().await;
    let worktree = tempfile::tempdir().unwrap();
    let (project, task) = kernel.task().await;
    kernel
        .act(&task, "queue", "")
        .await
        .error_for_status()
        .unwrap();
    let output = kernel
        .worker(
            &project,
            worktree.path(),
            &[
                "--",
                "sh",
                "-c",
                "printf '%s' \"$1\"; printf 'artifact' > result.txt; printf 'diagnostic' >&2",
                "test-harness",
            ],
        )
        .await;
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(worktree.path().join("result.txt")).unwrap(),
        "artifact"
    );
    let runs: Vec<Run> = kernel
        .client
        .get(format!("{}/api/tasks/{}/runs", kernel.url, task.id))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, "succeeded");
    assert!(runs[0].stdout.contains(&task.id));
    assert!(runs[0].stdout.contains("First improvement"));
    assert_eq!(runs[0].stderr, "diagnostic");
    assert_eq!(
        kernel.store.workspace().await.unwrap().tasks[0].status,
        "review"
    );
    assert!(kernel.claim(&project).await.is_none());
    assert_eq!(
        kernel
            .act(&task, "approve", "Checked result.txt")
            .await
            .status(),
        StatusCode::OK
    );
}

#[cfg(unix)]
#[tokio::test]
async fn worker_records_nonzero_exit_spawn_failure_and_timeout() {
    let kernel = Kernel::start().await;
    let worktree = tempfile::tempdir().unwrap();
    for (args, reason) in [
        (
            vec!["--", "sh", "-c", "printf 'partial'; exit 7", "test-harness"],
            "Harness exited",
        ),
        (
            vec!["--", "/nonexistent/zerolux-harness-fixture"],
            "Cannot start harness",
        ),
        (
            vec![
                "--timeout-secs",
                "1",
                "--",
                "sh",
                "-c",
                "sleep 60",
                "test-harness",
            ],
            "Harness timed out",
        ),
    ] {
        let (project, task) = kernel.task().await;
        kernel
            .act(&task, "queue", "")
            .await
            .error_for_status()
            .unwrap();
        let output = kernel.worker(&project, worktree.path(), &args).await;
        assert!(!output.status.success());
        let runs = kernel.store.runs(&task.id).await.unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, "failed");
        assert!(runs[0].failure_reason.as_deref().unwrap().contains(reason));
        assert!(kernel.claim(&project).await.is_none());
        assert_eq!(
            kernel.act(&task, "approve", "").await.status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            kernel
                .act(&task, "queue", "Inspected partial changes")
                .await
                .status(),
            StatusCode::OK
        );
    }
}

#[tokio::test]
async fn api_rejects_foreign_origins_rebinding_invalid_input_and_unknown_routes() {
    let kernel = Kernel::start().await;
    assert_eq!(
        kernel
            .client
            .get(format!("{}/api/health", kernel.url))
            .header("host", "attacker.example")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        kernel
            .client
            .post(format!("{}/api/projects", kernel.url))
            .header("origin", "https://attacker.example")
            .json(&json!({"name":"Injected"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        kernel
            .client
            .post(format!("{}/api/projects", kernel.url))
            .header("origin", "null")
            .json(&json!({"name":"Injected"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        kernel
            .client
            .post(format!("{}/api/projects", kernel.url))
            .header("origin", &kernel.url)
            .json(&json!({"name":"Allowed"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        kernel
            .client
            .post(format!("{}/api/projects", kernel.url))
            .header("content-type", "text/plain")
            .body("{\"name\":\"Injected\"}")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(
        kernel
            .post("/api/projects", json!({"name":"  "}))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        kernel
            .post(
                "/api/projects",
                json!({"name":"Large", "description":"x".repeat(1024*1024)})
            )
            .await
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let (project, _) = kernel.task().await;
    for (project_id, actor) in [
        (project.id.as_str(), kernel.owner.id.as_str()),
        ("missing", "unknown-agent"),
    ] {
        assert_eq!(
            kernel
                .post(
                    "/api/tasks",
                    json!({"project_id":project_id, "title":"Invalid", "assignee_id":actor})
                )
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        kernel
            .post(
                "/api/worker/claim",
                json!({"project_id":project.id, "actor_id":kernel.owner.id})
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    // A page address gets the web app; an unknown API address stays a JSON 404.
    std::fs::create_dir_all(kernel.dir.path().join("web")).unwrap();
    std::fs::write(kernel.dir.path().join("web/index.html"), "<main>app</main>").unwrap();
    let page = kernel
        .client
        .get(format!("{}/chats/some-chat", kernel.url))
        .send()
        .await
        .unwrap();
    assert_eq!(page.status(), StatusCode::OK);
    assert_eq!(page.text().await.unwrap(), "<main>app</main>");
    // A build may write `.br`/`.gz` next to a file: a client accepting them gets that one,
    // for a page address too; the original serves everyone else.
    std::fs::write(kernel.dir.path().join("web/index.html.br"), "page-br").unwrap();
    std::fs::write(kernel.dir.path().join("web/app.js"), "console.log(1)").unwrap();
    std::fs::write(kernel.dir.path().join("web/app.js.gz"), "script-gz").unwrap();
    for (path, encoding, expected) in [
        ("/chats/some-chat", "br", "page-br"),
        ("/app.js", "gzip, br", "script-gz"),
    ] {
        let response = kernel
            .client
            .get(format!("{}{path}", kernel.url))
            .header("accept-encoding", encoding)
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.headers()["content-encoding"],
            encoding.split(',').next().unwrap()
        );
        assert_eq!(response.text().await.unwrap(), expected);
    }
    let plain = kernel
        .client
        .get(format!("{}/app.js", kernel.url))
        .send()
        .await
        .unwrap();
    assert!(plain.headers().get("content-encoding").is_none());
    assert_eq!(plain.text().await.unwrap(), "console.log(1)");
    assert_eq!(
        kernel
            .client
            .get(format!("{}/api/missing", kernel.url))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        kernel
            .client
            .get(format!("{}/api/tasks/missing/runs", kernel.url))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
}
