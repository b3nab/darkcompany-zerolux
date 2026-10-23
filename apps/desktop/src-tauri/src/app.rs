use crate::{
    catalog::{Catalog, Profile, Source},
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

struct Lifecycle {
    stop: watch::Sender<bool>,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    phase: AtomicU8,
}

struct LocalRuntime {
    url: tauri::Url,
    stop: watch::Sender<bool>,
    task: tokio::task::JoinHandle<Result<()>>,
}

struct WorkspaceView {
    window: WebviewWindow,
}

impl WorkspaceView {
    fn close(&self) -> Result<()> {
        self.window.close().context("Close the workspace view")
    }
}

#[derive(Default, Deserialize)]
struct SavedView {
    #[serde(rename = "canLeave")]
    can_leave: Option<bool>,
    drafts: Option<HashMap<String, String>>,
    path: Option<String>,
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
        catalog.save(&self.root.root)?;
        self.catalog = catalog;
        Ok(())
    }

    async fn local_url(&mut self, profile: &Profile) -> Result<tauri::Url> {
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
        let server = Server::start(ServerOptions {
            address: ([127, 0, 0, 1], workspace.port()?).into(),
            expose: None,
            public: None,
            data_dir: database
                .parent()
                .context("The workspace database has a directory")?
                .to_path_buf(),
            database: zerolux::db::Location::Sqlite(database),
            web_dir: resources.join("web"),
            livekit: None,
            runner: Some(RunnerProgram::bundled(&resources)),
            auth: Some(zerolux::auth::AuthEntry {
                bun: executable("bun"),
                entry: resources.join("auth/server.js"),
            }),
        })
        .await
        .context("Start this workspace's local kernel")?;
        if let Err(error) = workspace.remember_port(server.address().port()) {
            server.shutdown().await?;
            return Err(error);
        }
        let url: tauri::Url = server.url().parse().expect("bound kernel URL");
        let (stop, mut stopped) = watch::channel(false);
        let task = tokio::spawn(async move {
            let _workspace = workspace;
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
        // Retry initialization if its reply was lost. Existing/legacy workspaces are
        // never renamed during startup; names use the same HTTP API as other clients.
        if profile.workspace_id.is_none()
            && matches!(profile.source, Source::Local { legacy: false })
        {
            reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(5))
                .build()?
                .post(url.join("api/workspace")?)
                .json(&serde_json::json!({"name":profile.name}))
                .send()
                .await?
                .error_for_status()
                .context("Set the new workspace's name")?;
        }
        let verified = connection::verify(url.as_str(), profile.workspace_id.as_deref()).await?;
        profile.observe(&verified)?;
        ensure!(!*self.stopped.borrow(), "The desktop is closing");
        for view in self.windows.get(id).into_iter().flatten() {
            view.window.set_title(&profile.name)?;
        }
        if !self.windows.contains_key(id) {
            let saved = if profile.app_ui {
                None
            } else {
                Some(SavedView {
                    can_leave: Some(true),
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
            if (state.canLeave !== true) return {canLeave:state.canLeave};
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
            "This workspace has messages waiting to be sent"
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
            Action::Join { url, code, name } => {
                let program = RunnerProgram::bundled(&self.resources()?);
                self.computers.join(&url, &code, &name, program).await?;
            }
            Action::Leave { id } => self.computers.leave(&id).await?,
            Action::NewWindow { id } => self.new_window(id).await?,
            Action::Reopen => self.reopen().await?,
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

pub fn run(launch: LaunchOptions) -> Result<()> {
    supported_platform()?;
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        // The page's own `Notification` reaches the system's notifications.
        .plugin(tauri_plugin_notification::init())
        // Only `choose_folder` opens it: pages are given no dialog of their own.
        .plugin(tauri_plugin_dialog::init())
        .manage(crate::extension_ui::Kernels::default())
        .register_asynchronous_uri_scheme_protocol(
            crate::extension_ui::SCHEME,
            crate::extension_ui::serve,
        )
        .invoke_handler(tauri::generate_handler![
            workspace_action,
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
            crate::tray::tray_notify
        ])
        .on_menu_event(|app, event| match event.id().as_ref() {
            "workspaces" => show_manager(app, None),
            "new-window" => ask(app, Action::NewWindow { id: None }),
            _ => {}
        })
        .setup(move |app| {
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
            let menu = tauri::menu::Menu::default(app.handle())?;
            // ⌘N opens another window, as in Finder and Safari: ⇧⌘N stays a new folder.
            let window = tauri::menu::MenuItem::with_id(
                app,
                "new-window",
                "New Window",
                true,
                Some("CmdOrCtrl+N"),
            )?;
            let item = tauri::menu::MenuItem::with_id(
                app,
                "workspaces",
                "Manage Workspaces…",
                true,
                Some("CmdOrCtrl+Shift+O"),
            )?;
            menu.append(&tauri::menu::Submenu::with_items(
                app,
                "Workspace",
                true,
                &[&window, &item],
            )?)?;
            app.set_menu(menu)?;
            crate::notify::install(app.handle());
            crate::tray::install(app.handle())?;
            let data = std::env::var_os("ZEROLUX_DESKTOP_DATA_DIR")
                .map(PathBuf::from)
                .map(Ok)
                .unwrap_or_else(|| {
                    app.path()
                        .app_data_dir()
                        .context("Locate desktop data directory")
                });
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
                };
                host.publish(true, None);
                let error = host
                    .initial(launch)
                    .await
                    .err()
                    .map(|error| format!("{error:#}"));
                host.publish(false, error.clone());
                if error.is_some() {
                    show_manager(&host.app, None);
                }
                loop {
                    if *stopped.borrow() {
                        break;
                    }
                    let command = tokio::select! {
                        _=stopped.wait_for(|stop| *stop)=>break,
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
        .build(tauri::generate_context!())?;
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
