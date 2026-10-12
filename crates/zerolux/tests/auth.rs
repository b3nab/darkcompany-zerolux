//! Human sign-in through the real authentication service, started by the kernel from this
//! checkout on a temporary workspace. Needs `bun` and `livekit-server`; skipped otherwise.
use std::{net::SocketAddr, path::Path};

use reqwest::{Client, StatusCode, header};
use serde_json::{Value, json};
use zerolux::{
    auth::AuthEntry,
    db::Location,
    livekit::LiveKitConfig,
    server::{Server, ServerOptions},
};

#[path = "support/db.rs"]
mod db;

fn installed(program: &str) -> bool {
    std::process::Command::new(program)
        .arg("--version")
        .output()
        .is_ok()
}

fn options(dir: &Path, database: Location) -> ServerOptions {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    ServerOptions {
        address: "127.0.0.1:0".parse().unwrap(),
        expose: None,
        data_dir: dir.join("data"),
        database,
        web_dir: dir.join("web"),
        livekit: Some(LiveKitConfig {
            url: None,
            api_key: None,
            api_secret: None,
            data_dir: dir.join("livekit"),
        }),
        public: None,
        #[cfg(unix)]
        runner: None,
        auth: Some(AuthEntry::checkout(&root)),
    }
}

struct Kernel {
    server: Server,
    url: String,
    client: Client,
}

impl Kernel {
    async fn start(dir: &Path, database: Location) -> Self {
        let server = Server::start(options(dir, database)).await.unwrap();
        let url = server.url();
        Self {
            server,
            url,
            client: Client::builder().no_proxy().build().unwrap(),
        }
    }

    fn address(&self) -> SocketAddr {
        self.server.address()
    }

    async fn health(&self) -> Value {
        self.client
            .get(format!("{}/api/health", self.url))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }

    async fn post(&self, path: &str, bearer: Option<&str>, body: Value) -> reqwest::Response {
        let mut request = self.client.post(format!("{}{path}", self.url)).json(&body);
        if let Some(token) = bearer {
            request = request.bearer_auth(token);
        }
        request.send().await.unwrap()
    }

    async fn get(&self, path: &str, bearer: Option<&str>) -> reqwest::Response {
        let mut request = self.client.get(format!("{}{path}", self.url));
        if let Some(token) = bearer {
            request = request.bearer_auth(token);
        }
        request.send().await.unwrap()
    }

    async fn sign_up(&self, name: &str, email: &str, setup: Option<&str>) -> reqwest::Response {
        let mut request = self
            .client
            .post(format!("{}/api/auth/sign-up/email", self.url))
            .json(&json!({ "name": name, "email": email, "password": "correct horse battery" }));
        if let Some(setup) = setup {
            request = request.header("x-zerolux-setup-token", setup);
        }
        request.send().await.unwrap()
    }

    async fn sign_in(&self, email: &str) -> String {
        let response = self
            .post(
                "/api/auth/sign-in/email",
                None,
                json!({ "email": email, "password": "correct horse battery" }),
            )
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        token_of(&response)
    }
}

/// A request sent as written, so the path reaches the kernel unnormalized.
async fn raw_post(address: SocketAddr, path: &str, headers: &[&str], body: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    let extra = headers
        .iter()
        .map(|h| format!("{h}\r\n"))
        .collect::<String>();
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    response
}

