//! Real `livekit-server`, no model. Skipped when the binary is not installed.
use std::{sync::Arc, time::Duration};

use tokio::sync::{mpsc, watch};
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

/// A person's connection follows their sign-in: it is cut when the sign-in ends (noticed by
/// the sweep, without the device's cooperation) and when they sign out; the device then asks
/// the kernel for a new token, which only a live sign-in gets. The token itself is short.
#[tokio::test(flavor = "multi_thread")]
async fn a_persons_connection_ends_with_their_sign_in() {
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
    let now = zerolux::store::now_ms();
    // The token is good for a minute, as its JWT says.
    let ticket = livekit.human_token("owner", now + 60 * 60 * 1000).unwrap();
    assert!(ticket.expires_at - now <= 60_500);
    let payload = ticket.token.split('.').nth(1).unwrap();
    let payload = base64_decode(payload);
    let claims: serde_json::Value = serde_json::from_slice(&payload).unwrap();
    assert!(claims["exp"].as_i64().unwrap() - now / 1000 <= 61);

    // A device signed in for two more seconds, then a device signed in for an hour.
    let signed_in = Arc::new(AtomicBool::new(true));
    let requests = Arc::new(AtomicUsize::new(0));
    let subscribe = |expires_at: i64| {
        let (livekit, signed_in, requests) = (livekit.clone(), signed_in.clone(), requests.clone());
        let (invalidate, invalidations) = mpsc::channel(1);
        let (stopper, stop) = watch::channel(false);
        let link = tokio::spawn(zerolux::agent_link::run(
            move || {
                requests.fetch_add(1, Ordering::SeqCst);
                let ticket = if signed_in.load(Ordering::SeqCst) {
                    livekit
                        .human_token("owner", expires_at)
                        .map(|t| (t.url, t.token))
                } else {
                    Err(anyhow::anyhow!("not signed in"))
                };
                async move { ticket }
            },
            invalidate,
            stop,
        ));
        (invalidations, stopper, link)
    };
    let (mut short, stop_short, short_link) = subscribe(zerolux::store::now_ms() + 2_000);
    tokio::time::timeout(Duration::from_secs(15), short.recv())
        .await
        .expect("joined")
        .unwrap();
    livekit.notify(&event, &["owner".into()]).await.unwrap();
    tokio::time::timeout(Duration::from_secs(60), short.recv())
        .await
        .expect("notified while signed in")
        .unwrap();
    // Not yet expired: the sweep leaves it.
    livekit.sweep_expired().await.unwrap();
    livekit.notify(&event, &["owner".into()]).await.unwrap();
    tokio::time::timeout(Duration::from_secs(60), short.recv())
        .await
        .expect("still connected")
        .unwrap();
    // Expired: the sweep disconnects it; the device asks for a token and gets none.
    tokio::time::sleep(Duration::from_millis(2_100)).await;
    signed_in.store(false, Ordering::SeqCst);
    let asked = requests.load(Ordering::SeqCst);
    livekit.sweep_expired().await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        while requests.load(Ordering::SeqCst) == asked {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("the device was disconnected and asked for a new token");
    livekit.notify(&event, &["owner".into()]).await.unwrap();
    assert!(quiet(&mut short).await, "the expired sign-in hears nothing");
    stop_short.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(10), short_link)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    // Signed out: the person's devices are disconnected at once, whatever their token said.
    signed_in.store(true, Ordering::SeqCst);
    let (mut long, stop_long, long_link) = subscribe(zerolux::store::now_ms() + 60 * 60 * 1000);
    tokio::time::timeout(Duration::from_secs(15), long.recv())
        .await
        .expect("joined")
        .unwrap();
    signed_in.store(false, Ordering::SeqCst);
    let asked = requests.load(Ordering::SeqCst);
    livekit.disconnect_clients("owner").await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        while requests.load(Ordering::SeqCst) == asked {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("the device was disconnected and asked for a new token");
    livekit.notify(&event, &["owner".into()]).await.unwrap();
    assert!(quiet(&mut long).await, "a signed-out device hears nothing");
    stop_long.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(10), long_link)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    livekit.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}

/// The JWT's payload, base64url as JWTs are.
fn base64_decode(value: &str) -> Vec<u8> {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut bits = 0u32;
    let mut count = 0;
    let mut out = Vec::new();
    for byte in value.bytes().filter(|b| *b != b'=') {
        let index = TABLE.iter().position(|t| *t == byte).unwrap() as u32;
        bits = (bits << 6) | index;
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    out
}

/// A device that keeps its token after signing out can rejoin while that token lasts, and
/// no longer: the sweep disconnects the connection at the token's end, and the kept token
/// no longer joins. Takes two minutes: the token's life plus the leeway the server grants.
#[tokio::test(flavor = "multi_thread")]
async fn a_kept_token_outlives_a_sign_out_by_its_minute_at_most() {
    if !installed() {
        eprintln!("livekit-server not installed: skipped");
        return;
    }
    let dir = std::env::temp_dir().join(format!("zerolux-livekit-kept-{}", std::process::id()));
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
    // The one token the device ever got, for a sign-in good for an hour.
    let kept = livekit
        .human_token("owner", zerolux::store::now_ms() + 60 * 60 * 1000)
        .unwrap();
    let issued = zerolux::store::now_ms();
    let (invalidate, mut invalidations) = mpsc::channel(1);
    let (stopper, stop) = watch::channel(false);
    let link = {
        let (url, token) = (kept.url.clone(), kept.token.clone());
        tokio::spawn(zerolux::agent_link::run(
            move || {
                let ticket = Ok((url.clone(), token.clone()));
                async move { ticket }
            },
            invalidate,
            stop,
        ))
    };
    tokio::time::timeout(Duration::from_secs(15), invalidations.recv())
        .await
        .expect("joined")
        .unwrap();
    // Signed out: kicked, but the kept token rejoins by itself while it is valid.
    livekit.disconnect_clients("owner").await.unwrap();
    tokio::time::timeout(Duration::from_secs(20), invalidations.recv())
        .await
        .expect("rejoined with the kept token")
        .unwrap();
    livekit.notify(&event, &["owner".into()]).await.unwrap();
    tokio::time::timeout(Duration::from_secs(60), invalidations.recv())
        .await
        .expect("still hears notices, for now")
        .unwrap();
    // The token's minute ends: still connected (no sweep yet), but no notice reaches it.
    let elapsed = zerolux::store::now_ms() - issued;
    tokio::time::sleep(Duration::from_millis((61_000 - elapsed).max(0) as u64)).await;
    livekit.notify(&event, &["owner".into()]).await.unwrap();
    assert!(
        quiet(&mut invalidations).await,
        "past its minute, the connection hears nothing even before the sweep"
    );
    // Then the minute of leeway the server grants an expired token: the sweep disconnects
    // it and the kept token joins no more.
    let elapsed = zerolux::store::now_ms() - issued;
    tokio::time::sleep(Duration::from_millis((122_000 - elapsed).max(0) as u64)).await;
    livekit.sweep_expired().await.unwrap();
    tokio::time::sleep(Duration::from_secs(8)).await;
    livekit.notify(&event, &["owner".into()]).await.unwrap();
    assert!(quiet(&mut invalidations).await, "the kept token is spent");
    stopper.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(10), link)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    livekit.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}
