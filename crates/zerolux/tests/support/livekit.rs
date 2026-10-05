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
    tokio::time::timeout(Duration::from_secs(15), invalidations.recv())
        .await
        .expect("joined")
        .unwrap();
    (invalidations, stopper, link)
}
