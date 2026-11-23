//! Workspace windows and the tray share one native, receive-only LiveKit peer per signed-in
//! workspace. A webview never allocates ICE sockets to receive kernel notices.
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Manager, WebviewWindow, ipc::Channel};
use tokio::sync::watch;
use zerolux::agent_link::{self, Notice};

// The credential is never logged or sent to another view. A new sign-in cannot inherit a room.
#[derive(Clone, PartialEq, Eq, Hash)]
struct Scope {
    endpoint: tauri::Url,
    credential: Option<String>,
}
type Sink = Channel<serde_json::Value>;
type View = (String, uuid::Uuid);
#[derive(Default)]
struct Group {
    views: HashMap<View, Sink>,
    live: bool,
    stop: Option<watch::Sender<bool>>,
}
#[derive(Clone, Default)]
pub struct Rooms(Arc<Mutex<HashMap<Scope, Group>>>);

impl Rooms {
    fn attach(&self, scope: Scope, view: View, sink: Sink) {
        let mut rooms = self.0.lock().expect("notice rooms");
        let group = rooms.entry(scope.clone()).or_default();
        if group.live {
            let _ = sink.send(serde_json::json!({"type":"live"}));
        }
        group.views.insert(view, sink);
        // A room being closed still owns its peer. If another window arrived, the same
        // worker starts again *after* close completes, never on top of the previous peer.
        if group.stop.is_some() {
            return;
        }
        let (stop, mut stopped) = watch::channel(false);
        group.stop = Some(stop);
        let hub = self.clone();
        tauri::async_runtime::spawn(async move {
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(10))
                .build()
                .expect("HTTP client");
            loop {
                agent_link::listen(
                    || async {
                        let mut req = client.get(scope.endpoint.clone());
                        if let Some(token) = &scope.credential {
                            req = req.bearer_auth(token);
                        }
                        #[derive(Deserialize)]
                        struct Ticket {
                            url: String,
                            token: String,
                        }
                        let ticket: Ticket = req.send().await?.error_for_status()?.json().await?;
                        Ok((ticket.url, ticket.token))
                    },
                    |notice| hub.deliver(&scope, notice),
                    stopped,
                )
                .await;
                let mut rooms = hub.0.lock().expect("notice rooms");
                let Some(group) = rooms.get_mut(&scope) else {
                    return;
                };
                if group.views.is_empty() {
                    rooms.remove(&scope);
                    return;
                }
                let (tx, rx) = watch::channel(false);
                group.stop = Some(tx);
                stopped = rx;
            }
        });
    }
    fn deliver(&self, scope: &Scope, notice: Notice<'_>) {
        let mut rooms = self.0.lock().expect("notice rooms");
        let Some(group) = rooms.get_mut(scope) else {
            return;
        };
        if group.stop.as_ref().is_some_and(|s| *s.borrow()) {
            return;
        }
        match notice {
            Notice::Live => group.live = true,
            Notice::Offline | Notice::Reconnecting => group.live = false,
            Notice::Packet(_) => {}
        }
        // Don't hold the registry while calling into a webview: another window may be
        // closing or mounting on the UI thread at the same time.
        let targets = group.views.clone();
        drop(rooms);
        let data = serde_json::json!(notice);
        for ((label, id), sink) in targets {
            if sink.send(data.clone()).is_err() {
                self.detach(&label, Some(id));
            }
        }
    }
    pub fn detach(&self, label: &str, id: Option<uuid::Uuid>) {
        for group in self.0.lock().expect("notice rooms").values_mut() {
            group
                .views
                .retain(|(window, key), _| window != label || id.is_some_and(|id| id != *key));
            group.stop_if_empty();
        }
    }
}
impl Group {
    fn stop_if_empty(&mut self) {
        if self.views.is_empty() {
            self.live = false;
            if let Some(stop) = &self.stop {
                stop.send_replace(true);
            }
        }
    }
}

// As for the extension UI, the host knows which kernels this packaged page may reach.
// Only the fixed ticket route may receive its bearer, with no redirects.
fn endpoint(kernel: &tauri::Url, bases: impl Iterator<Item = tauri::Url>) -> Option<tauri::Url> {
    if !bases
        .map(|base| base.origin())
        .any(|origin| origin == kernel.origin())
        || !kernel.username().is_empty()
        || kernel.password().is_some()
        || kernel.query().is_some()
        || kernel.fragment().is_some()
    {
        return None;
    }
    let prefix = kernel.path().trim_end_matches('/');
    if !prefix.is_empty()
        && !prefix
            .strip_prefix("/w/")
            .is_some_and(|id| !id.is_empty() && !id.contains('/'))
    {
        return None;
    }
    let mut url = kernel.clone();
    url.set_path(&format!("{prefix}/api/livekit/token"));
    Some(url)
}

