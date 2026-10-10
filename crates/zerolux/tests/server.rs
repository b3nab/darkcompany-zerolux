//! The kernel lifecycle shared by the CLI and the desktop app: start, serve, release everything.
use std::net::{SocketAddr, TcpListener};

use serde_json::Value;
use zerolux::{
    api::PublicOrigin,
    livekit::LiveKitConfig,
    server::{Server, ServerOptions},
    store::Store,
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

fn options(dir: &std::path::Path, address: SocketAddr) -> ServerOptions {
    ServerOptions {
        address,
        expose: None,
        database: dir.join("data/zerolux.db"),
        web_dir: dir.join("web"),
        // Always the managed local LiveKit, whatever LIVEKIT_* is set in the environment.
        livekit: Some(LiveKitConfig {
            url: None,
            api_key: None,
            api_secret: None,
            data_dir: dir.join("livekit"),
        }),
        public: None,
        #[cfg(unix)]
        runner: None,
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
    // The database directory was created and the owner bootstrapped, like the CLI does.
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
    assert!(health["workspace"]["id"].is_string());
    assert!(dir.path().join("data/zerolux.db").is_file());

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
    // The data outlives the server: reopening finds the same owner.
    let store = Store::open(&dir.path().join("data/zerolux.db"))
        .await
        .unwrap();
    let workspace = store.workspace().await.unwrap();
    assert_eq!(workspace.workspace.id, health["workspace"]["id"]);
    assert_eq!(workspace.actors.len(), 1);
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
    let text = format!("{error:#}");
    assert!(
        text.contains(&format!("Cannot listen on {address}")) && text.contains("retry"),
        "{text}"
    );
    // Binding comes first: no directory, no database, no LiveKit for a port we do not own.
    assert!(!dir.path().join("data").exists());
    drop(busy);
}

#[tokio::test(flavor = "multi_thread")]
async fn only_loopback_addresses_are_accepted_without_expose() {
    let dir = tempfile::tempdir().unwrap();
    for address in ["0.0.0.0:0", "192.0.2.7:0"] {
        let error = Server::start(options(dir.path(), address.parse().unwrap()))
            .await
            .err()
            .expect("a non-loopback kernel address is refused");
        assert!(format!("{error:#}").contains("--expose"), "{error:#}");
    }
    let error = Server::start(ServerOptions {
        expose: Some("127.0.0.1".parse().unwrap()),
        ..options(dir.path(), "127.0.0.1:0".parse().unwrap())
    })
    .await
    .err()
    .expect("exposing loopback is refused");
    assert!(
        format!("{error:#}").contains("private network"),
        "{error:#}"
    );
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
    let second = Server::start(options(dir.path(), address)).await.unwrap();
    assert_eq!(second.address(), address);
    second.shutdown().await.unwrap();
}

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
        .expect("the workspace is leased");
    assert!(format!("{error:#}").contains("already serves"), "{error:#}");
    // An alias of the same data is the same workspace: a symlinked directory meets the lease.
    let alias = dir.path().join("alias");
    std::os::unix::fs::symlink(dir.path().join("data"), &alias).unwrap();
    let error = Server::start(ServerOptions {
        database: alias.join("zerolux.db"),
        ..options(dir.path(), "127.0.0.1:0".parse().unwrap())
    })
    .await
    .err()
    .expect("the alias is leased too");
    assert!(format!("{error:#}").contains("already serves"), "{error:#}");
    // A symlink planted at the lease path is not followed; a hard-linked database is refused.
    let planted = dir.path().join("planted");
    std::fs::write(&planted, "").unwrap();
    let other = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(other.path().join("data")).unwrap();
    std::fs::write(other.path().join("data/zerolux.db"), "").unwrap();
    std::os::unix::fs::symlink(&planted, other.path().join("data/zerolux.db.lock")).unwrap();
    let error = Server::start(options(other.path(), "127.0.0.1:0".parse().unwrap()))
        .await
        .err()
        .expect("a symlinked lease file is refused");
    assert!(format!("{error:#}").contains("lease"), "{error:#}");
    let linked = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(linked.path().join("data")).unwrap();
    std::fs::hard_link(
        dir.path().join("data/zerolux.db"),
        linked.path().join("data/zerolux.db"),
    )
    .unwrap();
    let error = Server::start(options(linked.path(), "127.0.0.1:0".parse().unwrap()))
        .await
        .err()
        .expect("a hard-linked database is refused");
    assert!(format!("{error:#}").contains("hard link"), "{error:#}");
    std::fs::remove_file(linked.path().join("data/zerolux.db")).unwrap();
    // Plain store access is not a kernel: maintenance and tests keep working alongside.
    let store = Store::open(&dir.path().join("data/zerolux.db"))
        .await
        .unwrap();
    assert_eq!(store.workspace().await.unwrap().actors.len(), 1);
    drop(store);
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
        workspace_room("aab44ae4-3888-405f-a1e9-6012ccc9628a"),
        "zerolux-aab44ae4-3888-405f-a1e9-6012ccc9628a"
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
    let ticket: Value = via_proxy("/api/livekit/token")
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
        .get(format!("{base}/api/livekit/token"))
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
        ("https://company.example", Some("Bearer x")),
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
    let base = server.url();
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
            .request(reqwest::Method::OPTIONS, format!("{base}/api/workspace"))
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
            "content-type"
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
        let with_credentials = client
            .get(format!("{base}/api/health"))
            .header("host", "company.example")
            .header("origin", origin)
            .header("authorization", "Bearer x")
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
        .request(reqwest::Method::OPTIONS, format!("{base}/api/workspace"))
        .header("origin", "http://evil.localhost")
        .header("access-control-request-method", "POST")
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 403);
    server.shutdown().await.unwrap();
}
