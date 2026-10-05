//! Real `livekit-server`, no model. Skipped when the binary is not installed.
use std::{sync::Arc, time::Duration};

use tokio::sync::mpsc;
use zerolux::livekit::{LiveKit, LiveKitConfig};

#[path = "support/livekit.rs"]
mod support;
use support::{installed, subscriber};

async fn quiet(invalidations: &mut mpsc::Receiver<()>) -> bool {
    tokio::time::timeout(Duration::from_secs(2), invalidations.recv())
        .await
        .is_err()
}

#[tokio::test(flavor = "multi_thread")]
async fn managed_server_delivers_only_to_the_addressed_actor() {
    if !installed() {
        eprintln!("livekit-server not installed: skipped");
        return;
    }
    let dir = std::env::temp_dir().join(format!("zerolux-livekit-{}", std::process::id()));
    let livekit = Arc::new(
        LiveKit::start(LiveKitConfig {
            url: None,
            api_key: None,
            api_secret: None,
            data_dir: dir.clone(),
        })
        .await
        .unwrap(),
    );
    let event = serde_json::json!({"event_id": "e1", "type": "message.created"});

    // Nobody connected yet: the room does not exist, and that is not a failure.
    livekit.notify(&event, &["aspen".into()]).await.unwrap();

    let (mut aspen, stop_aspen, aspen_link) = subscriber(&livekit, "aspen").await;
    let (mut aspen_second, stop_second, second_link) = subscriber(&livekit, "aspen").await;
    let (mut birch, stop_birch, birch_link) = subscriber(&livekit, "birch").await;

    livekit.notify(&event, &["aspen".into()]).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), aspen.recv())
        .await
        .expect("aspen notified")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), aspen_second.recv())
        .await
        .expect("second connection notified")
        .unwrap();
    assert!(
        quiet(&mut birch).await,
        "birch shares the harness but was not addressed"
    );

    // An actor that is not connected must not turn into a broadcast.
    livekit.notify(&event, &["codex".into()]).await.unwrap();
    assert!(quiet(&mut aspen).await && quiet(&mut birch).await);

    // Stop returns only after the room was closed explicitly, even while idle in the room.
    for (stopper, link) in [
        (stop_aspen, aspen_link),
        (stop_second, second_link),
        (stop_birch, birch_link),
    ] {
        stopper.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), link)
            .await
            .expect("link stops")
            .unwrap()
            .unwrap();
    }
    livekit.shutdown().await.unwrap();
    let log = std::fs::read_to_string(dir.join("livekit.log")).unwrap();
    assert!(!log.is_empty());
    let _ = std::fs::remove_dir_all(dir);
}
