use reqwest::{Client, Method, StatusCode};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;
use zerolux::{
    api,
    chat_runtime::ChatRuntime,
    harness::Harness,
    livekit::{LiveKit, LiveKitConfig},
    model::{HireChatSession, IssuedChatSession, SetOwnerName},
    store::Store,
};

#[cfg(unix)]
#[path = "support/codex_runtime.rs"]
mod codex_runtime;

struct Kernel {
    _dir: tempfile::TempDir,
    store: Store,
    url: String,
    client: Client,
    server: tokio::task::JoinHandle<()>,
}

#[cfg(unix)]
struct ChildKernel {
    child: tokio::process::Child,
    process_group: i32,
}

#[cfg(unix)]
impl Drop for ChildKernel {
    fn drop(&mut self) {
        if self.process_group != 0 {
            // This group was created by this fixture and contains only its
            // kernel and managed LiveKit child. Also clean up after a panic.
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(self.process_group),
                nix::sys::signal::Signal::SIGKILL,
            );
        }
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn child_kernel_discovers_and_hires_an_isolated_native_session_over_http() {
    use std::{
        os::unix::fs::{PermissionsExt, symlink},
        process::Stdio,
        time::Duration,
    };
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let executable = |name| {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join(name))
            .find(|path| path.is_file())
    };
    let (Some(bun), Some(livekit)) = (executable("bun"), executable("livekit-server")) else {
        eprintln!("Bun or livekit-server not installed: skipped");
        return;
    };
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let fixture_home = dir.path().join("home");
    let fixture_codex = dir.path().join("codex");
    let fixture_pi = dir.path().join("pi");
    let fixture_sessions = dir.path().join("pi-sessions");
    let bin = dir.path().join("bin");
    let tmp = dir.path().join("tmp");
    for path in [
        &fixture_home,
        &fixture_codex.join("app-server-control"),
        &fixture_pi,
        &fixture_sessions,
        &bin,
        &tmp,
    ] {
        std::fs::create_dir_all(path).unwrap();
    }
    // No real Claude process or credentials are reachable through this PATH.
    let claude = bin.join("claude");
    std::fs::write(&claude, "#!/bin/sh\nprintf '%s\\n' '[]'\n").unwrap();
    std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o700)).unwrap();
    symlink(std::fs::canonicalize(bun).unwrap(), bin.join("bun")).unwrap();
    symlink(
        std::fs::canonicalize(livekit).unwrap(),
        bin.join("livekit-server"),
    )
    .unwrap();
    let native = codex_runtime::Runtime::new_in(dir.path()).await;
    symlink(
        native.endpoint.strip_prefix("unix://").unwrap(),
        fixture_codex.join("app-server-control/app-server-control.sock"),
    )
    .unwrap();

    // The pi IPC fixture acknowledges link closure, not native turn termination.
    // This deliberately gives the kernel no evidence that inference was cancelled.
    let pi_socket = dir.path().join("pi.sock");
    let pi_listener = tokio::net::UnixListener::bind(&pi_socket).unwrap();
    let pi_record = json!({
        "version":1, "instance_id":"pi-fixture", "endpoint":pi_socket,
        "nonce":"a".repeat(64), "native_session_id":"pi-native-fixture",
        "workspace":std::fs::canonicalize(dir.path()).unwrap()
    });
    let registry = fixture_pi.join("zerolux-links");
    std::fs::create_dir(&registry).unwrap();
    let descriptor = registry.join("fixture.json");
    std::fs::write(&descriptor, pi_record.to_string()).unwrap();
    std::fs::set_permissions(&descriptor, std::fs::Permissions::from_mode(0o600)).unwrap();
    let pi_token = Arc::new(std::sync::Mutex::new(String::new()));
    let pi_stops = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let saved_token = pi_token.clone();
    let stopped = pi_stops.clone();
    let pi_control = tokio::spawn(async move {
        loop {
            let (stream, _) = pi_listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["nonce"], pi_record["nonce"]);
            let response = match request["method"].as_str().unwrap() {
                "describe" => json!({
                    "ok":true, "instance_id":pi_record["instance_id"],
                    "native_session_id":pi_record["native_session_id"],
                    "workspace":pi_record["workspace"], "busy":false, "paired":false,
                    "title":"Isolated pi"
                }),
                "pair" => {
                    assert_eq!(request["native_session_id"], pi_record["native_session_id"]);
                    assert_eq!(request["workspace"], pi_record["workspace"]);
                    *saved_token.lock().unwrap() = request["token"].as_str().unwrap().into();
                    json!({"ok":true,"link_id":"pi-fixture-link"})
                }
                "stop" => {
                    assert_eq!(request["link_id"], "pi-fixture-link");
                    stopped.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    json!({"ok":true})
                }
                "sessions" => json!({"ok":true,"sessions":[]}),
                other => panic!("unexpected pi control method: {other}"),
            };
            stream
                .get_mut()
                .write_all(response.to_string().as_bytes())
                .await
                .unwrap();
            stream.get_mut().shutdown().await.unwrap();
        }
    });

    let child = tokio::process::Command::new(env!("CARGO_BIN_EXE_zerolux"))
        .args(["serve", "--port", "0", "--database"])
        .arg(dir.path().join("kernel.db"))
        .arg("--web-dir")
        .arg(dir.path().join("web"))
        .current_dir(dir.path())
        .env_clear()
        .env("HOME", &fixture_home)
        .env("USERPROFILE", &fixture_home)
        .env("CODEX_HOME", &fixture_codex)
        .env("PI_CODING_AGENT_DIR", &fixture_pi)
        .env("PI_CODING_AGENT_SESSION_DIR", &fixture_sessions)
        .env("TMPDIR", &tmp)
        .env(
            "PATH",
            std::env::join_paths([
                bin.as_path(),
                std::path::Path::new("/usr/bin"),
                std::path::Path::new("/bin"),
            ])
            .unwrap(),
        )
        .env("NO_COLOR", "1")
        .env("RUST_LOG", "zerolux=info")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .process_group(0)
        .spawn()
        .unwrap();
    let mut kernel = ChildKernel {
        process_group: child.id().unwrap() as i32,
        child,
    };
    let mut logs = BufReader::new(kernel.child.stderr.take().unwrap()).lines();
    let port = tokio::time::timeout(Duration::from_secs(15), async {
        while let Some(line) = logs.next_line().await.unwrap() {
            if line.contains("ZeroLux kernel ready") {
                let port: String = line
                    .split("127.0.0.1:")
                    .nth(1)
                    .unwrap()
                    .chars()
                    .take_while(char::is_ascii_digit)
                    .collect();
                return port.parse::<u16>().unwrap();
            }
            eprintln!("fixture kernel: {line}");
        }
        panic!("fixture kernel exited before becoming ready");
    })
    .await
    .unwrap();
    let drain = tokio::spawn(async move {
        while let Ok(Some(line)) = logs.next_line().await {
            eprintln!("fixture kernel: {line}");
        }
    });
    let url = format!("http://127.0.0.1:{port}/api");
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    client
        .post(format!("{url}/onboarding/owner"))
        .json(&json!({"name":"Isolated owner"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let discovery = client
        .get(format!("{url}/sessions"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(
        discovery["sessions"].as_array().unwrap().len(),
        2,
        "{discovery}"
    );
    let discovered = discovery["sessions"].as_array().unwrap();
    let codex = discovered
        .iter()
        .find(|session| session["harness"] == "codex")
        .unwrap();
    let pi = discovered
        .iter()
        .find(|session| session["harness"] == "pi")
        .unwrap();
    assert_eq!(codex["availability"], "attachable");
    assert_eq!(pi["availability"], "attachable");
    assert!(!discovery.to_string().contains("endpoint"));
    assert_eq!(
        native.count("thread/resume"),
        0,
        "discovery must not attach"
    );
    let hired = client
        .post(format!("{url}/chat/hire"))
        .json(&json!({
            "discovered_session_id": codex["id"], "name":"Isolated Codex"
        }))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(hired["session"]["native_session_id"], codex_runtime::THREAD);
    assert!(!hired.to_string().contains("token") && !hired.to_string().contains("native_locator"));
    assert_eq!(native.count("thread/resume"), 1);
    assert_eq!(native.count("thread/start"), 0);
    assert_eq!(
        native.count("thread/queue/add"),
        0,
        "hiring must not submit a prompt"
    );
    let conversation = client
        .post(format!("{url}/conversations"))
        .json(&json!({
            "kind":"dm", "title":"Child fixture chat", "members":[{
                "actor_id":hired["actor"]["id"], "session_id":hired["session"]["id"]
            }]
        }))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let conversation = conversation["conversation"]["id"].as_str().unwrap();
    client
        .post(format!("{url}/conversations/{conversation}/messages"))
        .json(&json!({
            "id":Uuid::new_v4().to_string(), "text":"Wake only the isolated native fixture",
            "reply_to_delivery_id":null
        }))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    native.wait(|state| state.queue.len() == 1).await;
    let session = hired["session"]["id"].as_str().unwrap();
    let stopped = client
        .post(format!("{url}/chat/sessions/{session}/stop"))
        .send()
        .await
        .unwrap();
    assert_eq!(
        stopped.status(),
        StatusCode::OK,
        "{}",
        stopped.text().await.unwrap()
    );
    assert!(native.state.lock().unwrap().queue.is_empty());
    assert_eq!(native.count("thread/queue/delete"), 1);

    let hired_pi = client
        .post(format!("{url}/chat/hire"))
        .json(&json!({
            "discovered_session_id":pi["id"], "name":"Isolated pi"
        }))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let pi_session = hired_pi["session"]["id"].as_str().unwrap();
    let pi_stop_url = format!("{url}/chat/sessions/{pi_session}/stop");
    let stopped_pi = client
        .post(&pi_stop_url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(stopped_pi["session"]["status"], "stopped");
    let note = stopped_pi["session"]["attention_reason"].as_str().unwrap();
    assert!(note.contains("not confirmed") && note.contains("pi may continue"));
    assert_eq!(pi_stops.load(std::sync::atomic::Ordering::SeqCst), 1);
    let token = pi_token.lock().unwrap().clone();
    assert!(!token.is_empty());
    assert_eq!(
        client
            .get(format!("{url}/chat/inbox"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let repeated = client
        .post(&pi_stop_url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(repeated, stopped_pi);
    assert_eq!(
        pi_stops.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "repeat Stop must not repeat IPC effects"
    );

    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(kernel.process_group),
        nix::sys::signal::Signal::SIGTERM,
    )
    .unwrap();
    let status = tokio::time::timeout(Duration::from_secs(10), kernel.child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success(), "kernel shutdown: {status}");
    kernel.process_group = 0;
    drain.await.unwrap();
    pi_control.abort();
}

#[tokio::test]
async fn livekit_tickets_are_scoped_to_the_authenticated_actor_and_restart_requires_readiness() {
    let kernel = Kernel::start().await;
    let agent = kernel.agent("Agent", None).await;
    let owner = kernel.store.chat_identity(None).await.unwrap();
    kernel
        .post(
            &format!("/chat/sessions/{}/status", agent.session.id),
            Some(&agent.token),
            json!({ "status": "connected" }),
        )
        .await
        .error_for_status()
        .unwrap();

    // Minimal Twirp fixture: there are no LiveKit participants. This starts no
    // server executable, WebRTC session, credentials or real harness adapter.
    let transport_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let transport_url = format!("http://{}", transport_listener.local_addr().unwrap());
    let transport = tokio::spawn(async move {
        axum::serve(
            transport_listener,
            axum::Router::new().fallback(|| async {
                (
                    axum::http::StatusCode::NOT_FOUND,
                    axum::Json(json!({ "code": "not_found", "msg": "No fixture room" })),
                )
            }),
        )
        .await
        .unwrap();
    });
    let livekit = Arc::new(
        LiveKit::start(LiveKitConfig {
            url: Some(transport_url),
            api_key: Some("fixture-key".into()),
            api_secret: Some("fixture-secret-not-real".into()),
            data_dir: kernel._dir.path().to_owned(),
        })
        .await
        .unwrap(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let runtime = ChatRuntime::start(
        kernel.store.clone(),
        livekit.clone(),
        url.clone(),
        std::env::temp_dir().join(Uuid::new_v4().to_string()),
    )
    .await
    .unwrap();
    let session = kernel.store.chat_sessions(&owner).await.unwrap().remove(0);
    assert_eq!(session.status, "attention");
    assert!(session.attention_reason.unwrap().contains("restarted"));
    let app = api::router_with_runtime(
        kernel.store.clone(),
        kernel._dir.path().join("web"),
        runtime.clone(),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let verifier = livekit_api::access_token::TokenVerifier::with_api_key(
        "fixture-key",
        "fixture-secret-not-real",
    );
    let mut identities = Vec::new();
    for token in [None, None, Some(agent.token.as_str())] {
        let mut request = kernel
            .client
            .get(format!("{url}/api/livekit/token?actor_id=forged"));
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let ticket = request
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        assert!(!ticket.to_string().contains("fixture-secret-not-real"));
        let claims = verifier.verify(ticket["token"].as_str().unwrap()).unwrap();
        let expected = if token.is_some() {
            &agent.actor.id
        } else {
            &owner.actor_id
        };
        assert!(claims.sub.starts_with(&format!("{expected}:")));
        assert_eq!(claims.video.room, "zerolux");
        assert!(!claims.video.can_publish());
        assert!(!claims.video.can_publish_data());
        assert!(claims.video.can_subscribe());
        identities.push(claims.sub);
    }
    assert_ne!(identities[0], identities[1]);
    assert_eq!(
        kernel
            .client
            .post(format!("{url}/api/chat/hire"))
            .json(&json!({"discovered_session_id":"invalid", "name":"Fixture"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    let stop_url = format!("{url}/api/chat/sessions/{}/stop", agent.session.id);
    let stopped = kernel
        .client
        .post(&stop_url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(stopped["session"]["status"], "stopped");
    assert!(
        stopped["session"]["attention_reason"]
            .as_str()
            .unwrap()
            .contains("no active adapter")
    );
    let repeated = kernel
        .client
        .post(&stop_url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(stopped, repeated);
    runtime.shutdown().await.unwrap();
    assert_eq!(
        kernel
            .client
            .get(format!("{url}/api/livekit/token"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    livekit.shutdown().await.unwrap();
    server.abort();
    transport.abort();
}

impl Kernel {
    async fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("test.db")).await.unwrap();
        store
            .set_owner_name(SetOwnerName {
                name: "Fixture owner".into(),
            })
            .await
            .unwrap();
        Self::serve(dir, store, None).await.0
    }

    async fn serve(
        dir: tempfile::TempDir,
        store: Store,
        livekit: Option<Arc<LiveKit>>,
    ) -> (Self, Option<Arc<ChatRuntime>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let runtime = if let Some(livekit) = livekit {
            Some(
                ChatRuntime::start(
                    store.clone(),
                    livekit,
                    url.clone(),
                    std::env::temp_dir().join(Uuid::new_v4().to_string()),
                )
                .await
                .unwrap(),
            )
        } else {
            None
        };
        let app = if let Some(runtime) = &runtime {
            api::router_with_runtime(store.clone(), dir.path().join("web"), runtime.clone())
        } else {
            api::router(store.clone(), dir.path().join("web"))
        };
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (
            Self {
                _dir: dir,
                store,
                url,
                client: Client::builder().no_proxy().build().unwrap(),
                server,
            },
            runtime,
        )
    }

    fn request(&self, method: Method, path: &str, token: Option<&str>) -> reqwest::RequestBuilder {
        let request = self
            .client
            .request(method, format!("{}/api{path}", self.url));
        if let Some(token) = token {
            request.bearer_auth(token)
        } else {
            request
        }
    }

    async fn post(&self, path: &str, token: Option<&str>, body: Value) -> reqwest::Response {
        self.request(Method::POST, path, token)
            .json(&body)
            .send()
            .await
            .unwrap()
    }

    async fn get(&self, path: &str, token: Option<&str>) -> reqwest::Response {
        self.request(Method::GET, path, token).send().await.unwrap()
    }

    // Domain fixtures issue scoped credentials without discovery, native I/O or
    // models. Only HTTP authentication/authorization and persistence run here.
    async fn agent(&self, name: &str, actor_id: Option<String>) -> IssuedChatSession {
        let owner = self.store.chat_identity(None).await.unwrap();
        self.store
            .hire_chat_session(
                &owner,
                HireChatSession {
                    name: name.into(),
                    actor_id,
                    harness: Harness::Codex,
                    native_session_id: Uuid::new_v4().to_string(),
                    title: name.into(),
                    workspace: self._dir.path().to_string_lossy().into_owned(),
                    native_locator: json!({ "fixture": true }),
                    resume: false,
                },
            )
            .await
            .unwrap()
    }

    async fn conversation(&self, agent: &IssuedChatSession) -> String {
        let response = self
            .post(
                "/conversations",
                None,
                json!({
                    "kind": "dm", "title": "Fixture chat",
                    "members": [{ "actor_id": agent.actor.id, "session_id": agent.session.id }]
                }),
            )
            .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        response.json::<Value>().await.unwrap()["conversation"]["id"]
            .as_str()
            .unwrap()
            .into()
    }
}

impl Drop for Kernel {
    fn drop(&mut self) {
        self.server.abort();
    }
}

/// Exercise the real kernel/publisher/subscribers with a native RPC fixture.
/// Only LiveKit is a child process; no model, personal session or credentials.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn live_chat_round_trip_and_stop_use_the_real_runtime() {
    use std::time::Duration;
    use tokio::sync::{mpsc, watch};
    use zerolux::{
        agent_link,
        codex::{CodexDriver, CodexRpc},
    };

    if std::process::Command::new("livekit-server")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("livekit-server not installed: skipped");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let native = codex_runtime::Runtime::new_in(dir.path()).await;
    let store = Store::open(&dir.path().join("kernel.db")).await.unwrap();
    store
        .set_owner_name(SetOwnerName {
            name: "Owner".into(),
        })
        .await
        .unwrap();
    let livekit = Arc::new(
        LiveKit::start(LiveKitConfig {
            url: None,
            api_key: None,
            api_secret: None,
            data_dir: dir.path().join("livekit"),
        })
        .await
        .unwrap(),
    );
    let (kernel, runtime) = Kernel::serve(dir, store, Some(livekit.clone())).await;
    let runtime = runtime.unwrap();
    let owner = kernel.store.chat_identity(None).await.unwrap();
    // Discovery is fixture-free here: the session is explicitly issued from
    // isolated metadata, then paired through the production runtime entrypoint.
    let agent = kernel
        .store
        .hire_chat_session(
            &owner,
            HireChatSession {
                name: "Codex fixture".into(),
                actor_id: None,
                harness: Harness::Codex,
                native_session_id: codex_runtime::THREAD.into(),
                title: "Fixture".into(),
                workspace: kernel._dir.path().to_string_lossy().into_owned(),
                native_locator: json!({ "endpoint": native.endpoint }),
                resume: false,
            },
        )
        .await
        .unwrap();

    // A browser-equivalent receiver obtains its ticket via HTTP, subscribes,
    // then refreshes snapshots only in response to real LiveKit invalidations.
    let (invalidate, mut invalidations) = mpsc::channel(1);
    let (stop_ui, stopped_ui) = watch::channel(false);
    let ticket_client = kernel.client.clone();
    let ticket_url = format!("{}/api/livekit/token", kernel.url);
    let ui = tokio::spawn(agent_link::run(
        move || {
            let client = ticket_client.clone();
            let url = ticket_url.clone();
            async move {
                let value = client
                    .get(url)
                    .send()
                    .await?
                    .error_for_status()?
                    .json::<Value>()
                    .await?;
                Ok((
                    value["url"].as_str().unwrap().into(),
                    value["token"].as_str().unwrap().into(),
                ))
            }
        },
        invalidate,
        stopped_ui,
    ));
    tokio::time::timeout(Duration::from_secs(15), invalidations.recv())
        .await
        .expect("owner subscribed")
        .unwrap();
    let driver = CodexDriver::attach(&native.endpoint, codex_runtime::THREAD)
        .await
        .unwrap();
    runtime
        .connect_codex(driver, &agent.session, agent.token.clone())
        .await
        .unwrap();
    runtime.changed();
    snapshot_after_invalidation(&kernel, "/chat/sessions", &mut invalidations, |view| {
        view["sessions"][0]["status"] == "connected"
    })
    .await;

    let conversation = kernel.conversation(&agent).await;
    let path = format!("/conversations/{conversation}/messages");
    let message = kernel
        .post(
            &path,
            None,
            json!({
                "id": Uuid::new_v4().to_string(), "text": "Inspect this fixture",
                "reply_to_delivery_id": null
            }),
        )
        .await
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let delivery = message["deliveries"][0]["id"].as_str().unwrap();
    native.wait(|state| state.queue.len() == 1).await;
    snapshot_after_invalidation(&kernel, &path, &mut invalidations, |view| {
        view["messages"][0]["deliveries"][0]["status"] == "notified"
    })
    .await;
    assert_eq!(native.count("thread/queue/add"), 1);
    let turn = json!({
        "id": "fixture-turn", "status": "completed", "itemsView": "full", "items": [
            { "type": "userMessage", "id": "fixture-user", "clientId": delivery,
              "content": [{ "type": "text", "text": "Inspect this fixture" }] },
            { "type": "agentMessage", "id": "fixture-answer", "phase": "final_answer",
              "text": "Verified integration fixture" }
        ]
    });
    {
        let mut state = native.state.lock().unwrap();
        state.queue.clear();
        state.history.push(turn.clone());
    }
    native.emit(json!({ "method": "turn/completed", "params": {
        "threadId": codex_runtime::THREAD, "turn": turn
    }}));
    // The terminal answer stays private: only an explicit reply reaches the chat.
    kernel
        .post(
            &path,
            Some(&agent.token),
            json!({
                "id": Uuid::new_v4().to_string(), "text": "Verified integration fixture",
                "reply_to_delivery_id": delivery
            }),
        )
        .await
        .error_for_status()
        .unwrap();
    let view = snapshot_after_invalidation(&kernel, &path, &mut invalidations, |view| {
        view["messages"]
            .as_array()
            .is_some_and(|messages| messages.len() == 2)
    })
    .await;
    assert_eq!(view["messages"][1]["text"], "Verified integration fixture");
    assert_eq!(view["messages"][1]["author_id"], agent.actor.id);
    assert_eq!(view["messages"][1]["reply_to_delivery_id"], delivery);
    assert_eq!(view["messages"][0]["deliveries"][0]["status"], "read");

    kernel
        .post(
            &path,
            None,
            json!({
                "id": Uuid::new_v4().to_string(), "text": "Pending work to cancel",
                "reply_to_delivery_id": null
            }),
        )
        .await
        .error_for_status()
        .unwrap();
    native.wait(|state| state.queue.len() == 1).await;
    snapshot_after_invalidation(&kernel, &path, &mut invalidations, |view| {
        view["messages"][2]["deliveries"][0]["status"] == "notified"
    })
    .await;
    native.state.lock().unwrap().queue.push(json!({
        "id": "unrelated-native-input", "clientUserMessageId": "private-native-input", "input": []
    }));
    let stopped = kernel
        .post(
            &format!("/chat/sessions/{}/stop", agent.session.id),
            None,
            json!({}),
        )
        .await;
    assert_eq!(
        stopped.status(),
        StatusCode::OK,
        "{}",
        stopped.text().await.unwrap()
    );
    assert_eq!(
        kernel.get("/chat/inbox", Some(&agent.token)).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(native.count("thread/queue/add"), 2);
    assert_eq!(native.count("thread/queue/delete"), 1);
    assert_eq!(native.count("turn/interrupt"), 0);
    assert_eq!(
        native.state.lock().unwrap().queue[0]["id"],
        "unrelated-native-input"
    );
    assert_eq!(native.state.lock().unwrap().queue.len(), 1);
    let repeated = kernel
        .post(
            &format!("/chat/sessions/{}/stop", agent.session.id),
            None,
            json!({}),
        )
        .await
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert!(
        repeated["session"]["attention_reason"].is_null(),
        "a confirmed cancellation stays confirmed on repeat Stop"
    );
    assert_eq!(native.count("thread/queue/delete"), 1);

    // A second owner-authorized link uses the same isolated native identity.
    // When native cancellation cannot be acknowledged, HTTP must not claim it
    // succeeded. Repeating Stop must preserve the warning without another send.
    let rehire = kernel
        .store
        .hire_chat_session(
            &owner,
            HireChatSession {
                name: "Codex fixture".into(),
                actor_id: Some(agent.actor.id.clone()),
                harness: Harness::Codex,
                native_session_id: codex_runtime::THREAD.into(),
                title: "Fixture".into(),
                workspace: kernel._dir.path().to_string_lossy().into_owned(),
                native_locator: json!({ "endpoint": native.endpoint }),
                resume: false,
            },
        )
        .await
        .unwrap();
    let rpc = CodexRpc::connect_with_timeout(&native.endpoint, Duration::from_millis(250))
        .await
        .unwrap();
    let driver = CodexDriver::attach_with_rpc(rpc, codex_runtime::THREAD)
        .await
        .unwrap();
    runtime
        .connect_codex(driver, &rehire.session, rehire.token.clone())
        .await
        .unwrap();
    snapshot_after_invalidation(&kernel, "/chat/sessions", &mut invalidations, |view| {
        view["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|session| session["id"] == rehire.session.id && session["status"] == "connected")
    })
    .await;
    kernel.post(&path, None, json!({
        "id": Uuid::new_v4().to_string(), "text": "Native cancellation will not acknowledge",
        "reply_to_delivery_id": null
    })).await.error_for_status().unwrap();
    native.wait(|state| state.queue.len() == 2).await;
    snapshot_after_invalidation(&kernel, &path, &mut invalidations, |view| {
        view["messages"][3]["deliveries"][0]["status"] == "notified"
    })
    .await;
    native.state.lock().unwrap().drop_cancel_ack = true;
    let stop_path = format!("/chat/sessions/{}/stop", rehire.session.id);
    assert_eq!(
        kernel.post(&stop_path, None, json!({})).await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        kernel
            .get("/chat/inbox", Some(&rehire.token))
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let sessions = kernel
        .get("/chat/sessions", None)
        .await
        .json::<Value>()
        .await
        .unwrap();
    let session = sessions["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|session| session["id"] == rehire.session.id)
        .unwrap();
    assert_eq!(session["status"], "stopped");
    let reason = session["attention_reason"]
        .as_str()
        .expect("cancellation warning persisted");
    assert!(reason.contains("not confirmed"));
    let repeated = kernel
        .post(&stop_path, None, json!({}))
        .await
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(repeated["session"]["attention_reason"], reason);
    assert_eq!(native.count("thread/queue/delete"), 2);

    stop_ui.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(5), ui)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    runtime.shutdown().await.unwrap();
    livekit.shutdown().await.unwrap();
}

#[cfg(unix)]
async fn snapshot_after_invalidation(
    kernel: &Kernel,
    path: &str,
    invalidations: &mut tokio::sync::mpsc::Receiver<()>,
    matches: impl Fn(&Value) -> bool,
) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let view = kernel
                .get(path, None)
                .await
                .error_for_status()
                .unwrap()
                .json::<Value>()
                .await
                .unwrap();
            if matches(&view) {
                return view;
            }
            invalidations
                .recv()
                .await
                .expect("UI subscriber remains connected");
        }
    })
    .await
    .expect("HTTP state must advance through LiveKit invalidations")
}

#[tokio::test]
async fn bearer_never_falls_back_to_owner_and_cannot_use_legacy_apis() {
    let kernel = Kernel::start().await;
    let agent = kernel.agent("Fixture agent", None).await;
    assert_eq!(
        kernel.get("/workspace", None).await.status(),
        StatusCode::OK
    );
    for token in ["invalid", "", "contains whitespace"] {
        assert_eq!(
            kernel.get("/workspace", Some(token)).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let wrong_scheme = kernel
        .client
        .get(format!("{}/api/workspace", kernel.url))
        .header("Authorization", "Basic ignored")
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_scheme.status(), StatusCode::UNAUTHORIZED);
    let duplicate = kernel
        .client
        .get(format!("{}/api/workspace", kernel.url))
        .header("Authorization", format!("Bearer {}", agent.token))
        .header("Authorization", "Bearer invalid")
        .send()
        .await
        .unwrap();
    assert_eq!(duplicate.status(), StatusCode::UNAUTHORIZED);
    for path in ["/workspace", "/tasks/example/runs"] {
        assert_eq!(
            kernel.get(path, Some(&agent.token)).await.status(),
            StatusCode::FORBIDDEN,
            "{path}"
        );
    }
    for path in [
        "/onboarding/owner",
        "/actors",
        "/projects",
        "/tasks",
        "/connections",
        "/tasks/example/actions",
        "/tasks/example/assignee",
        "/worker/claim",
        "/worker/runs/example/finish",
        "/worker/runs/example/heartbeat",
        "/connections/example/heartbeat",
        "/connections/example/disconnect",
    ] {
        assert_eq!(
            kernel
                .post(path, Some(&agent.token), json!({}))
                .await
                .status(),
            StatusCode::FORBIDDEN,
            "{path}"
        );
    }
    assert_eq!(
        kernel.get("/sessions", Some(&agent.token)).await.status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        kernel
            .post(
                "/chat/hire",
                Some(&agent.token),
                json!({
                    "discovered_session_id": "a".repeat(64), "name": "Unauthorized hire"
                })
            )
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        kernel.get("/health", Some(&agent.token)).await.status(),
        StatusCode::OK
    );
    assert_eq!(
        kernel.get("/chat/inbox", None).await.status(),
        StatusCode::FORBIDDEN
    );
    let sessions = kernel
        .get("/chat/sessions", Some(&agent.token))
        .await
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(sessions["sessions"].as_array().unwrap().len(), 1);
    assert!(!sessions.to_string().contains(&agent.token));
    assert!(!sessions.to_string().contains("native_locator"));
}

#[tokio::test]
async fn message_dispatch_reply_and_receipts_follow_one_delivery() {
    let kernel = Kernel::start().await;
    let agent = kernel.agent("Fixture agent", None).await;
    let conversation = kernel.conversation(&agent).await;
    let path = format!("/conversations/{conversation}/messages");
    let owner = kernel.store.chat_identity(None).await.unwrap();
    let body = json!({
        "id": Uuid::new_v4().to_string(), "text": "Please inspect the deterministic fixture",
        "reply_to_delivery_id": null,
        "author_id": agent.actor.id
    });
    let response = kernel.post(&path, None, body.clone()).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let message = response.json::<Value>().await.unwrap();
    assert_eq!(message["author_id"], owner.actor_id);
    assert_eq!(message["seq"], 1);
    assert_eq!(message["deliveries"][0]["status"], "stored");
    let delivery = message["deliveries"][0]["id"].as_str().unwrap();
    assert_eq!(
        kernel.post(&path, None, body.clone()).await.status(),
        StatusCode::OK
    );
    let mut conflict = body;
    conflict["text"] = json!("Different input under the same ID");
    assert_eq!(
        kernel.post(&path, None, conflict).await.status(),
        StatusCode::CONFLICT
    );

    let dispatch = format!("/chat/deliveries/{delivery}/dispatch");
    assert_eq!(
        kernel
            .post(&dispatch, Some(&agent.token), json!({}))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let status = format!("/chat/sessions/{}/status", agent.session.id);
    assert_eq!(
        kernel
            .post(&status, None, json!({ "status": "connected" }))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        kernel
            .post(
                &status,
                Some(&agent.token),
                json!({ "status": "connected" })
            )
            .await
            .status(),
        StatusCode::OK
    );
    let issued = kernel.post(&dispatch, Some(&agent.token), json!({})).await;
    assert_eq!(issued.status(), StatusCode::OK);
    assert_eq!(
        issued.json::<Value>().await.unwrap()["delivery"]["status"],
        "uncertain"
    );
    assert_eq!(
        kernel
            .post(&dispatch, Some(&agent.token), json!({}))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let receipt = format!("/chat/deliveries/{delivery}/receipt");
    assert_eq!(
        kernel
            .post(
                &receipt,
                Some(&agent.token),
                json!({ "status": "notified", "native_request_id": "fixture-request" })
            )
            .await
            .status(),
        StatusCode::OK
    );

    let reply = json!({
        "id": Uuid::new_v4().to_string(), "text": "Verified fixture output", "reply_to_delivery_id": delivery, "author_id": owner.actor_id
    });
    let saved = kernel.post(&path, Some(&agent.token), reply.clone()).await;
    assert_eq!(saved.status(), StatusCode::CREATED);
    assert_eq!(
        saved.json::<Value>().await.unwrap()["author_id"],
        agent.actor.id
    );
    let mut fallback = reply;
    fallback["id"] = json!(Uuid::new_v4().to_string());
    assert_eq!(
        kernel
            .post(&path, Some(&agent.token), fallback.clone())
            .await
            .status(),
        StatusCode::OK
    );
    fallback["text"] = json!("A competing fallback");
    assert_eq!(
        kernel
            .post(&path, Some(&agent.token), fallback)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        kernel
            .post(
                &receipt,
                Some(&agent.token),
                json!({ "status": "uncertain" })
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );

    let first = kernel
        .get(&format!("{path}?after=0&limit=1"), None)
        .await
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(first["next_cursor"], 1);
    assert_eq!(first["has_more"], true);
    assert_eq!(first["messages"][0]["deliveries"][0]["status"], "read");
    let second = kernel
        .get(&format!("{path}?after=1&limit=1"), Some(&agent.token))
        .await
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(second["next_cursor"], 2);
    assert_eq!(second["has_more"], false);
    assert_eq!(second["messages"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn sessions_scope_history_and_stop_revokes_only_its_token() {
    let kernel = Kernel::start().await;
    let first = kernel.agent("Agent", None).await;
    let second = kernel
        .agent("Another context", Some(first.actor.id.clone()))
        .await;
    let outsider = kernel.agent("Another agent", None).await;
    let conversation = kernel.conversation(&first).await;
    for agent in [&second, &outsider] {
        assert_eq!(
            kernel
                .get(
                    &format!("/conversations/{conversation}/messages"),
                    Some(&agent.token)
                )
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        let list = kernel
            .get("/conversations", Some(&agent.token))
            .await
            .json::<Value>()
            .await
            .unwrap();
        assert_eq!(list["conversations"], json!([]));
    }
    let group = kernel
        .post(
            "/conversations",
            None,
            json!({
                "kind": "group", "title": "Different audience",
                "members": [
                    { "actor_id": first.actor.id, "session_id": first.session.id },
                    { "actor_id": outsider.actor.id, "session_id": outsider.session.id }
                ]
            }),
        )
        .await;
    assert_eq!(group.status(), StatusCode::CREATED);
    let group = group.json::<Value>().await.unwrap();
    let group_path = format!(
        "/conversations/{}/messages",
        group["conversation"]["id"].as_str().unwrap()
    );
    for agent in [&first, &outsider] {
        assert_eq!(
            kernel.get(&group_path, Some(&agent.token)).await.status(),
            StatusCode::OK
        );
    }
    assert_eq!(
        kernel.get(&group_path, Some(&second.token)).await.status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        kernel
            .get(
                &format!("/conversations/{conversation}/messages"),
                Some(&outsider.token)
            )
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let stop = format!("/chat/sessions/{}/stop", first.session.id);
    assert_eq!(
        kernel
            .post(&stop, Some(&first.token), json!({}))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        kernel.post(&stop, None, json!({})).await.status(),
        StatusCode::OK
    );
    assert_eq!(
        kernel.post(&stop, None, json!({})).await.status(),
        StatusCode::OK
    );
    assert_eq!(
        kernel.get("/chat/inbox", Some(&first.token)).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        kernel
            .get("/chat/inbox", Some(&second.token))
            .await
            .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn pause_and_native_approval_decisions_require_the_correct_caller() {
    let kernel = Kernel::start().await;
    let agent = kernel.agent("Agent", None).await;
    let outsider = kernel.agent("Outsider", None).await;
    let conversation = kernel.conversation(&agent).await;
    kernel
        .post(
            &format!("/chat/sessions/{}/status", agent.session.id),
            Some(&agent.token),
            json!({ "status": "connected" }),
        )
        .await
        .error_for_status()
        .unwrap();
    let sent = kernel.post(&format!("/conversations/{conversation}/messages"), None, json!({
        "id": Uuid::new_v4().to_string(), "text": "Need a native permission", "reply_to_delivery_id": null
    })).await.json::<Value>().await.unwrap();
    let delivery = sent["deliveries"][0]["id"].as_str().unwrap();
    let pause = format!("/conversations/{conversation}/pause");
    assert_eq!(
        kernel
            .post(&pause, Some(&agent.token), json!({ "paused": true }))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    kernel
        .post(&pause, None, json!({ "paused": true }))
        .await
        .error_for_status()
        .unwrap();
    let dispatch = format!("/chat/deliveries/{delivery}/dispatch");
    assert_eq!(
        kernel
            .post(&dispatch, Some(&agent.token), json!({}))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    kernel
        .post(&pause, None, json!({ "paused": false }))
        .await
        .error_for_status()
        .unwrap();
    kernel
        .post(&dispatch, Some(&agent.token), json!({}))
        .await
        .error_for_status()
        .unwrap();
    let approval_id = Uuid::new_v4().to_string();
    let request = json!({
        "id": approval_id, "delivery_id": delivery, "native_request_id": "permission-1",
        "summary": "Fixture permission", "details": { "command": "fixture command, never executed" }
    });
    assert_eq!(
        kernel
            .post("/chat/approvals", Some(&outsider.token), request.clone())
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    kernel
        .post("/chat/approvals", Some(&agent.token), request)
        .await
        .error_for_status()
        .unwrap();
    let decision = format!("/chat/approvals/{approval_id}/decision");
    assert_eq!(
        kernel
            .post(
                &decision,
                Some(&agent.token),
                json!({ "decision": "allow" })
            )
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    kernel
        .post(&decision, None, json!({ "decision": "deny" }))
        .await
        .error_for_status()
        .unwrap();
    kernel
        .post(&decision, None, json!({ "decision": "deny" }))
        .await
        .error_for_status()
        .unwrap();
    assert_eq!(
        kernel
            .post(&decision, None, json!({ "decision": "allow" }))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let forwarding = format!("/chat/approvals/{approval_id}/dispatch");
    assert_eq!(
        kernel.post(&forwarding, None, json!({})).await.status(),
        StatusCode::FORBIDDEN
    );
    kernel
        .post(&forwarding, Some(&agent.token), json!({}))
        .await
        .error_for_status()
        .unwrap();
    assert_eq!(
        kernel
            .post(&forwarding, Some(&agent.token), json!({}))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let receipt = format!("/chat/approvals/{approval_id}/receipt");
    kernel
        .post(
            &receipt,
            Some(&agent.token),
            json!({ "status": "delivered" }),
        )
        .await
        .error_for_status()
        .unwrap();
    assert_eq!(
        kernel
            .post(
                &receipt,
                Some(&agent.token),
                json!({ "status": "uncertain" })
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let own = kernel
        .get("/chat/approvals", None)
        .await
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(own["approvals"][0]["decision"], "deny");
    assert_eq!(own["approvals"][0]["status"], "delivered");
    let others = kernel
        .get("/chat/approvals", Some(&outsider.token))
        .await
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(others["approvals"], json!([]));
}

#[tokio::test]
async fn errors_are_json_and_loopback_boundary_is_unchanged() {
    let kernel = Kernel::start().await;
    for path in ["/sessions", "/livekit/token"] {
        let response = kernel.get(path, None).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(response.json::<Value>().await.unwrap()["error"].is_string());
    }
    let malformed = kernel
        .post("/conversations", None, json!({ "kind": 7 }))
        .await;
    assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);
    assert!(malformed.json::<Value>().await.unwrap()["error"].is_string());
    let query = kernel
        .get("/conversations/absent/messages?after=not-a-number", None)
        .await;
    assert_eq!(query.status(), StatusCode::BAD_REQUEST);
    assert!(query.json::<Value>().await.unwrap()["error"].is_string());
    let foreign = kernel
        .request(Method::GET, "/conversations", None)
        .header("Origin", "https://example.com")
        .send()
        .await
        .unwrap();
    assert_eq!(foreign.status(), StatusCode::FORBIDDEN);
    let host = kernel
        .request(Method::GET, "/conversations", None)
        .header("Host", "example.com")
        .send()
        .await
        .unwrap();
    assert_eq!(host.status(), StatusCode::FORBIDDEN);
}
