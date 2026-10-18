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

    async fn sign_up(&self, name: &str, email: &str) -> reqwest::Response {
        self.client
            .post(format!("{}/api/auth/sign-up/email", self.url))
            .json(&json!({ "name": name, "email": email, "password": "correct horse battery" }))
            .send()
            .await
            .unwrap()
    }

    async fn join(&self, name: &str, email: &str, invite: &str) -> reqwest::Response {
        self.client
            .post(format!("{}/api/auth/sign-up/email", self.url))
            .header("x-zerolux-invite", invite)
            .json(&json!({ "name": name, "email": email, "password": "correct horse battery" }))
            .send()
            .await
            .unwrap()
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
async fn the_first_account_becomes_the_owner_and_signs_in_after_restart() {
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
    for value in kernel
        .get("/api/health", None)
        .await
        .headers()
        .get_all(header::CACHE_CONTROL)
    {
        assert_eq!(value, "no-store");
    }
    // Nobody is the owner without credentials any more.
    assert_eq!(
        kernel.get("/api/workspace", None).await.status(),
        StatusCode::UNAUTHORIZED
    );
    // A name the owner may not have is refused before an account exists; the kernel's own
    // enrollment header is not a caller's to claim.
    assert_eq!(
        kernel
            .sign_up("Local owner", "owner@example.test")
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    let signed_up = kernel.sign_up("Owner fixture", "owner@example.test").await;
    let status = signed_up.status();
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        signed_up.text().await.unwrap()
    );
    let token = token_of(&signed_up);
    // Signed in but not bound yet: told so, and nothing of the workspace.
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
    // The claim binds the first account to the owner and names them.
    let claimed = kernel
        .post("/api/auth/claim", Some(&token), json!({}))
        .await;
    assert_eq!(claimed.status(), StatusCode::OK);
    let claimed: Value = claimed.json().await.unwrap();
    assert!(claimed["actor_id"].is_string());
    assert_eq!(claimed["setup_required"], false);
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
    // Once the owner has an account, a second claim is nothing and nobody else signs up.
    assert_eq!(
        kernel
            .post("/api/auth/claim", Some(&token), json!({}))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        kernel.sign_up("Other", "other@example.test").await.status(),
        StatusCode::FORBIDDEN
    );
    let raw = raw_post(
        kernel.address(),
        "/api/auth/sign-up/../sign-up/email",
        &["x-zerolux-auth-enroll: 1"],
        &json!({ "name": "Other", "email": "other@example.test", "password": "correct horse battery" }).to_string(),
    )
    .await;
    assert!(raw.starts_with("HTTP/1.1 403"), "{raw}");
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
    assert_eq!(b.health().await["auth"]["setup_required"], true);
    let signed_up = a.sign_up("Owner fixture", "owner@example.test").await;
    assert_eq!(signed_up.status(), StatusCode::OK);
    let token = token_of(&signed_up);
    assert_eq!(
        a.post("/api/auth/claim", Some(&token), json!({}))
            .await
            .status(),
        StatusCode::OK
    );
    // The same session and binding on the other kernel; signing up is closed there too.
    assert_eq!(
        b.get("/api/workspace", Some(&token)).await.status(),
        StatusCode::OK
    );
    assert_eq!(b.health().await["auth"]["setup_required"], false);
    assert_eq!(
        b.sign_up("Other", "other@example.test").await.status(),
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
    let sessions = store_a.sessions(&owner).await.unwrap();
    let status = |id: &str| sessions.iter().find(|s| s.id == id).unwrap().status.clone();
    assert_eq!(status(&on_a.session.id), "attention");
    assert_eq!(status(&on_b.session.id), "connected");
    a.server.shutdown().await.unwrap();
    b.server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_person_joins_with_an_invitation_from_the_owner() {
    if !installed("bun") || !installed("livekit-server") {
        eprintln!("bun or livekit-server not installed: skipped");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let database = db::TestDatabase::new(dir.path().join("data/zerolux.db")).await;
    let kernel = Kernel::start(dir.path(), database.location().clone()).await;
    assert!(
        kernel.health().await["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("people-v1"))
    );
    let owner = token_of(&kernel.sign_up("Owner fixture", "owner@example.test").await);
    kernel
        .post("/api/auth/claim", Some(&owner), json!({}))
        .await;
    let identity: Value = kernel
        .get("/api/auth/identity", Some(&owner))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(identity["owner"], true);
    // The owner invites; the token is in that answer only.
    let created: Value = kernel
        .post("/api/invites", Some(&owner), json!({}))
        .await
        .json()
        .await
        .unwrap();
    let invite = created["token"].as_str().unwrap().to_owned();
    assert!(created["invite"].get("token_hash").is_none());
    let shown: Value = kernel
        .get(&format!("/api/auth/invites/{invite}"), None)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(shown["invitation"]["invited_by"], "Owner fixture");
    // Without it nobody signs up; with it a person does, and joins by claiming it.
    assert_eq!(
        kernel.sign_up("Ada", "ada@example.test").await.status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        kernel
            .join("Ada", "ada@example.test", "not-an-invitation")
            .await
            .status(),
        StatusCode::GONE
    );
    let joined = kernel.join("Ada", "ada@example.test", &invite).await;
    assert_eq!(joined.status(), StatusCode::OK);
    let ada = token_of(&joined);
    assert_eq!(
        kernel.get("/api/workspace", Some(&ada)).await.status(),
        StatusCode::FORBIDDEN,
        "not a person until the claim"
    );
    assert_eq!(
        kernel
            .post("/api/auth/claim", Some(&ada), json!({}))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let claimed: Value = kernel
        .post("/api/auth/claim", Some(&ada), json!({ "invite": invite }))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(claimed["owner"], false);
    assert!(claimed["actor_id"].is_string());
    let workspace: Value = kernel
        .get("/api/workspace", Some(&ada))
        .await
        .json()
        .await
        .unwrap();
    let people: Vec<_> = workspace["actors"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| a["kind"] == "human")
        .collect();
    assert_eq!(people.len(), 2);
    // Used up: nobody else joins with it, and only the owner invites or renames.
    assert_eq!(
        kernel
            .get(&format!("/api/auth/invites/{invite}"), None)
            .await
            .status(),
        StatusCode::GONE
    );
    assert_eq!(
        kernel
            .join("Bea", "bea@example.test", &invite)
            .await
            .status(),
        StatusCode::GONE
    );
    assert_eq!(
        kernel
            .post("/api/invites", Some(&ada), json!({}))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        kernel
            .post("/api/workspace", Some(&ada), json!({ "name": "Mine" }))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    // Sessions on this computer are its owner's.
    assert_eq!(
        kernel
            .get("/api/sessions/discover", Some(&ada))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let sessions: Value = kernel
        .get("/api/sessions", Some(&ada))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(sessions["sessions"], json!([]));
    // The kernel's computer is the owner's, closed to others until the owner opens it.
    let hosts: Value = kernel
        .get("/api/hosts", Some(&ada))
        .await
        .json()
        .await
        .unwrap();
    let host = hosts["hosts"][0]["id"].as_str().unwrap().to_owned();
    assert_eq!(hosts["hosts"][0]["person_id"], identity["actor_id"]);
    assert_eq!(hosts["hosts"][0]["here"], true);
    let account = format!("/api/hosts/{host}/accounts/claude-code");
    let put = |token: &str, body: Value| {
        kernel
            .client
            .put(format!("{}{account}", kernel.url))
            .bearer_auth(token)
            .json(&body)
            .send()
    };
    assert_eq!(
        put(&ada, json!({"oauth_token": "fixture-token"}))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let opened = kernel
        .client
        .patch(format!("{}/api/hosts/{host}", kernel.url))
        .bearer_auth(&owner)
        .json(&json!({"open": true}))
        .send()
        .await
        .unwrap();
    assert_eq!(opened.status(), StatusCode::OK);
    // Open: Ada keeps her own Claude Code token there; the owner's accounts are the computer's.
    assert_eq!(
        put(&ada, json!({"oauth_token": "fixture-token"}))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert!(
        dir.path()
            .join("data/people")
            .join(claimed["actor_id"].as_str().unwrap())
            .join("claude/zerolux-account.json")
            .is_file()
    );
    assert_eq!(
        put(&owner, json!({"oauth_token": "fixture-token"}))
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    kernel.server.shutdown().await.unwrap();
}
