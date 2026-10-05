//! The one LiveKit subscriber shared by the harness adapters. It signals an invalidation after
//! joining the notice room, on every notice and after every reconnection; the consumer re-reads
//! its own inbox. Notice payloads never leave this module and no model work starts here.

use std::time::Duration;

use anyhow::Context;
use livekit::prelude::*;
use serde::Deserialize;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, watch},
};

use crate::livekit::TOPIC;

const RETRY: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
struct Ticket {
    url: String,
    token: String,
}

/// Stays subscribed until `stop` turns true. `ticket` yields a fresh LiveKit URL and token for
/// every connection attempt, so an expired token or a restarted server heals by itself.
pub async fn run<F, Fut>(
    ticket: F,
    invalidate: mpsc::Sender<()>,
    mut stop: watch::Receiver<bool>,
) -> anyhow::Result<()>
where
    F: Fn() -> Fut,
    Fut: Future<Output = anyhow::Result<(String, String)>>,
{
    while !*stop.borrow() {
        // A stop never interrupts the join: a `Room` dropped half-built keeps its sockets, so
        // every connection is awaited (within `CONNECT_TIMEOUT`) and then closed explicitly.
        let joined = async {
            let (url, token) = ticket().await?;
            tokio::time::timeout(
                CONNECT_TIMEOUT,
                Room::connect(&url, &token, RoomOptions::default()),
            )
            .await
            .context("Joining the LiveKit notice room timed out")?
            .context("Join the LiveKit notice room")
        };
        match joined.await {
            Ok((room, mut events)) => {
                // Subscribed first, then invalidate: a notice sent in between is never lost.
                signal(&invalidate);
                let stopped = *stop.borrow()
                    || loop {
                        tokio::select! {
                            event = events.recv() => match event {
                                Some(RoomEvent::DataReceived { topic, .. })
                                    if topic.as_deref() == Some(TOPIC) => signal(&invalidate),
                                Some(RoomEvent::Reconnected) => signal(&invalidate),
                                Some(RoomEvent::Disconnected { .. }) | None => break false,
                                Some(_) => {}
                            },
                            _ = stop.wait_for(|stopped| *stopped) => break true,
                        }
                    };
                // Dropping a `Room` leaves its connection open: always close it explicitly.
                let _ = room.close().await;
                if stopped {
                    break;
                }
            }
            Err(error) => tracing::warn!(%error, "LiveKit subscription failed; retrying"),
        }
        tokio::select! {
            _ = tokio::time::sleep(RETRY) => {}
            _ = stop.wait_for(|stopped| *stopped) => break,
        }
    }
    Ok(())
}

/// A full channel already holds a pending invalidation: coalescing is the intended behavior.
fn signal(invalidate: &mpsc::Sender<()>) {
    let _ = invalidate.try_send(());
}

/// `zerolux agent-link`, the child process form for adapters living outside the kernel.
/// stdin: one line `{"base_url":"...","token":"<bearer>"}`, then EOF asks to stop.
/// stdout: one `{"type":"invalidate"}` line per invalidation. stderr: diagnostics, no secrets.
pub async fn cli() -> anyhow::Result<()> {
    #[derive(Deserialize)]
    struct Init {
        base_url: String,
        token: String,
    }
    let mut stdin = BufReader::new(tokio::io::stdin()).lines();
    let line = stdin
        .next_line()
        .await?
        .context("Expected the init record on stdin")?;
    let init: Init = serde_json::from_str(&line).context("Invalid init record")?;
    let endpoint = format!("{}/api/livekit/token", init.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()?;
    let ticket = || async {
        let ticket: Ticket = client
            .get(&endpoint)
            .bearer_auth(&init.token)
            .send()
            .await
            .context("Contact the kernel")?
            .error_for_status()
            .context("The kernel refused the LiveKit token request")?
            .json()
            .await?;
        Ok((ticket.url, ticket.token))
    };
    let (invalidate, mut invalidations) = mpsc::channel(1);
    let (stopper, stop) = watch::channel(false);
    let output = async {
        let mut stdout = tokio::io::stdout();
        while invalidations.recv().await.is_some() {
            stdout.write_all(b"{\"type\":\"invalidate\"}\n").await?;
            stdout.flush().await?;
        }
        anyhow::Ok(())
    };
    let input = async {
        // Anything after the init record is ignored; only the end of stdin matters.
        while stdin.next_line().await.ok().flatten().is_some() {}
        let _ = stopper.send(true);
    };
    let (result, written, ()) = tokio::join!(run(ticket, invalidate, stop), output, input);
    written?;
    result
}
