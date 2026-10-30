//! The kernel lifecycle shared by the CLI and the desktop app: start, serve, release everything.
use std::net::{SocketAddr, TcpListener};

use serde_json::Value;

fn lease_contended(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.raw_os_error() == fs2::lock_contended_error().raw_os_error())
}
use zerolux::{
    api::PublicOrigin,
    livekit::LiveKitConfig,
    server::{Server, ServerOptions},
    store::Instance,
};

mod support {
    /// A managed LiveKit is started with the kernel: without it the server cannot start.
    pub fn installed() -> bool {
        std::process::Command::new("livekit-server")
            .arg("--version")
            .output()
            .is_ok()
    }
}

/// A new workspace of the kernel, with its owner: its ID.
async fn made(server: &Server) -> String {
    server
        .handle()
        .create_workspace("owner-account", "Owner", "Company", None)
        .await
        .unwrap()
        .id
}

/// A workspace kept in the kernel's data directory itself, as the CLI's: the one it hands over.
async fn home_workspace(config: &ServerOptions) -> String {
    std::fs::create_dir_all(&config.data_dir).unwrap();
    Instance::open(&config.database)
        .await
        .unwrap()
        .create_workspace("owner-account", "Owner", "Home", Some(&config.data_dir))
        .await
        .unwrap()
        .id
}

