//! Human sign-in through the real authentication service, started by the kernel from this
//! checkout on a temporary instance. Needs `bun` and `livekit-server`; skipped otherwise.
use std::{net::SocketAddr, path::Path, time::Duration};

use reqwest::{Client, StatusCode, header};
use serde_json::{Value, json};
use uuid::Uuid;
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

fn ready() -> bool {
    let ready = installed("bun") && installed("livekit-server");
    if !ready {
        eprintln!("bun or livekit-server not installed: skipped");
    }
    ready
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
        runner: None,
        auth: Some(AuthEntry::checkout(&root)),
    }
}

const PASSWORD: &str = "correct horse battery";

struct Kernel {
    server: Server,
    client: Client,
}

impl Kernel {
    async fn start(dir: &Path, database: Location) -> Self {
        Self {
            server: Server::start(options(dir, database)).await.unwrap(),
            client: Client::builder().no_proxy().build().unwrap(),
        }
    }

    /// The kernel's own address: its accounts sign in and list their workspaces here.
    fn root(&self) -> String {
        self.server.url()
    }

    /// A workspace's address: what its people and agents call.
    fn base(&self, id: &str) -> String {
        self.server.handle().workspace_url(id)
    }

    async fn health(&self) -> Value {
        self.get(&self.root(), "/api/health", None)
            .await
            .json()
            .await
            .unwrap()
    }

    async fn post(
        &self,
        at: &str,
        path: &str,
        bearer: Option<&str>,
        body: Value,
    ) -> reqwest::Response {
        let mut request = self.client.post(format!("{at}{path}")).json(&body);
        if let Some(token) = bearer {
            request = request.bearer_auth(token);
        }
        request.send().await.unwrap()
    }

    async fn get(&self, at: &str, path: &str, bearer: Option<&str>) -> reqwest::Response {
        let mut request = self.client.get(format!("{at}{path}"));
        if let Some(token) = bearer {
            request = request.bearer_auth(token);
        }
        request.send().await.unwrap()
    }

    async fn sign_up(&self, name: &str, email: &str, invite: Option<&str>) -> reqwest::Response {
        let mut request = self
            .client
            .post(format!("{}/api/auth/sign-up/email", self.root()))
            .json(&json!({ "name": name, "email": email, "password": PASSWORD }));
        if let Some(invite) = invite {
            request = request.header("x-zerolux-invite", invite);
        }
        request.send().await.unwrap()
    }

    async fn sign_in(&self, email: &str) -> String {
        let response = self
            .post(
                &self.root(),
                "/api/auth/sign-in/email",
                None,
                json!({ "email": email, "password": PASSWORD }),
            )
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        token_of(&response)
    }

    /// A new workspace, `token`'s account its owner: its ID.
    async fn create(&self, token: &str, body: Value) -> String {
        let response = self
            .post(&self.root(), "/api/workspaces", Some(token), body)
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        let created: Value = response.json().await.unwrap();
        assert_eq!(created["workspace"]["owner"], true);
        created["workspace"]["id"].as_str().unwrap().to_owned()
    }

