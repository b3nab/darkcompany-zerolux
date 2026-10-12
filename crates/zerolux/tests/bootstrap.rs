//! The API's hygiene: origins, content types, sizes, the web app's pages and unknown routes.
use std::time::Duration;

use reqwest::{Client, Response, StatusCode};
use serde_json::{Value, json};
use tempfile::TempDir;
use zerolux::{api, model::SetOwnerName};

#[path = "support/db.rs"]
mod db;

struct Kernel {
    dir: TempDir,
    _db: db::TestDatabase,
    owner_id: String,
    url: String,
    client: Client,
    server: tokio::task::JoinHandle<()>,
}

impl Kernel {
    async fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = db::TestDatabase::new(dir.path().join("test.db")).await;
        let store = db.open().await;
        let owner = store
            .set_owner_name(SetOwnerName {
                name: "Test owner".into(),
            })
            .await
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let router = api::router(store, dir.path().join("web"));
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            dir,
            _db: db,
            owner_id: owner.id,
            url,
            client: Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
            server,
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
    fn agent(&self, name: &str) -> Value {
        json!({"name": name, "owner_id": self.owner_id, "harness": "pi"})
    }
}

impl Drop for Kernel {
    fn drop(&mut self) {
        self.server.abort();
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
    for origin in ["https://attacker.example", "null"] {
        assert_eq!(
            kernel
                .client
                .post(format!("{}/api/actors", kernel.url))
                .header("origin", origin)
                .json(&kernel.agent("Injected"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN,
            "{origin}"
        );
    }
    assert_eq!(
        kernel
            .client
            .post(format!("{}/api/actors", kernel.url))
            .header("origin", &kernel.url)
            .json(&kernel.agent("Allowed"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        kernel
            .client
            .post(format!("{}/api/actors", kernel.url))
            .header("content-type", "text/plain")
            .body(kernel.agent("Injected").to_string())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(
        kernel
            .post("/api/actors", kernel.agent("  "))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        kernel
            .post("/api/actors", kernel.agent(&"x".repeat(1024 * 1024)))
            .await
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
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
    for path in ["/api/missing", "/api/tasks/missing/runs"] {
        assert_eq!(
            kernel
                .client
                .get(format!("{}{path}", kernel.url))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }
}
