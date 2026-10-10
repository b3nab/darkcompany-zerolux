#![cfg(unix)]
//! Stop must still win when read-only native inspection is already in flight.
use serde_json::json;
use std::{sync::Arc, time::Duration};
use zerolux::{
    chat::RELINKING,
    codex::CodexDriver,
    harness::Harness,
    model::{HireChatSession, SetOwnerName},
    store::Store,
};

#[allow(dead_code)]
#[path = "support/codex_runtime.rs"]
mod native;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owner_stop_during_native_read_prevents_cold_resume() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("chat.db")).await.unwrap();
    store
        .set_owner_name(SetOwnerName {
            name: "Fixture owner".into(),
        })
        .await
        .unwrap();
    let owner = store.chat_identity(None).await.unwrap();
    let workspace = dir.path().to_string_lossy().into_owned();
    let issued = store
        .hire_chat_session(
            &owner,
            HireChatSession {
                name: "Fixture Codex".into(),
                actor_id: None,
                harness: Harness::Codex,
                native_session_id: native::THREAD.into(),
                title: "Fixture".into(),
                workspace: workspace.clone(),
                native_locator: json!({}),
                resume: false,
            },
        )
        .await
        .unwrap();
    assert!(
        !store
            .stop_chat_session_marked(&owner, &issued.session.id, RELINKING)
            .await
            .unwrap()
    );
    assert!(store.relink_wanted("codex", native::THREAD).await.unwrap());

    let native = native::Runtime::new_in(dir.path()).await;
    let gate = Arc::new(tokio::sync::Notify::new());
    {
        let mut state = native.state.lock().unwrap();
        state.unloaded = true;
        state.paused_read = Some(gate.clone());
    }
    let endpoint = native.endpoint.clone();
    let wanted = store.clone();
    let attempt = tokio::spawn(async move {
        CodexDriver::resume(&endpoint, native::THREAD, &workspace, || async move {
            Ok(wanted.relink_wanted("codex", native::THREAD).await?)
        })
        .await
    });
    native
        .wait(|state| state.requests.iter().any(|r| r["method"] == "thread/read"))
        .await;
    assert_eq!(native.count("thread/resume"), 0);

    // The runtime marked this row RELINKING, then the owner stopped it while the native
    // read was blocked. The real Store transition must cancel the runtime's intent.
    store
        .stop_chat_session(&owner, &issued.session.id)
        .await
        .unwrap();
    assert!(!store.relink_wanted("codex", native::THREAD).await.unwrap());
    gate.notify_one();
    let result = tokio::time::timeout(Duration::from_secs(5), attempt)
        .await
        .unwrap()
        .unwrap();
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("A native session was resumed after the owner stopped its relink"),
    };
    assert!(format!("{error:#}").contains("stopped before"), "{error:#}");
    assert_eq!(native.count("thread/resume"), 0);
    assert_eq!(native.count("thread/queue/add"), 0);
    assert_eq!(native.count("turn/start"), 0);
    assert!(native.state.lock().unwrap().unloaded);
    assert!(
        store
            .revive_chat_session(&owner, "codex", native::THREAD, "fixture retry")
            .await
            .unwrap()
            .is_none()
    );
    let sessions = store.chat_sessions(&owner).await.unwrap();
    assert_eq!(sessions.len(), 1);
    assert!(sessions[0].stopped_at.is_some());
}
