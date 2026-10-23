#![cfg(unix)]
//! One test, its own process: it points CODEX_HOME at an empty folder, so that no Codex of
//! the computer is asked. A running Claude Code session tells its account's plan.
use serde_json::json;

#[allow(dead_code, unused_imports)]
#[path = "support/claude_owned.rs"]
mod claude_owned;
use claude_owned::*;

#[tokio::test(flavor = "multi_thread")]
async fn a_running_claude_session_tells_its_accounts_plan() {
    let fixture = Fixture::new();
    // SAFETY: this test binary holds one test; nothing else reads the variable concurrently.
    unsafe { std::env::set_var("CODEX_HOME", fixture.dir.path().join("codex")) };
    let kernel = Kernel::start(&fixture, 0).await;
    let started = kernel
        .api(
            "/sessions",
            Some(json!({"harness":"claude-code", "name":"Plan fixture",
                "workspace":fixture.dir.path().join("workspace")})),
        )
        .await;
    let session = started["session"]["id"].as_str().unwrap();
    let plans = kernel.api("/subscriptions?refresh=true", None).await;
    let claude = plans["subscriptions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|plan| plan["provider"] == "claude")
        .unwrap_or_else(|| panic!("no Claude plan in {plans}"));
    assert_eq!(claude["id"], "claude:fixture@example.com");
    assert_eq!(claude["plan"], "max");
    assert_eq!(claude["limits"][0]["kind"], "session");
    assert_eq!(claude["limits"][0]["percent"], 31.0);
    assert_eq!(claude["limits"][1]["kind"], "weekly_all");
    // Stopped, the last reading stays.
    kernel
        .api(&format!("/sessions/{session}/stop"), Some(json!({})))
        .await;
    let plans = kernel.api("/subscriptions?refresh=true", None).await;
    assert!(
        plans["subscriptions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|plan| plan["id"] == "claude:fixture@example.com"),
        "{plans}"
    );
    kernel.shutdown().await;
}
