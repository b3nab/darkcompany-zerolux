//! Relinking after a lost link, with an in-process fake pi whose pairing answers when the
//! test says so. Sets `PI_CODING_AGENT_DIR` for this process: it runs alone in this binary.
//! The fake pi listens on a Unix socket.
#![cfg(unix)]
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

#[path = "support/db.rs"]
mod db;

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
    fake_pi_named(dir, native, "pi-fixture")
}

/// Another live pi on the same session, as a terminal opened on it would be.
fn fake_pi_named(dir: &std::path::Path, native: &str, instance: &str) -> FakePi {
    let socket = dir.join(format!("{instance}.sock"));
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let record = json!({
        "version":1, "instance_id":instance, "endpoint":socket,
        "nonce":"a".repeat(64), "native_session_id":native,
        "workspace":std::fs::canonicalize(dir).unwrap()
    });
    let registry = dir.join("agent/zerolux-links");
    std::fs::create_dir_all(&registry).unwrap();
    let descriptor = registry.join(format!("{instance}.json"));
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
            if predicate(&store.sessions(&owner).await.unwrap()) {
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
    // Every discovery root is the fixture's: relinking scans all harnesses, and the person's
    // Claude Code sessions and Codex app-server must neither be contacted nor slow this down.
    let bin = dir.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let claude = bin.join("claude");
    std::fs::write(&claude, "#!/bin/sh\nprintf '[]\\n'\n").unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let path = std::env::join_paths(std::iter::once(bin).chain(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    )))
    .unwrap();
    // SAFETY: this test binary holds one test; nothing else reads the variables concurrently.
    unsafe {
        std::env::set_var("PI_CODING_AGENT_DIR", dir.path().join("agent"));
        std::env::set_var("CLAUDE_CONFIG_DIR", dir.path().join("claude"));
        std::env::set_var("CODEX_HOME", dir.path().join("codex"));
        std::env::set_var("PATH", path);
    }
    let native = "pi-native";
    let pi = fake_pi(dir.path(), native);
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
    let hire = runtime.attach(&owner, &candidate.id, "cedar", None);
    let (hired, _) = tokio::join!(hire, async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        pi.release.notify_one();
    });
    let (actor, first) = hired.unwrap();
    let actor = actor.unwrap();
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
        sessions.iter().any(|s| {
            s.actor_id.as_ref() == Some(&actor.id)
                && s.stopped_at.is_none()
                && s.status == "attention"
        })
    })
    .await;
    let sessions = store.sessions(&owner).await.unwrap();
    let revived = sessions.iter().find(|s| s.stopped_at.is_none()).unwrap();
    assert_eq!(
        revived.id, first.id,
        "the same session waits for the next relink"
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
            .sessions(&owner)
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
    let sessions = store.sessions(&owner).await.unwrap();
    assert!(
        sessions.iter().all(|s| s.stopped_at.is_some()),
        "an owner's Stop is final: {sessions:?}"
    );
    runtime.reconnect().await.unwrap();
    assert!(
        store
            .sessions(&owner)
            .await
            .unwrap()
            .iter()
            .all(|s| s.stopped_at.is_some())
    );

    // Scenario 3: the owner's Stop lands on the session while its relink is pairing. Their
    // decision is recorded there: no retry either.
    // The owner's Stop reached pi: its link is gone, so it can be hired again.
    pi.paired.store(false, std::sync::atomic::Ordering::SeqCst);
    let relinked = runtime.attach(&owner, &candidate.id, "", Some(actor.id.clone()));
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
        let (old, _) = store
            .stop_chat_session_with_state(&owner, &live.id)
            .await
            .unwrap();
        assert!(old.stopped_at.is_some());
        pi.release.notify_one();
    };
    let (result, _) = tokio::join!(reconnect, stop_old);
    result.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let sessions = store.sessions(&owner).await.unwrap();
    assert!(
        sessions.iter().all(|s| s.stopped_at.is_some()),
        "the owner's Stop on the relinking session is final: {sessions:?}"
    );

    // Scenario 4: the same Stop, but pairing then succeeds: the new link is torn down and pi
    // is told to stop, as if the owner had stopped it.
    pi.paired.store(false, std::sync::atomic::Ordering::SeqCst);
    pi.refuse.store(false, std::sync::atomic::Ordering::SeqCst);
    let hired = runtime.attach(&owner, &candidate.id, "", Some(actor.id.clone()));
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
    let sessions = store.sessions(&owner).await.unwrap();
    assert!(
        sessions.iter().all(|s| s.stopped_at.is_some()),
        "a link paired after the owner's Stop is torn down: {sessions:?}"
    );

    // Scenario 5: a second live pi on the same session (a terminal opened on it): the link
    // is lost, and the relink goes to the newest pi; nothing is refused as a duplicate.
    pi.paired.store(false, std::sync::atomic::Ordering::SeqCst);
    let hired = runtime.attach(&owner, &candidate.id, "", Some(actor.id.clone()));
    let (hired, _) = tokio::join!(hired, async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        pi.release.notify_one();
    });
    let (_, live) = hired.unwrap();
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let terminal = fake_pi_named(dir.path(), native, "pi-terminal");
    store
        .set_chat_session_status(&owner, &live.id, agent(&live.id))
        .await
        .unwrap();
    let before = terminal.pairs.load(std::sync::atomic::Ordering::SeqCst);
    let old_pairs = pi.pairs.load(std::sync::atomic::Ordering::SeqCst);
    let (relinked, _) = tokio::join!(runtime.reconnect(), async {
        tokio::time::timeout(Duration::from_secs(60), async {
            while terminal.pairs.load(std::sync::atomic::Ordering::SeqCst) == before {
                if pi.pairs.load(std::sync::atomic::Ordering::SeqCst) != old_pairs {
                    pi.release.notify_one();
                    panic!("the old pi was paired instead of the newest");
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the newest pi is the one paired");
        terminal.release.notify_one();
    });
    relinked.unwrap();
    tokio::time::timeout(Duration::from_secs(60), async {
        while !terminal.paired.load(std::sync::atomic::Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the terminal pi is paired");
    assert_eq!(
        store
            .sessions(&owner)
            .await
            .unwrap()
            .iter()
            .filter(|s| s.stopped_at.is_none())
            .count(),
        1
    );

    runtime.shutdown().await.unwrap();
    livekit.shutdown().await.unwrap();
}
