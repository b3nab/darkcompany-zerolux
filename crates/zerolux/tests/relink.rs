//! Relinking after a lost link, with an in-process fake pi whose pairing answers when the
//! test says so. Sets `PI_CODING_AGENT_DIR` for this process: it runs alone in this binary.
use std::{os::unix::fs::PermissionsExt, sync::Arc, time::Duration};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::Notify,
};
use zerolux::{
    chat_runtime::ChatRuntime,
    livekit::{LiveKit, LiveKitConfig},
    model::{ChatSessionStatus, SetOwnerName},
    store::Store,
};

fn installed() -> bool {
    std::process::Command::new("livekit-server")
        .arg("--version")
        .output()
        .is_ok()
}

/// A pi control endpoint: `describe` at once; `pair` only after `release`, and then a refusal
/// when `refuse` is set. What the test does between the two is the scenario.
struct FakePi {
    release: Arc<Notify>,
    refuse: Arc<std::sync::atomic::AtomicBool>,
    paired: Arc<std::sync::atomic::AtomicBool>,
    pairs: Arc<std::sync::atomic::AtomicUsize>,
}

fn fake_pi(dir: &std::path::Path, native: &str) -> FakePi {
    let socket = dir.join("pi.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let record = json!({
        "version":1, "instance_id":"pi-fixture", "endpoint":socket,
        "nonce":"a".repeat(64), "native_session_id":native,
        "workspace":std::fs::canonicalize(dir).unwrap()
    });
    let registry = dir.join("agent/zerolux-links");
    std::fs::create_dir_all(&registry).unwrap();
    let descriptor = registry.join("fixture.json");
    std::fs::write(&descriptor, record.to_string()).unwrap();
    std::fs::set_permissions(&descriptor, std::fs::Permissions::from_mode(0o600)).unwrap();
    let fake = FakePi {
        release: Arc::new(Notify::new()),
        refuse: Arc::new(false.into()),
        paired: Arc::new(false.into()),
        pairs: Arc::new(0.into()),
    };
    let (release, refuse, paired, pairs) = (
        fake.release.clone(),
        fake.refuse.clone(),
        fake.paired.clone(),
        fake.pairs.clone(),
    );
    tokio::spawn(async move {
        use std::sync::atomic::Ordering::SeqCst;
        let record = Arc::new(record);
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let (record, release, refuse, paired, pairs) = (
                record.clone(),
                release.clone(),
                refuse.clone(),
                paired.clone(),
                pairs.clone(),
            );
            // Each request on its own: a pending pairing never delays a `describe`.
            tokio::spawn(async move {
                let mut stream = BufReader::new(stream);
                let mut line = String::new();
                stream.read_line(&mut line).await.unwrap();
                let Ok(request) = serde_json::from_str::<Value>(&line) else {
                    return; // The client gave up before asking anything.
                };
                let response = match request["method"].as_str().unwrap() {
                    "describe" => json!({
                        "ok":true, "instance_id":record["instance_id"],
                        "native_session_id":record["native_session_id"],
                        "workspace":record["workspace"], "busy":false, "paired":paired.load(SeqCst), "title":"pi"
                    }),
                    "pair" => {
                        pairs.fetch_add(1, SeqCst);
                        release.notified().await;
                        if refuse.load(SeqCst) {
                            json!({"ok":false})
                        } else {
                            paired.store(true, SeqCst);
                            json!({"ok":true,"link_id":"link"})
                        }
                    }
                    "stop" => {
                        paired.store(false, SeqCst);
                        json!({"ok":true})
                    }
                    "sessions" => json!({"ok":true,"sessions":[]}),
                    _ => json!({"ok":true}),
                };
                let out = stream.get_mut();
                let _ = out.write_all(response.to_string().as_bytes()).await;
                let _ = out.shutdown().await;
            });
        }
    });
    fake
}