async fn handoff_info(
    directory: &std::path::Path,
    different: Option<&str>,
) -> zerolux::handoff::Info {
    for _ in 0..200 {
        if let Ok(info) = zerolux::handoff::describe(directory).await
            && different.is_none_or(|instance| instance != info.instance)
        {
            return info;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("The temporary CLI did not expose its handoff channel");
}

#[tokio::test(flavor = "multi_thread")]
async fn handoff_commits_the_same_files_host_and_port_without_releasing_the_backup_lease() {
    if !support::installed() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("separate-db")).unwrap();
    std::fs::create_dir_all(dir.path().join("data/storage")).unwrap();
    std::fs::write(dir.path().join("data/storage/kept.txt"), "same files").unwrap();
    let mut config = options(dir.path(), "127.0.0.1:0".parse().unwrap());
    config.database = zerolux::db::Location::Sqlite(dir.path().join("separate-db/company.sqlite"));
    let home = home_workspace(&config).await;
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let original = config.clone();
    let cli = tokio::spawn(zerolux::server::serve_cli_until(original, async {
        let _ = stopped.await;
    }));
    let info = handoff_info(&config.data_dir, None).await;
    assert_eq!(info.workspace_id, home);
    let profile = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        info.database,
        dunce::canonicalize(dir.path().join("separate-db/company.sqlite")).unwrap()
    );
    let transfer = zerolux::handoff::Transfer::begin(&info, &profile)
        .await
        .unwrap();
    let lease = zerolux::lease::Lease::acquire(&config.database).unwrap();
    assert!(zerolux::lease::Lease::acquire(&config.database).is_err());
    config.address = info.network.address();
    let embedded = Server::start_with_lease(config.clone(), lease)
        .await
        .unwrap();
    assert!(zerolux::lease::Lease::acquire(&config.database).is_err());
    transfer.finish(true).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), cli)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    drop(stop);
    assert_eq!(
        embedded.handle().workspaces().await.unwrap()[0].id,
        info.workspace_id
    );
    assert_eq!(embedded.address(), info.network.address());
    assert_eq!(
        std::fs::read_to_string(config.data_dir.join("host-id"))
            .unwrap()
            .trim(),
        info.host_id
    );
    assert_eq!(
        std::fs::read_to_string(config.data_dir.join("storage/kept.txt")).unwrap(),
        "same files"
    );
    assert!(
        zerolux::handoff::describe(&config.data_dir).await.is_err(),
        "A desktop-owned server cannot be stolen by another desktop"
    );
    embedded.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn handoff_disconnect_resumes_the_cli_and_stale_descriptions_cannot_stop_it() {
    if !support::installed() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let config = options(dir.path(), "127.0.0.1:0".parse().unwrap());
    home_workspace(&config).await;
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let cli = tokio::spawn(zerolux::server::serve_cli_until(config.clone(), async {
        let _ = stopped.await;
    }));
    let info = handoff_info(&config.data_dir, None).await;
    let profile = uuid::Uuid::new_v4().to_string();
    let mut wrong = info.clone();
    wrong.workspace_id = "another-workspace".into();
    assert!(
        zerolux::handoff::Transfer::begin(&wrong, &profile)
            .await
            .is_err()
    );
    assert_eq!(
        handoff_info(&config.data_dir, None).await.instance,
        info.instance
    );
    let transfer = zerolux::handoff::Transfer::begin(&info, &profile)
        .await
        .unwrap();
    drop(transfer);
    let resumed = handoff_info(&config.data_dir, Some(&info.instance)).await;
    assert_eq!(resumed.workspace_id, info.workspace_id);
    assert_eq!(resumed.host_id, info.host_id);
    assert_eq!(resumed.network, info.network);
    let transfer = zerolux::handoff::Transfer::begin(&resumed, &profile)
        .await
        .unwrap();
    transfer.finish(false).await.unwrap();
    let again = handoff_info(&config.data_dir, Some(&resumed.instance)).await;
    assert_eq!(again.workspace_id, info.workspace_id);
    stop.send(()).unwrap();
    cli.await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn handoff_commit_survives_a_lost_acknowledgement_and_its_receipt_is_profile_bound() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    if !support::installed() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let mut config = options(dir.path(), "127.0.0.1:0".parse().unwrap());
    home_workspace(&config).await;
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let cli = tokio::spawn(zerolux::server::serve_cli_until(config.clone(), async {
        let _ = stopped.await;
    }));
    let info = handoff_info(&config.data_dir, None).await;
    let profile = uuid::Uuid::new_v4().to_string();
    let stream = zerolux::platform::Local::connect(
        &zerolux::local_control::endpoint_of(&config.data_dir).unwrap(),
    )
    .await
    .unwrap();
    let (read, mut write) = tokio::io::split(stream);
    let mut lines = tokio::io::BufReader::new(read).lines();
    write.write_all(format!("{}\n", serde_json::json!({"method": "kernel.handoff", "params": {"kernel": info, "profile": profile}})).as_bytes()).await.unwrap();
    let ready: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    assert!(ready["result"]["info"].is_object());
    let lease = zerolux::lease::Lease::acquire(&config.database).unwrap();
    config.address = info.network.address();
    let embedded = Server::start_with_lease(config, lease).await.unwrap();
    write.write_all(format!("{}\n", serde_json::json!({"method": "kernel.commit", "params": {"instance": info.instance, "profile": profile}})).as_bytes()).await.unwrap();
    write.flush().await.unwrap();
    drop(write);
    drop(lines); // the decision reaches the CLI; its acknowledgement cannot reach us
    tokio::time::timeout(std::time::Duration::from_secs(5), cli)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    drop(stop);
    let decision = zerolux::handoff::Decision::read(&info, &profile)
        .await
        .unwrap();
    assert!(decision.committed);
    drop(decision);
    assert!(
        zerolux::handoff::Decision::read(&info, &uuid::Uuid::new_v4().to_string())
            .await
            .is_err()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(
                info.directory
                    .join(format!("handoff-{}.json", info.instance))
            )
            .unwrap()
            .permissions()
            .mode()
                & 0o777,
            0o600
        );
    }
    embedded.shutdown().await.unwrap();
}