fn token_of(response: &reqwest::Response) -> String {
    response
        .headers()
        .get("set-auth-token")
        .expect("the service answers with the signed session token")
        .to_str()
        .unwrap()
        .to_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_first_account_claims_the_owner_with_the_setup_credential_and_signs_in_after_restart() {
    if !installed("bun") || !installed("livekit-server") {
        eprintln!("bun or livekit-server not installed: skipped");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let database = db::TestDatabase::new(dir.path().join("data/zerolux.db")).await;
    let kernel = Kernel::start(dir.path(), database.location().clone()).await;
    let health = kernel.health().await;
    assert_eq!(health["api_version"], 2);
    assert!(
        health["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("auth-v1"))
    );
    assert_eq!(health["auth"]["setup_required"], true);
    for response in kernel
        .get("/api/health", None)
        .await
        .headers()
        .get_all(header::CACHE_CONTROL)
    {
        assert_eq!(response, "no-store");
    }
    // The setup credential: a private file of the data directory, never in the API.
    let setup_path = dir.path().join("data/auth/setup-token");
    let setup = std::fs::read_to_string(&setup_path).unwrap();
    assert!(setup.len() >= 32);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&setup_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    // Nobody is the owner without credentials any more.
    assert_eq!(
        kernel.get("/api/workspace", None).await.status(),
        StatusCode::UNAUTHORIZED
    );
    // Signing up is not open: it needs the setup credential.
    assert_eq!(
        kernel
            .sign_up("Owner fixture", "owner@example.test", None)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        kernel
            .sign_up("Owner fixture", "owner@example.test", Some("wrong"))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    // Nor by a path that only normalizes to the signup, nor with a name the owner may not
    // have, nor by claiming the kernel's own enrollment header.
    let raw = raw_post(
        kernel.address(),
        "/api/auth/sign-up/../sign-up/email",
        &["x-zerolux-auth-enroll: 1"],
        &json!({ "name": "Owner fixture", "email": "owner@example.test", "password": "correct horse battery" })
            .to_string(),
    )
    .await;
    assert!(raw.starts_with("HTTP/1.1 403"), "{raw}");
    assert_eq!(
        kernel
            .sign_up("Local owner", "owner@example.test", Some(&setup))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    let signed_up = kernel
        .sign_up("Owner fixture", "owner@example.test", Some(&setup))
        .await;
    let status = signed_up.status();
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        signed_up.text().await.unwrap()
    );
    let token = token_of(&signed_up);
    // Signed in but not bound: told so, and nothing of the workspace.
    let identity: Value = kernel
        .get("/api/auth/identity", Some(&token))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(identity["user"]["email"], "owner@example.test");
    assert_eq!(identity["actor_id"], Value::Null);
    assert_eq!(identity["setup_required"], true);
    assert_eq!(
        kernel.get("/api/workspace", Some(&token)).await.status(),
        StatusCode::FORBIDDEN
    );
    // The claim binds the account to the owner, names them, and consumes the credential.
    let wrong = kernel
        .post(
            "/api/auth/claim",
            Some(&token),
            json!({ "setup_token": "wrong" }),
        )
        .await;
    assert_eq!(wrong.status(), StatusCode::FORBIDDEN);
    let claimed = kernel
        .post(
            "/api/auth/claim",
            Some(&token),
            json!({ "setup_token": setup }),
        )
        .await;
    assert_eq!(claimed.status(), StatusCode::OK);
    let claimed: Value = claimed.json().await.unwrap();
    assert!(claimed["actor_id"].is_string());
    assert_eq!(claimed["setup_required"], false);
    assert!(!setup_path.exists(), "consumed");
    assert_eq!(kernel.health().await["auth"]["setup_required"], false);
    let workspace: Value = kernel
        .get("/api/workspace", Some(&token))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(workspace["onboarding_required"], false);
    let owner = workspace["actors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["kind"] == "human")
        .unwrap();
    assert_eq!(owner["name"], "Owner fixture");
    assert_eq!(owner["id"], claimed["actor_id"]);
    assert!(owner.get("auth_subject").is_none(), "never shown");
    // Once bound, a second claim is nothing; a second account cannot sign up.
    assert_eq!(
        kernel
            .post(
                "/api/auth/claim",
                Some(&token),
                json!({ "setup_token": setup })
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        kernel
            .sign_up("Other", "other@example.test", Some(&setup))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    // Signing out revokes the token on the next request; signing in gives a new one.
    assert_eq!(
        kernel
            .post("/api/auth/sign-out", Some(&token), json!({}))
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        kernel.get("/api/workspace", Some(&token)).await.status(),
        StatusCode::UNAUTHORIZED
    );
    let token = kernel.sign_in("owner@example.test").await;
    assert_eq!(
        kernel.get("/api/workspace", Some(&token)).await.status(),
        StatusCode::OK
    );
    // A made-up token is nobody; so is a cookie of nothing.
    assert_eq!(
        kernel
            .get("/api/workspace", Some("not.a-session"))
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let address = kernel.address();
    kernel.server.shutdown().await.unwrap();
    assert!(
        std::net::TcpListener::bind(address).is_ok(),
        "the service and the kernel are gone"
    );
    // After a restart the account, its sessions and the binding are still there.
    let kernel = Kernel::start(dir.path(), database.location().clone()).await;
    assert_eq!(kernel.health().await["auth"]["setup_required"], false);
    assert!(!setup_path.exists());
    assert_eq!(
        kernel.get("/api/workspace", Some(&token)).await.status(),
        StatusCode::OK
    );
    let identity: Value = kernel
        .get("/api/auth/identity", Some(&token))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(identity["actor_id"], claimed["actor_id"]);
    kernel.server.shutdown().await.unwrap();
}

/// Two kernels serving one PostgreSQL workspace: a sign-in on one is a sign-in on the other,
/// the setup credential is consumed for both, and each keeps to its own agent sessions.
#[tokio::test(flavor = "multi_thread")]
async fn two_kernels_of_one_workspace_share_sign_in_and_keep_their_own_sessions() {
    if !installed("bun")
        || !installed("livekit-server")
        || std::env::var("ZEROLUX_TEST_POSTGRES_URL").is_err()
    {
        return;
    }
    let (dir_a, dir_b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let database = db::TestDatabase::new(dir_a.path().join("unused.db")).await;
    let a = Kernel::start(dir_a.path(), database.location().clone()).await;
    let b = Kernel::start(dir_b.path(), database.location().clone()).await;
    // One setup credential, made by whichever kernel came first, valid on both.
    let setup_a = std::fs::read_to_string(dir_a.path().join("data/auth/setup-token")).ok();
    let setup_b = std::fs::read_to_string(dir_b.path().join("data/auth/setup-token")).ok();
    let setup = setup_a
        .or(setup_b)
        .expect("one kernel delivered the credential");
    assert_eq!(b.health().await["auth"]["setup_required"], true);
    let signed_up = a
        .sign_up("Owner fixture", "owner@example.test", Some(&setup))
        .await;
    assert_eq!(signed_up.status(), StatusCode::OK);
    let token = token_of(&signed_up);
    assert_eq!(
        a.post(
            "/api/auth/claim",
            Some(&token),
            json!({ "setup_token": setup })
        )
        .await
        .status(),
        StatusCode::OK
    );
    // The same session and binding on the other kernel; the credential is spent there too.
    assert_eq!(
        b.get("/api/workspace", Some(&token)).await.status(),
        StatusCode::OK
    );
    assert_eq!(b.health().await["auth"]["setup_required"], false);
    assert_eq!(
        b.sign_up("Other", "other@example.test", Some(&setup))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    // Agent sessions belong to the host that started them: a restart of A recovers A's,
    // and leaves B's as they are.
    let store_a = zerolux::store::Store::open_at(database.location())
        .await
        .unwrap()
        .hosted(
            std::fs::read_to_string(dir_a.path().join("data/host-id"))
                .unwrap()
                .trim()
                .to_owned(),
        );
    let store_b = zerolux::store::Store::open_at(database.location())
        .await
        .unwrap()
        .hosted(
            std::fs::read_to_string(dir_b.path().join("data/host-id"))
                .unwrap()
                .trim()
                .to_owned(),
        );
    let owner = store_a.chat_identity(None).await.unwrap();
    let hire = |native: &str| zerolux::model::HireChatSession {
        name: format!("agent-{native}"),
        actor_id: None,
        harness: zerolux::harness::Harness::ClaudeCode,
        native_session_id: native.into(),
        title: native.into(),
        workspace: "/tmp".into(),
        native_locator: json!({"fixture": true}),
        resume: false,
    };
    let on_a = store_a
        .hire_chat_session(&owner, hire("on-a"))
        .await
        .unwrap();
    let on_b = store_b
        .hire_chat_session(&owner, hire("on-b"))
        .await
        .unwrap();
    for (store, issued) in [(&store_a, &on_a), (&store_b, &on_b)] {
        let identity = store.chat_identity(Some(&issued.token)).await.unwrap();
        store
            .set_chat_session_status(
                &identity,
                &issued.session.id,
                zerolux::model::ChatSessionStatus {
                    status: "connected".into(),
                    reason: None,
                },
            )
            .await
            .unwrap();
    }
    a.server.shutdown().await.unwrap();
    let a = Kernel::start(dir_a.path(), database.location().clone()).await;
    let sessions = store_a.chat_sessions(&owner).await.unwrap();
    let status = |id: &str| sessions.iter().find(|s| s.id == id).unwrap().status.clone();
    assert_eq!(status(&on_a.session.id), "attention");
    assert_eq!(status(&on_b.session.id), "connected");
    a.server.shutdown().await.unwrap();
    b.server.shutdown().await.unwrap();
}
