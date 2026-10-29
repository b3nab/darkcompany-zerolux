use crate::{
    catalog::{AdoptionJournal, Catalog, Managed, NetworkJournal, Profile, Source},
    computer::{LinkView, Links},
    connection,
    local::{self, LocalWorkspace},
    preferences::LaunchOptions,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{mpsc, oneshot, watch};
use zerolux::{
    claude_runner::{RunnerProgram, executable},
    server::{Server, ServerOptions},
};

const MANAGER: &str = "manager";

#[derive(Clone, Default, Serialize)]
pub(crate) struct View {
    revision: u64,
    pub(crate) profiles: Vec<ProfileView>,
    pub(crate) active: Option<String>,
    /// Other workspaces this computer joined, to run their person's sessions here.
    computers: Vec<LinkView>,
    ready: bool,
    busy: bool,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
pub(crate) struct ProfileView {
    #[serde(flatten)]
    pub(crate) profile: Profile,
    running: bool,
    #[serde(rename = "dataDirectory")]
    data_directory: Option<PathBuf>,
    database: Option<PathBuf>,
    network: Option<zerolux::handoff::Network>,
    #[serde(rename = "localUrl")]
    local_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Action {
    List,
    Open {
        id: String,
    },
    Add {
        url: String,
    },
    Create {
        name: String,
    },
    Edit {
        id: String,
        url: String,
    },
    Adopt {
        id: String,
        directory: String,
    },
    Network {
        id: String,
        network: zerolux::handoff::Network,
    },
    Startup {
        id: String,
        enabled: bool,
    },
    Forget {
        id: String,
    },
    /// Joins a workspace as one of its computers, with the code its person made there.
    Join {
        url: String,
        code: String,
        name: String,
    },
    /// Leaves a workspace this computer joined.
    Leave {
        id: String,
    },
    /// Another window of a workspace: the one named, else the one in front or last opened.
    NewWindow {
        #[serde(default)]
        id: Option<String>,
    },
    /// The app was brought back with no window open: its workspace comes back.
    Reopen,
    /// Internal only: package activation is requested by the authenticated updater.
    #[serde(skip)]
    InstallUpdate(Box<crate::updates::Pending>),
}

type Reply = oneshot::Sender<Result<View, String>>;
pub(crate) struct Commands {
    pub(crate) send: mpsc::Sender<(Action, Reply)>,
    pub(crate) view: Arc<Mutex<View>>,
}

// Only the trusted, packaged manager can read or change the connection registry.
#[tauri::command]
async fn workspace_action(
    window: WebviewWindow,
    commands: tauri::State<'_, Commands>,
    action: Action,
) -> Result<View, String> {
    if window.label() != MANAGER || !window.url().ok().as_ref().is_some_and(local::boot_page) {
        return Err(
            "Workspace connections are managed from the desktop's local window only".into(),
        );
    }
    if matches!(action, Action::List) {
        return Ok(commands.view.lock().expect("desktop view lock").clone());
    }
    let (send, receive) = oneshot::channel();
    commands
        .send
        .try_send((action, send))
        .map_err(|_| "The desktop is busy or closing".to_owned())?;
    receive
        .await
        .map_err(|_| "The desktop is closing".to_owned())?
}

#[derive(Serialize)]
struct AdoptionPreview {
    id: String,
    #[serde(flatten)]
    info: zerolux::handoff::Info,
}

async fn adoption_info(profile: &Profile, directory: &Path) -> Result<zerolux::handoff::Info> {
    let url = profile
        .existing_url()
        .context("Only an existing CLI workspace can be adopted")?;
    ensure!(
        profile.app_ui,
        "Open this workspace once before adopting it, to preserve its previous drafts"
    );
    let workspace_id = profile
        .workspace_id
        .as_deref()
        .context("The connection has no verified workspace identity")?;
    let info = zerolux::handoff::describe(directory).await?;
    info.validate(directory, workspace_id)?;
    let expected = connection::kernel_url(url)?;
    let mut addresses = vec![format!("http://{}", info.network.address())];
    if let Some(expose) = info.network.expose {
        addresses.push(format!(
            "http://{}",
            std::net::SocketAddr::new(expose, info.network.port)
        ));
    }
    if let Some(public) = &info.network.public_origin {
        addresses.push(public.clone());
    }
    ensure!(
        addresses
            .iter()
            .any(|address| connection::kernel_url(address).is_ok_and(|url| url == expected)),
        "The chosen kernel does not serve this connection's address"
    );
    connection::verify(url, Some(workspace_id)).await?;
    Ok(info)
}

#[tauri::command]
async fn workspace_adoption_preview(
    window: WebviewWindow,
    commands: tauri::State<'_, Commands>,
    id: String,
    directory: String,
) -> Result<AdoptionPreview, String> {
    if window.label() != MANAGER || !window.url().ok().as_ref().is_some_and(local::boot_page) {
        return Err("Adoption is available only in Manage Workspaces".into());
    }
    let profile = commands
        .view
        .lock()
        .expect("desktop view lock")
        .profiles
        .iter()
        .find(|entry| entry.profile.id == id)
        .map(|entry| entry.profile.clone())
        .ok_or("This connection is no longer saved")?;
    adoption_info(&profile, Path::new(&directory))
        .await
        .map(|info| AdoptionPreview { id, info })
        .map_err(|error| format!("{error:#}"))
}

struct Lifecycle {
    stop: watch::Sender<bool>,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    phase: AtomicU8,
}

struct LocalRuntime {
    url: tauri::Url,
    network: zerolux::handoff::Network,
    stop: watch::Sender<bool>,
    task: tokio::task::JoinHandle<Result<()>>,
}

struct WorkspaceView {
    window: WebviewWindow,
}

fn replace_tracked<T>(
    current: &mut Vec<T>,
    next: Vec<T>,
    show: impl Fn(&T) -> Result<()>,
    close: impl Fn(&T) -> Result<()>,
) -> Result<()> {
    let previous = std::mem::replace(current, next);
    let mut error = None;
    for view in current.iter() {
        if let Err(failed) = show(view) {
            error.get_or_insert(failed);
        }
    }
    if error.is_some() {
        current.extend(previous);
    } else {
        for view in previous {
            if let Err(failed) = close(&view) {
                error.get_or_insert(failed);
                current.push(view);
            }
        }
    }
    match error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

impl WorkspaceView {
    fn close(&self) -> Result<()> {
        self.window.close().context("Close the workspace view")
    }
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct SavedView {
    #[serde(rename = "canLeave")]
    can_leave: Option<bool>,
    reason: Option<String>,
    drafts: Option<HashMap<String, String>>,
    path: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct UpdateViews {
    version: String,
    views: HashMap<String, Vec<SavedView>>,
}

impl UpdateViews {
    fn merge(
        previous: Option<&Self>,
        version: String,
        live: HashMap<String, Vec<SavedView>>,
    ) -> Self {
        let mut views = previous
            .map(|saved| saved.views.clone())
            .unwrap_or_default();
        views.extend(live);
        Self { version, views }
    }

    fn persist(root: &Path, saved: Option<&Self>) -> Result<()> {
        if let Some(saved) = saved.filter(|saved| !saved.views.is_empty()) {
            crate::preferences::write_json(root, "update-views.json", saved)
        } else {
            match std::fs::remove_file(root.join("update-views.json")) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error.into()),
            }
        }
    }
}

pub(crate) async fn install_update(
    app: &tauri::AppHandle,
    pending: crate::updates::Pending,
) -> Result<(), String> {
    let (send, receive) = oneshot::channel();
    app.state::<Commands>()
        .send
        .try_send((Action::InstallUpdate(Box::new(pending)), send))
        .map_err(|_| "The desktop is busy or closing".to_owned())?;
    receive
        .await
        .map_err(|_| "The desktop is closing".to_owned())??;
    Ok(())
}

struct Host {
    app: tauri::AppHandle,
    root: Arc<LocalWorkspace>,
    catalog: Catalog,
    runtimes: HashMap<String, LocalRuntime>,
    /// Each workspace's open windows, the one last opened at the end.
    windows: HashMap<String, Vec<WorkspaceView>>,
    active: Option<String>,
    generation: u64,
    view: Arc<Mutex<View>>,
    stopped: watch::Receiver<bool>,
    computers: Links,
    startup_retry: HashMap<String, (u32, tokio::time::Instant)>,
}

pub(crate) fn open_external(handle: &tauri::AppHandle, url: &tauri::Url) {
    if local::external_link(url)
        && let Err(error) = handle.opener().open_url(url.as_str(), None::<&str>)
    {
        eprintln!("Could not open link in the browser: {error}");
    }
}

// A web address a workspace's view asks for opens in the system browser, never in the app.
#[tauri::command]
fn open_link(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let url = tauri::Url::parse(&url).map_err(|error| error.to_string())?;
    if !local::external_link(&url) {
        return Err("Only web addresses open outside the app".into());
    }
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}

/// A folder of this computer, chosen by its person in macOS's own panel, attached to the window
/// that asks; none when they cancel. Only a path comes back: the folder is read by the kernel.
#[tauri::command]
async fn choose_folder(
    app: tauri::AppHandle,
    window: tauri::Window,
    start: Option<String>,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        use block2::RcBlock;
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSModalResponseCancel, NSModalResponseOK, NSOpenPanel, NSWindow};
        use objc2_foundation::{NSString, NSURL};
        use std::cell::RefCell;

        let start = start.filter(|start| Path::new(start).is_dir());
        let (send, receive) = oneshot::channel();
        app.run_on_main_thread(move || {
            let parent = match window.ns_window() {
                Ok(parent) => parent,
                Err(error) => {
                    let _ = send.send(Err(error.to_string()));
                    return;
                }
            };
            let panel = NSOpenPanel::openPanel(MainThreadMarker::new().expect("Tauri main thread"));
            panel.setCanChooseDirectories(true);
            panel.setCanChooseFiles(false);
            panel.setAllowsMultipleSelection(false);
            panel.setShowsHiddenFiles(true);
            if let Some(start) = start {
                panel.setDirectoryURL(Some(&NSURL::fileURLWithPath_isDirectory(
                    &NSString::from_str(&start),
                    true,
                )));
            }
            let selected = panel.clone();
            let send = RefCell::new(Some(send));
            let complete = RcBlock::new(move |response| {
                let result = if response == NSModalResponseOK {
                    selected
                        .URL()
                        .and_then(|url| url.path())
                        .map(|path| Some(path.to_string()))
                        .ok_or_else(|| "The selected folder has no local path".to_owned())
                } else if response == NSModalResponseCancel {
                    Ok(None)
                } else {
                    Err("The folder chooser could not open".to_owned())
                };
                if let Some(send) = send.borrow_mut().take() {
                    let _ = send.send(result);
                }
            });
            // Tauri owns this NSWindow; AppKit is called only on its main thread.
            panel.beginSheetModalForWindow_completionHandler(
                unsafe { &*parent.cast::<NSWindow>() },
                &complete,
            );
        })
        .map_err(|error| error.to_string())?;
        receive.await.map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_dialog::DialogExt;
        let mut panel = app.dialog().file().set_parent(&window);
        if let Some(start) = start.filter(|start| std::path::Path::new(start).is_dir()) {
            panel = panel.set_directory(start);
        }
        panel
            .blocking_pick_folder()
            .map(|chosen| {
                chosen
                    .into_path()
                    .map(|path| path.to_string_lossy().into_owned())
                    .map_err(|error| error.to_string())
            })
            .transpose()
    }
}

fn manager_request(url: &tauri::Url) -> bool {
    url.scheme() == "zerolux"
        && url.host_str() == Some("workspaces")
        && matches!(url.path(), "" | "/")
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

/// The workspace a window shows, from its label `workspace-<profile>-<generation>`.
fn profile_of(label: &str) -> Option<&str> {
    label
        .strip_prefix("workspace-")?
        .rsplit_once('-')
        .map(|(id, _)| id)
}

/// The workspace in front.
pub(crate) fn active_profile<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<String> {
    app.state::<Commands>()
        .view
        .lock()
        .expect("desktop view lock")
        .active
        .clone()
}

/// Which of a workspace's windows came later, from the same label.
pub(crate) fn generation_of(label: &str) -> u64 {
    label
        .rsplit('-')
        .next()
        .and_then(|part| part.parse().ok())
        .unwrap_or(0)
}

/// Asks the desktop for something from its menu or the Dock, without waiting for its answer.
pub(crate) fn ask(app: &tauri::AppHandle, action: Action) {
    let (reply, _) = oneshot::channel();
    let _ = app.state::<Commands>().send.try_send((action, reply));
}

pub(crate) fn show_manager(app: &tauri::AppHandle, profile: Option<&str>) {
    if let Some(window) = app.get_webview_window(MANAGER) {
        let _ = window.show();
        let _ = window.set_focus();
        if let Some(id) = profile {
            let id = serde_json::to_string(id).expect("profile ID");
            let _ = window.eval(format!("window.zeroluxDesktopFocus?.({id})"));
        }
    }
}

fn render(app: &tauri::AppHandle, view: &View) {
    crate::tray::changed(app);
    if let Some(window) = app.get_webview_window(MANAGER)
        && window.url().ok().as_ref().is_some_and(local::boot_page)
    {
        let value = serde_json::to_string(view).expect("desktop view");
        let _ = window.eval(format!("window.zeroluxDesktopState?.({value})"));
    }
}

/// The kernel's files this app carries (web app, sign-in, runners, Bun, LiveKit server),
/// written out once into its data folder; its programs are found there first from then on.
fn carried(data: &Path) -> Result<PathBuf> {
    zerolux::carry::unpack(data)?
        .context("This build carries no kernel files: build the app with `bun run desktop:build`")
}

impl Host {
    fn resources(&self) -> Result<PathBuf> {
        carried(&self.root.root)
    }

    fn snapshot(&self, busy: bool, error: Option<String>) -> View {
        View {
            revision: 0,
            profiles: self
                .catalog
                .profiles
                .iter()
                .map(|profile| ProfileView {
                    profile: profile.clone(),
                    data_directory: profile.directory(&self.root.root),
                    database: profile.database(&self.root.root).ok(),
                    network: self
                        .runtimes
                        .get(&profile.id)
                        .map(|runtime| runtime.network.clone())
                        .or_else(|| profile.network(&self.root.root).ok().flatten()),
                    local_url: self
                        .runtimes
                        .get(&profile.id)
                        .map(|runtime| runtime.url.to_string()),
                    running: self
                        .runtimes
                        .get(&profile.id)
                        .is_some_and(|runtime| !runtime.task.is_finished()),
                })
                .collect(),
            active: self.active.clone(),
            computers: self.computers.views(),
            ready: true,
            busy,
            error,
        }
    }

    fn publish(&self, busy: bool, error: Option<String>) -> View {
        let mut snapshot = self.snapshot(busy, error);
        {
            let mut current = self.view.lock().expect("desktop view lock");
            snapshot.revision = current.revision + 1;
            *current = snapshot.clone();
        }
        render(&self.app, &snapshot);
        snapshot
    }

    fn save(&mut self, catalog: Catalog) -> Result<()> {
        if let Err(error) = catalog.save(&self.root.root) {
            // Atomic rename may have committed even if its following fsync failed.
            if let Ok(observed) = Catalog::load(&self.root.root) {
                self.catalog = observed;
            }
            return Err(error);
        }
        self.catalog = catalog;
        Ok(())
    }

    async fn local_url(&mut self, profile: &Profile) -> Result<tauri::Url> {
        self.local_url_with_lease(profile, None).await
    }

    async fn local_url_with_lease(
        &mut self,
        profile: &Profile,
        lease: Option<zerolux::lease::Lease>,
    ) -> Result<tauri::Url> {
        if let Some(runtime) = self.runtimes.get(&profile.id)
            && !runtime.task.is_finished()
        {
            return Ok(runtime.url.clone());
        }
        if let Some(runtime) = self.runtimes.remove(&profile.id) {
            let _ = runtime.task.await;
        }
        let database = profile.database(&self.root.root)?;
        let directory = profile
            .directory(&self.root.root)
            .context("This is not an app-managed workspace")?;
        let workspace = if directory == self.root.root {
            self.root.clone()
        } else {
            Arc::new(LocalWorkspace::open(directory)?)
        };
        let resources = self.resources()?;
        let network = profile
            .network(&self.root.root)?
            .context("This workspace has no local network settings")?;
        if let Some(managed) = &profile.managed {
            ensure!(
                std::fs::read_to_string(workspace.root.join("host-id"))?.trim() == managed.host_id,
                "This workspace's host identity changed; its data was not opened"
            );
        }
        let livekit = match std::fs::read(
            self.root.root.join(format!("runtime-{}.json", profile.id)),
        ) {
            Ok(bytes) => Some(
                serde_json::from_slice::<zerolux::livekit::LiveKitConfig>(&bytes)
                    .context("Read this workspace's private service settings")?,
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ensure!(
                    !profile
                        .managed
                        .as_ref()
                        .is_some_and(|managed| managed.private_services),
                    "This adopted workspace's private service settings are missing; its services were not replaced"
                );
                None
            }
            Err(error) => return Err(error.into()),
        };
        let options = ServerOptions {
            address: network.address(),
            expose: network.expose,
            public: network
                .public_origin
                .as_ref()
                .map(|origin| {
                    zerolux::api::PublicOrigin::new(origin, network.public_livekit_url.clone())
                })
                .transpose()?,
            data_dir: workspace.root.clone(),
            database: zerolux::db::Location::Sqlite(database),
            initial_workspace_name: (profile.workspace_id.is_none()
                && matches!(profile.source, Source::Local { legacy: false }))
            .then(|| profile.name.clone()),
            web_dir: resources.join("web"),
            livekit,
            runner: Some(RunnerProgram::bundled(&resources)),
            auth: Some(zerolux::auth::AuthEntry {
                bun: executable("bun"),
                entry: resources.join("auth/server.js"),
            }),
        };
        #[cfg(target_os = "macos")]
        let activity = crate::activity::LocalKernel::new();
        let server = match lease {
            Some(lease) => Server::start_with_lease(options, lease).await,
            None => Server::start(options).await,
        }
        .context("Start this workspace's local kernel")?;
        if profile.managed.is_none()
            && let Err(error) = workspace.remember_port(server.address().port())
        {
            server.shutdown().await?;
            return Err(error);
        }
        let url: tauri::Url = server.url().parse().expect("bound kernel URL");
        let network = zerolux::handoff::Network {
            port: server.address().port(),
            ..network
        };
        let (stop, mut stopped) = watch::channel(false);
        let task = tokio::spawn(async move {
            let _workspace = workspace;
            #[cfg(target_os = "macos")]
            let _activity = activity;
            server
                .run_until(async {
                    let _ = stopped.wait_for(|stopped| *stopped).await;
                })
                .await
        });
        self.runtimes.insert(
            profile.id.clone(),
            LocalRuntime {
                url: url.clone(),
                network,
                stop,
                task,
            },
        );
        Ok(url)
    }

    /// Where a workspace's kernel answers: its address, or its local kernel, started if need be.
    async fn kernel_url(&mut self, profile: &Profile) -> Result<tauri::Url> {
        match &profile.source {
            Source::Existing { url } => connection::kernel_url(url),
            Source::Local { .. } => self.local_url(profile).await,
        }
    }

    /// Forgets the windows their person closed.
    fn prune(&mut self) {
        let open = self.app.webview_windows();
        for views in self.windows.values_mut() {
            views.retain(|view| open.contains_key(view.window.label()));
        }
        self.windows.retain(|_, views| !views.is_empty());
    }

    async fn open(&mut self, id: &str) -> Result<()> {
        self.prune();
        let mut profile = self.catalog.profile(id)?.clone();
        let url = self.kernel_url(&profile).await?;
        let verified = connection::verify(url.as_str(), profile.workspace_id.as_deref()).await?;
        profile.observe(&verified)?;
        ensure!(!*self.stopped.borrow(), "The desktop is closing");
        for view in self.windows.get(id).into_iter().flatten() {
            view.window.set_title(&profile.name)?;
        }
        if !self.windows.contains_key(id) {
            self.restore_profile_views(&profile, &verified.url).await?;
        }
        if !self.windows.contains_key(id) {
            let saved = if profile.app_ui {
                None
            } else {
                Some(SavedView {
                    can_leave: Some(true),
                    reason: None,
                    drafts: Some(self.legacy_drafts(&profile, &verified.url).await?),
                    path: None,
                })
            };
            let window = self
                .build_view(&profile, &verified.url, saved.as_ref())
                .await?;
            self.windows.insert(id.to_owned(), vec![window]);
        }
        profile.app_ui = true;
        let mut catalog = self.catalog.clone();
        *catalog.profile_mut(id)? = profile;
        catalog.selected = Some(id.to_owned());
        self.save(catalog)?;
        self.activate(id)
    }

    /// A workspace's latest window comes forward; other workspaces' windows stay as they are,
    /// side by side as in VS Code.
    fn activate(&mut self, id: &str) -> Result<()> {
        self.active = Some(id.to_owned());
        if let Some(view) = self.windows.get(id).and_then(|views| views.last()) {
            view.window.show()?;
            view.window.unminimize()?;
            view.window.set_focus()?;
        }
        if let Some(manager) = self.app.get_webview_window(MANAGER) {
            manager.hide()?;
        }
        Ok(())
    }

    /// Another window of a workspace, a little below and to the right of the one before, as
    /// the system's own windows open; the first opens it.
    async fn new_window(&mut self, id: Option<String>) -> Result<()> {
        self.prune();
        let focused = self.app.webview_windows().into_values().find_map(|window| {
            window
                .is_focused()
                .unwrap_or(false)
                .then(|| profile_of(window.label()).map(str::to_owned))
                .flatten()
        });
        let Some(id) = id
            .or(focused)
            .or_else(|| self.active.clone())
            .or_else(|| self.catalog.selected.clone())
        else {
            show_manager(&self.app, None);
            return Ok(());
        };
        if !self.windows.contains_key(&id) {
            return self.open(&id).await;
        }
        let profile = self.catalog.profile(&id)?.clone();
        let url = self.kernel_url(&profile).await?;
        let verified = connection::verify(url.as_str(), profile.workspace_id.as_deref()).await?;
        let view = self.build_view(&profile, &verified.url, None).await?;
        if let Some(position) = self
            .windows
            .get(&id)
            .and_then(|views| views.last())
            .and_then(|last| last.window.outer_position().ok())
        {
            let step = (28.0 * view.window.scale_factor()?) as i32;
            view.window.set_position(tauri::PhysicalPosition::new(
                position.x + step,
                position.y + step,
            ))?;
        }
        self.windows.entry(id.clone()).or_default().push(view);
        self.activate(&id)
    }

    /// Back from the Dock with no window: the workspace last in front, else the one last
    /// opened, else the choice of workspaces.
    async fn reopen(&mut self) -> Result<()> {
        self.prune();
        if let Some(id) = self
            .active
            .clone()
            .filter(|id| self.windows.contains_key(id))
            .or_else(|| self.catalog.selected.clone())
        {
            return self.open(&id).await;
        }
        show_manager(&self.app, None);
        Ok(())
    }

    fn browser_store<'a>(
        &self,
        mut builder: WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle>,
        profile: &Profile,
        legacy: bool,
    ) -> Result<WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle>> {
        if legacy && profile.legacy_browser {
            return Ok(builder);
        }
        let id = uuid::Uuid::parse_str(&profile.id)?;
        #[cfg(target_os = "macos")]
        {
            builder = builder.data_store_identifier(*id.as_bytes());
        }
        #[cfg(not(target_os = "macos"))]
        {
            let directory = self.root.root.join("webviews").join(id.to_string());
            std::fs::create_dir_all(&directory)?;
            builder = builder.data_directory(directory);
        }
        Ok(builder)
    }

    async fn legacy_drafts(
        &mut self,
        profile: &Profile,
        url: &tauri::Url,
    ) -> Result<HashMap<String, String>> {
        self.generation += 1;
        let endpoint = url.join("api/health")?;
        let expected = endpoint.clone();
        let (loaded, ready) = oneshot::channel();
        let loaded = Mutex::new(Some(loaded));
        // A JSON endpoint, not the remote app: import only this origin's drafts, with no
        // remote native capability and without copying cookies or opening any database.
        let builder = WebviewWindowBuilder::new(
            &self.app,
            format!("draft-import-{}-{}", profile.id, self.generation),
            WebviewUrl::External(endpoint),
        )
        .visible(false)
        .disable_javascript()
        .on_navigation(move |next| next == &expected)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_page_load(move |_, page| {
            if page.event() == tauri::webview::PageLoadEvent::Finished
                && let Some(loaded) = loaded.lock().expect("draft import load lock").take()
            {
                let _ = loaded.send(());
            }
        });
        let window = self.browser_store(builder, profile, true)?.build()?;
        let result = async {
            tokio::time::timeout(Duration::from_secs(10), ready)
                .await
                .context("The previous draft store did not load")??;
            ensure!(window.url()? == url.join("api/health")?, "The previous draft origin did not load");
            let (send, receive) = oneshot::channel();
            let send = Mutex::new(Some(send));
            window.eval_with_callback("(() => { try { const drafts=localStorage.getItem('zerolux-drafts'); if (drafts!==null && drafts.length>4194304) return {status:'too-large'}; return {status:'ok',drafts}; } catch { return {status:'unavailable'}; } })()", move |value| {
                if let Some(send) = send.lock().expect("draft import lock").take() {
                    let _ = send.send(value);
                }
            })?;
            let json = tokio::time::timeout(Duration::from_secs(5), receive)
                .await
                .context("The previous draft store did not answer")??;
            ensure!(
                json.len() <= 4 * 1024 * 1024,
                "Previous drafts are too large to import"
            );
            let envelope: serde_json::Value = serde_json::from_str(&json)?;
            ensure!(envelope["status"] == "ok", "The previous drafts could not be read");
            let saved: Option<String> = serde_json::from_value(envelope.get("drafts").context("Missing previous draft snapshot")?.clone())?;
            saved
                .map(|text| serde_json::from_str(&text))
                .transpose()
                .context("Read previous drafts")
                .map(Option::unwrap_or_default)
        }
        .await;
        window.close().context("Close the draft import view")?;
        result
    }

    async fn build_view(
        &mut self,
        profile: &Profile,
        url: &tauri::Url,
        saved: Option<&SavedView>,
    ) -> Result<WorkspaceView> {
        self.generation += 1;
        let label = format!("workspace-{}-{}", profile.id, self.generation);
        self.app
            .state::<crate::extension_ui::Kernels>()
            .set(&profile.id, url);
        let navigation = self.app.clone();
        let popup = self.app.clone();
        let profile_id = profile.id.clone();
        let popup_id = profile.id.clone();
        let context = serde_json::json!({"profileId":profile.id,"workspaceId":profile.workspace_id,"managed":matches!(profile.source, Source::Local { .. }),"kernelUrl":url.as_str(),"platform":std::env::consts::OS});
        let restore = match saved.and_then(|saved| saved.drafts.as_ref()) {
            Some(drafts) => {
                let json = serde_json::to_string(drafts)?;
                let marker = uuid::Uuid::new_v4();
                let migration = !profile.app_ui;
                let route = serde_json::to_string(
                    &saved
                        .and_then(|saved| saved.path.as_deref())
                        .and_then(local::app_route),
                )?;
                format!(
                    "let restore=true; try {{ restore=sessionStorage.getItem('zerolux-restored')!=='{marker}'; }} catch {{}} if (restore) {{ let drafts={json}; if ({migration}) {{ const existing=localStorage.getItem('zerolux-drafts'); if (existing!==null) drafts=JSON.parse(existing); }} if (drafts===null || typeof drafts!=='object' || Array.isArray(drafts) || Object.values(drafts).some(v=>typeof v!=='string')) throw new Error('Invalid saved drafts'); window.zeroluxRestoredDrafts=drafts; window.zeroluxDraftImportSaved=false; try {{ localStorage.setItem('zerolux-drafts',JSON.stringify(drafts)); window.zeroluxDraftImportSaved=true; }} catch {{}} const route={route}; if (route) history.replaceState(null,'',route); try {{ sessionStorage.setItem('zerolux-restored','{marker}'); }} catch {{}} }}"
                )
            }
            None => String::new(),
        };
        let script = format!(
            "if ((location.protocol==='tauri:' && location.host==='localhost') || location.origin==='http://tauri.localhost') {{ Object.defineProperty(window,'zeroluxDesktop',{{value:Object.freeze({context})}}); if (location.pathname==='/index.html') history.replaceState(null,'','/'); {restore} }}"
        );
        let (loaded, ready) = oneshot::channel();
        let loaded = Mutex::new(Some(loaded));
        let mut builder =
            WebviewWindowBuilder::new(&self.app, label, WebviewUrl::App("index.html".into()))
                .title(&profile.name)
                .visible(false)
                .inner_size(1280.0, 820.0)
                .min_inner_size(800.0, 560.0)
                .initialization_script(script)
                // A file the page saves goes to Downloads, by the name it gives.
                .on_download(|_, _| true)
                // Files dropped on the page reach it, as in a browser.
                .disable_drag_drop_handler()
                .on_page_load(move |_, page| {
                    if page.event() == tauri::webview::PageLoadEvent::Finished
                        && local::app_page(page.url())
                        && let Some(loaded) = loaded.lock().expect("workspace load lock").take()
                    {
                        let _ = loaded.send(());
                    }
                })
                .on_navigation(move |next| {
                    if manager_request(next) {
                        show_manager(&navigation, Some(&profile_id));
                        return false;
                    }
                    // Its own pages, and the frames of extensions' pages.
                    let allowed = local::app_page(next) || crate::extension_ui::page(next);
                    if !allowed {
                        open_external(&navigation, next);
                    }
                    allowed
                })
                .on_new_window(move |next, _| {
                    if manager_request(&next) {
                        show_manager(&popup, Some(&popup_id));
                    } else {
                        open_external(&popup, &next);
                    }
                    tauri::webview::NewWindowResponse::Deny
                });
        #[cfg(target_os = "macos")]
        {
            // Centred in the page's 48px header, which keeps its first 92px for them.
            builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(17.0, 26.0));
        }
        #[cfg(not(target_os = "macos"))]
        {
            builder = builder.decorations(false);
        }
        let window = self
            .browser_store(builder, profile, false)?
            .build()
            .context("Open the workspace view")?;
        // Closing a window closes it alone, as in VS Code. The app stays in the tray, its
        // kernels at work, until it is quit.
        let view = WorkspaceView { window };
        let result = async {
            tokio::time::timeout(Duration::from_secs(10), ready)
                .await
                .context("The workspace view did not load")??;
            if !profile.app_ui {
                let (send, receive) = oneshot::channel();
                let send = Mutex::new(Some(send));
                view.window.eval_with_callback(
                    "window.zeroluxDraftImportSaved === true",
                    move |value| {
                        if let Some(send) = send.lock().expect("draft persistence lock").take() {
                            let _ = send.send(value);
                        }
                    },
                )?;
                let value = tokio::time::timeout(Duration::from_secs(5), receive).await??;
                ensure!(value == "true", "Imported drafts could not be saved");
            }
            ensure!(!*self.stopped.borrow(), "The desktop is closing");
            Ok::<(), anyhow::Error>(())
        }
        .await;
        if let Err(error) = result {
            let _ = view.close();
            return Err(error);
        }
        Ok(view)
    }

    /// Each of a workspace's windows, with its drafts and place, once nothing waits to be sent in
    /// any; their input stays frozen meanwhile.
    async fn prepare_views(&self, id: &str) -> Result<Vec<SavedView>> {
        let mut saved = Vec::new();
        for view in self.windows.get(id).into_iter().flatten() {
            saved.push(Self::prepare_view(view).await?);
        }
        Ok(saved)
    }

    async fn prepare_view(view: &WorkspaceView) -> Result<SavedView> {
        let (send, receive) = oneshot::channel();
        let send = Mutex::new(Some(send));
        // Freeze user input in the same JS turn as the synchronous outbox check. Only
        // app-owned drafts move between addresses of this same verified workspace;
        // cookies and unrelated local storage are never copied.
        view.window.eval_with_callback(r#"(() => {
            const state = typeof window.zeroluxWorkspaceState === 'function' ? window.zeroluxWorkspaceState() : {canLeave:null};
            if (state.canLeave !== true) return {canLeave:state.canLeave, reason:state.reason};
            const saved = {...state, path: location.pathname + location.search + location.hash};
            document.body.inert = true;
            return saved;
        })()"#, move |value| {
            if let Some(send) = send.lock().expect("view snapshot lock").take() { let _ = send.send(value); }
        })?;
        let json = tokio::time::timeout(Duration::from_secs(5), receive)
            .await
            .context("The workspace did not answer")??;
        ensure!(
            json.len() <= 4 * 1024 * 1024,
            "The draft snapshot is too large"
        );
        let saved: SavedView =
            serde_json::from_str(&json).context("Read the workspace's navigation state")?;
        ensure!(
            saved.can_leave.is_some(),
            "Update this kernel's web interface first"
        );
        ensure!(
            saved.can_leave == Some(true),
            "{}",
            saved
                .reason
                .as_deref()
                .unwrap_or("This workspace has messages waiting to be sent")
        );
        Ok(saved)
    }

    fn unfreeze(&self, id: &str) {
        for view in self.windows.get(id).into_iter().flatten() {
            let _ = view.window.eval("document.body.inert = false");
        }
    }

    async fn edit(&mut self, id: &str, url: &str) -> Result<()> {
        let mut profile = self.catalog.profile(id)?.clone();
        ensure!(
            matches!(profile.source, Source::Existing { .. }),
            "An app-managed workspace's address cannot be changed"
        );
        let verified = connection::verify(url, profile.workspace_id.as_deref()).await?;
        if profile.existing_url() == Some(verified.url.as_str()) {
            profile.observe(&verified)?;
            let mut catalog = self.catalog.clone();
            *catalog.profile_mut(id)? = profile;
            return self.save(catalog);
        }
        ensure!(
            profile.app_ui,
            "Open this workspace once before changing its address"
        );
        self.prune();
        let prepared = self.prepare_views(id).await;
        let result: Result<()> = async {
            let saved = prepared?;
            profile.observe(&verified)?;
            // Each window again at the new address, where it was, with its drafts.
            let mut replacements = Vec::new();
            for one in &saved {
                match self.build_view(&profile, &verified.url, Some(one)).await {
                    Ok(view) => replacements.push(view),
                    Err(error) => {
                        for view in &replacements {
                            let _ = view.close();
                        }
                        return Err(error);
                    }
                }
            }
            let mut catalog = self.catalog.clone();
            *catalog.profile_mut(id)? = profile;
            if let Err(error) = self.save(catalog) {
                for view in &replacements {
                    let _ = view.close();
                }
                return Err(error);
            }
            if !replacements.is_empty() {
                for view in &replacements {
                    view.window.show()?;
                }
                for previous in self
                    .windows
                    .insert(id.to_owned(), replacements)
                    .into_iter()
                    .flatten()
                {
                    previous.close()?;
                }
                if self.active.as_deref() == Some(id) {
                    self.activate(id)?;
                }
            }
            Ok(())
        }
        .await;
        self.unfreeze(id);
        result
    }

    async fn stop_local(&mut self, id: &str) -> Result<()> {
        if let Some(runtime) = self.runtimes.remove(id) {
            runtime.stop.send_replace(true);
            runtime
                .task
                .await
                .context("Wait for the local kernel to stop")??;
        }
        Ok(())
    }

    async fn replacement_views(
        &mut self,
        profile: &Profile,
        url: &tauri::Url,
        saved: &[SavedView],
    ) -> Result<Vec<WorkspaceView>> {
        let mut views = Vec::new();
        for state in saved {
            match self.build_view(profile, url, Some(state)).await {
                Ok(view) => views.push(view),
                Err(error) => {
                    for view in views {
                        let _ = view.close();
                    }
                    return Err(error);
                }
            }
        }
        Ok(views)
    }

    fn replace_views(&mut self, id: &str, views: Vec<WorkspaceView>) -> Result<()> {
        let current = self.windows.entry(id.to_owned()).or_default();
        // Keep every window tracked even when the OS refuses a show or close. The caller
        // can then unfreeze all surviving views after a committed ownership change.
        replace_tracked(
            current,
            views,
            |view| view.window.show().map_err(Into::into),
            WorkspaceView::close,
        )
        .context("The workspace changed ownership, but some windows could not be replaced")
    }

    async fn adopt(&mut self, id: &str, directory: &Path) -> Result<()> {
        for journal in Catalog::pending_adoptions(&self.root.root)? {
            ensure!(
                !self
                    .runtimes
                    .get(&journal.previous.id)
                    .is_some_and(|runtime| !runtime.task.is_finished()),
                "An ownership transfer is still being reconciled; restart the app before another transfer"
            );
        }
        self.catalog.recover_adoptions(&self.root.root).await?;
        let previous = self.catalog.profile(id)?.clone();
        let info = adoption_info(&previous, directory).await?;
        ensure!(
            !self
                .catalog
                .profiles
                .iter()
                .filter(|profile| profile.id != id)
                .any(|profile| {
                    profile.directory(&self.root.root).as_ref() == Some(&info.directory)
                        || profile.database(&self.root.root).ok().as_ref() == Some(&info.database)
                }),
            "These files are already managed by another saved connection"
        );
        self.resources()?;
        self.prune();
        let result = self.adopt_prepared(&previous, info).await;
        self.unfreeze(id);
        result
    }

    async fn adopt_prepared(
        &mut self,
        previous: &Profile,
        info: zerolux::handoff::Info,
    ) -> Result<()> {
        let saved = self.prepare_views(&previous.id).await?;
        let private_name = format!("runtime-{}.json", previous.id);
        let private_path = self.root.root.join(&private_name);
        let private_before = match std::fs::read(&private_path) {
            Ok(bytes) => Some(serde_json::from_slice::<serde_json::Value>(&bytes)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let journal = AdoptionJournal {
            previous: previous.clone(),
            info: info.clone(),
            private_before,
        };
        journal.save(&self.root.root)?;
        let transfer = zerolux::handoff::Transfer::begin(&info, &previous.id).await?;
        let result: Result<Vec<WorkspaceView>> = async {
            let lease = zerolux::lease::Lease::acquire(&zerolux::db::Location::Sqlite(
                info.database.clone(),
            ))?;
            info.validate(
                &info.directory,
                previous.workspace_id.as_deref().unwrap_or_default(),
            )?;
            let backup = self
                .root
                .root
                .join("backups")
                .join(format!("adoption-{}", uuid::Uuid::new_v4()));
            zerolux::platform::private_dir(&backup)?;
            crate::updates::backup(&info.database, &backup.join("workspace.db")).await?;
            for (source, name) in [
                (info.directory.join("host-id"), "host-id"),
                (info.directory.join("extensions/vault.key"), "vault.key"),
            ] {
                if source.is_file() {
                    let target = backup.join(name);
                    std::fs::copy(source, &target)?;
                    std::fs::OpenOptions::new()
                        .write(true)
                        .open(target)?
                        .sync_all()?;
                }
            }
            crate::preferences::write_json(
                &backup,
                "adoption.json",
                &serde_json::json!({"previous": previous, "kernel": info}),
            )?;
            crate::preferences::write_json(
                &self.root.root,
                &private_name,
                &transfer.configuration.livekit,
            )?;
            let mut profile = previous.adopted(&info)?;
            let url = self.local_url_with_lease(&profile, Some(lease)).await?;
            let verified =
                connection::verify(url.as_str(), profile.workspace_id.as_deref()).await?;
            profile.observe(&verified)?;
            let views = self.replacement_views(&profile, &url, &saved).await?;
            let mut catalog = self.catalog.clone();
            *catalog.profile_mut(&previous.id)? = profile;
            if let Err(error) = self.save(catalog) {
                for view in views {
                    let _ = view.close();
                }
                return Err(error);
            }
            Ok(views)
        }
        .await;
        match result {
            Ok(views) => {
                // After ownership is persisted, a lost IPC acknowledgement is indeterminate,
                // never permission to stop this kernel and let the CLI race it.
                let acknowledgement = transfer.finish(true).await;
                let decision = match zerolux::handoff::Decision::read(&info, &previous.id).await {
                    Ok(decision) => decision,
                    Err(error) => {
                        self.replace_views(&previous.id, views)?;
                        return Err(error.context("Ownership is still being reconciled; the desktop keeps this workspace running"));
                    }
                };
                let committed = decision.committed;
                drop(decision);
                if committed {
                    let recovered = journal.recover(&self.root.root, &mut self.catalog).await;
                    let replaced = self.replace_views(&previous.id, views);
                    recovered?;
                    replaced?;
                    // The durable receipt resolves an ACK lost after the CLI committed.
                    Ok(())
                } else {
                    for view in views {
                        let _ = view.close();
                    }
                    self.stop_local(&previous.id).await?;
                    journal.recover(&self.root.root, &mut self.catalog).await?;
                    if let Some(url) = previous
                        .existing_url()
                        .and_then(|url| connection::kernel_url(url).ok())
                    {
                        self.app
                            .state::<crate::extension_ui::Kernels>()
                            .set(&previous.id, &url);
                    }
                    acknowledgement
                        .context("The transfer was not committed; the CLI retains this workspace")
                }
            }
            Err(error) => {
                let mut recovery = Vec::new();
                if let Err(stopped) = self.stop_local(&previous.id).await {
                    recovery.push(format!("Stop the attempted embedded kernel: {stopped:#}"));
                }
                if let Some(url) = previous
                    .existing_url()
                    .and_then(|url| connection::kernel_url(url).ok())
                {
                    self.app
                        .state::<crate::extension_ui::Kernels>()
                        .set(&previous.id, &url);
                }
                if let Err(cancelled) = transfer.finish(false).await {
                    recovery.push(format!("The CLI was asked to resume: {cancelled:#}"));
                }
                if let Err(restored) = journal.recover(&self.root.root, &mut self.catalog).await {
                    recovery.push(format!("Recover the previous connection: {restored:#}"));
                }
                if recovery.is_empty() {
                    Err(error)
                } else {
                    anyhow::bail!("{error:#}; {}", recovery.join("; "))
                }
            }
        }
    }

    async fn change_network(&mut self, id: &str, network: zerolux::handoff::Network) -> Result<()> {
        self.catalog.recover_networks(&self.root.root)?;
        network.validate()?;
        ensure!(network.port != 0, "Choose a port from 1 to 65535");
        let previous = self.catalog.profile(id)?.clone();
        if previous.network(&self.root.root)?.as_ref() == Some(&network)
            && self
                .runtimes
                .get(id)
                .is_none_or(|runtime| runtime.network == network)
        {
            return Ok(());
        }
        let directory = previous
            .directory(&self.root.root)
            .context("Only an app-managed workspace has local network settings")?;
        let mut profile = previous.clone();
        profile.managed = Some(Managed {
            database: previous.database(&self.root.root)?,
            directory: directory.clone(),
            host_id: std::fs::read_to_string(directory.join("host-id"))?
                .trim()
                .to_owned(),
            network,
            private_services: previous
                .managed
                .as_ref()
                .is_some_and(|managed| managed.private_services),
        });
        self.prune();
        let result: Result<()> = async {
            let saved = self.prepare_views(id).await?;
            let journal = NetworkJournal {
                previous: previous.clone(),
            };
            journal.save(&self.root.root)?;
            if let Err(error) = self.stop_local(id).await {
                let recovered = self.local_url(&previous).await;
                journal.recover(&self.root.root, &mut self.catalog)?;
                recovered?;
                return Err(error);
            }
            let started: Result<Vec<WorkspaceView>> = async {
                let url = self.local_url(&profile).await?;
                connection::verify(url.as_str(), profile.workspace_id.as_deref()).await?;
                let views = self.replacement_views(&profile, &url, &saved).await?;
                let mut catalog = self.catalog.clone();
                *catalog.profile_mut(id)? = profile;
                if let Err(error) = self.save(catalog) {
                    for view in views {
                        let _ = view.close();
                    }
                    return Err(error);
                }
                Ok(views)
            }
            .await;
            match started {
                Ok(views) => {
                    let replaced = self.replace_views(id, views);
                    journal.finish(&self.root.root)?;
                    replaced
                }
                Err(error) => {
                    self.stop_local(id).await?;
                    journal.recover(&self.root.root, &mut self.catalog)?;
                    let url = self
                        .local_url(&previous)
                        .await
                        .context("The previous network settings could not restart")?;
                    self.app
                        .state::<crate::extension_ui::Kernels>()
                        .set(id, &url);
                    Err(error)
                }
            }
        }
        .await;
        self.unfreeze(id);
        result
    }

    async fn perform(&mut self, action: Action) -> Result<()> {
        match action {
            Action::List => {}
            Action::Open { id } => self.open(&id).await?,
            Action::Add { url } => {
                let verified = connection::verify(&url, None).await?;
                let mut catalog = self.catalog.clone();
                let id = catalog.add_existing(&verified)?;
                self.save(catalog)?;
                self.open(&id).await?;
            }
            Action::Create { name } => {
                let mut catalog = self.catalog.clone();
                let id = catalog.add_local(&name)?;
                self.save(catalog)?;
                self.open(&id).await?;
            }
            Action::Edit { id, url } => self.edit(&id, &url).await?,
            Action::Adopt { id, directory } => self.adopt(&id, Path::new(&directory)).await?,
            Action::Network { id, network } => self.change_network(&id, network).await?,
            Action::Startup { id, enabled } => {
                let mut catalog = self.catalog.clone();
                let profile = catalog.profile_mut(&id)?;
                ensure!(
                    matches!(profile.source, Source::Local { .. }),
                    "Only an app-managed workspace can start with the app"
                );
                profile.start_on_launch = enabled;
                self.save(catalog)?;
            }
            Action::Join { url, code, name } => {
                let program = RunnerProgram::bundled(&self.resources()?);
                self.computers.join(&url, &code, &name, program).await?;
            }
            Action::Leave { id } => self.computers.leave(&id).await?,
            Action::NewWindow { id } => self.new_window(id).await?,
            Action::Reopen => self.reopen().await?,
            Action::InstallUpdate(pending) => self.install_update(*pending).await?,
            Action::Forget { id } => {
                ensure!(
                    !self
                        .runtimes
                        .get(&id)
                        .is_some_and(|runtime| !runtime.task.is_finished()),
                    "This local kernel is still running"
                );
                self.prune();
                if let Err(error) = self.prepare_views(&id).await {
                    self.unfreeze(&id);
                    return Err(error);
                }
                let mut catalog = self.catalog.clone();
                catalog.forget(&id)?;
                if let Err(error) = self.save(catalog) {
                    self.unfreeze(&id);
                    return Err(error);
                }
                crate::credentials::forget(&id);
                for view in self.windows.remove(&id).into_iter().flatten() {
                    view.close()?;
                }
                if self.active.as_deref() == Some(&id) {
                    self.active = None;
                }
                show_manager(&self.app, None);
                // Browser storage and local databases are deliberately not deleted here.
            }
        }
        Ok(())
    }

    async fn initial(&mut self, launch: LaunchOptions) -> Result<()> {
        self.catalog.recover_networks(&self.root.root)?;
        let resumed = self.catalog.recover_adoptions(&self.root.root).await?;
        let mut startup_errors: Vec<_> = resumed.into_iter().map(|name| format!("{name}: the previous CLI kept ownership after an interrupted transfer; retry Run with this app")).collect();
        let profiles: Vec<_> = self
            .catalog
            .profiles
            .iter()
            .filter(|profile| profile.start_on_launch)
            .cloned()
            .collect();
        for profile in profiles {
            if let Err(error) = self.local_url(&profile).await {
                self.startup_retry.insert(
                    profile.id.clone(),
                    (1, tokio::time::Instant::now() + Duration::from_secs(2)),
                );
                startup_errors.push(format!("{}: {error:#}", profile.name));
            }
        }
        let restored = self.restore_update_views().await;
        if launch.autostart {
            restored?;
            ensure!(
                startup_errors.is_empty(),
                "Workspace startup: {}",
                startup_errors.join("; ")
            );
            return Ok(());
        }
        let opened = self.initial_workspace(launch).await;
        opened?;
        restored?;
        ensure!(
            startup_errors.is_empty(),
            "Workspace startup: {}",
            startup_errors.join("; ")
        );
        Ok(())
    }

    async fn retry_startups(&mut self) {
        let due: Vec<_> = self
            .startup_retry
            .iter()
            .filter(|(_, (_, when))| *when <= tokio::time::Instant::now())
            .map(|(id, (attempt, _))| (id.clone(), *attempt))
            .collect();
        if due.is_empty() {
            return;
        }
        let mut errors = Vec::new();
        for (id, attempt) in due {
            self.startup_retry.remove(&id);
            let Ok(profile) = self.catalog.profile(&id).cloned() else {
                continue;
            };
            if !profile.start_on_launch {
                continue;
            }
            if let Err(error) = self.local_url(&profile).await {
                if attempt < 6 {
                    self.startup_retry.insert(
                        id,
                        (
                            attempt + 1,
                            tokio::time::Instant::now()
                                + Duration::from_secs(2u64.pow(attempt + 1).min(60)),
                        ),
                    );
                }
                errors.push(format!("{}: {error:#}", profile.name));
            }
        }
        let previous = self.view.lock().expect("desktop view lock").error.clone();
        let error = if errors.is_empty() {
            previous.filter(|error| !error.starts_with("Workspace startup:"))
        } else {
            Some(format!("Workspace startup: {}", errors.join("; ")))
        };
        self.publish(false, error);
    }

    async fn initial_workspace(&mut self, launch: LaunchOptions) -> Result<()> {
        if launch.choose_workspace {
            return Ok(());
        }
        if let Some(url) = launch.connect {
            let canonical = connection::kernel_url(&url)?;
            if let Some(profile) = self
                .catalog
                .profiles
                .iter()
                .find(|profile| profile.existing_url() == Some(canonical.as_str()))
            {
                let id = profile.id.clone();
                return self.open(&id).await;
            }
            return self.perform(Action::Add { url }).await;
        }
        if launch.local {
            if let Some(profile) = self
                .catalog
                .profiles
                .iter()
                .find(|profile| matches!(profile.source, Source::Local { .. }))
            {
                let id = profile.id.clone();
                return self.open(&id).await;
            }
            return self
                .perform(Action::Create {
                    name: "Workspace".into(),
                })
                .await;
        }
        if let Some(id) = self.catalog.selected.clone() {
            self.open(&id).await?;
        }
        Ok(())
    }

    /// Restore every window's drafts and route after an update, including background workspaces.
    async fn restore_update_views(&mut self) -> Result<()> {
        let file = self.root.root.join("update-views.json");
        let saved = match std::fs::read(&file) {
            Ok(bytes) => serde_json::from_slice::<UpdateViews>(&bytes)
                .context("Read the windows saved before the update")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        // A failed installation must never restore an old snapshot over drafts edited later.
        if saved.version != zerolux::build::version() {
            std::fs::remove_file(file)?;
            return Ok(());
        }
        let selected = self.catalog.selected.clone();
        let mut deferred = Vec::new();
        for id in saved.views.keys() {
            if let Err(error) = self.open(id).await {
                deferred.push(format!("{id}: {error:#}"));
            }
        }
        let mut catalog = self.catalog.clone();
        catalog.selected = selected;
        self.save(catalog)?;
        ensure!(
            deferred.is_empty(),
            "Some windows could not reopen; their drafts are kept until you open them: {}",
            deferred.join("; ")
        );
        Ok(())
    }

    /// An offline workspace keeps its snapshots until its next successful open. A successful
    /// profile is removed atomically, so another unavailable profile cannot duplicate its views.
    async fn restore_profile_views(&mut self, profile: &Profile, url: &tauri::Url) -> Result<()> {
        let file = self.root.root.join("update-views.json");
        let mut saved: UpdateViews = match std::fs::read(&file) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        if saved.version != zerolux::build::version() {
            return Ok(());
        }
        let Some(states) = saved.views.remove(&profile.id) else {
            return Ok(());
        };
        if states.is_empty() {
            return UpdateViews::persist(&self.root.root, Some(&saved));
        }
        let mut views = Vec::new();
        let prepared: Result<()> = async {
            for state in states {
                views.push(self.build_view(profile, url, Some(&state)).await?);
            }
            UpdateViews::persist(&self.root.root, Some(&saved))?;
            Ok(())
        }
        .await;
        if let Err(error) = prepared {
            for view in views {
                let _ = view.close();
            }
            return Err(error);
        }
        for view in &views {
            view.window.show()?;
        }
        self.windows.insert(profile.id.clone(), views);
        Ok(())
    }

    async fn install_update(&mut self, pending: crate::updates::Pending) -> Result<()> {
        let databases: Vec<_> = self
            .catalog
            .profiles
            .iter()
            .filter(|profile| matches!(profile.source, Source::Local { .. }))
            .map(|profile| Ok((profile.id.clone(), profile.database(&self.root.root)?)))
            .collect::<Result<_>>()?;
        let databases: Vec<_> = databases
            .into_iter()
            .filter(|(_, path)| path.is_file())
            .collect();
        ensure!(
            databases.is_empty() || pending.schema == zerolux::build::schema(),
            "This update changes the workspace schema; this pre-release cannot install it automatically"
        );
        let previous_views: Option<UpdateViews> =
            match std::fs::read(self.root.root.join("update-views.json")) {
                Ok(bytes) => Some(serde_json::from_slice(&bytes)?),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
            };
        self.app
            .state::<Lifecycle>()
            .phase
            .compare_exchange(0, 3, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| anyhow::anyhow!("The desktop is already closing"))?;
        self.prune();
        let running: Vec<_> = self.runtimes.keys().cloned().collect();
        let mut leases = Vec::new();
        let mut stopped = false;
        let mut computers_stopped = false;
        let result: Result<()> = async {
            let mut saved = HashMap::new();
            for id in self.windows.keys() {
                saved.insert(id.clone(), self.prepare_views(id).await?);
            }
            let checkpoint = UpdateViews::merge(
                previous_views.as_ref(),
                pending.update.version.clone(),
                saved,
            );
            UpdateViews::persist(&self.root.root, Some(&checkpoint))?;
            // Freeze is only a browser-input guard. The snapshot is taken after the kernels
            // have stopped, while their database leases prevent another writer starting.
            for runtime in self.runtimes.values() {
                runtime.stop.send_replace(true);
            }
            stopped = true;
            let mut shutdown_error = None;
            for (_, runtime) in self.runtimes.drain() {
                if let Err(error) = runtime.task.await.unwrap_or_else(|error| Err(error.into())) {
                    shutdown_error.get_or_insert(error);
                }
            }
            if let Some(error) = shutdown_error {
                return Err(error.context("Stop the local kernels before updating"));
            }
            for (_, database) in &databases {
                leases.push(zerolux::lease::Lease::acquire(
                    &zerolux::db::Location::Sqlite(database.clone()),
                )?);
            }
            let directory = self
                .root
                .root
                .join("backups")
                .join(format!("update-{}", uuid::Uuid::new_v4()));
            if !databases.is_empty() {
                std::fs::create_dir_all(&directory)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
                }
                for (id, database) in &databases {
                    crate::updates::backup(database, &directory.join(format!("{id}.db"))).await?;
                }
                crate::preferences::write_json(
                    &directory,
                    "update.json",
                    &serde_json::json!({
                        "from": zerolux::build::info(), "to": pending.update.version,
                        "databases": databases, "schema": pending.schema,
                    }),
                )?;
            }
            // Joined computers stop their links cooperatively, never the remote kernel or
            // native agents. Their carried resources are kept in versioned directories.
            let empty = Links::new(self.root.root.join("computer"));
            std::mem::replace(&mut self.computers, empty)
                .shutdown()
                .await;
            computers_stopped = true;
            let install = pending.clone();
            tauri::async_runtime::spawn_blocking(move || {
                install.update.install(install.bytes.as_slice())
            })
            .await??;
            #[cfg(not(windows))]
            crate::restart::restart(&self.app)?;
            self.app
                .state::<Lifecycle>()
                .phase
                .store(2, Ordering::Release);
            #[cfg(not(windows))]
            {
                self.app.exit(0);
                Ok(())
            }
            #[cfg(windows)]
            self.app.restart()
        }
        .await;
        if result.is_ok() {
            return Ok(());
        }
        // An installer or backup failure leaves the old installation usable. No database
        // restore is attempted: the original database has never been replaced.
        drop(leases);
        let mut recovery = Vec::new();
        if let Err(error) = UpdateViews::persist(&self.root.root, previous_views.as_ref()) {
            recovery.push(format!(
                "The saved update windows could not be recovered: {error}"
            ));
        }
        if stopped {
            for id in running {
                if let Ok(profile) = self.catalog.profile(&id).cloned()
                    && let Err(error) = self.local_url(&profile).await
                {
                    recovery.push(format!("{}: {error:#}", profile.name));
                }
            }
            if computers_stopped && let Ok(resources) = self.resources() {
                self.computers = Links::start(
                    self.root.root.join("computer"),
                    &RunnerProgram::bundled(&resources),
                );
            }
        }
        for id in self.windows.keys() {
            self.unfreeze(id);
        }
        self.app
            .state::<Lifecycle>()
            .phase
            .store(0, Ordering::Release);
        if recovery.is_empty() {
            result
        } else {
            Err(anyhow::anyhow!(
                "{}; some local kernels could not restart: {}",
                result.unwrap_err(),
                recovery.join("; ")
            ))
        }
    }

    async fn shutdown(self) {
        self.computers.shutdown().await;
        for runtime in self.runtimes.values() {
            runtime.stop.send_replace(true);
        }
        for (_, runtime) in self.runtimes {
            if let Err(error) = runtime.task.await.unwrap_or_else(|error| Err(error.into())) {
                eprintln!("Local kernel shutdown: {error:#}");
            }
        }
    }
}

fn supported_platform() -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        // Wry otherwise silently falls back to a shared data store. The bundle declares
        // the same minimum; this also covers development/unbundled executables.
        let output = std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()?;
        let version = String::from_utf8(output.stdout)?;
        let major = version
            .trim()
            .split('.')
            .next()
            .and_then(|part| part.parse::<u32>().ok());
        ensure!(
            output.status.success() && major.is_some_and(|major| major >= 14),
            "ZeroLux desktop requires macOS 14 or later to isolate workspace data"
        );
    }
    Ok(())
}