async fn wait_for(store: &Store, predicate: impl Fn(&[zerolux::model::ChatSession]) -> bool) {
    let owner = store.chat_identity(None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if predicate(&store.chat_sessions(&owner).await.unwrap()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("expected session state");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_relink_retries_unless_the_owner_stopped_the_session_meanwhile() {
    if !installed() {
        eprintln!("livekit-server not installed: skipped");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    // SAFETY: this test binary holds one test; nothing else reads the variable concurrently.
    unsafe { std::env::set_var("PI_CODING_AGENT_DIR", dir.path().join("agent")) };
    let native = "pi-native";
    let pi = fake_pi(dir.path(), native);
    let store = Store::open(&dir.path().join("chat.db")).await.unwrap();
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
    let runtime = ChatRuntime::start(
        store.clone(),
        livekit.clone(),
        "http://127.0.0.1:1".into(),
        dir.path().join("links"),
    )
    .await
    .unwrap();

    // Hired once: pairing succeeds.
    let discovered = zerolux::sessions::discover_sessions().await;
    let candidate = discovered
        .sessions
        .iter()
        .find(|s| s.harness == zerolux::harness::Harness::Pi)
        .expect("fake pi discovered");
    let hire = runtime.hire(&owner, &candidate.id, "cedar", None);
    let (hired, _) = tokio::join!(hire, async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        pi.release.notify_one();
    });
    let (actor, first) = hired.unwrap();
    let agent = |id: &str| ChatSessionStatus {
        status: "attention".into(),
        reason: Some(format!("lost {id}")),
    };

    // Scenario 1: the link is lost, pairing fails while relinking: retried, not abandoned.
    store
        .set_chat_session_status(&owner, &first.id, agent(&first.id))
        .await
        .unwrap();
    pi.refuse.store(true, std::sync::atomic::Ordering::SeqCst);
    let (relinked, _) = tokio::join!(runtime.reconnect(), async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        pi.release.notify_one();
    });
    relinked.unwrap();
    wait_for(&store, |sessions| {
        sessions
            .iter()
            .any(|s| s.actor_id == actor.id && s.stopped_at.is_none() && s.status == "attention")
    })
    .await;
    let sessions = store.chat_sessions(&owner).await.unwrap();
    let revived = sessions.iter().find(|s| s.stopped_at.is_none()).unwrap();
    assert_ne!(
        revived.id, first.id,
        "the relink's own session is the one revived"
    );
    assert!(
        revived
            .attention_reason
            .as_deref()
            .unwrap()
            .contains("retrying")
    );

    // Scenario 2: the owner presses Stop while pairing is pending: no retry, no revival.
    let before = pi.pairs.load(std::sync::atomic::Ordering::SeqCst);
    let reconnect = runtime.reconnect();
    let stop = async {
        tokio::time::timeout(Duration::from_secs(10), async {
            while pi.pairs.load(std::sync::atomic::Ordering::SeqCst) == before {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("pairing started");
        let pending = store
            .chat_sessions(&owner)
            .await
            .unwrap()
            .into_iter()
            .find(|s| s.stopped_at.is_none())
            .expect("the relink's session");
        store.stop_chat_session(&owner, &pending.id).await.unwrap();
        pi.release.notify_one();
    };
    let (result, _) = tokio::join!(reconnect, stop);
    result.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let sessions = store.chat_sessions(&owner).await.unwrap();
    assert!(
        sessions.iter().all(|s| s.stopped_at.is_some()),
        "an owner's Stop is final: {sessions:?}"
    );
    runtime.reconnect().await.unwrap();
    assert!(
        store
            .chat_sessions(&owner)
            .await
            .unwrap()
            .iter()
            .all(|s| s.stopped_at.is_some())
    );

    // Scenario 3: the owner's Stop lands on the session the runtime had just stopped for the
    // relink, while pairing is pending. Their decision is recorded there: no revival either.
    // The owner's Stop reached pi: its link is gone, so it can be hired again.
    pi.paired.store(false, std::sync::atomic::Ordering::SeqCst);
    let relinked = runtime.hire(&owner, &candidate.id, "", Some(actor.id.clone()));
    let (relinked, _) = tokio::join!(relinked, async {
        pi.refuse.store(false, std::sync::atomic::Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(300)).await;
        pi.release.notify_one();
    });
    let (_, live) = relinked.unwrap();
    store
        .set_chat_session_status(&owner, &live.id, agent(&live.id))
        .await
        .unwrap();
    pi.refuse.store(true, std::sync::atomic::Ordering::SeqCst);
    let before = pi.pairs.load(std::sync::atomic::Ordering::SeqCst);
    let reconnect = runtime.reconnect();
    let stop_old = async {
        tokio::time::timeout(Duration::from_secs(10), async {
            while pi.pairs.load(std::sync::atomic::Ordering::SeqCst) == before {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("pairing started");
        let (old, already) = store
            .stop_chat_session_with_state(&owner, &live.id)
            .await
            .unwrap();
        assert!(already && old.stopped_at.is_some());
        pi.release.notify_one();
    };
    let (result, _) = tokio::join!(reconnect, stop_old);
    result.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let sessions = store.chat_sessions(&owner).await.unwrap();
    assert!(
        sessions.iter().all(|s| s.stopped_at.is_some()),
        "the owner's Stop on the relinking session is final: {sessions:?}"
    );

    // Scenario 4: the same Stop, but pairing then succeeds: the new link is torn down and pi
    // is told to stop, as if the owner had stopped it.
    pi.paired.store(false, std::sync::atomic::Ordering::SeqCst);
    pi.refuse.store(false, std::sync::atomic::Ordering::SeqCst);
    let hired = runtime.hire(&owner, &candidate.id, "", Some(actor.id.clone()));
    let (hired, _) = tokio::join!(hired, async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        pi.release.notify_one();
    });
    let (_, live) = hired.unwrap();
    store
        .set_chat_session_status(&owner, &live.id, agent(&live.id))
        .await
        .unwrap();
    let before = pi.pairs.load(std::sync::atomic::Ordering::SeqCst);
    let reconnect = runtime.reconnect();
    let stop_old = async {
        tokio::time::timeout(Duration::from_secs(10), async {
            while pi.pairs.load(std::sync::atomic::Ordering::SeqCst) == before {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("pairing started");
        store.stop_chat_session(&owner, &live.id).await.unwrap();
        pi.release.notify_one();
    };
    let (result, _) = tokio::join!(reconnect, stop_old);
    result.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while pi.paired.load(std::sync::atomic::Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("pi told to stop");
    let sessions = store.chat_sessions(&owner).await.unwrap();
    assert!(
        sessions.iter().all(|s| s.stopped_at.is_some()),
        "a link paired after the owner's Stop is torn down: {sessions:?}"
    );

    runtime.shutdown().await.unwrap();
    livekit.shutdown().await.unwrap();
}