fn options(dir: &std::path::Path, address: SocketAddr) -> ServerOptions {
    ServerOptions {
        address,
        expose: None,
        data_dir: dir.join("data"),
        database: zerolux::db::Location::Sqlite(dir.join("data/zerolux.db")),
        web_dir: dir.join("web"),
        // Always the managed local LiveKit, whatever LIVEKIT_* is set in the environment.
        livekit: Some(LiveKitConfig {
            url: None,
            api_key: None,
            api_secret: None,
            data_dir: dir.join("livekit"),
        }),
        public: None,
        runner: None,
        auth: None,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn start_serves_the_api_and_shutdown_releases_the_port_and_the_data() {
    if !support::installed() {
        eprintln!("livekit-server not installed: skipped");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(options(dir.path(), "127.0.0.1:0".parse().unwrap()))
        .await
        .unwrap();
    let address = server.address();
    assert_ne!(address.port(), 0, "an OS-assigned port is reported back");
    assert_eq!(server.url(), format!("http://{address}"));
    // The database directory was created and the instance made, like the CLI does.
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let health: Value = client
        .get(format!("{}/api/health", server.url()))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health["name"], "zerolux");
    assert_eq!(health["api_version"], zerolux::api::API_VERSION);
    assert!(health["instance"]["id"].is_string());
    assert!(dir.path().join("data/zerolux.db").is_file());
    let workspace = server
        .handle()
        .create_workspace("owner-account", "Owner", "Company", None)
        .await
        .unwrap();

    server.shutdown().await.unwrap();
    // Released: the same port binds again at once, and nothing answers there.
    let rebound = TcpListener::bind(address).expect("the kernel port is free after shutdown");
    drop(rebound);
    assert!(
        client
            .get(format!("http://{address}/api/health"))
            .send()
            .await
            .is_err()
    );
    // The data outlives the server: reopening finds the same instance, workspace and owner.
    let instance = Instance::open(&zerolux::db::Location::Sqlite(
        dir.path().join("data/zerolux.db"),
    ))
    .await
    .unwrap();
    assert_eq!(instance.id(), health["instance"]["id"]);
    let reopened = instance.store(&workspace.id).workspace().await.unwrap();
    assert_eq!(reopened.workspace.name, "Company");
    assert_eq!(reopened.actors.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn one_kernel_serves_several_workspaces_each_in_its_own_folder() {
    if !support::installed() {
        eprintln!("livekit-server not installed: skipped");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(options(dir.path(), "127.0.0.1:0".parse().unwrap()))
        .await
        .unwrap();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let get = |url: String| {
        let client = client.clone();
        async move {
            let response = client.get(url).send().await.unwrap();
            let status = response.status();
            (
                status,
                response.json::<Value>().await.unwrap_or(Value::Null),
            )
        }
    };
    let post = |url: String, body: Value| {
        let client = client.clone();
        async move {
            let response = client.post(url).json(&body).send().await.unwrap();
            assert!(response.status().is_success(), "{}", response.status());
        }
    };
    let handle = server.handle();
    // A new database starts with no workspace; each one is made with its owner.
    assert!(handle.workspaces().await.unwrap().is_empty());
    let a = handle
        .create_workspace("owner-account", "Aspen", "First", None)
        .await
        .unwrap()
        .id;
    // A workspace in a folder of its own, in a git repository: its data stays out of git.
    let project = dir.path().join("project");
    std::fs::create_dir_all(project.join(".git/info")).unwrap();
    let b = handle
        .create_workspace(
            "owner-account",
            "Birch",
            "Project",
            Some(&project.join(".zerolux")),
        )
        .await
        .unwrap();
    assert_ne!(a, b.id);
    assert!(project.join(".zerolux/host-id").is_file());
    assert!(
        !project.join(".zerolux/zerolux.db").exists(),
        "one database"
    );
    let exclude = std::fs::read_to_string(project.join(".git/info/exclude")).unwrap();
    assert!(exclude.lines().any(|line| line == "/.zerolux/"));

    // Without sign-in, the kernel's workspaces are all the local owner's; each answers at its
    // own address with its own data.
    let (_, listed) = get(format!("{}/api/workspaces", server.url())).await;
    let listed: Vec<&str> = listed["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|workspace| workspace["id"].as_str().unwrap())
        .collect();
    assert_eq!(listed, [a.as_str(), b.id.as_str()]);
    for (id, owner) in [(&a, "aspen"), (&b.id, "birch")] {
        let url = handle.workspace_url(id);
        let (status, own) = get(format!("{url}/api/health")).await;
        assert_eq!(status, 200);
        assert_eq!(own["workspace"]["id"], id.as_str());
        post(
            format!("{url}/api/onboarding/owner"),
            serde_json::json!({"name": owner}),
        )
        .await;
    }
    let actors = |id: String| {
        let get = &get;
        let url = handle.workspace_url(&id);
        async move { get(format!("{url}/api/workspace")).await.1["actors"].clone() }
    };
    assert_eq!(actors(a.clone()).await[0]["name"], "aspen");
    let own = actors(b.id.clone()).await;
    assert_eq!(own.as_array().unwrap().len(), 1);
    assert_eq!(own[0]["name"], "birch");
    let (status, _) = get(format!("{}/w/no-such-workspace/api/health", server.url())).await;
    assert_eq!(status, 404);
    // A folder is one workspace's.
    assert!(
        handle
            .create_workspace(
                "owner-account",
                "Birch",
                "Again",
                Some(&project.join(".zerolux"))
            )
            .await
            .is_err()
    );

    // Removed, it is no longer served; its folder and data are left as they are.
    handle.remove_workspace(&b.id).await.unwrap();
    let (status, _) = get(format!("{}/api/health", handle.workspace_url(&b.id))).await;
    assert_eq!(status, 404);
    assert!(project.join(".zerolux/host-id").is_file());
    // The first workspace goes too, and the kernel keeps serving neither.
    handle.remove_workspace(&a).await.unwrap();
    assert!(handle.workspaces().await.unwrap().is_empty());
    let (_, listed) = get(format!("{}/api/workspaces", server.url())).await;
    assert_eq!(listed["workspaces"], serde_json::json!([]));
    server.shutdown().await.unwrap();
    // Stopped, the kernel makes no more workspaces.
    assert!(
        handle
            .create_workspace("owner-account", "Aspen", "Later", None)
            .await
            .is_err()
    );
    // Started again, it serves every workspace of its database, with its data.
    let server = Server::start(options(dir.path(), "127.0.0.1:0".parse().unwrap()))
        .await
        .unwrap();
    let handle = server.handle();
    assert_eq!(handle.workspaces().await.unwrap().len(), 2);
    let (status, own) = get(format!("{}/api/workspace", handle.workspace_url(&b.id))).await;
    assert_eq!(status, 200);
    assert_eq!(own["actors"][0]["name"], "birch");
    server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_busy_port_fails_before_any_data_is_opened() {
    let dir = tempfile::tempdir().unwrap();
    let busy = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = busy.local_addr().unwrap();
    let error = Server::start(options(dir.path(), address))
        .await
        .err()
        .expect("a busy port is an error");
    assert!(format!("{error:#}").contains(&address.to_string()));
    // Binding comes first: no directory, no database, no LiveKit for a port we do not own.
    assert!(!dir.path().join("data").exists());
    drop(busy);
}

#[tokio::test(flavor = "multi_thread")]
async fn only_loopback_addresses_are_accepted_without_expose() {
    let dir = tempfile::tempdir().unwrap();
    for address in ["0.0.0.0:0", "192.0.2.7:0"] {
        Server::start(options(dir.path(), address.parse().unwrap()))
            .await
            .err()
            .expect("a non-loopback kernel address is refused");
    }
    Server::start(ServerOptions {
        expose: Some("127.0.0.1".parse().unwrap()),
        ..options(dir.path(), "127.0.0.1:0".parse().unwrap())
    })
    .await
    .err()
    .expect("exposing loopback is refused");
    assert!(!dir.path().join("data").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn dropping_the_server_requests_shutdown_and_a_second_start_reuses_the_port() {
    if !support::installed() {
        eprintln!("livekit-server not installed: skipped");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let first = Server::start(options(dir.path(), "127.0.0.1:0".parse().unwrap()))
        .await
        .unwrap();
    let address = first.address();
    // Drop only asks; waiting is `run_until`/`shutdown`. Give the lifecycle task time to end.
    drop(first);
    let mut rebound = None;
    for _ in 0..100 {
        if let Ok(listener) = TcpListener::bind(address) {
            rebound = Some(listener);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let rebound = rebound.expect("the port is released after drop");
    drop(rebound);
    // The desktop remembers its port: a later start on the same address and data works.
    // The port goes first; the data lease ends only when the lifecycle task has stopped
    // the runtime and LiveKit, so a start that meets the lease still held tries again.
    let mut second = None;
    for _ in 0..100 {
        match Server::start(options(dir.path(), address)).await {
            Ok(server) => {
                second = Some(server);
                break;
            }
            Err(error) if lease_contended(&error) => {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            Err(error) => panic!("{error:#}"),
        }
    }
    let second = second.expect("the data lease is released after drop");
    assert_eq!(second.address(), address);
    second.shutdown().await.unwrap();
}

// Aliases are made with Unix symlinks.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn one_kernel_serves_a_workspace_at_a_time_and_the_lease_ends_with_it() {
    if !support::installed() {
        eprintln!("livekit-server not installed: skipped");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let first = Server::start(options(dir.path(), "127.0.0.1:0".parse().unwrap()))
        .await
        .unwrap();
    // A second kernel on the same data, even on another port, is refused before it starts.
    let error = Server::start(options(dir.path(), "127.0.0.1:0".parse().unwrap()))
        .await
        .err()
        .expect("the database is leased");
    assert!(lease_contended(&error), "{error:#}");
    // An alias of the same data is the same workspace: a symlinked directory meets the lease.
    let alias = dir.path().join("alias");
    std::os::unix::fs::symlink(dir.path().join("data"), &alias).unwrap();
    let error = Server::start(ServerOptions {
        data_dir: alias.clone(),
        database: zerolux::db::Location::Sqlite(alias.join("zerolux.db")),
        ..options(dir.path(), "127.0.0.1:0".parse().unwrap())
    })
    .await
    .err()
    .expect("the alias is leased too");
    assert!(lease_contended(&error), "{error:#}");
    // A symlink planted at the lease path is not followed; a hard-linked database is refused.
    let planted = dir.path().join("planted");
    std::fs::write(&planted, "").unwrap();
    let other = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(other.path().join("data")).unwrap();
    std::fs::write(other.path().join("data/zerolux.db"), "").unwrap();
    std::os::unix::fs::symlink(&planted, other.path().join("data/zerolux.db.lock")).unwrap();
    Server::start(options(other.path(), "127.0.0.1:0".parse().unwrap()))
        .await
        .err()
        .expect("a symlinked lease file is refused");
    assert_eq!(std::fs::read(&planted).unwrap(), b"");
    let linked = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(linked.path().join("data")).unwrap();
    std::fs::hard_link(
        dir.path().join("data/zerolux.db"),
        linked.path().join("data/zerolux.db"),
    )
    .unwrap();
    Server::start(options(linked.path(), "127.0.0.1:0".parse().unwrap()))
        .await
        .err()
        .expect("a hard-linked database is refused");
    std::fs::remove_file(linked.path().join("data/zerolux.db")).unwrap();
    // Plain database access is not a kernel: maintenance and tests keep working alongside.
    let instance = Instance::open(&zerolux::db::Location::Sqlite(
        dir.path().join("data/zerolux.db"),
    ))
    .await
    .unwrap();
    assert!(instance.workspaces().await.unwrap().is_empty());
    drop(instance);
    first.shutdown().await.unwrap();
    assert!(dir.path().join("data/zerolux.db.lock").is_file());
    let second = Server::start(options(dir.path(), "127.0.0.1:0".parse().unwrap()))
        .await
        .expect("the lease is released with the kernel");
    second.shutdown().await.unwrap();
}

#[test]
fn the_notice_room_is_scoped_to_the_workspace() {
    use zerolux::livekit::{ROOM, workspace_room};
    assert_eq!(
        workspace_room("0f9b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"),
        "zerolux-0f9b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
    );
    // Not a UUID: encoded without loss, so distinct ids never share a room.
    assert_eq!(workspace_room("a b"), "zerolux-x612062");
    assert_ne!(workspace_room("a b"), workspace_room("ab"));
    assert_ne!(workspace_room("x"), ROOM);
    assert_ne!(workspace_room("x"), workspace_room("y"));
}

#[test]
fn a_public_origin_is_a_bare_origin_and_its_livekit_url_is_a_websocket_url() {
    for ok in [
        "https://company.example",
        "http://kernel.lan:8080",
        "https://Company.Example/",
    ] {
        assert!(PublicOrigin::new(ok, None).is_ok(), "{ok}");
    }
    for bad in [
        "company.example",
        "https://company.example/zerolux",
        "https://company.example/?x=1",
        "https://user@company.example",
        "ftp://company.example",
        "",
    ] {
        assert!(PublicOrigin::new(bad, None).is_err(), "{bad}");
    }
    assert!(
        PublicOrigin::new(
            "https://company.example",
            Some("wss://rtc.company.example".into())
        )
        .is_ok()
    );
    assert!(
        PublicOrigin::new(
            "https://company.example",
            Some("https://rtc.company.example".into())
        )
        .is_err()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_public_origin_is_served_by_authority_with_its_own_livekit_address() {
    if !support::installed() {
        eprintln!("livekit-server not installed: skipped");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let public = PublicOrigin::new(
        "https://company.example",
        Some("wss://rtc.company.example".into()),
    )
    .unwrap();
    let server = Server::start(ServerOptions {
        public: Some(public),
        ..options(dir.path(), "127.0.0.1:0".parse().unwrap())
    })
    .await
    .unwrap();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let base = server.url();
    let workspace = format!("/w/{}", made(&server).await);
    let via_proxy = |path: &str| {
        // What a reverse proxy on this computer forwards: the public Host, the public Origin.
        client
            .get(format!("{base}{path}"))
            .header("host", "company.example")
            .header("origin", "https://company.example")
    };
    // Served as the public origin, from a loopback peer: the proxy's connection.
    let health = via_proxy("/api/health").send().await.unwrap();
    assert_eq!(health.status(), 200);
    // Realtime from outside goes to the configured LiveKit address, not the kernel's loopback.
    let ticket: Value = via_proxy(&format!("{workspace}/api/livekit/token"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(ticket["url"], "wss://rtc.company.example");
    // Locally, the ticket still names the managed server on this computer.
    let local: Value = client
        .get(format!("{base}{workspace}/api/livekit/token"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        local["url"].as_str().unwrap().contains("127.0.0.1"),
        "{local}"
    );
    // Public means public: a wrong Origin, a plain-http Origin and agent credentials are refused.
    for (origin, authorization) in [
        ("https://other.example", None),
        ("http://company.example", None),
        // An agent's credential never arrives from the public origin.
        (
            "https://company.example",
            Some("Bearer 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
        ),
    ] {
        let mut request = client
            .get(format!("{base}/api/health"))
            .header("host", "company.example")
            .header("origin", origin);
        if let Some(authorization) = authorization {
            request = request.header("authorization", authorization);
        }
        assert_eq!(
            request.send().await.unwrap().status(),
            403,
            "{origin} {authorization:?}"
        );
    }
    // An unknown public authority is neither public nor local.
    let unknown = client
        .get(format!("{base}/api/health"))
        .header("host", "elsewhere.example")
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), 403);
    server.shutdown().await.unwrap();

    // Without a public LiveKit address, the kernel's own LiveKit is not promised to outsiders.
    let server = Server::start(ServerOptions {
        public: Some(PublicOrigin::new("https://company.example", None).unwrap()),
        ..options(dir.path(), "127.0.0.1:0".parse().unwrap())
    })
    .await
    .unwrap();
    let base = server.handle().workspace_url(&made(&server).await);
    let refused = client
        .get(format!("{base}/api/livekit/token"))
        .header("host", "company.example")
        .header("origin", "https://company.example")
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 503);
    server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_desktop_app_origin_is_accepted_as_the_request_it_makes_with_explicit_cors() {
    if !support::installed() {
        eprintln!("livekit-server not installed: skipped");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let public = PublicOrigin::new("https://company.example", None).unwrap();
    let server = Server::start(ServerOptions {
        public: Some(public),
        ..options(dir.path(), "127.0.0.1:0".parse().unwrap())
    })
    .await
    .unwrap();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let base = server.url();
    let workspace = server.handle().workspace_url(&made(&server).await);
    for origin in ["tauri://localhost", "http://tauri.localhost"] {
        // A local kernel: the desktop's page is a local request, tagged for the browser.
        let response = client
            .get(format!("{base}/api/health"))
            .header("origin", origin)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200, "{origin}");
        assert_eq!(
            response.headers()["access-control-allow-origin"],
            origin,
            "{origin}"
        );
        assert_eq!(response.headers()["vary"], "Origin");
        // The browser's preflight for a JSON POST is answered without reaching any handler.
        let preflight = client
            .request(
                reqwest::Method::OPTIONS,
                format!("{workspace}/api/workspace"),
            )
            .header("origin", origin)
            .header("access-control-request-method", "POST")
            .header("access-control-request-headers", "content-type")
            .send()
            .await
            .unwrap();
        assert_eq!(preflight.status(), 204);
        assert_eq!(preflight.headers()["access-control-allow-origin"], origin);
        assert_eq!(
            preflight.headers()["access-control-allow-methods"],
            "GET, POST"
        );
        assert_eq!(
            preflight.headers()["access-control-allow-headers"],
            "content-type, authorization, x-zerolux-invite"
        );
        assert_eq!(
            preflight.headers()["access-control-expose-headers"],
            "set-auth-token"
        );
        // A remote kernel: the desktop is a public visitor there, nothing more.
        let public = client
            .get(format!("{base}/api/health"))
            .header("host", "company.example")
            .header("origin", origin)
            .send()
            .await
            .unwrap();
        assert_eq!(public.status(), 200);
        assert_eq!(public.headers()["access-control-allow-origin"], origin);
        // An agent's credential never arrives from the public origin.
        let with_credentials = client
            .get(format!("{base}/api/health"))
            .header("host", "company.example")
            .header("origin", origin)
            .header(
                "authorization",
                "Bearer 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            )
            .send()
            .await
            .unwrap();
        assert_eq!(with_credentials.status(), 403);
    }
    // Any other origin stays refused, and gets no CORS headers at all.
    for origin in [
        "tauri://evil",
        "http://evil.localhost",
        "https://tauri.localhost.evil",
    ] {
        let refused = client
            .get(format!("{base}/api/health"))
            .header("origin", origin)
            .send()
            .await
            .unwrap();
        assert_eq!(refused.status(), 403, "{origin}");
        assert!(
            refused
                .headers()
                .get("access-control-allow-origin")
                .is_none()
        );
    }
    // A preflight from elsewhere is an ordinary refused request.
    let refused = client
        .request(
            reqwest::Method::OPTIONS,
            format!("{workspace}/api/workspace"),
        )
        .header("origin", "http://evil.localhost")
        .header("access-control-request-method", "POST")
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 403);
    server.shutdown().await.unwrap();
}

#[path = "support/db.rs"]
mod db;
