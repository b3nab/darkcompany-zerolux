use crate::{
    catalog::{Catalog, Profile, Source},
    connection,
    local::{self, LocalWorkspace},
    preferences::LaunchOptions,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
    time::Duration,
};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{mpsc, oneshot, watch};
use zerolux::server::{Server, ServerOptions};

const MANAGER: &str = "manager";

#[derive(Clone, Default, Serialize)]
struct View {
    revision: u64,
    profiles: Vec<ProfileView>,
    active: Option<String>,
    ready: bool,
    busy: bool,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
struct ProfileView {
    #[serde(flatten)]
    profile: Profile,
    running: bool,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    List,
    Open { id: String },
    Add { url: String },
    Create { name: String },
    Edit { id: String, url: String },
    Forget { id: String },
}

type Reply = oneshot::Sender<Result<View, String>>;
struct Commands {
    send: mpsc::Sender<(Action, Reply)>,
    view: Arc<Mutex<View>>,
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
    closing: Arc<AtomicBool>,
}

impl WorkspaceView {
    fn close(&self) -> Result<()> {
        self.closing.store(true, Ordering::Release);
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
    windows: HashMap<String, WorkspaceView>,
    active: Option<String>,
    generation: u64,
    view: Arc<Mutex<View>>,
    stopped: watch::Receiver<bool>,
}

fn open_external(handle: &tauri::AppHandle, url: &tauri::Url) {
    if local::external_link(url)
        && let Err(error) = handle.opener().open_url(url.as_str(), None::<&str>)
    {
        eprintln!("Could not open link in the browser: {error}");
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

fn show_manager(app: &tauri::AppHandle, profile: Option<&str>) {
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
    if let Some(window) = app.get_webview_window(MANAGER)
        && window.url().ok().as_ref().is_some_and(local::boot_page)
    {
        let value = serde_json::to_string(view).expect("desktop view");
        let _ = window.eval(format!("window.zeroluxDesktopState?.({value})"));
    }
}

impl Host {
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
        let resources = self
            .app
            .path()
            .resource_dir()
            .context("Locate packaged desktop resources")?;
        let resources = local::resource_root(&resources)?;
        let server = Server::start(ServerOptions {
            address: ([127, 0, 0, 1], workspace.port()?).into(),
            expose: None,
            public: None,
            database,
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

    async fn open(&mut self, id: &str) -> Result<()> {
        let mut profile = self.catalog.profile(id)?.clone();
        let url = match &profile.source {
            Source::Existing { url } => connection::kernel_url(url)?,
            Source::Local { .. } => self.local_url(&profile).await?,
        };
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
        if let Some(view) = self.windows.get(id) {
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
            self.windows.insert(id.to_owned(), window);
        }
        profile.app_ui = true;
        let mut catalog = self.catalog.clone();
        *catalog.profile_mut(id)? = profile;
        catalog.selected = Some(id.to_owned());
        self.save(catalog)?;
        self.activate(id)
    }

    fn activate(&mut self, id: &str) -> Result<()> {
        self.active = Some(id.to_owned());
        for (other, view) in &self.windows {
            if other == id {
                view.window.show()?;
                view.window.set_focus()?;
            } else {
                view.window.hide()?;
            }
        }
        if let Some(manager) = self.app.get_webview_window(MANAGER) {
            manager.hide()?;
        }
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
                .context("The previous draft store did not load; it was left unchanged")??;
            ensure!(window.url()? == url.join("api/health")?, "The previous draft origin did not load; its store was left unchanged");
            let (send, receive) = oneshot::channel();
            let send = Mutex::new(Some(send));
            window.eval_with_callback("(() => { try { const drafts=localStorage.getItem('zerolux-drafts'); if (drafts!==null && drafts.length>4194304) return {status:'too-large'}; return {status:'ok',drafts}; } catch { return {status:'unavailable'}; } })()", move |value| {
                if let Some(send) = send.lock().expect("draft import lock").take() {
                    let _ = send.send(value);
                }
            })?;
            let json = tokio::time::timeout(Duration::from_secs(5), receive)
                .await
                .context("The previous draft store did not answer; it was left unchanged")??;
            ensure!(
                json.len() <= 4 * 1024 * 1024,
                "Previous drafts are too large to import; their store was left unchanged"
            );
            let envelope: serde_json::Value = serde_json::from_str(&json)?;
            ensure!(envelope["status"] == "ok", "The previous drafts could not be read; their store was left unchanged");
            let saved: Option<String> = serde_json::from_value(envelope.get("drafts").context("Missing previous draft snapshot")?.clone())?;
            saved
                .map(|text| serde_json::from_str(&text))
                .transpose()
                .context("Read previous drafts; their store was left unchanged")
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
        let navigation = self.app.clone();
        let popup = self.app.clone();
        let profile_id = profile.id.clone();
        let popup_id = profile.id.clone();
        let closing = Arc::new(AtomicBool::new(false));
        let close_flag = closing.clone();
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
                    let allowed = local::app_page(next);
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
            .context("Open this workspace's isolated view")?;
        let handle = self.app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && !close_flag.load(Ordering::Acquire)
            {
                api.prevent_close();
                handle.exit(0);
            }
        });
        let view = WorkspaceView { window, closing };
        let result = async {
            tokio::time::timeout(Duration::from_secs(10), ready).await
                .context("The packaged workspace interface did not load")??;
            if !profile.app_ui {
                let (send, receive) = oneshot::channel();
                let send = Mutex::new(Some(send));
                view.window.eval_with_callback("window.zeroluxDraftImportSaved === true", move |value| {
                    if let Some(send) = send.lock().expect("draft persistence lock").take() { let _ = send.send(value); }
                })?;
                let value = tokio::time::timeout(Duration::from_secs(5), receive).await??;
                ensure!(value == "true", "Imported drafts could not be saved. The previous browser store was left unchanged.");
            }
            ensure!(!*self.stopped.borrow(), "The desktop is closing");
            Ok::<(), anyhow::Error>(())
        }.await;
        if let Err(error) = result {
            let _ = view.close();
            return Err(error);
        }
        Ok(view)
    }

    async fn prepare_view(&self, id: &str) -> Result<Option<SavedView>> {
        let Some(view) = self.windows.get(id) else {
            return Ok(None);
        };
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
            .context("The workspace did not answer; its view was kept open")??;
        ensure!(
            json.len() <= 4 * 1024 * 1024,
            "The draft snapshot is too large; the workspace was kept open"
        );
        let saved: SavedView =
            serde_json::from_str(&json).context("Read the workspace's navigation state")?;
        ensure!(
            saved.can_leave.is_some(),
            "Update this kernel's web interface before changing its open connection"
        );
        ensure!(
            saved.can_leave == Some(true),
            "This workspace has messages waiting to be sent. Keep it open until they are confirmed."
        );
        Ok(Some(saved))
    }

    fn unfreeze(&self, id: &str) {
        if let Some(view) = self.windows.get(id) {
            let _ = view.window.eval("document.body.inert = false");
        }
    }

    async fn edit(&mut self, id: &str, url: &str) -> Result<()> {
        let mut profile = self.catalog.profile(id)?.clone();
        ensure!(
            matches!(profile.source, Source::Existing { .. }),
            "An app-managed workspace uses its own local address"
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
            "Open this saved workspace once to import its previous drafts before changing its address. The previous browser store was left unchanged."
        );
        let prepared = self.prepare_view(id).await;
        let result: Result<()> = async {
            let saved = prepared?;
            profile.observe(&verified)?;
            let replacement = if self.windows.contains_key(id) {
                Some(
                    self.build_view(&profile, &verified.url, saved.as_ref())
                        .await?,
                )
            } else {
                None
            };
            let mut catalog = self.catalog.clone();
            *catalog.profile_mut(id)? = profile;
            if let Err(error) = self.save(catalog) {
                if let Some(view) = replacement {
                    let _ = view.close();
                }
                return Err(error);
            }
            if let Some(replacement) = replacement {
                if let Some(previous) = self.windows.insert(id.to_owned(), replacement) {
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
            Action::Forget { id } => {
                ensure!(
                    !self
                        .runtimes
                        .get(&id)
                        .is_some_and(|runtime| !runtime.task.is_finished()),
                    "This local kernel is still running. Its saved connection must stay available until the kernel is closed."
                );
                if let Err(error) = self.prepare_view(&id).await {
                    self.unfreeze(&id);
                    return Err(error);
                }
                let mut catalog = self.catalog.clone();
                catalog.forget(&id)?;
                if let Err(error) = self.save(catalog) {
                    self.unfreeze(&id);
                    return Err(error);
                }
                if let Some(view) = self.windows.remove(&id) {
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
        .invoke_handler(tauri::generate_handler![
            workspace_action,
            crate::chrome::window_control
        ])
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "workspaces" {
                show_manager(app, None);
            }
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
                    if let Some(active) = active {
                        let prefix = format!("workspace-{active}-");
                        if let Some(window) = handle
                            .webview_windows()
                            .into_values()
                            .filter(|window| window.label().starts_with(&prefix))
                            .max_by_key(|window| {
                                window
                                    .label()
                                    .rsplit('-')
                                    .next()
                                    .and_then(|part| part.parse::<u64>().ok())
                                    .unwrap_or(0)
                            })
                        {
                            let _ = window.show();
                            let _ = window.set_focus();
                            if let Some(manager) = handle.get_webview_window(MANAGER) {
                                let _ = manager.hide();
                            }
                            return;
                        }
                    }
                    handle.exit(0);
                }
            });
            let menu = tauri::menu::Menu::default(app.handle())?;
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
                &[&item],
            )?)?;
            app.set_menu(menu)?;
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
                zerolux::worker::shutdown_signal().await;
                signal_handle.exit(0);
            });
            Ok(())
        })
        .build(tauri::generate_context!())?;
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

#[cfg(test)]
mod tests {
    use super::*;
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