/// Where the desktop keeps its data: the system's place for the app, or a test's own.
pub(crate) fn data_root(app: &tauri::AppHandle) -> tauri::Result<PathBuf> {
    std::env::var_os("ZEROLUX_DESKTOP_DATA_DIR")
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| app.path().app_data_dir())
}

pub fn run(launch: LaunchOptions) -> Result<()> {
    supported_platform()?;
    let mut context = tauri::generate_context!();
    context.package_info_mut().version = zerolux::build::version().parse()?;
    let wait_for_parent = launch.wait_for_parent;
    let mut builder = tauri::Builder::default().plugin(
        tauri::plugin::Builder::<tauri::Wry>::new("previous-instance")
            .setup(move |app, _| {
                if wait_for_parent {
                    local::wait_for_previous(&data_root(app)?, Duration::from_secs(30))?;
                }
                Ok(())
            })
            .build(),
    );
    // A test's data-root override must never forward to the personal installation.
    if std::env::var_os("ZEROLUX_DESKTOP_DATA_DIR").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !args.iter().any(|arg| arg == "--autostart") && app.try_state::<Commands>().is_some()
            {
                ask(app, Action::Reopen);
            }
        }));
    }
    let app = builder
        .plugin(crate::autostart::plugin())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        // The page's own `Notification` reaches the system's notifications.
        .plugin(tauri_plugin_notification::init())
        // Only `choose_folder` opens it: pages are given no dialog of their own.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(crate::extension_ui::Kernels::default())
        .register_asynchronous_uri_scheme_protocol(
            crate::extension_ui::SCHEME,
            crate::extension_ui::serve,
        )
        .invoke_handler(tauri::generate_handler![
            workspace_action,
            workspace_adoption_preview,
            open_link,
            choose_folder,
            crate::chrome::window_control,
            crate::credentials::read_workspace_credential,
            crate::credentials::write_workspace_credential,
            crate::tray::tray_workspaces,
            crate::tray::tray_credential,
            crate::tray::tray_report,
            crate::tray::tray_resize,
            crate::tray::tray_hide,
            crate::tray::tray_open,
            crate::tray::tray_new_window,
            crate::tray::tray_notify,
            crate::updates::update_status,
            crate::updates::update_check,
            crate::updates::update_channel,
            crate::updates::update_download,
            crate::updates::update_install,
            crate::autostart::autostart_status,
            crate::autostart::autostart_set,
            crate::menu::menu_commands,
            crate::menu::menu_sections,
            crate::menu::menu_run,
            crate::menu::menu_popup
        ])
        .on_menu_event(|app, event| crate::menu::run(app, event.id().as_ref()))
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Focused(true) => crate::menu::focused(window),
            tauri::WindowEvent::Destroyed => crate::menu::closed(window),
            _ => {}
        })
        .setup(move |app| {
            crate::autostart::refresh(app.handle());
            let view = Arc::new(Mutex::new(View::default()));
            let page_view = view.clone();
            let (send, mut commands) = mpsc::channel(4);
            app.manage(Commands {
                send,
                view: view.clone(),
            });
            let navigation = app.handle().clone();
            let popup = app.handle().clone();
            let manager =
                WebviewWindowBuilder::new(app, MANAGER, WebviewUrl::App("desktop.html".into()))
                    .visible(!launch.autostart)
                    .title("ZeroLux — Workspaces")
                    .inner_size(760.0, 720.0)
                    .min_inner_size(600.0, 520.0)
                    .on_navigation(move |url| {
                        let allowed = local::boot_page(url);
                        if !allowed {
                            open_external(&navigation, url);
                        }
                        allowed
                    })
                    .on_new_window(move |url, _| {
                        open_external(&popup, &url);
                        tauri::webview::NewWindowResponse::Deny
                    })
                    .on_page_load(move |window, _| {
                        let snapshot = page_view.lock().expect("desktop view lock").clone();
                        render(window.app_handle(), &snapshot);
                    })
                    .build()?;
            let handle = app.handle().clone();
            manager.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let active = handle
                        .state::<Commands>()
                        .view
                        .lock()
                        .expect("desktop view lock")
                        .active
                        .clone();
                    // The active workspace's latest window comes back, else any one's; with
                    // none the app stays in the tray.
                    let back = handle
                        .webview_windows()
                        .into_values()
                        .filter_map(|window| {
                            let profile = profile_of(window.label())?;
                            Some((
                                active.as_deref() == Some(profile),
                                generation_of(window.label()),
                                window,
                            ))
                        })
                        .max_by_key(|(front, generation, _)| (*front, *generation));
                    if let Some((_, _, window)) = back {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    if let Some(manager) = handle.get_webview_window(MANAGER) {
                        let _ = manager.hide();
                    }
                }
            });
            crate::menu::install(app.handle())?;
            crate::notify::install(app.handle());
            crate::tray::install(app.handle())?;
            let data = data_root(app.handle()).context("Locate desktop data directory");
            let (stop, mut stopped) = watch::channel(false);
            let task_handle = app.handle().clone();
            let task = tauri::async_runtime::spawn(async move {
                let root = data.and_then(LocalWorkspace::open).map(Arc::new);
                let loaded = root.and_then(|root| {
                    let catalog = Catalog::load(&root.root)?;
                    catalog.save(&root.root)?;
                    Ok((root, catalog))
                });
                let (root, catalog) = match loaded {
                    Ok(loaded) => loaded,
                    Err(error) => {
                        let snapshot = View {
                            revision: 1,
                            error: Some(format!("{error:#}")),
                            ..Default::default()
                        };
                        *view.lock().expect("desktop view lock") = snapshot.clone();
                        render(&task_handle, &snapshot);
                        return;
                    }
                };
                crate::updates::initialize(&task_handle, root.root.clone());
                // The workspaces this computer joined connect again with the app.
                let computers = carried(&root.root).map(|resources| {
                    Links::start(
                        root.root.join("computer"),
                        &RunnerProgram::bundled(&resources),
                    )
                });
                let computers = match computers {
                    Ok(computers) => computers,
                    // Without the app's runners, its sessions could not start: they wait.
                    Err(error) => {
                        eprintln!("Joined workspaces are not connected: {error:#}");
                        Links::new(root.root.join("computer"))
                    }
                };
                let mut host = Host {
                    app: task_handle,
                    root,
                    catalog,
                    runtimes: HashMap::new(),
                    windows: HashMap::new(),
                    active: None,
                    generation: 0,
                    view,
                    stopped: stopped.clone(),
                    computers,
                    startup_retry: HashMap::new(),
                };
                host.publish(true, None);
                let background = launch.autostart;
                let error = host
                    .initial(launch)
                    .await
                    .err()
                    .map(|error| format!("{error:#}"));
                host.publish(false, error.clone());
                if error.is_some() && !background {
                    show_manager(&host.app, None);
                }
                let mut startup_tick = tokio::time::interval(Duration::from_secs(2));
                loop {
                    if *stopped.borrow() {
                        break;
                    }
                    let command = tokio::select! {
                        _=async { let _ = stopped.wait_for(|stop| *stop).await; }=>break,
                        _=startup_tick.tick()=>{ host.retry_startups().await; continue; },
                        // A joined workspace connected, broke or stopped: shown as it is,
                        // keeping what the last action said.
                        _=host.computers.changed()=>{
                            let error = host.view.lock().expect("desktop view lock").error.clone();
                            host.publish(false, error);
                            continue;
                        }
                        command=commands.recv()=>command,
                    };
                    let Some((action, reply)) = command else {
                        break;
                    };
                    if *stopped.borrow() {
                        break;
                    }
                    if !matches!(action, Action::List) {
                        host.publish(true, None);
                    }
                    let result = host.perform(action).await;
                    let error = result.as_ref().err().map(|error| format!("{error:#}"));
                    let snapshot = host.publish(false, error.clone());
                    let _ = reply.send(match error {
                        Some(error) => Err(error),
                        None => Ok(snapshot),
                    });
                }
                host.shutdown().await;
            });
            app.manage(Lifecycle {
                stop,
                task: Mutex::new(Some(task)),
                phase: AtomicU8::new(0),
            });
            let signal_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                zerolux::server::shutdown_signal().await;
                signal_handle.exit(0);
            });
            Ok(())
        })
        .build(context)?;
    app.run(|handle, event| {
        // The Dock's icon pressed with no window open: a workspace comes back.
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } = event
        {
            ask(handle, Action::Reopen);
            return;
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_window_replacement_keeps_every_survivor_tracked_for_unfreeze() {
        let mut current = vec![1, 2];
        assert!(
            replace_tracked(
                &mut current,
                vec![3, 4],
                |id| {
                    ensure!(*id != 4, "fixture show failure");
                    Ok(())
                },
                |_| Ok(())
            )
            .is_err()
        );
        assert_eq!(current, vec![3, 4, 1, 2]);
        let mut current = vec![1, 2];
        assert!(
            replace_tracked(
                &mut current,
                vec![3],
                |_| Ok(()),
                |id| {
                    ensure!(*id != 2, "fixture close failure");
                    Ok(())
                }
            )
            .is_err()
        );
        assert_eq!(current, vec![3, 2]);
        replace_tracked(&mut current, vec![4], |_| Ok(()), |_| Ok(())).unwrap();
        assert_eq!(current, vec![4]);
    }

    fn draft(text: &str) -> Vec<SavedView> {
        vec![SavedView {
            can_leave: Some(true),
            reason: None,
            drafts: Some(HashMap::from([("chat".into(), text.into())])),
            path: Some("/chats".into()),
        }]
    }

    #[test]
    fn another_update_keeps_offline_drafts_and_a_failed_install_restores_its_previous_checkpoint() {
        let root = tempfile::tempdir().unwrap();
        let previous = UpdateViews {
            version: "0.0.1-beta.1".into(),
            views: HashMap::from([
                ("offline".into(), draft("deferred")),
                ("open".into(), draft("old")),
            ]),
        };
        UpdateViews::persist(root.path(), Some(&previous)).unwrap();
        let next = UpdateViews::merge(
            Some(&previous),
            "0.0.1-rc.1".into(),
            HashMap::from([("open".into(), draft("new"))]),
        );
        UpdateViews::persist(root.path(), Some(&next)).unwrap();
        let read = || {
            serde_json::from_slice::<UpdateViews>(
                &std::fs::read(root.path().join("update-views.json")).unwrap(),
            )
            .unwrap()
        };
        let saved = read();
        assert_eq!(
            saved.views["offline"][0].drafts.as_ref().unwrap()["chat"],
            "deferred"
        );
        assert_eq!(
            saved.views["open"][0].drafts.as_ref().unwrap()["chat"],
            "new"
        );
        // Installation fails: restore only the pre-existing deferred checkpoint.
        UpdateViews::persist(root.path(), Some(&previous)).unwrap();
        assert_eq!(read().version, "0.0.1-beta.1");
        // A successful profile does not repeat because another profile stays offline.
        let mut remaining = read();
        remaining.views.remove("open");
        UpdateViews::persist(root.path(), Some(&remaining)).unwrap();
        assert_eq!(read().views.len(), 1);
        assert!(read().views.contains_key("offline"));
        UpdateViews::persist(root.path(), None).unwrap();
        assert!(!root.path().join("update-views.json").exists());
    }

    #[test]
    fn a_window_names_its_workspace() {
        assert_eq!(
            profile_of("workspace-6f0c1d2e-aaaa-bbbb-cccc-0123456789ab-7"),
            Some("6f0c1d2e-aaaa-bbbb-cccc-0123456789ab")
        );
        assert_eq!(profile_of("manager"), None);
        assert_eq!(profile_of("draft-import-x-1"), None);
    }

    #[test]
    fn workspace_navigation_only_opens_the_manager_without_arguments() {
        assert!(manager_request(&"zerolux://workspaces".parse().unwrap()));
        for value in [
            "zerolux://workspaces?url=http://evil.example",
            "zerolux://workspaces/other",
            "zerolux://user@workspaces",
            "https://workspaces/",
        ] {
            assert!(!manager_request(&value.parse().unwrap()));
        }
    }
}
