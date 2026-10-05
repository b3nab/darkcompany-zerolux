//! Sockets of a LiveKit subscription, counted on the whole process: this test runs alone.
use std::{sync::Arc, time::Duration};

use tokio::sync::{mpsc, watch};
use zerolux::{
    agent_link,
    livekit::{LiveKit, LiveKitConfig},
};

#[path = "support/livekit.rs"]
mod support;
use support::{installed, subscriber};

/// Network sockets held by this process: what a WebRTC peer keeps until its room is closed.
fn sockets() -> usize {
    let listing = std::process::Command::new("lsof")
        .args(["-p", &std::process::id().to_string(), "-n", "-P"])
        .output()
        .expect("lsof");
    String::from_utf8_lossy(&listing.stdout)
        .lines()
        .filter(|line| line.contains(" UDP ") || line.contains(" TCP "))
        .count()
}

#[tokio::test(flavor = "multi_thread")]
async fn stopped_subscriptions_release_their_sockets() {
    if !installed() {
        eprintln!("livekit-server not installed: skipped");
        return;
    }
    let dir = std::env::temp_dir().join(format!("zerolux-livekit-fd-{}", std::process::id()));
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
    let baseline = sockets();

    // Stopped once subscribed: the room is closed and nothing stays open.
    let (_, stop, link) = subscriber(&livekit, "aspen").await;
    assert!(sockets() > baseline, "a joined room holds sockets");
    stop.send_replace(true);
    link.await.unwrap().unwrap();
    assert_eq!(sockets(), baseline);

    // Stopped while still joining: the join completes and the room is closed all the same.
    let (invalidate, _invalidations) = mpsc::channel(1);
    let (stop, stop_rx) = watch::channel(false);
    let tickets = livekit.clone();
    let link = tokio::spawn(agent_link::run(
        move || {
            let ticket = tickets.client_token("aspen").map(|t| (t.url, t.token));
            async move { ticket }
        },
        invalidate,
        stop_rx,
    ));
    tokio::time::sleep(Duration::from_millis(300)).await;
    stop.send_replace(true);
    link.await.unwrap().unwrap();
    assert_eq!(sockets(), baseline);

    livekit.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}
