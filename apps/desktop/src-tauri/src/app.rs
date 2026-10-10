use crate::{
    connection,
    local::{self, LocalWorkspace},
    preferences::{self, Choice, LaunchOptions, SavedConnection},
};
use anyhow::{Context, Result};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering},
    },
};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{mpsc, watch};
use zerolux::server::{Server, ServerOptions};

struct Lifecycle {
    stop: watch::Sender<bool>,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    // 0: running/starting, 1: cleanup in progress, 2: safe to exit.
    phase: AtomicU8,
}

#[derive(Clone, serde::Serialize)]
struct StartupView {
    status: String,
    error: Option<String>,
    choosing: bool,
    url: String,
}

struct Selection {
    view: Arc<Mutex<StartupView>>,
    send: mpsc::Sender<Choice>,
}

fn render(window: &tauri::WebviewWindow, view: &StartupView) {
    if window.url().ok().as_ref().is_some_and(local::boot_page) {
        let value = serde_json::to_string(view).expect("serialize startup view");
        let _ = window.eval(format!("window.zeroluxDesktopState?.({value});"));
    }
}

// Host-only configuration: the capability is local-only, and the URL/state checks also
// reject calls from a connected kernel UI. No workspace/domain operations use Tauri IPC.
#[tauri::command]
fn choose_workspace(
    window: tauri::WebviewWindow,
    selection: tauri::State<'_, Selection>,
    choice: Choice,
) -> Result<(), String> {
    if !window.url().ok().as_ref().is_some_and(local::boot_page) {
        return Err("Workspace selection is only available on the desktop startup page".into());
    }
    if let Choice::Existing { url } = &choice {
        connection::kernel_url(url).map_err(|error| error.to_string())?;
    }
    let next = {
        let mut view = selection.view.lock().expect("startup view lock");
        if !view.choosing {
            return Err("The desktop is not selecting a workspace".into());
        }
        selection.send.try_send(choice).map_err(|_| {
            "The desktop is busy or closing; reopen it to choose a workspace".to_string()
        })?;
        view.choosing = false;
        view.error = None;
        view.status = "Opening your workspace…".into();
        view.clone()
    };
    render(&window, &next);
    Ok(())
}

fn open_external(handle: &tauri::AppHandle, url: &tauri::Url) {
    if local::external_link(url)
        && let Err(error) = handle.opener().open_url(url.as_str(), None::<&str>)
    {
        eprintln!("Could not open link in the browser: {error}");
    }
}

async fn open_workspace(
    workspace: &LocalWorkspace,
    choice: Choice,
    saved: Option<&SavedConnection>,
    window: &tauri::WebviewWindow,
    origin: &Mutex<Option<tauri::Url>>,
    stopped: &mut watch::Receiver<bool>,
) -> Result<()> {
    let (url, server, selected) = match choice {
        Choice::Existing { url } => {
            let canonical = connection::kernel_url(&url)?;
            let expected = saved.and_then(|value| value.expected_id(&canonical));
            let verified = connection::verify(canonical.as_str(), expected).await?;
            let selected = SavedConnection::Existing {
                url: verified.url.to_string(),
                workspace_id: verified.id,
            };
            (verified.url, None, selected)
        }
        Choice::Local => {
            // The existing-kernel branch never resolves resources or opens a database/LiveKit.
            let resources = window.app_handle().path().resource_dir().context("Locate packaged desktop resources; launch ZeroLux from its real path, not a symlink")?;
            let resources = local::resource_root(&resources)?;
            let server = Server::start(ServerOptions {
                address: ([127, 0, 0, 1], workspace.port()?).into(),
                expose: None,
                public: None,
                database: workspace.root.join("zerolux.db"),
                web_dir: resources.join("web"),
                livekit: None,
                #[cfg(unix)]
                runner: Some(zerolux::claude_runner::RunnerProgram {
                    entry: resources.join("claude/runner.js"),
                    pi_entry: Some(resources.join("pi/runner.js")),
                    sdk_executable: Some(local::executable("claude")),
                    ..Default::default()
                }),
            })
            .await
            .context("Start the local desktop kernel")?;
            if let Err(error) = workspace.remember_port(server.address().port()) {
                server.shutdown().await?;
                return Err(error);
            }
            let url = server.url().parse().expect("bound kernel URL");
            (url, Some(server), SavedConnection::Local)
        }
    };
    let ready: Result<()> = (|| {
        preferences::save(&workspace.root, &selected)?;
        *origin.lock().expect("origin lock") = Some(url.clone());
        if !*stopped.borrow() {
            window.navigate(url)?;
        }
        Ok(())
    })();
    if let Err(error) = ready {
        if let Some(server) = server {
            server.shutdown().await?;
        }
        return Err(error);
    }
    match server {
        Some(server) => {
            server
                .run_until(async {
                    let _ = stopped.wait_for(|value| *value).await;
                })
                .await
        }
        None => {
            // The desktop owns only its window/connection, never the external kernel lifecycle.
            let _ = stopped.wait_for(|value| *value).await;
            Ok(())
        }
    }
}

