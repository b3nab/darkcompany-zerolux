#![cfg(unix)]
//! One test, its own process: it points CODEX_HOME at a fixture app-server. A person's ChatGPT
//! plan is read from their Codex, with its windows and earned resets, and a reset is used.
use std::sync::Arc;

use zerolux::{
    chat_runtime::ChatRuntime,
    livekit::{LiveKit, LiveKitConfig},
    model::SetOwnerName,
};

#[path = "support/db.rs"]
mod db;

// The shared fixture offers more than this one test uses.
#[allow(dead_code)]
#[path = "support/codex_runtime.rs"]
mod codex_runtime;
use codex_runtime::Runtime;

fn installed() -> bool {
    std::process::Command::new("livekit-server")
        .arg("--version")
        .output()
        .is_ok()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_chatgpt_plan_is_read_from_codex_and_an_earned_reset_is_used() {
    if !installed() {
        eprintln!("livekit-server not installed: skipped");
        return;
    }
    // Short paths: a Unix socket path is limited to about 100 bytes on macOS.
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let runtime = Runtime::new().await;
    let codex_home = dir.path().join("codex");
    std::fs::create_dir_all(codex_home.join("app-server-control")).unwrap();
    std::os::unix::fs::symlink(
        runtime.endpoint.trim_start_matches("unix://"),
        codex_home.join("app-server-control/app-server-control.sock"),
    )
    .unwrap();
    // SAFETY: this test binary holds one test; nothing else reads the variables concurrently.
    unsafe {
        std::env::set_var("CODEX_HOME", &codex_home);
        std::env::set_var("CLAUDE_CONFIG_DIR", dir.path().join("claude"));
    }
    let database = db::TestDatabase::new(dir.path().join("chat.db")).await;
    let store = database.open().await;
    store
        .set_owner_name(SetOwnerName {
            name: "Owner".into(),
        })
        .await
        .unwrap();
    let owner = store.chat_identity(None).await.unwrap();
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
    let chat = ChatRuntime::start(
        store.clone(),
        livekit.clone(),
        "http://127.0.0.1:9".into(),
        dir.path().join("links"),
    )
    .await
    .unwrap();

    let plans = chat.subscriptions(&owner, true).await.unwrap();
    assert_eq!(plans.len(), 1, "{plans:?}");
    let plan = &plans[0];
    assert_eq!(plan.id, "chatgpt:acct-1");
    assert_eq!(plan.provider, "chatgpt");
    assert_eq!(plan.plan.as_deref(), Some("pro"));
    assert_eq!(plan.account.as_deref(), Some("ines@example.com"));
    assert_eq!(plan.allowed, Some(true));
    assert_eq!(plan.limits.len(), 2);
    assert_eq!(plan.limits[0].percent, 80.0);
    assert_eq!(plan.resets.as_ref().unwrap().available, 1);
    // Without Claude Code running, there is no Claude plan to read.
    assert!(plans.iter().all(|plan| plan.provider != "claude"));

    // A fresh reading is not read again.
    let asked = runtime.count("account/rateLimits/read");
    chat.subscriptions(&owner, false).await.unwrap();
    assert_eq!(runtime.count("account/rateLimits/read"), asked);

    // Using the earned reset empties the window, and there is none left after.
    let outcome = chat
        .reset_subscription(&owner, "chatgpt:acct-1", None)
        .await
        .unwrap();
    assert_eq!(outcome, "reset");
    let plans = chat.subscriptions(&owner, false).await.unwrap();
    assert_eq!(plans[0].limits[0].percent, 0.0);
    assert_eq!(plans[0].resets.as_ref().unwrap().available, 0);
    assert_eq!(
        chat.reset_subscription(&owner, "chatgpt:acct-1", None)
            .await
            .unwrap(),
        "no_credit"
    );
    assert!(
        chat.reset_subscription(&owner, "claude:ines@example.com", None)
            .await
            .is_err()
    );
    // Only a person reads their plans.
    let agent = zerolux::model::ChatIdentity {
        session_id: Some("s".into()),
        ..owner.clone()
    };
    assert!(chat.subscriptions(&agent, false).await.is_err());
    chat.shutdown().await.unwrap();
    livekit.shutdown().await.unwrap();
}
