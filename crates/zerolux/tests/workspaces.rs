//! One instance, several workspaces: each with its own people, roles and data, in one
//! shared database.
use zerolux::{model::*, store::Error};

#[path = "support/db.rs"]
mod db;
use db::TestDatabase;

#[tokio::test]
async fn an_instance_makes_workspaces_with_their_owners_and_lists_an_accounts_memberships() {
    let dir = tempfile::tempdir().unwrap();
    let database = TestDatabase::new(dir.path().join("instance.db")).await;
    let instance = database.instance().await;
    // A new database has its instance, and no workspace.
    assert!(instance.workspaces().await.unwrap().is_empty());
    let again = database.instance().await;
    assert_eq!(again.id(), instance.id());
    assert_eq!(again.auth_secret(), instance.auth_secret());
    let alpha = instance
        .create_workspace("ada", "Ada", "Alpha", None)
        .await
        .unwrap();
    let beta = instance
        .create_workspace("ada", "Ada", "Beta", Some(&dir.path().join("beta")))
        .await
        .unwrap();
    instance
        .create_workspace("bea", "Bea", "Gamma", None)
        .await
        .unwrap();
    // A folder is one workspace's; a workspace has a name, and its owner a name of their own.
    assert!(matches!(
        instance
            .create_workspace("ada", "Ada", "Delta", Some(&dir.path().join("beta")))
            .await,
        Err(Error::Conflict)
    ));
    assert!(matches!(
        instance.create_workspace("ada", "Ada", " ", None).await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        instance
            .create_workspace("ada", "Local owner", "Delta", None)
            .await,
        Err(Error::Invalid(_))
    ));
    assert_eq!(instance.workspaces().await.unwrap().len(), 3);
    let memberships = instance.memberships("ada").await.unwrap();
    let ids: Vec<_> = memberships.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, [alpha.id.as_str(), beta.id.as_str()]);
    assert!(memberships.iter().all(|m| m.owner));
    assert!(instance.memberships("nobody").await.unwrap().is_empty());
    // The owner is the account's person there, by role.
    let store = instance.store(&alpha.id);
    let owner = store.actor_for_subject("ada").await.unwrap().unwrap();
    assert_eq!(owner.role.as_deref(), Some("owner"));
    assert_eq!(owner.name, "Ada");
    assert!(
        store
            .is_workspace_owner(&ChatIdentity::person(&owner.id))
            .await
            .unwrap()
    );
    assert!(store.actor_for_subject("bea").await.unwrap().is_none());
    let workspace = store.workspace().await.unwrap();
    assert_eq!(workspace.workspace.id, alpha.id);
    assert!(!workspace.onboarding_required);
    assert_eq!(workspace.actors.len(), 1);
}

fn hire(name: &str) -> HireChatSession {
    HireChatSession {
        name: name.into(),
        actor_id: None,
        harness: zerolux::harness::Harness::ClaudeCode,
        native_session_id: format!("native-{name}"),
        title: format!("{name} session"),
        workspace: "/fixture".into(),
        native_locator: serde_json::json!({"fixture": true}),
        resume: false,
    }
}

