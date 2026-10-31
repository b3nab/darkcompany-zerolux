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

#[path = "support/owner.rs"]
mod owner;

#[path = "support/db.rs"]
mod db;

#[cfg(unix)]
#[path = "support/codex_runtime.rs"]
mod codex_runtime;

struct Kernel {
    _dir: tempfile::TempDir,
    _db: db::TestDatabase,
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

    let bun_dir = owner::bun_dir();
    let child = tokio::process::Command::new(env!("CARGO_BIN_EXE_zerolux"))
        .args(["serve", "--port", "0", "--database"])
        .arg(dir.path().join("kernel.db"))
        .arg("--web-dir")
        .arg(dir.path().join("web"))
        .arg("--auth-entry")
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../services/auth/src/server.ts"),
        )
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
                bun_dir.as_path(),
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
            if let Some((_, address)) = line.split_once("address=127.0.0.1:") {
                let port: String = address.chars().take_while(char::is_ascii_digit).collect();
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
    let base = owner::workspace(&format!("http://127.0.0.1:{port}"), dir.path()).await;
    let url = format!("{base}/api");
    let client = owner::client(&base, Duration::from_secs(20)).await;
    let discovery = client
        .get(format!("{url}/sessions/discover"))
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
    // The Console lists the harnesses' sessions of the workspace's folder, and reads them
    // without opening them.
    let in_folder = |client: reqwest::Client, url: String| async move {
        client
            .get(format!("{url}/sessions/native"))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()
    };
    let listed = in_folder(client.clone(), url.clone()).await;
    let ids = |listed: &Value| {
        let mut ids: Vec<String> = listed["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|session| session["id"].as_str().unwrap().to_owned())
            .collect();
        ids.sort();
        ids
    };
    let mut both = vec![
        codex["id"].as_str().unwrap().to_owned(),
        pi["id"].as_str().unwrap().to_owned(),
    ];
    both.sort();
    assert_eq!(ids(&listed), both);
    for op in ["events", "output"] {
        client
            .get(format!(
                "{url}/sessions/native/{}/{op}",
                codex["id"].as_str().unwrap()
            ))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
    }
    assert_eq!(native.count("thread/resume"), 0, "reading must not open");
    let hired = client
        .post(format!("{url}/sessions/attach"))
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
    // In the workspace now, it is one of its sessions and no longer listed as native.
    assert_eq!(
        ids(&in_folder(client.clone(), url.clone()).await),
        [pi["id"].as_str().unwrap().to_owned()]
    );
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
        .post(format!("{url}/sessions/{session}/stop"))
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
        .post(format!("{url}/sessions/attach"))
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
    let pi_stop_url = format!("{url}/sessions/{pi_session}/stop");
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
    assert!(stopped_pi["session"]["attention_reason"].is_string());
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
    let session = kernel.store.sessions(&owner).await.unwrap().remove(0);
    assert_eq!(session.status, "attention");
    assert!(session.attention_reason.is_some());
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
            &agent.actor.as_ref().unwrap().id
        } else {
            owner.actor_id.as_ref().unwrap()
        };
        assert!(claims.sub.starts_with(&format!("{expected}:")));
        assert_eq!(claims.video.room, "zerolux");
        assert!(!claims.video.can_publish());
        assert!(!claims.video.can_publish_data());
        assert!(claims.video.can_subscribe());
        identities.push(claims.sub);
    }
    assert_ne!(identities[0], identities[1]);
    // What a session streams reaches whoever reads it; only the session itself reports it.
    let live_path = format!("{url}/api/chat/sessions/{}/live", agent.session.id);
    let reported = kernel
        .client
        .post(&live_path)
        .bearer_auth(&agent.token)
        .json(&json!({"changes":[
            {"type":"append","item":"m","kind":"text","text":"Work"},
            {"type":"append","item":"m","kind":"text","text":"ing"}
        ]}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(reported["seq"], 2);
    let state = kernel
        .client
        .get(format!("{url}/api/sessions/{}/live", agent.session.id))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(
        state,
        json!({"seq":2,"items":[{"id":"m","kind":"text","text":"Working"}],"queue":[],"usage":null,"goal":null,"compacting":false})
    );
    // At its budget, the session's work stops for the owner; a higher budget lets it go on.
    let session_path = format!("{url}/api/sessions/{}", agent.session.id);
    let budget = |usd: f64| {
        kernel
            .client
            .patch(&session_path)
            .json(&json!({ "budget_usd": usd }))
            .send()
    };
    let set = budget(1.5).await.unwrap().json::<Value>().await.unwrap();
    assert_eq!(set["session"]["budget_usd"], 1.5);
    let report = |cost: f64| {
        kernel
            .client
            .post(&live_path)
            .bearer_auth(&agent.token)
            .json(&json!({"changes":[{"type":"usage","cost_usd":cost}]}))
            .send()
    };
    report(1.0).await.unwrap().error_for_status().unwrap();
    let status = |store: Store, id: String| async move {
        let owner = store.chat_identity(None).await.unwrap();
        store.chat_session(&owner, &id).await.unwrap()
    };
    let before = status(kernel.store.clone(), agent.session.id.clone()).await;
    report(1.6).await.unwrap().error_for_status().unwrap();
    let reached = status(kernel.store.clone(), agent.session.id.clone()).await;
    assert_eq!(reached.status, "attention");
    assert!(reached.attention_reason.is_some());
    let raised = budget(5.0).await.unwrap().json::<Value>().await.unwrap();
    assert_eq!(raised["session"]["status"], "connected");
    assert_ne!(before.status, "stopped");
    // Words the session receives on a schedule; a run it cannot take says why.
    let created = kernel
        .client
        .post(format!("{url}/api/sessions/{}/schedules", agent.session.id))
        .json(&json!({"cron":"*/5 * * * *","prompt":"Check the build"}))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let schedule = created["schedule"]["id"].as_str().unwrap().to_owned();
    assert!(created["schedule"]["next_run_at"].as_i64().unwrap() > 0);
    assert_eq!(
        kernel
            .client
            .post(format!("{url}/api/sessions/{}/schedules", agent.session.id))
            .json(&json!({"cron":"whenever","prompt":"x"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    sea_orm::ConnectionTrait::execute_raw(
        kernel.store.db(),
        sea_orm::Statement::from_string(
            sea_orm::ConnectionTrait::get_database_backend(kernel.store.db()),
            format!("UPDATE schedules SET next_run_at=1 WHERE id='{schedule}'"),
        ),
    )
    .await
    .unwrap();
    runtime.run_schedules().await.unwrap();
    let listed = kernel
        .client
        .get(format!("{url}/api/schedules"))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let ran = &listed["schedules"][0];
    assert!(ran["last_run_at"].as_i64().is_some());
    assert!(ran["last_error"].as_str().is_some());
    assert!(ran["next_run_at"].as_i64().unwrap() > 1);
    let paused = kernel
        .client
        .patch(format!("{url}/api/schedules/{schedule}"))
        .json(&json!({"enabled":false}))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(paused["schedule"]["enabled"], false);
    assert!(paused["schedule"]["next_run_at"].is_null());
    kernel
        .client
        .delete(format!("{url}/api/schedules/{schedule}"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    // A terminal in the session's folder, for the owner.
    let opened = kernel
        .client
        .post(format!("{url}/api/sessions/{}/terminals", agent.session.id))
        .json(&json!({"cols":80,"rows":24}))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let terminal = opened["terminal"]["id"].as_str().unwrap().to_owned();
    kernel
        .client
        .post(format!("{url}/api/terminals/{terminal}/input"))
        .json(&json!({"data": if cfg!(windows) {
            "echo \"from-$(6*7)\"\r\n"
        } else {
            "echo from-$((6*7))\n"
        }}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let mut seen = String::new();
    let mut after = 0;
    for _ in 0..200 {
        let read = kernel
            .client
            .get(format!("{url}/api/terminals/{terminal}?after={after}"))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        after = read["output"]["next"].as_u64().unwrap();
        let bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            read["output"]["data"].as_str().unwrap(),
        )
        .unwrap();
        let piece = String::from_utf8_lossy(&bytes);
        // Windows' console asks where the cursor is, and waits for the answer a terminal on
        // screen gives.
        if piece.contains("\u{1b}[6n") {
            kernel
                .client
                .post(format!("{url}/api/terminals/{terminal}/input"))
                .json(&json!({"data": "\u{1b}[1;1R"}))
                .send()
                .await
                .unwrap();
        }
        seen.push_str(&piece);
        if seen.contains("from-42") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(seen.contains("from-42"), "{seen}");
    assert_eq!(
        kernel
            .client
            .post(format!("{url}/api/terminals/{terminal}/input"))
            .bearer_auth(&agent.token)
            .json(&json!({"data":"ls\n"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    kernel
        .client
        .delete(format!("{url}/api/terminals/{terminal}"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let free = kernel.agent("", None).await;
    assert_eq!(
        kernel
            .client
            .post(&live_path)
            .bearer_auth(&free.token)
            .json(&json!({"changes":[{"type":"clear"}]}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    // A session without an agent gets notices addressed to itself.
    let ticket = kernel
        .client
        .get(format!("{url}/api/livekit/token"))
        .bearer_auth(&free.token)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let claims = verifier.verify(ticket["token"].as_str().unwrap()).unwrap();
    assert!(claims.sub.starts_with(&format!("{}:", free.session.id)));
    assert_eq!(
        kernel
            .client
            .post(format!("{url}/api/sessions/attach"))
            .json(&json!({"discovered_session_id":"invalid", "name":"Fixture"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    let stop_url = format!("{url}/api/sessions/{}/stop", agent.session.id);
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
    assert!(stopped["session"]["attention_reason"].is_string());
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
        let db = db::TestDatabase::new(dir.path().join("test.db")).await;
        let store = db.open().await;
        store
            .set_owner_name(SetOwnerName {
                name: "Fixture owner".into(),
            })
            .await
            .unwrap();
        Self::serve(dir, db, store, None).await.0
    }

    async fn serve(
        dir: tempfile::TempDir,
        db: db::TestDatabase,
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
                _db: db,
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
                    title: format!("{name} session"),
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
                    "members": [{ "actor_id": agent.actor.as_ref().unwrap().id, "session_id": agent.session.id }]
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
    let database = db::TestDatabase::new(dir.path().join("kernel.db")).await;
    let store = database.open().await;
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
    let (kernel, runtime) = Kernel::serve(dir, database, store, Some(livekit.clone())).await;
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
    snapshot_after_invalidation(&kernel, "/sessions", &mut invalidations, |view| {
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
    // Terminal output is not a chat message: only an explicit reply reaches the chat.
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
    assert_eq!(
        view["messages"][1]["author_id"],
        agent.actor.as_ref().unwrap().id
    );
    assert_eq!(view["messages"][1]["reply_to_delivery_id"], delivery);
    assert_eq!(view["messages"][0]["deliveries"][0]["status"], "read");

    // Compacting is the owner's choice: the agent's own token cannot start it.
    let compact = format!("/sessions/{}/compact", agent.session.id);
    assert_eq!(
        kernel
            .post(&compact, Some(&agent.token), json!({}))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let started = kernel
        .post(&compact, None, json!({}))
        .await
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(started, json!({ "started": true }));
    assert_eq!(native.count("thread/compact/start"), 1);
    let refused = kernel
        .post(&compact, None, json!({ "instructions": "Keep the plan" }))
        .await;
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
    assert_eq!(native.count("thread/compact/start"), 1);

    // A Codex session works toward a goal its person sets: Codex keeps it.
    let goal = format!("/sessions/{}/goal", agent.session.id);
    let read = kernel.get(&goal, None).await.json::<Value>().await.unwrap();
    assert_eq!(read, json!({ "goal": null }));
    let set = kernel
        .request(Method::PUT, &goal, None)
        .json(&json!({ "objective": " Ship the release ", "token_budget": 50000 }))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(set["goal"]["objective"], "Ship the release");
    assert_eq!(set["goal"]["status"], "active");
    assert_eq!(set["goal"]["token_budget"], 50000);
    let refused = kernel
        .request(Method::PUT, &goal, None)
        .json(&json!({ "status": "budget_limited" }))
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        kernel
            .request(Method::PUT, &goal, Some(&agent.token))
            .json(&json!({ "objective": "Mine" }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    kernel
        .request(Method::DELETE, &goal, None)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(native.count("thread/goal/set"), 1);
    assert_eq!(native.count("thread/goal/clear"), 1);

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
            &format!("/sessions/{}/stop", agent.session.id),
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
            &format!("/sessions/{}/stop", agent.session.id),
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
                actor_id: Some(agent.actor.as_ref().unwrap().id.clone()),
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
    snapshot_after_invalidation(&kernel, "/sessions", &mut invalidations, |view| {
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
    let stop_path = format!("/sessions/{}/stop", rehire.session.id);
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
        .get("/sessions", None)
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
    tokio::time::timeout(Duration::from_secs(60), ui)
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
    assert_eq!(
        kernel.get("/workspace", Some(&agent.token)).await.status(),
        StatusCode::FORBIDDEN
    );
    for path in ["/onboarding/owner", "/actors"] {
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
        kernel
            .get("/sessions/discover", Some(&agent.token))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        kernel
            .post(
                "/sessions/attach",
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
        .get("/sessions", Some(&agent.token))
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
        "author_id": agent.actor.as_ref().unwrap().id
    });
    let response = kernel.post(&path, None, body.clone()).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let message = response.json::<Value>().await.unwrap();
    assert_eq!(message["author_id"], owner.actor_id.clone().unwrap());
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
        agent.actor.as_ref().unwrap().id
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
        .agent(
            "Another context",
            Some(first.actor.as_ref().unwrap().id.clone()),
        )
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
                    { "actor_id": first.actor.as_ref().unwrap().id, "session_id": first.session.id },
                    { "actor_id": outsider.actor.as_ref().unwrap().id, "session_id": outsider.session.id }
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
    let stop = format!("/sessions/{}/stop", first.session.id);
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
async fn the_console_lists_reads_and_organizes_sessions_with_or_without_an_agent() {
    let kernel = Kernel::start().await;
    let free = kernel.agent("", None).await;
    let agent = kernel.agent("Agent", None).await;
    assert!(free.actor.is_none());
    let list = kernel
        .get("/sessions", None)
        .await
        .json::<Value>()
        .await
        .unwrap();
    let listed = list["sessions"].as_array().unwrap();
    assert_eq!(listed.len(), 2);
    assert!(
        listed
            .iter()
            .any(|s| s["id"] == free.session.id && s["actor_id"].is_null())
    );
    // A session reads itself, never another; the owner reads every one.
    let path = format!("/sessions/{}", free.session.id);
    let own = kernel.get(&path, Some(&free.token)).await;
    assert_eq!(own.status(), StatusCode::OK);
    assert_eq!(
        own.json::<Value>().await.unwrap()["session"]["id"],
        free.session.id
    );
    assert_eq!(
        kernel.get(&path, Some(&agent.token)).await.status(),
        StatusCode::FORBIDDEN
    );
    // The owner names, pins and archives it.
    let patch = |token: Option<&str>, body: Value| {
        kernel
            .request(Method::PATCH, &path, token)
            .json(&body)
            .send()
    };
    let changed = patch(None, json!({"title":"Release", "pinned":true}))
        .await
        .unwrap();
    assert_eq!(changed.status(), StatusCode::OK);
    let changed = changed.json::<Value>().await.unwrap();
    assert_eq!(changed["session"]["title"], "Release");
    assert!(changed["session"]["pinned_at"].is_i64());
    assert!(changed["session"]["archived_at"].is_null());
    assert_eq!(
        patch(Some(&free.token), json!({"archived":true}))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        patch(None, json!({"owner":"someone"}))
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    // A session without an agent keeps its link, and has no chats.
    assert_eq!(
        kernel.get("/chat/inbox", Some(&free.token)).await.status(),
        StatusCode::OK
    );
    let conversation = kernel.conversation(&agent).await;
    assert_eq!(
        kernel
            .post(
                &format!("/conversations/{conversation}/messages"),
                Some(&free.token),
                json!({"id": Uuid::new_v4().to_string(), "text": "hello"}),
            )
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    // The files of its folder, to mention them.
    std::fs::write(kernel._dir.path().join("plan.md"), "").unwrap();
    let files = kernel
        .get(
            &format!("/sessions/{}/files?query=plan", free.session.id),
            None,
        )
        .await
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(files["files"], json!(["plan.md"]));
    // Its code: what git says has changed, the changes, a file, and the owner's git actions.
    let folder = kernel._dir.path();
    std::process::Command::new("git")
        .arg("-C")
        .arg(folder)
        .args(["init", "-q", "-b", "main"])
        .status()
        .unwrap();
    let git = kernel
        .get(&format!("/sessions/{}/git", free.session.id), None)
        .await
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(git["branch"], "main");
    assert!(
        git["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["path"] == "plan.md" && c["unstaged"] == "?")
    );
    std::fs::write(folder.join("plan.md"), "first step\n").unwrap();
    let diff = kernel
        .get(
            &format!("/sessions/{}/git/diff?path=plan.md", free.session.id),
            None,
        )
        .await
        .json::<Value>()
        .await
        .unwrap();
    assert!(diff["diff"].as_str().unwrap().contains("+first step"));
    let staged = kernel
        .post(
            &format!("/sessions/{}/git/stage", free.session.id),
            None,
            json!({"paths":["plan.md"]}),
        )
        .await
        .json::<Value>()
        .await
        .unwrap();
    assert!(
        staged["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["path"] == "plan.md" && c["staged"] == "A")
    );
    let file = kernel
        .get(
            &format!("/sessions/{}/file?path=plan.md", free.session.id),
            None,
        )
        .await
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(file["text"], "first step\n");
    assert_eq!(
        kernel
            .get(
                &format!("/sessions/{}/file?path=../x", free.session.id),
                None
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    // Input comes in one of three modes.
    assert_eq!(
        kernel
            .post(
                &format!("/sessions/{}/input", free.session.id),
                None,
                json!({"text":"hello","mode":"whenever"}),
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    // A new session names its harness.
    assert_eq!(
        kernel
            .post("/sessions", None, json!({"workspace": "/tmp"}))
            .await
            .status(),
        StatusCode::BAD_REQUEST
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
    for path in ["/sessions/discover", "/livekit/token"] {
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

/// A person's computer joins the workspace with a one-time code, keeps a channel to the
/// kernel, answers what the kernel asks over it, and is gone once removed.
#[tokio::test(flavor = "multi_thread")]
async fn a_computer_joins_as_a_host_and_answers_over_its_channel() {
    if std::process::Command::new("livekit-server")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("livekit-server not installed: skipped");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let host_dir = dir.path().join("laptop");
    let database = db::TestDatabase::new(dir.path().join("kernel.db")).await;
    let store = database.open().await;
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
    let (kernel, runtime) = Kernel::serve(dir, database, store, Some(livekit.clone())).await;
    let runtime = runtime.unwrap();
    let linked: Value = kernel
        .post("/hosts/link", None, json!({"name": "Laptop"}))
        .await
        .json()
        .await
        .unwrap();
    let code = linked["code"].as_str().unwrap().to_owned();
    let host = linked["host"]["id"].as_str().unwrap().to_owned();
    assert_eq!(linked["host"]["joined"], false);
    zerolux::host_link::join(&kernel.url, &code, "Ada's laptop", &host_dir)
        .await
        .unwrap();
    // The code works once.
    assert!(
        zerolux::host_link::join(&kernel.url, &code, "Again", &host_dir.join("again"))
            .await
            .is_err()
    );
    let config = zerolux::host_link::HostConfig::load(&host_dir).unwrap();
    assert_eq!(config.host_id, host);
    assert!(config.secret.starts_with(zerolux::host_link::SECRET_PREFIX));
    let (stop, stopped) = tokio::sync::watch::channel(false);
    let links = host_dir.join("links");
    let connected =
        tokio::spawn(async move { zerolux::host_link::run(config, &links, stopped).await });
    for _ in 0..100 {
        if runtime.hosts.online(&host).await {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let pong = runtime.hosts.call(&host, "ping", json!({})).await.unwrap();
    assert_eq!(pong["version"], zerolux::build::version());
    assert_eq!(pong["build"]["commit"], zerolux::build::commit());
    assert!(
        runtime
            .hosts
            .call(&host, "nothing", json!({}))
            .await
            .is_err()
    );
    let hosts: Value = kernel.get("/hosts", None).await.json().await.unwrap();
    let laptop = hosts["hosts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["id"] == host)
        .unwrap()
        .clone();
    assert_eq!(laptop["name"], "Ada's laptop");
    assert_eq!(
        (laptop["joined"].clone(), laptop["online"].clone()),
        (json!(true), json!(true))
    );
    // A session on that computer is read there: its native record and its folder.
    let work = host_dir.join("work");
    std::fs::create_dir_all(&work).unwrap();
    std::fs::write(work.join("notes.md"), "fixture").unwrap();
    let record = work.join("session.jsonl");
    std::fs::write(
        &record,
        format!(
            "{}\n",
            json!({"type":"message","timestamp":"2026-10-18T10:00:00Z",
                "message":{"role":"user","content":[{"type":"text","text":"Hello from the laptop"}]}})
        ),
    )
    .unwrap();
    let owner = kernel.store.chat_identity(None).await.unwrap();
    let issued = kernel
        .store
        .hire_chat_session(
            &owner,
            HireChatSession {
                name: String::new(),
                actor_id: None,
                harness: zerolux::harness::Harness::Pi,
                native_session_id: "laptop-session".into(),
                title: "On the laptop".into(),
                workspace: work.to_string_lossy().into_owned(),
                native_locator: json!({"session_file": record}),
                resume: false,
            },
        )
        .await
        .unwrap();
    sea_orm::ConnectionTrait::execute_unprepared(
        kernel.store.db(),
        &format!(
            "UPDATE sessions SET host_id='{host}' WHERE id='{}'",
            issued.session.id
        ),
    )
    .await
    .unwrap();
    let events: Value = kernel
        .get(&format!("/sessions/{}/events", issued.session.id), None)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(
        events["events"][0]["text"], "Hello from the laptop",
        "{events}"
    );
    let files: Value = kernel
        .get(
            &format!("/sessions/{}/files?query=notes", issued.session.id),
            None,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(files["files"], json!(["notes.md"]), "{files}");
    // Its terminal command goes on there, in its folder, once stopped here.
    let command: Value = kernel
        .get(
            &format!("/sessions/{}/terminal-command", issued.session.id),
            None,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(
        command["command"],
        format!(
            "cd '{}' && pi --session '{}'",
            work.display(),
            record.display()
        )
    );
    assert_eq!(command["host_id"], host);
    assert_eq!(command["stop_first"], true);
    // Its history is searched there too.
    let searched: Value = kernel
        .get("/sessions/search?q=from%20the%20LAPTOP", None)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(
        searched["results"][0]["session_id"], issued.session.id,
        "{searched}"
    );
    assert_eq!(searched["results"][0]["kind"], "input");
    // Its background commands run there, in its folder, and are read, watched and stopped
    // from here.
    let command = if cfg!(windows) {
        "cd & echo done & exit 4"
    } else {
        "pwd; echo done; exit 4"
    };
    let started: Value = kernel
        .post(
            &format!("/sessions/{}/background-commands", issued.session.id),
            None,
            json!({ "command": command }),
        )
        .await
        .json()
        .await
        .unwrap();
    let command_id = started["background_command"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut ended = Value::Null;
    for _ in 0..100 {
        runtime.check_background().await.unwrap();
        let read: Value = kernel
            .get(&format!("/background-commands/{command_id}"), None)
            .await
            .json()
            .await
            .unwrap();
        if read["background_command"]["status"] != "running" {
            ended = read;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(ended["background_command"]["status"], "exited", "{ended}");
    assert_eq!(ended["background_command"]["exit_code"], 4);
    let text = ended["output"]["text"].as_str().unwrap();
    assert!(
        text.contains("done") && text.contains(work.file_name().unwrap().to_str().unwrap()),
        "{text}"
    );
    // Its output is kept on that computer.
    assert!(
        host_dir
            .join("links/background")
            .join(format!("{command_id}.log"))
            .exists()
    );
    let long = if cfg!(windows) {
        "ping -n 30 127.0.0.1 > nul"
    } else {
        "sleep 30"
    };
    let started: Value = kernel
        .post(
            &format!("/sessions/{}/background-commands", issued.session.id),
            None,
            json!({ "command": long }),
        )
        .await
        .json()
        .await
        .unwrap();
    let command_id = started["background_command"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let stopped: Value = kernel
        .post(
            &format!("/background-commands/{command_id}/stop"),
            None,
            json!({}),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(
        stopped["background_command"]["status"], "stopped",
        "{stopped}"
    );
    // Its process there ends.
    use sea_orm::EntityTrait as _;
    let pid =
        zerolux::entity::background_commands::Entity::find_by_id(kernel.store.key(&command_id))
            .one(kernel.store.db())
            .await
            .unwrap()
            .unwrap()
            .pid
            .unwrap() as u32;
    let mut alive = true;
    for _ in 0..100 {
        alive = zerolux::platform::alive(pid);
        if !alive {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(
        !alive,
        "the stopped command's process {pid} is still running"
    );
    // Removed: its channel closes and its secret no longer connects.
    kernel
        .request(Method::DELETE, &format!("/hosts/{host}"), None)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert!(!runtime.hosts.online(&host).await);
    assert!(runtime.hosts.call(&host, "ping", json!({})).await.is_err());
    // It stops trying, and says why.
    let ended = tokio::time::timeout(std::time::Duration::from_secs(10), connected)
        .await
        .unwrap()
        .unwrap();
    assert!(ended.is_err());
    drop(stop);
    runtime.shutdown().await.unwrap();
    livekit.shutdown().await.unwrap();
}

/// A Codex session started on a joined computer: the computer starts the thread and runs its
/// adapter with the token the kernel issues; input and Stop reach it over its channel.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_codex_session_runs_on_a_joined_computer() {
    if std::process::Command::new("livekit-server")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("livekit-server not installed: skipped");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("laptop-work");
    std::fs::create_dir_all(&work).unwrap();
    let native = codex_runtime::Runtime::new_in(&work).await;
    let host_dir = dir.path().join("laptop");
    let database = db::TestDatabase::new(dir.path().join("kernel.db")).await;
    let store = database.open().await;
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
    let (kernel, runtime) = Kernel::serve(dir, database, store, Some(livekit.clone())).await;
    let runtime = runtime.unwrap();
    let linked: Value = kernel
        .post("/hosts/link", None, json!({}))
        .await
        .json()
        .await
        .unwrap();
    let host = linked["host"]["id"].as_str().unwrap().to_owned();
    zerolux::host_link::join(
        &kernel.url,
        linked["code"].as_str().unwrap(),
        "Laptop",
        &host_dir,
    )
    .await
    .unwrap();
    let config = zerolux::host_link::HostConfig::load(&host_dir).unwrap();
    let (tell, told) = tokio::sync::mpsc::unbounded_channel();
    let computer = zerolux::host_runtime::HostRuntime::with_codex(
        config.url.clone(),
        host_dir.join("links"),
        Some(native.endpoint.clone()),
        tell,
    );
    let (stop, stopped) = tokio::sync::watch::channel(false);
    let (state, mut seen) =
        tokio::sync::watch::channel(zerolux::host_link::HostLinkState::Connecting);
    let connected = tokio::spawn(zerolux::host_link::run_reporting(
        config, stopped, computer, told, state,
    ));
    // The computer says when it is connected.
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        seen.wait_for(|state| *state == zerolux::host_link::HostLinkState::Connected),
    )
    .await
    .unwrap()
    .unwrap();
    for _ in 0..100 {
        if runtime.hosts.online(&host).await {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let created = kernel
        .post(
            "/sessions",
            None,
            json!({"harness": "codex", "workspace": work, "host": host}),
        )
        .await;
    let status = created.status();
    let created: Value = created.json().await.unwrap();
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["session"]["id"].as_str().unwrap().to_owned();
    assert_eq!(created["session"]["host_id"], host);
    assert_eq!(
        created["session"]["native_session_id"],
        codex_runtime::STARTED
    );
    // ZeroLux started it, rather than finding it.
    assert_eq!(created["session"]["created"], true);
    assert_eq!(native.count("thread/start"), 1);
    // The adapter on the computer reports to the kernel itself.
    let mut session = Value::Null;
    for _ in 0..100 {
        session = kernel
            .get(&format!("/sessions/{id}"), None)
            .await
            .json::<Value>()
            .await
            .unwrap()["session"]
            .clone();
        if session["status"] == "connected" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(session["status"], "connected", "{session}");
    // Its native settings are read on the computer, from its Codex.
    let settings = kernel.get(&format!("/sessions/{id}/settings"), None).await;
    let status = settings.status();
    let settings: Value = settings.json().await.unwrap();
    assert_eq!(status, StatusCode::OK, "{settings}");
    assert_eq!(settings["values"]["model"], "fixture-model", "{settings}");
    let sent = kernel
        .post(
            &format!("/sessions/{id}/input"),
            None,
            json!({"text": "Run the tests"}),
        )
        .await;
    assert_eq!(
        sent.status(),
        StatusCode::OK,
        "{}",
        sent.text().await.unwrap()
    );
    // Idle, it waits in Codex's own queue and starts the next turn there.
    assert_eq!(native.count("thread/queue/add"), 1);
    // Images go with it, kept on the computer where its Codex reads them.
    let pictured = kernel
        .post(
            &format!("/sessions/{id}/input"),
            None,
            json!({"text": "Look", "images": [{"media_type": "image/png", "data": "AQID"}]}),
        )
        .await;
    assert_eq!(
        pictured.status(),
        StatusCode::OK,
        "{}",
        pictured.text().await.unwrap()
    );
    assert_eq!(native.count("thread/queue/add"), 2);
    let kept: Vec<_> = std::fs::read_dir(host_dir.join("attachments").join(&id))
        .unwrap()
        .flatten()
        .collect();
    assert_eq!(kept.len(), 1);
    // A terminal in its folder runs on the computer.
    let opened: Value = kernel
        .post(
            &format!("/sessions/{id}/terminals"),
            None,
            json!({"cols": 80, "rows": 24}),
        )
        .await
        .json()
        .await
        .unwrap();
    let terminal = opened["terminal"]["id"].as_str().unwrap().to_owned();
    kernel
        .post(
            &format!("/terminals/{terminal}/input"),
            None,
            json!({"data": "echo from-$((6*7))\n"}),
        )
        .await
        .error_for_status()
        .unwrap();
    let mut seen = String::new();
    for _ in 0..100 {
        let read: Value = kernel
            .get(&format!("/terminals/{terminal}?after=0"), None)
            .await
            .json()
            .await
            .unwrap();
        let bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            read["output"]["data"].as_str().unwrap_or_default(),
        )
        .unwrap();
        seen = String::from_utf8_lossy(&bytes).into_owned();
        if seen.contains("from-42") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(seen.contains("from-42"), "{seen}");
    let listed: Value = kernel
        .get(&format!("/sessions/{id}/terminals"), None)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(listed["terminals"][0]["id"], terminal);
    kernel
        .request(Method::DELETE, &format!("/terminals/{terminal}"), None)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    // A fork is made there, by its Codex, and runs there.
    let forked = kernel
        .post(&format!("/sessions/{id}/fork"), None, json!({}))
        .await;
    let status = forked.status();
    let forked: Value = forked.json().await.unwrap();
    assert_eq!(status, StatusCode::OK, "{forked}");
    assert_eq!(forked["session"]["host_id"], host);
    assert_eq!(forked["session"]["created"], true);
    assert_eq!(native.count("thread/fork"), 1);
    // A new session's worktree is made on the computer, under its own data.
    let repository = work.join("repository");
    std::fs::create_dir_all(&repository).unwrap();
    for args in [
        &["init", "-q"][..],
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "Start",
        ][..],
    ] {
        assert!(
            std::process::Command::new("git")
                .arg("-C")
                .arg(&repository)
                .args(args)
                .status()
                .unwrap()
                .success()
        );
    }
    let made = runtime
        .hosts
        .call(
            &host,
            "session.folder",
            json!({"workspace": repository, "worktree": "feature/fixture"}),
        )
        .await
        .unwrap();
    let folder = made["folder"].as_str().unwrap();
    assert!(
        folder.ends_with("worktrees/repository/feature-fixture"),
        "{folder}"
    );
    assert!(std::path::Path::new(folder).join(".git").exists());
    // Its computer goes offline: the session waits for it.
    stop.send_replace(true);
    connected.await.unwrap().unwrap();
    for _ in 0..100 {
        session = kernel
            .get(&format!("/sessions/{id}"), None)
            .await
            .json::<Value>()
            .await
            .unwrap()["session"]
            .clone();
        if session["status"] == "attention" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(session["status"], "attention", "{session}");
    // Stopped while its computer is offline: here, at once, and said so.
    let stopped = kernel
        .post(&format!("/sessions/{id}/stop"), None, json!({}))
        .await;
    let status = stopped.status();
    let stopped: Value = stopped.json().await.unwrap();
    assert_eq!(status, StatusCode::OK, "{stopped}");
    assert_eq!(stopped["session"]["status"], "stopped");
    runtime.shutdown().await.unwrap();
    livekit.shutdown().await.unwrap();
}