pub fn run(launch: LaunchOptions) -> Result<()> {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .invoke_handler(tauri::generate_handler![choose_workspace])
        .setup(move |app| {
            let origin: Arc<Mutex<Option<tauri::Url>>> = Arc::default();
            let view = Arc::new(Mutex::new(StartupView {
                status: "Choose your workspace".into(), error: None, choosing: false,
                url: launch.connect.clone().unwrap_or_else(|| "http://127.0.0.1:4310/".into()),
            }));
            let (send, mut choices) = mpsc::channel(1);
            app.manage(Selection { view: view.clone(), send });
            let allowed = origin.clone();
            let page_view = view.clone();
            let navigation_handle = app.handle().clone();
            let popup_handle = app.handle().clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("desktop.html".into()))
                .title("ZeroLux").inner_size(1280.0, 820.0).min_inner_size(800.0, 560.0)
                .on_navigation(move |url| {
                    let local = local::boot_page(url) || allowed.lock().expect("origin lock").as_ref().is_some_and(|expected| local::same_origin(expected, url));
                    if !local { open_external(&navigation_handle, url); }
                    local
                })
                .on_new_window(move |url, _| { open_external(&popup_handle, &url); tauri::webview::NewWindowResponse::Deny })
                .on_page_load(move |window, _| {
                    let snapshot = page_view.lock().expect("startup view lock").clone();
                    render(&window, &snapshot);
                }).build()?;
            let boot_url = window.url()?;
            let close = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close(); close.app_handle().exit(0);
                }
            });
            let data = match std::env::var_os("ZEROLUX_DESKTOP_DATA_DIR") {
                Some(path) => Ok(PathBuf::from(path)),
                None => app.path().app_data_dir().context("Locate desktop data directory"),
            };
            let (stop, mut stopped) = watch::channel(false);
            let task = tauri::async_runtime::spawn(async move {
                let result: Result<()> = async {
                    // This lock belongs to desktop settings, not the connected kernel's data.
                    let workspace = LocalWorkspace::open(data?)?;
                    let saved = preferences::load(&workspace.root)?;
                    if let Some(SavedConnection::Existing { url, .. }) = &saved
                        && launch.connect.is_none() {
                        view.lock().expect("startup view lock").url = url.clone();
                    }
                    let mut initial = launch.initial(saved.as_ref());
                    loop {
                        if *stopped.borrow() { return Ok(()); }
                        let choice = match initial.take() {
                            Some(choice) => choice,
                            None => {
                                let snapshot = {
                                    let mut value = view.lock().expect("startup view lock");
                                    value.choosing = true;
                                    value.status = "Choose your workspace".into();
                                    value.clone()
                                };
                                render(&window, &snapshot);
                                tokio::select! {
                                    _ = stopped.wait_for(|value| *value) => return Ok(()),
                                    choice = choices.recv() => match choice { Some(choice) => choice, None => return Ok(()) },
                                }
                            }
                        };
                        {
                            let mut value = view.lock().expect("startup view lock");
                            value.choosing = false;
                            value.error = None;
                            value.status = "Opening your workspace…".into();
                            if let Choice::Existing { url } = &choice { value.url = url.clone(); }
                        }
                        let snapshot = view.lock().expect("startup view lock").clone();
                        render(&window, &snapshot);
                        let saved = preferences::load(&workspace.root)?;
                        match open_workspace(&workspace, choice, saved.as_ref(), &window, &origin, &mut stopped).await {
                            Ok(()) => return Ok(()),
                            Err(error) => {
                                let message = format!("{error:#}");
                                eprintln!("{message}");
                                *origin.lock().expect("origin lock") = None;
                                view.lock().expect("startup view lock").error = Some(message);
                                let _ = window.navigate(boot_url.clone());
                                // No automatic fallback, retry, identity replacement or new workspace.
                            }
                        }
                    }
                }.await;
                if let Err(error) = result {
                    let message = format!("{error:#}");
                    eprintln!("{message}");
                    let snapshot = {
                        let mut value = view.lock().expect("startup view lock");
                        value.status = "ZeroLux could not start".into(); value.error = Some(message); value.choosing = false;
                        value.clone()
                    };
                    render(&window, &snapshot);
                }
            });
            app.manage(Lifecycle { stop, task: Mutex::new(Some(task)), phase: AtomicU8::new(0) });
            let signal_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { zerolux::worker::shutdown_signal().await; signal_handle.exit(0); });
            Ok(())
        }).build(tauri::generate_context!())?;
    app.run(|handle, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            let Some(state) = handle.try_state::<Lifecycle>() else {
                return;
            };
            if state.phase.load(Ordering::Acquire) == 2 {
                return;
            }
            api.prevent_exit();
            if state
                .phase
                .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
            {
                return;
            }
            state.stop.send_replace(true);
            let task = state.task.lock().expect("lifecycle lock").take();
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(task) = task {
                    let _ = task.await;
                }
                handle
                    .state::<Lifecycle>()
                    .phase
                    .store(2, Ordering::Release);
                handle.exit(0);
            });
        }
    });
    Ok(())
}
