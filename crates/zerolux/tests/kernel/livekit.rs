//! Real `livekit-server`, no model. Skipped when the binary is not installed.
use std::{sync::Arc, time::Duration};

use tokio::sync::{mpsc, watch};
use zerolux::livekit::{LiveKit, LiveKitConfig};

use crate::livekit_support as support;
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
    tokio::time::timeout(Duration::from_secs(60), aspen.recv())
        .await
        .expect("aspen notified")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(60), aspen_second.recv())
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
        tokio::time::timeout(Duration::from_secs(60), link)
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

/// A person who signs out is disconnected at once: the device then asks the kernel for a
/// new token, which only a live sign-in gets. Signed in, the connection stays.
#[tokio::test(flavor = "multi_thread")]
async fn a_person_signed_out_is_disconnected_and_asks_for_a_new_token() {
    if !installed() {
        eprintln!("livekit-server not installed: skipped");
        return;
    }
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let dir = std::env::temp_dir().join(format!("zerolux-livekit-human-{}", std::process::id()));
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
    let signed_in = Arc::new(AtomicBool::new(true));
    let requests = Arc::new(AtomicUsize::new(0));
    let (invalidate, mut heard) = mpsc::channel(1);
    let (stopper, stop) = watch::channel(false);
    let link = {
        let (livekit, signed_in, requests) = (livekit.clone(), signed_in.clone(), requests.clone());
        tokio::spawn(zerolux::agent_link::run(
            move || {
                requests.fetch_add(1, Ordering::SeqCst);
                let ticket = if signed_in.load(Ordering::SeqCst) {
                    livekit.client_token("owner").map(|t| (t.url, t.token))
                } else {
                    Err(anyhow::anyhow!("not signed in"))
                };
                async move { ticket }
            },
            invalidate,
            stop,
        ))
    };
    tokio::time::timeout(Duration::from_secs(15), heard.recv())
        .await
        .expect("joined")
        .unwrap();
    // Signed in, nothing takes the connection away: it joined once and hears every notice.
    let joined = requests.load(Ordering::SeqCst);
    for _ in 0..2 {
        livekit.notify(&event, &["owner".into()]).await.unwrap();
        tokio::time::timeout(Duration::from_secs(60), heard.recv())
            .await
            .expect("notified while signed in")
            .unwrap();
    }
    assert_eq!(requests.load(Ordering::SeqCst), joined);
    // Signed out: disconnected at once; the device asks for a token and gets none.
    signed_in.store(false, Ordering::SeqCst);
    livekit.disconnect_clients("owner").await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        while requests.load(Ordering::SeqCst) == joined {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("the device was disconnected and asked for a new token");
    livekit.notify(&event, &["owner".into()]).await.unwrap();
    assert!(quiet(&mut heard).await, "a signed-out device hears nothing");
    stopper.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(10), link)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    livekit.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}