    async fn workspaces(&self, token: &str) -> Vec<Value> {
        let listed: Value = self
            .get(&self.root(), "/api/workspaces", Some(token))
            .await
            .json()
            .await
            .unwrap();
        listed["workspaces"].as_array().unwrap().clone()
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
async fn an_account_signs_in_once_and_sees_only_the_workspaces_it_made() {
    if !ready() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let database = db::TestDatabase::new(dir.path().join("data/zerolux.db")).await;
    let kernel = Kernel::start(dir.path(), database.location().clone()).await;
    let root = kernel.root();
    let health = kernel.health().await;
    let instance = health["instance"]["id"].as_str().unwrap().to_owned();
    assert_eq!(health["api_version"], zerolux::api::API_VERSION);
    for capability in ["workspaces-v1", "instance-auth-v1"] {
        assert!(
            health["capabilities"]
                .as_array()
                .unwrap()
                .contains(&json!(capability))
        );
    }
    assert_eq!(health["auth"]["setup_required"], true);
    // Its workspaces are listed to their people only.
    assert!(health.get("workspaces").is_none());
    for value in kernel
        .get(&root, "/api/health", None)
        .await
        .headers()
        .get_all(header::CACHE_CONTROL)
    {
        assert_eq!(value, "no-store");
    }
    assert_eq!(
        kernel.get(&root, "/api/workspaces", None).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        kernel
            .post(
                &root,
                "/api/workspaces",
                None,
                json!({ "name": "Nobody's" })
            )
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    // A name a person may not have is refused before an account exists; the kernel's own
    // enrollment header is not a caller's to claim.
    assert_eq!(
        kernel
            .sign_up("Local owner", "owner@example.test", None)
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    let signed_up = kernel
        .sign_up("Owner fixture", "owner@example.test", None)
        .await;
    assert_eq!(signed_up.status(), StatusCode::OK);
    let token = token_of(&signed_up);
    let identity: Value = kernel
        .get(&root, "/api/auth/identity", Some(&token))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(identity["user"]["email"], "owner@example.test");
    assert_eq!(identity["setup_required"], false);
    assert_eq!(kernel.health().await["auth"]["setup_required"], false);
    // Once the instance has an account, nobody else signs up without an invitation.
    assert_eq!(
        kernel
            .sign_up("Other", "other@example.test", None)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let raw = raw_post(
        kernel.server.address(),
        "/api/auth/sign-up/../sign-up/email",
        &["x-zerolux-auth-enroll: 1"],
        &json!({ "name": "Other", "email": "other@example.test", "password": PASSWORD })
            .to_string(),
    )
    .await;
    assert!(raw.starts_with("HTTP/1.1 403"), "{raw}");

    // The signed-in account makes its workspaces, as their owner.
    assert_eq!(kernel.workspaces(&token).await, Vec::<Value>::new());
    assert_eq!(
        kernel
            .post(
                &root,
                "/api/workspaces",
                Some(&token),
                json!({ "name": "Beta", "folder": "relative/folder" })
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    let alpha = kernel.create(&token, json!({ "name": "Alpha" })).await;
    let beta_folder = dir.path().join("beta");
    let beta = kernel
        .create(&token, json!({ "name": "Beta", "folder": beta_folder }))
        .await;
    assert!(beta_folder.join("host-id").is_file());
    assert!(
        dir.path()
            .join(format!("data/workspaces/{alpha}/host-id"))
            .is_file()
    );
    // A folder is one workspace's.
    assert_eq!(
        kernel
            .post(
                &root,
                "/api/workspaces",
                Some(&token),
                json!({ "name": "Gamma", "folder": beta_folder })
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let listed = kernel.workspaces(&token).await;
    let ids: Vec<&str> = listed.iter().map(|w| w["id"].as_str().unwrap()).collect();
    assert_eq!(ids, [alpha.as_str(), beta.as_str()]);
    assert!(listed.iter().all(|w| w["owner"] == true));

    // The same sign-in works in each of them, as their owner.
    let mut owners = Vec::new();
    for id in [&alpha, &beta] {
        let base = kernel.base(id);
        let identity: Value = kernel
            .get(&base, "/api/auth/identity", Some(&token))
            .await
            .json()
            .await
            .unwrap();
        assert_eq!(identity["owner"], true);
        assert!(identity["actor_id"].is_string());
        let workspace: Value = kernel
            .get(&base, "/api/workspace", Some(&token))
            .await
            .json()
            .await
            .unwrap();
        assert_eq!(workspace["workspace"]["id"], *id);
        assert_eq!(workspace["onboarding_required"], false);
        let owner = workspace["actors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["kind"] == "human")
            .unwrap()
            .clone();
        assert_eq!(owner["name"], "Owner fixture");
        assert_eq!(owner["id"], identity["actor_id"]);
        assert!(owner.get("auth_subject").is_none(), "never shown");
        // Already a person here: there is nothing to claim.
        assert_eq!(
            kernel
                .post(&base, "/api/auth/claim", Some(&token), json!({}))
                .await
                .status(),
            StatusCode::CONFLICT
        );
        owners.push(identity["actor_id"].clone());
    }
    assert_ne!(owners[0], owners[1], "a person of each workspace");
    // Nobody is anyone without credentials.
    assert_eq!(
        kernel
            .get(&kernel.base(&alpha), "/api/workspace", None)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );

    // Signing out at a workspace is signing out of the kernel; signing in again gives a token
    // for all of them.
    assert_eq!(
        kernel
            .post(
                &kernel.base(&alpha),
                "/api/auth/sign-out",
                Some(&token),
                json!({})
            )
            .await
            .status(),
        StatusCode::OK
    );
    for id in [&alpha, &beta] {
        assert_eq!(
            kernel
                .get(&kernel.base(id), "/api/workspace", Some(&token))
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let token = kernel.sign_in("owner@example.test").await;
    assert_eq!(
        kernel
            .get(&kernel.base(&beta), "/api/workspace", Some(&token))
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        kernel
            .get(&kernel.base(&beta), "/api/workspace", Some("not.a-session"))
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let address = kernel.server.address();
    kernel.server.shutdown().await.unwrap();
    assert!(
        std::net::TcpListener::bind(address).is_ok(),
        "the service and the kernel are gone"
    );
    // After a restart the instance, its accounts, sessions and workspaces are still there.
    let kernel = Kernel::start(dir.path(), database.location().clone()).await;
    let health = kernel.health().await;
    assert_eq!(health["instance"]["id"], instance);
    assert_eq!(health["auth"]["setup_required"], false);
    let listed = kernel.workspaces(&token).await;
    assert_eq!(listed.len(), 2);
    let identity: Value = kernel
        .get(&kernel.base(&alpha), "/api/auth/identity", Some(&token))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(identity["actor_id"], owners[0]);
    kernel.server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_existing_account_joins_another_workspace_with_an_invitation() {
    if !ready() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let database = db::TestDatabase::new(dir.path().join("data/zerolux.db")).await;
    let kernel = Kernel::start(dir.path(), database.location().clone()).await;
    let root = kernel.root();
    let owner = token_of(
        &kernel
            .sign_up("Owner fixture", "owner@example.test", None)
            .await,
    );
    let first = kernel.create(&owner, json!({ "name": "First" })).await;
    let second = kernel.create(&owner, json!({ "name": "Second" })).await;
    let (first_base, second_base) = (kernel.base(&first), kernel.base(&second));
    assert!(
        kernel
            .get(&first_base, "/api/health", None)
            .await
            .json::<Value>()
            .await
            .unwrap()["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("people-v1"))
    );
    let owner_identity: Value = kernel
        .get(&first_base, "/api/auth/identity", Some(&owner))
        .await
        .json()
        .await
        .unwrap();
    // The owner invites; the token is in that answer only.
    let invite = |base: String| {
        let kernel = &kernel;
        let owner = owner.clone();
        async move {
            let created: Value = kernel
                .post(&base, "/api/invites", Some(&owner), json!({}))
                .await
                .json()
                .await
                .unwrap();
            assert!(created["invite"].get("token_hash").is_none());
            created["token"].as_str().unwrap().to_owned()
        }
    };
    let to_first = invite(first_base.clone()).await;
    let shown: Value = kernel
        .get(&first_base, &format!("/api/auth/invites/{to_first}"), None)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(shown["invitation"]["invited_by"], "Owner fixture");
    assert_eq!(shown["invitation"]["workspace"], "First");
    // An invitation belongs to its workspace.
    assert_eq!(
        kernel
            .get(&second_base, &format!("/api/auth/invites/{to_first}"), None)
            .await
            .status(),
        StatusCode::GONE
    );
    // Without one nobody signs up; with one a person does, and joins by claiming it.
    assert_eq!(
        kernel
            .sign_up("Ada", "ada@example.test", Some("not-an-invitation"))
            .await
            .status(),
        StatusCode::GONE
    );
    let joined = kernel
        .sign_up("Ada", "ada@example.test", Some(&to_first))
        .await;
    assert_eq!(joined.status(), StatusCode::OK);
    let ada = token_of(&joined);
    assert_eq!(kernel.workspaces(&ada).await, Vec::<Value>::new());
    assert_eq!(
        kernel
            .get(&first_base, "/api/workspace", Some(&ada))
            .await
            .status(),
        StatusCode::FORBIDDEN,
        "not a person until the claim"
    );
    let unbound: Value = kernel
        .get(&first_base, "/api/auth/identity", Some(&ada))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(unbound["actor_id"], Value::Null);
    assert_eq!(unbound["owner"], false);
    assert_eq!(
        kernel
            .post(&first_base, "/api/auth/claim", Some(&ada), json!({}))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    // An invitation of one workspace does not open another.
    assert_eq!(
        kernel
            .post(
                &second_base,
                "/api/auth/claim",
                Some(&ada),
                json!({ "invite": to_first })
            )
            .await
            .status(),
        StatusCode::GONE
    );
    let claimed: Value = kernel
        .post(
            &first_base,
            "/api/auth/claim",
            Some(&ada),
            json!({ "invite": to_first }),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(claimed["owner"], false);
    assert!(claimed["actor_id"].is_string());
    let people = |workspace: Value| {
        workspace["actors"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|a| a["kind"] == "human")
            .count()
    };
    assert_eq!(
        people(
            kernel
                .get(&first_base, "/api/workspace", Some(&ada))
                .await
                .json()
                .await
                .unwrap()
        ),
        2
    );
    // Used up: nobody else joins with it, and only the owner invites or renames.
    assert_eq!(
        kernel
            .get(&first_base, &format!("/api/auth/invites/{to_first}"), None)
            .await
            .status(),
        StatusCode::GONE
    );
    assert_eq!(
        kernel
            .sign_up("Bea", "bea@example.test", Some(&to_first))
            .await
            .status(),
        StatusCode::GONE
    );
    assert_eq!(
        kernel
            .post(&first_base, "/api/invites", Some(&ada), json!({}))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        kernel
            .post(
                &first_base,
                "/api/workspace",
                Some(&ada),
                json!({ "name": "Mine" })
            )
            .await
            .status(),
        StatusCode::FORBIDDEN
    );

    // The same account joins the second workspace with its invitation: no new account.
    let to_second = invite(second_base.clone()).await;
    let joined: Value = kernel
        .post(
            &second_base,
            "/api/auth/claim",
            Some(&ada),
            json!({ "invite": to_second }),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(joined["user"]["id"], claimed["user"]["id"]);
    assert_ne!(joined["actor_id"], claimed["actor_id"]);
    let listed = kernel.workspaces(&ada).await;
    assert_eq!(listed.len(), 2);
    assert!(listed.iter().all(|w| w["owner"] == false));
    // Ada's own workspace is hers alone.
    let own = kernel.create(&ada, json!({ "name": "Ada's" })).await;
    assert_eq!(kernel.workspaces(&ada).await.len(), 3);
    assert_eq!(kernel.workspaces(&owner).await.len(), 2);
    assert_eq!(
        kernel
            .get(&kernel.base(&own), "/api/workspace", Some(&owner))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );

    // Sessions on this computer are its owner's.
    assert_eq!(
        kernel
            .get(&first_base, "/api/sessions/discover", Some(&ada))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let sessions: Value = kernel
        .get(&first_base, "/api/sessions", Some(&ada))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(sessions["sessions"], json!([]));
    // The kernel's computer is the owner's, closed to others until the owner opens it.
    let hosts: Value = kernel
        .get(&first_base, "/api/hosts", Some(&ada))
        .await
        .json()
        .await
        .unwrap();
    let host = hosts["hosts"][0]["id"].as_str().unwrap().to_owned();
    assert_eq!(hosts["hosts"][0]["person_id"], owner_identity["actor_id"]);
    assert_eq!(hosts["hosts"][0]["here"], true);
    let account = format!("{first_base}/api/hosts/{host}/accounts/claude-code");
    let put = |token: &str, body: Value| {
        kernel
            .client
            .put(&account)
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
        .patch(format!("{first_base}/api/hosts/{host}"))
        .bearer_auth(&owner)
        .json(&json!({"open": true}))
        .send()
        .await
        .unwrap();
    assert_eq!(opened.status(), StatusCode::OK);
    // Open: Ada keeps her own Claude Code token there, in the workspace's folder; the owner's
    // accounts are the computer's.
    assert_eq!(
        put(&ada, json!({"oauth_token": "fixture-token"}))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert!(
        dir.path()
            .join(format!("data/workspaces/{first}/people"))
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
    assert_eq!(
        kernel.get(&root, "/api/health", None).await.status(),
        StatusCode::OK
    );
    kernel.server.shutdown().await.unwrap();
}

/// A signed-in account that is not a person of a workspace neither reads nor writes anything
/// of it, whatever the route.
#[tokio::test(flavor = "multi_thread")]
async fn a_non_member_reaches_nothing_of_a_workspace() {
    if !ready() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let database = db::TestDatabase::new(dir.path().join("data/zerolux.db")).await;
    let kernel = Kernel::start(dir.path(), database.location().clone()).await;
    let owner = token_of(
        &kernel
            .sign_up("Owner fixture", "owner@example.test", None)
            .await,
    );
    let shared = kernel.create(&owner, json!({ "name": "Shared" })).await;
    let private = kernel.create(&owner, json!({ "name": "Private" })).await;
    let invited: Value = kernel
        .post(
            &kernel.base(&shared),
            "/api/invites",
            Some(&owner),
            json!({}),
        )
        .await
        .json()
        .await
        .unwrap();
    let invite = invited["token"].as_str().unwrap();
    let ada = token_of(
        &kernel
            .sign_up("Ada", "ada@example.test", Some(invite))
            .await,
    );
    assert_eq!(
        kernel
            .post(
                &kernel.base(&shared),
                "/api/auth/claim",
                Some(&ada),
                json!({ "invite": invite })
            )
            .await
            .status(),
        StatusCode::OK
    );
    // The private workspace's own IDs, as its owner sees them.
    let base = kernel.base(&private);
    let workspace: Value = kernel
        .get(&base, "/api/workspace", Some(&owner))
        .await
        .json()
        .await
        .unwrap();
    let person = workspace["actors"][0]["id"].as_str().unwrap().to_owned();
    let conversation = Uuid::new_v4();
    let session = Uuid::new_v4();
    let gets = [
        "/api/workspace".to_owned(),
        "/api/sessions".to_owned(),
        "/api/sessions/discover".to_owned(),
        "/api/sessions/search?q=x".to_owned(),
        format!("/api/sessions/{session}"),
        format!("/api/sessions/{session}/output"),
        format!("/api/sessions/{session}/events"),
        "/api/schedules".to_owned(),
        "/api/conversations".to_owned(),
        format!("/api/conversations/{conversation}/messages"),
        "/api/chat/inbox".to_owned(),
        "/api/chat/approvals".to_owned(),
        "/api/hosts".to_owned(),
        "/api/folders".to_owned(),
        "/api/subscriptions".to_owned(),
        "/api/extensions".to_owned(),
        "/api/actions".to_owned(),
        "/api/invites".to_owned(),
        "/api/livekit/token".to_owned(),
        format!("/api/actors/{person}/settings"),
    ];
    for path in &gets {
        assert_eq!(
            kernel.get(&base, path, Some(&ada)).await.status(),
            StatusCode::FORBIDDEN,
            "GET {path}"
        );
    }
    let posts = [
        ("/api/workspace".to_owned(), json!({ "name": "Taken" })),
        ("/api/onboarding/owner".to_owned(), json!({ "name": "Ada" })),
        (
            "/api/actors".to_owned(),
            json!({ "name": "Spy", "owner_id": person, "harness": "pi" }),
        ),
        (
            "/api/conversations".to_owned(),
            json!({ "kind": "group", "title": "Spy", "members": [] }),
        ),
        (
            format!("/api/conversations/{conversation}/messages"),
            json!({ "id": Uuid::new_v4(), "text": "Hello" }),
        ),
        ("/api/invites".to_owned(), json!({})),
        ("/api/hosts/link".to_owned(), json!({})),
        (
            "/api/extensions/folder".to_owned(),
            json!({ "folder": "/" }),
        ),
        (format!("/api/sessions/{session}/stop"), json!({})),
        (
            format!("/api/actors/{person}/name"),
            json!({ "name": "Spy" }),
        ),
        (
            "/api/sessions".to_owned(),
            json!({ "harness": "pi", "workspace": "/tmp" }),
        ),
    ];
    for (path, body) in &posts {
        assert_eq!(
            kernel
                .post(&base, path, Some(&ada), body.clone())
                .await
                .status(),
            StatusCode::FORBIDDEN,
            "POST {path}"
        );
    }
    // Nothing of it changed.
    let after: Value = kernel
        .get(&base, "/api/workspace", Some(&owner))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(after, workspace);
    let invites: Value = kernel
        .get(&base, "/api/invites", Some(&owner))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(invites["invites"], json!([]));
    kernel.server.shutdown().await.unwrap();
}

/// Two kernels serving one PostgreSQL instance: a sign-in on one is a sign-in on the other,
/// each serves the workspaces the other makes, and each keeps to its own agent sessions.
#[tokio::test(flavor = "multi_thread")]
async fn two_kernels_of_one_instance_share_sign_in_and_keep_their_own_sessions() {
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
    let signed_up = a.sign_up("Owner fixture", "owner@example.test", None).await;
    assert_eq!(signed_up.status(), StatusCode::OK);
    let token = token_of(&signed_up);
    // The same account on the other kernel; signing up is closed there too.
    assert_eq!(b.health().await["auth"]["setup_required"], false);
    assert_eq!(a.health().await["instance"], b.health().await["instance"]);
    assert_eq!(
        b.sign_up("Other", "other@example.test", None)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    // A workspace made on one kernel is served by the other too.
    let id = a.create(&token, json!({ "name": "Replicated" })).await;
    let mut served = false;
    for _ in 0..60 {
        if b.get(&b.base(&id), "/api/workspace", Some(&token))
            .await
            .status()
            == StatusCode::OK
        {
            served = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(served, "the other kernel serves the new workspace");
    // Agent sessions belong to the host that started them: a restart of A recovers A's,
    // and leaves B's as they are. Each kernel has its own host in the workspace's folder.
    let host = |dir: &Path| {
        std::fs::read_to_string(dir.join(format!("data/workspaces/{id}/host-id")))
            .unwrap()
            .trim()
            .to_owned()
    };
    assert_ne!(host(dir_a.path()), host(dir_b.path()));
    let instance = database.instance().await;
    let store_a = instance.store(&id).hosted(host(dir_a.path()));
    let store_b = instance.store(&id).hosted(host(dir_b.path()));
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