/// What one workspace holds is nowhere in another of the same instance, whatever its ID.
#[tokio::test]
async fn sessions_chats_people_and_events_stay_in_their_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let database = TestDatabase::new(dir.path().join("instance.db")).await;
    let instance = database.instance().await;
    let mut stores = Vec::new();
    for name in ["Alpha", "Beta"] {
        let workspace = instance
            .create_workspace("ada", "Ada", name, None)
            .await
            .unwrap();
        stores.push(instance.store(&workspace.id));
    }
    let (alpha, beta) = (&stores[0], &stores[1]);
    let (alpha_owner, beta_owner) = (
        alpha.chat_identity(None).await.unwrap(),
        beta.chat_identity(None).await.unwrap(),
    );
    assert_ne!(alpha_owner.actor_id, beta_owner.actor_id);

    // Alpha's agent, its session, a chat with a message, a request, a schedule, an invitation.
    let issued = alpha
        .hire_chat_session(&alpha_owner, hire("aspen"))
        .await
        .unwrap();
    let agent = issued.actor.clone().unwrap();
    let session = alpha.chat_identity(Some(&issued.token)).await.unwrap();
    alpha
        .set_chat_session_status(
            &session,
            &issued.session.id,
            ChatSessionStatus {
                status: "connected".into(),
                reason: None,
            },
        )
        .await
        .unwrap();
    let chat = alpha
        .create_conversation(
            &alpha_owner,
            CreateConversation {
                kind: "dm".into(),
                title: "Alpha chat".into(),
                members: vec![ConversationMemberInput {
                    actor_id: agent.id.clone(),
                    session_id: Some(issued.session.id.clone()),
                }],
            },
        )
        .await
        .unwrap();
    let sent = alpha
        .send_chat_message(
            &alpha_owner,
            &chat.id,
            SendChatMessage {
                id: uuid::Uuid::new_v4().to_string(),
                text: "Only in Alpha".into(),
                reply_to_delivery_id: None,
            },
        )
        .await
        .unwrap();
    let approval = alpha
        .create_chat_approval(
            &session,
            CreateChatApproval {
                id: uuid::Uuid::new_v4().to_string(),
                delivery_id: None,
                native_request_id: "request".into(),
                kind: "permission".into(),
                summary: "Run a command".into(),
                details: serde_json::json!({}),
            },
        )
        .await
        .unwrap();
    let schedule = alpha
        .create_schedule(
            &alpha_owner,
            &issued.session.id,
            serde_json::from_value(serde_json::json!({"cron": "0 9 * * *", "prompt": "Morning"}))
                .unwrap(),
        )
        .await
        .unwrap();
    let (_, invite) = alpha.create_invite(&alpha_owner).await.unwrap();

    // Beta sees none of it, and its people reach none of it by ID.
    assert!(beta.sessions(&beta_owner).await.unwrap().is_empty());
    assert!(beta.conversations(&beta_owner).await.unwrap().is_empty());
    assert!(beta.chat_approvals(&beta_owner).await.unwrap().is_empty());
    assert!(beta.schedules(&beta_owner, None).await.unwrap().is_empty());
    assert!(beta.invites(&beta_owner).await.unwrap().is_empty());
    assert!(beta.pending_chat_events(100).await.unwrap().is_empty());
    assert!(!alpha.pending_chat_events(100).await.unwrap().is_empty());
    assert_eq!(beta.workspace().await.unwrap().actors.len(), 1);
    assert_eq!(
        beta.everyone().await.unwrap(),
        vec![beta_owner.actor_id.clone().unwrap()]
    );
    assert!(
        beta.chat_session(&beta_owner, &issued.session.id)
            .await
            .is_err()
    );
    assert!(beta.readers(&issued.session.id).await.unwrap().is_empty());
    assert!(
        beta.chat_messages(&beta_owner, &chat.id, 0, 10)
            .await
            .is_err()
    );
    assert!(
        beta.decide_chat_approval(
            &beta_owner,
            &approval.id,
            ApprovalDecision {
                decision: "allow".into(),
                scope: None,
                reason: None,
            },
        )
        .await
        .is_err()
    );
    assert!(
        beta.delete_schedule(&beta_owner, &schedule.id)
            .await
            .is_err()
    );
    assert!(matches!(
        beta.invitation(&invite).await,
        Err(Error::NotFound)
    ));
    // Alpha's identities are nobody in Beta: its owner, its agent's session token.
    assert!(matches!(
        beta.chat_identity(Some(&issued.token)).await,
        Err(Error::Unauthorized)
    ));
    assert!(beta.sessions(&alpha_owner).await.is_err());
    assert!(beta.conversations(&session).await.is_err());
    // Nor can Beta take Alpha's people into its own rows.
    let mut borrowed = hire("aspen");
    borrowed.actor_id = Some(agent.id.clone());
    assert!(matches!(
        beta.hire_chat_session(&beta_owner, borrowed).await,
        Err(Error::Forbidden)
    ));
    assert!(
        beta.create_conversation(
            &beta_owner,
            CreateConversation {
                kind: "dm".into(),
                title: "Borrowed".into(),
                members: vec![ConversationMemberInput {
                    actor_id: agent.id.clone(),
                    session_id: Some(issued.session.id.clone()),
                }],
            },
        )
        .await
        .is_err()
    );
    // The same native session is another session in another workspace.
    let elsewhere = beta
        .hire_chat_session(&beta_owner, hire("aspen"))
        .await
        .unwrap();
    assert_ne!(elsewhere.session.id, issued.session.id);
    assert_eq!(
        alpha
            .chat_session(&alpha_owner, &issued.session.id)
            .await
            .unwrap()
            .id,
        issued.session.id
    );
    // Alpha's data is as it was.
    assert_eq!(alpha.sessions(&alpha_owner).await.unwrap().len(), 1);
    let page = alpha
        .chat_messages(&alpha_owner, &chat.id, 0, 10)
        .await
        .unwrap();
    assert_eq!(page.messages.len(), 1);
    assert_eq!(page.messages[0].id, sent.message.id);
    assert_eq!(alpha.chat_approvals(&alpha_owner).await.unwrap().len(), 1);
    assert_eq!(alpha.schedules(&alpha_owner, None).await.unwrap().len(), 1);
}

