//! Receive-only LiveKit subscription used by native clients. Harnesses receive invalidations;
//! desktop listeners receive the kernel's own packets. Neither starts model work here.

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

#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum Notice<'a> {
    Live,
    Reconnecting,
    Offline,
    Packet(&'a str),
}

/// Stays subscribed until `stop` turns true. `ticket` yields a fresh LiveKit URL and token for
/// every connection attempt, so an expired token or a restarted server heals by itself.
pub async fn run<F, Fut>(
    ticket: F,
    invalidate: mpsc::Sender<()>,
    stop: watch::Receiver<bool>,
) -> anyhow::Result<()>
where
    F: Fn() -> Fut,
    Fut: Future<Output = anyhow::Result<(String, String)>>,
{
    listen(
        ticket,
        |event| {
            if matches!(event, Notice::Live | Notice::Packet(_)) {
                signal(&invalidate);
            }
        },
        stop,
    )
    .await;
    Ok(())
}

pub async fn listen<F, Fut>(ticket: F, notify: impl Fn(Notice<'_>), mut stop: watch::Receiver<bool>)
where
    F: Fn() -> Fut,
    Fut: Future<Output = anyhow::Result<(String, String)>>,
{
    while !*stop.borrow() {
        // A stop never interrupts the join: a `Room` dropped half-built keeps its sockets, so
        // each join uses the SDK's own timeout and every joined room is closed explicitly.
        let joined = async {
            let (url, token) = ticket().await?;
            // Let the SDK finish or fail its own join; dropping a half-built room on an
            // outer timer can strand its peer. The loop below owns the next attempt.
            let mut options = RoomOptions::default();
            options.auto_subscribe = false;
            options.join_retries = 0;
            options.connect_timeout = CONNECT_TIMEOUT;
            Room::connect(&url, &token, options)
                .await
                .context("Join the LiveKit notice room")
        };
        match joined.await {
            Ok((room, mut events)) => {
                // Subscribed first, then invalidate: a notice sent in between is never lost.
                if !*stop.borrow() {
                    notify(Notice::Live);
                }
                let stopped = *stop.borrow()
                    || loop {
                        tokio::select! {
                            event = events.recv() => match event {
                                Some(RoomEvent::DataReceived { topic, participant: None, payload, .. })
                                    if topic.as_deref() == Some(TOPIC) => {
                                        if let Ok(data) = std::str::from_utf8(&payload) { notify(Notice::Packet(data)); }
                                    },
                                Some(RoomEvent::Reconnecting) => notify(Notice::Reconnecting),
                                Some(RoomEvent::Reconnected) => notify(Notice::Live),
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
            Err(error) => tracing::warn!(
                error = format!("{error:#}"),
                "LiveKit subscription failed; retrying"
            ),
        }
        notify(Notice::Offline);
        tokio::select! {
            _ = tokio::time::sleep(RETRY) => {}
            _ = stop.wait_for(|stopped| *stopped) => break,
        }
    }
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