#[tauri::command]
pub fn notice_subscribe(
    window: WebviewWindow,
    kernel: tauri::Url,
    credential: Option<String>,
    id: uuid::Uuid,
    sink: Sink,
    rooms: tauri::State<'_, Rooms>,
) -> Result<(), String> {
    let page = window.url().map_err(|e| e.to_string())?;
    let kernels = window.state::<crate::extension_ui::Kernels>();
    let url = if window.label() == crate::tray::PANEL && crate::local::app_page(&page) {
        endpoint(&kernel, kernels.all().into_values())
    } else {
        let base =
            crate::chrome::workspace_profile(window.label(), &page).and_then(|p| kernels.get(p));
        endpoint(&kernel, base.into_iter())
    }
    .ok_or_else(|| "This workspace is not open in this view".to_owned())?;
    rooms.attach(
        Scope {
            endpoint: url,
            credential,
        },
        (window.label().to_owned(), id),
        sink,
    );
    Ok(())
}
#[tauri::command]
pub fn notice_unsubscribe(window: WebviewWindow, id: uuid::Uuid, rooms: tauri::State<'_, Rooms>) {
    rooms.detach(window.label(), Some(id));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::mpsc,
        time::timeout,
    };
    use zerolux::livekit::{LiveKit, LiveKitConfig};

    #[test]
    fn ticket_routes_stay_on_the_registered_kernel() {
        let base = tauri::Url::parse("http://127.0.0.1:4310").unwrap();
        let route = |url: &str| endpoint(&url.parse().unwrap(), std::iter::once(base.clone()));
        assert_eq!(
            route("http://127.0.0.1:4310/w/a").unwrap().path(),
            "/w/a/api/livekit/token"
        );
        for url in [
            "http://elsewhere.invalid/w/a",
            "http://127.0.0.1:4311/w/a",
            "http://127.0.0.1:4310/api/other",
            "http://127.0.0.1:4310/w/a?other=1",
        ] {
            assert!(route(url).is_none());
        }
    }

    fn sink() -> (Sink, mpsc::UnboundedReceiver<Value>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Channel::new(move |body| {
                let _ = tx.send(body.deserialize().unwrap());
                Ok(())
            }),
            rx,
        )
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn windows_and_tray_share_the_real_room_but_not_another_accounts_notices() {
        if std::process::Command::new("livekit-server")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let lk = Arc::new(
            LiveKit::start(LiveKitConfig {
                api_key: None,
                api_secret: None,
                url: None,
                data_dir: dir.path().into(),
            })
            .await
            .unwrap(),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let scope = |actor: &str| Scope {
            endpoint: format!(
                "http://{}/api/livekit/token",
                listener.local_addr().unwrap()
            )
            .parse()
            .unwrap(),
            credential: Some(actor.into()),
        };
        let (alice, bob) = (scope("alice"), scope("bob"));
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (server, n) = (lk.clone(), count.clone());
        let tickets = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = Vec::new();
                while !buf.windows(4).any(|end| end == b"\r\n\r\n") {
                    if socket.read_buf(&mut buf).await.unwrap() == 0 {
                        break;
                    }
                }
                let h = String::from_utf8_lossy(&buf).to_lowercase();
                let actor = if h.contains("authorization: bearer alice\r\n") {
                    "alice"
                } else {
                    assert!(h.contains("authorization: bearer bob\r\n"));
                    "bob"
                };
                n.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let body = serde_json::to_string(&server.client_token(actor).unwrap()).unwrap();
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            }
        });
        let rooms = Rooms::default();
        let (a, mut av) = sink();
        let (b, mut bv) = sink();
        let (t, mut tv) = sink();
        for (scope, view, sink) in [
            (alice.clone(), "window", a),
            (alice.clone(), "tray", t),
            (bob, "other", b),
        ] {
            rooms.attach(scope, (view.into(), uuid::Uuid::new_v4()), sink);
        }
        timeout(Duration::from_secs(45), async {
            for rx in [&mut av, &mut bv, &mut tv] {
                assert_eq!(rx.recv().await.unwrap()["type"], "live");
            }
            assert_eq!(count.load(std::sync::atomic::Ordering::Relaxed), 2);
            let event = json!({"type":"session.changed","event_id":"fixture"});
            lk.notify(&event, &["alice".into()]).await.unwrap();
            for rx in [&mut av, &mut tv] {
                let message = rx.recv().await.unwrap();
                assert_eq!(
                    serde_json::from_str::<Value>(message["data"].as_str().unwrap()).unwrap(),
                    event
                );
            }
            // Drop the actual participant, not a JS mock: both views rejoin together,
            // with one fresh ticket, without duplicating the other workspace's reads.
            lk.disconnect_clients("alice").await.unwrap();
            for rx in [&mut av, &mut tv] {
                let mut down = false;
                loop {
                    let msg = rx.recv().await.unwrap();
                    if msg["type"] == "live" {
                        assert!(down);
                        break;
                    }
                    down |= msg["type"] == "offline" || msg["type"] == "reconnecting";
                }
            }
            assert_eq!(count.load(std::sync::atomic::Ordering::Relaxed), 3);
            rooms.detach("window", None);
            lk.notify(&event, &["alice".into()]).await.unwrap();
            assert_eq!(tv.recv().await.unwrap()["type"], "packet");
            assert!(bv.try_recv().is_err());
            assert!(av.recv().await.is_none());
            rooms.detach("other", None);
            rooms.detach("tray", None);
            while !rooms.0.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        tickets.abort();
        lk.shutdown().await.unwrap();
    }
}
