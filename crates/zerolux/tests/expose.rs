//! An exposed address serves the app and the owner API without sign-in; Host/Origin checks and agent restrictions apply.
use std::net::SocketAddr;

use axum::{extract::ConnectInfo, http::StatusCode, middleware};
use reqwest::{Client, RequestBuilder};
use serde_json::{Value, json};
use zerolux::{
    api::{self, Exposed},
    model::SetOwnerName,
    store::Store,
};

const EXPOSED: &str = "192.0.2.7:4310";

struct Kernel {
    dir: tempfile::TempDir,
    client: Client,
    /// Both servers bind loopback; connection metadata simulates a separate device.
    remote: String,
    local: String,
    servers: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for Kernel {
    fn drop(&mut self) {
        for server in &self.servers {
            server.abort();
        }
    }
}

impl Kernel {
    async fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("test.db")).await.unwrap();
        store
            .set_owner_name(SetOwnerName {
                name: "Test owner".into(),
            })
            .await
            .unwrap();
        std::fs::create_dir_all(dir.path().join("web")).unwrap();
        std::fs::write(dir.path().join("web/index.html"), "<main>app</main>").unwrap();
        let exposed = Exposed::new(EXPOSED.parse().unwrap());
        let mut urls = Vec::new();
        let mut servers = Vec::new();
        for peer in ["192.0.2.20:50000", "127.0.0.1:50000"] {
            let peer: SocketAddr = peer.parse().unwrap();
            let router = api::router_exposed(
                store.clone(),
                dir.path().join("web"),
                None,
                Some(exposed.clone()),
            )
            .layer(middleware::from_fn(
                move |mut request: axum::extract::Request, next: middleware::Next| async move {
                    request.extensions_mut().insert(ConnectInfo(peer));
                    next.run(request).await
                },
            ));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            urls.push(format!("http://{}", listener.local_addr().unwrap()));
            servers.push(tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap()
            }));
        }
        Self {
            dir,
            client: Client::builder().no_proxy().build().unwrap(),
            local: urls.pop().unwrap(),
            remote: urls.pop().unwrap(),
            servers,
        }
    }

    fn remote(&self, request: impl FnOnce(&Client, &str) -> RequestBuilder) -> RequestBuilder {
        request(&self.client, &self.remote).header("host", EXPOSED)
    }
}

#[tokio::test]
async fn another_device_gets_the_app_and_acts_as_the_owner_without_a_code() {
    let kernel = Kernel::start().await;
    let page = kernel
        .remote(|client, url| client.get(format!("{url}/team")))
        .send()
        .await
        .unwrap();
    assert_eq!(page.status(), StatusCode::OK);
    assert_eq!(page.text().await.unwrap(), "<main>app</main>");
    for path in ["/api/health", "/api/workspace", "/api/conversations"] {
        let response = kernel
            .remote(|client, url| client.get(format!("{url}{path}")))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert!(!response.headers().contains_key("set-cookie"));
    }
    let renamed = kernel
        .remote(|client, url| client.post(format!("{url}/api/onboarding/owner")))
        .header("origin", format!("http://{EXPOSED}"))
        .json(&json!({"name": "Renamed owner"}))
        .send()
        .await
        .unwrap();
    assert_eq!(renamed.status(), StatusCode::OK);
    assert_eq!(
        renamed.json::<Value>().await.unwrap()["name"],
        "Renamed owner"
    );
}

#[tokio::test]
async fn unknown_api_endpoints_return_json_404_on_both_interfaces() {
    let kernel = Kernel::start().await;
    for (base, host) in [(&kernel.local, None), (&kernel.remote, Some(EXPOSED))] {
        for (method, path) in [
            (reqwest::Method::POST, "/api/unknown"),
            (reqwest::Method::GET, "/api/unknown"),
        ] {
            let mut request = kernel.client.request(method, format!("{base}{path}"));
            if let Some(host) = host {
                request = request.header("host", host);
            }
            let response = request.json(&json!({})).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
            assert!(!response.headers().contains_key("set-cookie"));
            assert_eq!(
                response.json::<Value>().await.unwrap()["error"],
                "Unknown API endpoint"
            );
        }
    }
}

#[tokio::test]
async fn another_host_another_origin_and_remote_agent_credentials_are_refused() {
    let kernel = Kernel::start().await;
    let other_host = kernel
        .client
        .get(format!("{}/api/health", kernel.remote))
        .send()
        .await
        .unwrap();
    assert_eq!(other_host.status(), StatusCode::FORBIDDEN);
    for origin in ["http://192.0.2.66:4310", "http://example.test", "null"] {
        let response = kernel
            .remote(|client, url| client.get(format!("{url}/api/workspace")))
            .header("origin", origin)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{origin}");
    }
    let agent = kernel
        .remote(|client, url| client.get(format!("{url}/api/chat/inbox")))
        .bearer_auth("an-agent-token")
        .send()
        .await
        .unwrap();
    assert_eq!(agent.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn loopback_still_checks_host_origin_and_never_turns_an_invalid_bearer_into_owner() {
    let kernel = Kernel::start().await;
    let url = format!("{}/api/workspace", kernel.local);
    assert_eq!(
        kernel.client.get(&url).send().await.unwrap().status(),
        StatusCode::OK
    );
    for (header, value) in [("host", "example.test"), ("origin", "http://example.test")] {
        assert_eq!(
            kernel
                .client
                .get(&url)
                .header(header, value)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    let invalid_agent = kernel
        .client
        .get(&url)
        .bearer_auth("not-a-real-agent-token")
        .header("cookie", "session=ignored")
        .send()
        .await
        .unwrap();
    assert_eq!(invalid_agent.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn reopening_keeps_owner_device_rows_and_the_schema_unchanged() {
    let kernel = Kernel::start().await;
    let path = kernel.dir.path().join("test.db");
    let pool =
        sqlx::SqlitePool::connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&path))
            .await
            .unwrap();
    // Existing owner_devices rows are kept, but no runtime path reads them.
    sqlx::query("INSERT INTO owner_devices(token_hash,created_at) VALUES ('fixture-only',123)")
        .execute(&pool)
        .await
        .unwrap();
    let before: Vec<u8> =
        sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version=1")
            .fetch_one(&pool)
            .await
            .unwrap();
    let reopened = Store::open(&path).await.unwrap();
    assert_eq!(reopened.workspace().await.unwrap().actors.len(), 1);
    let row: (String, i64) = sqlx::query_as("SELECT token_hash,created_at FROM owner_devices")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row, ("fixture-only".into(), 123));
    let after: Vec<u8> =
        sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version=1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(before, after);
}

#[tokio::test]
async fn an_exposed_kernel_refuses_a_request_of_unknown_origin() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("test.db")).await.unwrap();
    let router = api::router_exposed(
        store,
        dir.path().join("web"),
        None,
        Some(Exposed::new(EXPOSED.parse().unwrap())),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let response = Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("{url}/api/health"))
        .send()
        .await
        .unwrap();
    server.abort();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}