/// The same extension in two workspaces of one kernel: installed, set and disabled apart.
#[tokio::test(flavor = "multi_thread")]
async fn each_workspace_has_its_own_extensions() {
    for program in ["livekit-server", "bun"] {
        if std::process::Command::new(program)
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("{program} not installed: skipped");
            return;
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let database = TestDatabase::new(dir.path().join("kernel/zerolux.db")).await;
    let server = zerolux::server::Server::start(zerolux::server::ServerOptions {
        address: "127.0.0.1:0".parse().unwrap(),
        expose: None,
        data_dir: dir.path().join("kernel"),
        database: database.location().clone(),
        web_dir: dir.path().join("web"),
        livekit: Some(zerolux::livekit::LiveKitConfig {
            url: None,
            api_key: None,
            api_secret: None,
            data_dir: dir.path().join("livekit"),
        }),
        public: None,
        runner: None,
        auth: None,
    })
    .await
    .unwrap();
    let handle = server.handle();
    let mut bases = Vec::new();
    for name in ["Alpha", "Beta"] {
        let workspace = handle
            .create_workspace("ada", "Ada", name, None)
            .await
            .unwrap();
        bases.push(handle.workspace_url(&workspace.id));
    }
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let call = |method: reqwest::Method, url: String, body: Option<serde_json::Value>| {
        let client = client.clone();
        async move {
            let mut request = client.request(method, url);
            if let Some(body) = body {
                request = request.json(&body);
            }
            let response = request.send().await.unwrap();
            let status = response.status();
            (
                status,
                response
                    .json::<serde_json::Value>()
                    .await
                    .unwrap_or_default(),
            )
        }
    };
    let notes = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/extensions/notes")
        .to_string_lossy()
        .into_owned();
    let listed = |base: &String| call(reqwest::Method::GET, format!("{base}/api/extensions"), None);
    let (alpha, beta) = (&bases[0], &bases[1]);
    let (status, body) = call(
        reqwest::Method::POST,
        format!("{alpha}/api/extensions/folder"),
        Some(serde_json::json!({"folder": notes})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        listed(alpha).await.1["extensions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(listed(beta).await.1["extensions"], serde_json::json!([]));
    let (status, body) = call(
        reqwest::Method::POST,
        format!("{beta}/api/extensions/folder"),
        Some(serde_json::json!({"folder": notes})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    // A setting of one is not the other's; neither is disabling it.
    let (status, body) = call(
        reqwest::Method::PATCH,
        format!("{alpha}/api/extensions/zerolux.notes/settings"),
        Some(serde_json::json!({"tone": "warm"})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let (status, _) = call(
        reqwest::Method::POST,
        format!("{alpha}/api/extensions/zerolux.notes/disable"),
        None,
    )
    .await;
    assert_eq!(status, 200);
    let tone = |extensions: serde_json::Value| {
        extensions["extensions"][0]["settings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|setting| setting["key"] == "tone")
            .unwrap()["value"]
            .clone()
    };
    let (alpha_now, beta_now) = (listed(alpha).await.1, listed(beta).await.1);
    assert_eq!(tone(alpha_now.clone()), "warm");
    assert_eq!(alpha_now["extensions"][0]["enabled"], false);
    assert_eq!(tone(beta_now.clone()), "plain");
    assert_eq!(beta_now["extensions"][0]["enabled"], true);
    let (status, _) = call(
        reqwest::Method::DELETE,
        format!("{alpha}/api/extensions/zerolux.notes"),
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(listed(alpha).await.1["extensions"], serde_json::json!([]));
    assert_eq!(
        listed(beta).await.1["extensions"].as_array().unwrap().len(),
        1
    );
    server.shutdown().await.unwrap();
}
