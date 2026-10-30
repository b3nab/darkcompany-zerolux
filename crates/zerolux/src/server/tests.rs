use super::*;
use crate::{harness::Harness, model::*};
use serde_json::{Value, json};

fn hosted(server: &Server, id: &str) -> Arc<api::Hosted> {
    server.shared.workspaces.read().unwrap()[id].clone()
}

fn harness_origin(server: &Server, id: &str) -> (String, SocketAddr) {
    let runtime = hosted(server, id).runtime.clone();
    assert_eq!(runtime.base_url(), server.handle().workspace_url(id));
    let origin = runtime.harness_url().to_owned();
    let url = reqwest::Url::parse(&origin).unwrap();
    // The surviving bridge accepts an origin, but refuses a workspace path.
    assert_eq!(url.scheme(), "http");
    assert_eq!(url.path(), "/");
    assert!(url.query().is_none() && url.fragment().is_none());
    let ip: IpAddr = url.host_str().unwrap().parse().unwrap();
    assert!(ip.is_loopback());
    let address = SocketAddr::new(ip, url.port().unwrap());
    (origin, address)
}

async fn session(workspace: &api::Hosted) -> IssuedChatSession {
    // A fake remote owner keeps the periodic local relinker away from native discovery.
    let store = workspace.store.clone().hosted("fixture-remote".into());
    store.register_host().await.unwrap();
    store
        .set_owner_name(SetOwnerName {
            name: "Owner".into(),
        })
        .await
        .unwrap();
    let owner = store.chat_identity(None).await.unwrap();
    store
        .hire_chat_session(
            &owner,
            HireChatSession {
                name: "Agent".into(),
                actor_id: None,
                harness: Harness::Pi,
                native_session_id: uuid::Uuid::new_v4().to_string(),
                title: "Fixture".into(),
                workspace: "/fixture".into(),
                native_locator: json!({}),
                resume: false,
            },
        )
        .await
        .unwrap()
}

fn options(directory: &std::path::Path) -> ServerOptions {
    ServerOptions {
        address: "127.0.0.1:0".parse().unwrap(),
        expose: None,
        data_dir: directory.join("kernel"),
        database: Location::Sqlite(directory.join("kernel/zerolux.db")),
        web_dir: directory.join("web"),
        // No LiveKit process, native harness, account or model is started.
        livekit: Some(LiveKitConfig {
            url: Some("ws://127.0.0.1:0".into()),
            api_key: Some("fixture".into()),
            api_secret: Some("fixture".into()),
            data_dir: directory.join("livekit"),
        }),
        public: None,
        runner: None,
        auth: None,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn harness_origins_isolate_tokens_and_close_before_the_database_lease_is_released() {
    let directory = tempfile::tempdir().unwrap();
    let server = Server::start(options(directory.path())).await.unwrap();
    let handle = server.handle();
    // A new database starts with no workspace.
    assert!(handle.workspaces().await.unwrap().is_empty());
    let a_id = handle
        .create_workspace("subject", "Owner", "A", Some(&directory.path().join("a")))
        .await
        .unwrap()
        .id;
    let b_id = handle
        .create_workspace("subject", "Owner", "B", None)
        .await
        .unwrap()
        .id;
    // Each workspace keeps its files in its folder; by default in the kernel's data directory.
    assert!(directory.path().join("a/host-id").is_file());
    assert!(
        directory
            .path()
            .join(format!("kernel/workspaces/{b_id}/host-id"))
            .is_file()
    );
    let a_session = session(&hosted(&server, &a_id)).await;
    let b_session = session(&hosted(&server, &b_id)).await;
    let (a_origin, a_address) = harness_origin(&server, &a_id);
    let (b_origin, b_address) = harness_origin(&server, &b_id);
    assert_ne!(a_address, b_address);
    assert_ne!(a_address, server.address());
    assert_ne!(b_address, server.address());
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let inbox = |base: String, token: String| {
        let client = client.clone();
        async move {
            client
                .get(format!("{base}/api/chat/inbox"))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
        }
    };
    for (origin, session, id) in [
        (&a_origin, &a_session, &a_id),
        (&b_origin, &b_session, &b_id),
    ] {
        // Both the actual runtime's origin and the client's /w/id route reach the same data.
        let client_url = handle.workspace_url(id);
        assert_eq!(
            reqwest::Url::parse(&client_url).unwrap().path(),
            format!("/w/{id}")
        );
        for base in [origin.clone(), client_url] {
            let response = inbox(base, session.token.clone()).await;
            assert_eq!(response.status(), 200);
            let body: Value = response.json().await.unwrap();
            assert_eq!(body["workspace"]["id"], *id);
            assert_eq!(body["session"]["id"], session.session.id);
            assert_eq!(
                body["session"]["native_session_id"],
                session.session.native_session_id
            );
            assert!(body["session"]["stopped_at"].is_null());
        }
    }
    assert_eq!(
        inbox(a_origin.clone(), b_session.token.clone())
            .await
            .status(),
        401
    );
    assert_eq!(
        inbox(b_origin.clone(), a_session.token.clone())
            .await
            .status(),
        401
    );
    // There is no implicit first workspace at the kernel's origin.
    assert_eq!(
        inbox(server.url(), a_session.token.clone()).await.status(),
        404
    );
    let refused = client
        .get(format!("{a_origin}/api/chat/inbox"))
        .bearer_auth(&a_session.token)
        .header("origin", "https://elsewhere.invalid")
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 403);

    handle.remove_workspace(&a_id).await.unwrap();
    let occupied = TcpListener::bind(a_address).await.unwrap();
    assert_eq!(
        inbox(handle.workspace_url(&a_id), a_session.token.clone())
            .await
            .status(),
        404
    );
    assert_eq!(inbox(b_origin, b_session.token.clone()).await.status(), 200);
    assert_eq!(handle.workspaces().await.unwrap().len(), 1);
    server.shutdown().await.unwrap();
    let _b_released = TcpListener::bind(b_address).await.unwrap();

    // Started again on the same database, the kernel serves every workspace, each from a new
    // harness origin, with the same data.
    let server = Server::start(options(directory.path())).await.unwrap();
    let handle = server.handle();
    assert_eq!(handle.workspaces().await.unwrap().len(), 2);
    let (new_origin, new_address) = harness_origin(&server, &a_id);
    assert_ne!(new_address, a_address);
    let response = inbox(new_origin, a_session.token.clone()).await;
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.json::<Value>().await.unwrap()["session"]["id"],
        a_session.session.id
    );
    server.shutdown().await.unwrap();
    let _a_released = TcpListener::bind(new_address).await.unwrap();
    drop(occupied);
}
