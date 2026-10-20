//! Shared helpers for tests against a real `livekit-server`.
use std::{sync::Arc, time::Duration};

use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};
use zerolux::{agent_link, livekit::LiveKit};

pub fn installed() -> bool {
    std::process::Command::new("livekit-server")
        .arg("--version")
        .output()
        .is_ok()
}

pub async fn subscriber(
    livekit: &Arc<LiveKit>,
    actor: &str,
) -> (
    mpsc::Receiver<()>,
    watch::Sender<bool>,
    JoinHandle<anyhow::Result<()>>,
) {
    let (invalidate, mut invalidations) = mpsc::channel(1);
    let (stopper, stop) = watch::channel(false);
    let (livekit, actor) = (livekit.clone(), actor.to_owned());
    let link = tokio::spawn(agent_link::run(
        move || {
            let ticket = livekit.client_token(&actor).map(|t| (t.url, t.token));
            async move { ticket }
        },
        invalidate,
        stop,
    ));
    // The first invalidation means "subscribed".
    if tokio::time::timeout(Duration::from_secs(15), invalidations.recv())
        .await
        .is_err()
    {
        // What the server and the link said, to see why on a system where it fails.
        let log = std::env::temp_dir()
            .join(format!("zerolux-livekit-{}", std::process::id()))
            .join("livekit.log");
        eprintln!(
            "LiveKit log:\n{}",
            std::fs::read_to_string(log).unwrap_or_default()
        );
        if link.is_finished() {
            eprintln!("Link ended: {:?}", link.await);
        }
        panic!("joined: the subscription did not start within 15 s");
    }
    (invalidations, stopper, link)
}
