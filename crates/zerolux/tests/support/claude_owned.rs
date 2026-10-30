//! A kernel with the real Claude runner and a scripted model instead of Claude
//! (`harnesses/claude/src/fixtures/owned-harness.ts`), for end-to-end tests.
use nix::{
    sys::signal::{Signal, kill, killpg},
    unistd::Pid,
};
use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use std::{os::unix::fs::PermissionsExt, path::PathBuf, sync::Arc, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use zerolux::{
    api,
    chat_runtime::ChatRuntime,
    claude_runner::RunnerProgram,
    harness::Harness,
    livekit::{LiveKit, LiveKitConfig},
    model::{ChatSessionStatus, HireChatSession, SendChatMessage, SetOwnerName},
    store::{Instance, Store},
};

pub(crate) struct Fixture {
    pub(crate) dir: tempfile::TempDir,
    pub(crate) program: RunnerProgram,
    /// The fixture's workspace, made by the first kernel started on it.
    workspace: tokio::sync::OnceCell<String>,
}
impl Fixture {
    pub(crate) fn new() -> Self {
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        let root = dir.path();
        for folder in ["home", "tmp", "workspace"] {
            std::fs::create_dir(root.join(folder)).unwrap();
        }
        let bun = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|path| path.join("bun"))
            .find(|path| path.is_file())
            .unwrap()
            .canonicalize()
            .unwrap();
        let wrapper = root.join("bun-fixture");
        std::fs::write(&wrapper, format!("#!/bin/sh\nexec /usr/bin/env -i HOME=\"{}\" TMPDIR=\"{}\" PATH=/usr/bin:/bin ZEROLUX_RUNNER_REGISTRY=\"$ZEROLUX_RUNNER_REGISTRY\" ZEROLUX_NATIVE_SESSION=\"$ZEROLUX_NATIVE_SESSION\" ZEROLUX_WORKSPACE=\"$ZEROLUX_WORKSPACE\" ZEROLUX_PERMISSION_MODE=\"$ZEROLUX_PERMISSION_MODE\" ZEROLUX_INITIAL_SETTINGS=\"$ZEROLUX_INITIAL_SETTINGS\" ZEROLUX_CLAUDE_MANAGED=\"$ZEROLUX_CLAUDE_MANAGED\" ${{ZEROLUX_SYSTEM_PROMPT:+ZEROLUX_SYSTEM_PROMPT=$ZEROLUX_SYSTEM_PROMPT}} \"{}\" \"$@\"\n", root.join("home").display(), root.join("tmp").display(), bun.display())).unwrap();
        let claude = root.join("claude-fixture");
        std::fs::write(&claude, "#!/bin/sh\nprintf '%s\\n' '[]'\n").unwrap();
        for file in [&wrapper, &claude] {
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let program = RunnerProgram {
            bun: wrapper,
            entry: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../harnesses/claude/src/fixtures/owned-harness.ts"),
            kernel_executable: Some(env!("CARGO_BIN_EXE_zerolux").into()),
            claude_cli: claude,
            pi_entry: None,
            sdk_executable: None,
        };
        Self {
            dir,
            program,
            workspace: Default::default(),
        }
    }
    pub(crate) fn trace(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.path().join("workspace/runner-trace.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }
    pub(crate) async fn control(&self, native: &str, mut request: Value) -> Value {
        let record = std::fs::read_dir(self.dir.path().join("links/claude"))
            .unwrap()
            .flatten()
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
            .filter_map(|entry| {
                serde_json::from_slice::<Value>(&std::fs::read(entry.path()).unwrap()).ok()
            })
            .find(|record| {
                record["native_session_id"] == native
                    && record["pid"]
                        .as_i64()
                        .and_then(|pid| i32::try_from(pid).ok())
                        .is_some_and(|pid| pid > 0 && kill(Pid::from_raw(pid), None).is_ok())
            })
            .unwrap();
        request["nonce"] = record["nonce"].clone();
        let deadline = if request["method"] == "prepare" {
            60
        } else {
            5
        };
        tokio::time::timeout(Duration::from_secs(deadline), async {
            let mut socket =
                zerolux::platform::Local::connect(record["endpoint"].as_str().unwrap())
                    .await
                    .unwrap();
            socket
                .write_all(format!("{request}\n").as_bytes())
                .await
                .unwrap();
            let mut bytes = Vec::new();
            socket
                .take(64 * 1024)
                .read_to_end(&mut bytes)
                .await
                .unwrap();
            let response: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(response["ok"], true);
            response
        })
        .await
        .unwrap()
    }
    pub(crate) async fn wait_trace(&self, predicate: impl Fn(&[Value]) -> bool) -> Vec<Value> {
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let rows = self.trace();
                if predicate(&rows) {
                    return rows;
                }
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("Trace did not reach expected state: {:?}", self.trace()))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if std::thread::panicking() {
            eprintln!("Runner trace: {:?}", self.trace());
        }
        // These detached process groups were created only by this fixture's runner launches.
        if let Ok(entries) = std::fs::read_dir(self.dir.path().join("links/claude")) {
            for entry in entries.flatten() {
                if entry.path().extension().and_then(|v| v.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(bytes) = std::fs::read(entry.path())
                    && let Ok(record) = serde_json::from_slice::<Value>(&bytes)
                    && let Some(pid) = record["pid"].as_i64()
                {
                    let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);
                }
            }
        }
    }
}

pub(crate) struct Kernel {
    pub(crate) store: Store,
    pub(crate) url: String,
    pub(crate) client: Client,
    pub(crate) livekit: Arc<LiveKit>,
    pub(crate) runtime: Option<Arc<ChatRuntime>>,
    pub(crate) server: tokio::task::JoinHandle<()>,
}
impl Kernel {
    pub(crate) async fn start(fixture: &Fixture, port: u16) -> Self {
        let root = fixture.dir.path();
        let instance = Instance::open(&zerolux::db::Location::Sqlite(root.join("chat.db")))
            .await
            .unwrap();
        let workspace = fixture
            .workspace
            .get_or_init(|| async {
                instance
                    .create_workspace("owner-account", "Owner", "Workspace", None)
                    .await
                    .unwrap()
                    .id
            })
            .await;
        let store = instance.store(workspace);
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
                data_dir: root.join("livekit"),
            })
            .await
            .unwrap(),
        );
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let runtime = ChatRuntime::start_with_runner(
            store.clone(),
            livekit.clone(),
            url.clone(),
            root.join("links"),
            fixture.program.clone(),
        )
        .await
        .unwrap();
        let app = api::router_with_runtime(store.clone(), root.join("web"), runtime.clone());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        runtime.reconnect().await.unwrap();
        Self {
            store,
            url,
            client: Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(75))
                .build()
                .unwrap(),
            livekit,
            runtime: Some(runtime),
            server,
        }
    }
    pub(crate) async fn api(&self, path: &str, body: Option<Value>) -> Value {
        let url = format!("{}/api{path}", self.url);
        let response = match body {
            Some(body) => self.client.post(url).json(&body).send().await,
            None => self.client.get(url).send().await,
        }
        .unwrap();
        let status = response.status();
        let body: Value = response.json().await.unwrap();
        assert!(status.is_success(), "{path}: {status} {body}");
        body
    }
    pub(crate) async fn wait(&self, path: &str, predicate: impl Fn(&Value) -> bool) -> Value {
        tokio::time::timeout(Duration::from_secs(25), async {
            loop {
                let data = self.api(path, None).await;
                if predicate(&data) {
                    return data;
                }
                tokio::time::sleep(Duration::from_millis(80)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("HTTP state did not settle at {path}"))
    }
    pub(crate) async fn shutdown(mut self) {
        self.runtime.take().unwrap().shutdown().await.unwrap();
        self.server.abort();
        let _ = (&mut self.server).await;
        self.livekit.shutdown().await.unwrap();
    }
}
impl Drop for Kernel {
    fn drop(&mut self) {
        self.server.abort();
        if let Some(runtime) = self.runtime.take() {
            tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current().block_on(async {
                    let _ = runtime.shutdown().await;
                    let _ = self.livekit.shutdown().await;
                })
            });
        }
    }
}
pub(crate) fn count(rows: &[Value], event: &str) -> usize {
    rows.iter().filter(|row| row["event"] == event).count()
}
