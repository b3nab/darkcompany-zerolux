//! ZeroLux's menu: the menu bar on macOS, and on Windows and Linux the same menus from the
//! window's menu button. One table names every command, its shortcut and where it runs: in the
//! app (windows, updates, zoom, help) or in the window in front (its pages and panels), which
//! the menu asks to run it. A window says which sections its bar shows, in their order.
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Mutex};
use tauri::{
    AppHandle, Emitter, Listener, LogicalPosition, Manager, WebviewWindow, Wry,
    menu::{
        AboutMetadata, ContextMenu, HELP_SUBMENU_ID, IsMenuItem, Menu, MenuItem,
        PredefinedMenuItem, Submenu, WINDOW_SUBMENU_ID,
    },
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// Where ZeroLux's documentation, releases and issues are.
const REPOSITORY: &str = "https://github.com/b3nab/darkcompany-zerolux";
const ZOOM_STEP: f64 = 0.1;
const MAC: bool = cfg!(target_os = "macos");

#[derive(Clone, Copy, PartialEq, Eq)]
enum Runs {
    /// By the app itself.
    App,
    /// By the window in front.
    Window,
}

/// A command of the menu, as the windows read them for their keys and their list of shortcuts.
#[derive(Clone, Copy, Serialize)]
pub struct Command {
    id: &'static str,
    label: &'static str,
    /// Its shortcut, as `CmdOrCtrl+Shift+N`.
    keys: Option<&'static str>,
    #[serde(skip)]
    runs: Runs,
    /// In this build, on this system.
    #[serde(skip)]
    here: bool,
}

const fn command(
    id: &'static str,
    label: &'static str,
    keys: Option<&'static str>,
    runs: Runs,
) -> Command {
    Command {
        id,
        label,
        keys,
        runs,
        here: true,
    }
}

impl Command {
    const fn when(self, here: bool) -> Self {
        Self { here, ..self }
    }
}

static COMMANDS: &[Command] = &[
    command("new-window", "New Window", Some("CmdOrCtrl+N"), Runs::App),
    command(
        "new-chat",
        "New Chat",
        Some("Alt+CmdOrCtrl+N"),
        Runs::Window,
    ),
    command("new-session", "New Session…", None, Runs::Window),
    command(
        "new-workspace",
        "New Workspace…",
        Some("CmdOrCtrl+Shift+N"),
        Runs::App,
    ),
    command(
        "open-folder",
        "Open Folder…",
        Some("CmdOrCtrl+O"),
        Runs::App,
    ),
    command(
        "manage-workspaces",
        "Manage Workspaces…",
        Some("CmdOrCtrl+Shift+O"),
        Runs::App,
    ),
    command("settings", "Settings…", Some("CmdOrCtrl+,"), Runs::Window),
    command("check-updates", "Check for Updates…", None, Runs::App),
    command(
        "sidebar",
        "Toggle Sidebar",
        Some("CmdOrCtrl+B"),
        Runs::Window,
    ),
    command(
        "command-menu",
        "Command Menu…",
        Some("CmdOrCtrl+K"),
        Runs::Window,
    ),
    command("zoom-reset", "Actual Size", Some("CmdOrCtrl+0"), Runs::App),
    // ⌘+ as in Safari and Chrome; on a keyboard where + takes Shift, ⌘= too (the page reads it).
    command("zoom-in", "Zoom In", Some("CmdOrCtrl++"), Runs::App),
    command("zoom-out", "Zoom Out", Some("CmdOrCtrl+-"), Runs::App),
    command("fullscreen", "Full Screen", Some("F11"), Runs::App).when(!MAC),
    // The web view's own tools, in builds from source only.
    command("reload", "Reload", Some("CmdOrCtrl+R"), Runs::App).when(cfg!(debug_assertions)),
    command(
        "devtools",
        "Developer Tools",
        Some("Alt+CmdOrCtrl+I"),
        Runs::App,
    )
    .when(cfg!(debug_assertions)),
    command(
        "back",
        "Back",
        Some(if MAC { "CmdOrCtrl+[" } else { "Alt+Left" }),
        Runs::Window,
    ),
    command(
        "forward",
        "Forward",
        Some(if MAC { "CmdOrCtrl+]" } else { "Alt+Right" }),
        Runs::Window,
    ),
    command("help", "ZeroLux Help", None, Runs::App),
    command(
        "shortcuts",
        "Keyboard Shortcuts",
        Some("CmdOrCtrl+/"),
        Runs::Window,
    ),
    command("whats-new", "What's New", None, Runs::App),
    command("report-issue", "Report an Issue…", None, Runs::App),
    command("data-folder", "Show Data Folder", None, Runs::App),
    // The app's own, not the system's: quitting waits for the kernel to stop and keeps the
    // windows open for the next launch.
    command(
        "quit",
        if MAC {
            "Quit ZeroLux"
        } else if cfg!(windows) {
            "Exit"
        } else {
            "Quit"
        },
        Some("CmdOrCtrl+Q"),
        Runs::App,
    ),
];

fn find(id: &str) -> Option<&'static Command> {
    COMMANDS
        .iter()
        .find(|command| command.here && command.id == id)
}

/// A section of a window's bar, opened with ⌘1…9 in its place.
#[derive(Clone, Deserialize)]
pub struct Section {
    path: String,
    label: String,
}

#[derive(Default)]
struct State {
    /// The workspace window last in front, which the window commands go to.
    front: Option<String>,
    sections: HashMap<String, Vec<Section>>,
    zoom: HashMap<String, f64>,
    /// What the updater is doing, as the update command says it.
    update: Update,
}

#[derive(Clone, Default, PartialEq)]
struct Update {
    phase: String,
    version: String,
    percent: Option<u32>,
}

fn state(app: &AppHandle) -> std::sync::MutexGuard<'_, State> {
    app.state::<Mutex<State>>()
        .inner()
        .lock()
        .expect("menu lock")
}

fn workspace_window(label: &str) -> bool {
    label.starts_with("workspace-")
}

/// The workspace window the menu speaks to: the one in front, else the last one that was.
fn front(app: &AppHandle) -> Option<WebviewWindow> {
    let windows = app.webview_windows();
    windows
        .values()
        .find(|window| workspace_window(window.label()) && window.is_focused().unwrap_or(false))
        .cloned()
        .or_else(|| {
            let front = state(app).front.clone()?;
            windows.get(&front).cloned()
        })
}

type Items = Vec<Box<dyn IsMenuItem<Wry>>>;

macro_rules! items {
    ($($item:expr),* $(,)?) => {{
        let items: Items = vec![$(Box::new($item?)),*];
        items
    }};
}

fn item(
    app: &AppHandle,
    id: &str,
    label: &str,
    keys: Option<&str>,
    enabled: bool,
) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, id, label, enabled, keys)
}

fn of(app: &AppHandle, id: &'static str) -> tauri::Result<MenuItem<Wry>> {
    let command = find(id).expect("a command of the table");
    item(app, id, command.label, command.keys, true)
}

fn submenu(
    app: &AppHandle,
    id: Option<&str>,
    title: &str,
    items: Items,
) -> tauri::Result<Submenu<Wry>> {
    let items: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(AsRef::as_ref).collect();
    match id {
        Some(id) => Submenu::with_id_and_items(app, id, title, true, &items),
        None => Submenu::with_items(app, title, true, &items),
    }
}

/// A menu's title, with its access key on Windows and Linux.
const fn title(mac: &'static str, others: &'static str) -> &'static str {
    if MAC { mac } else { others }
}

/// The update command as the updater stands: what choosing it does now, and whether it can.
fn update_item(app: &AppHandle) -> tauri::Result<MenuItem<Wry>> {
    let update = state(app).update.clone();
    let (label, enabled) = match update.phase.as_str() {
        "checking" => ("Checking for Updates…".to_owned(), false),
        "available" => (format!("Download ZeroLux {}…", update.version), true),
        "downloading" => (
            match update.percent {
                Some(percent) => format!("Downloading Update… {percent}%"),
                None => "Downloading Update…".to_owned(),
            },
            false,
        ),
        "ready" => (format!("Restart to Update to {}…", update.version), true),
        "installing" => ("Installing Update…".to_owned(), false),
        _ => ("Check for Updates…".to_owned(), true),
    };
    item(app, "check-updates", &label, None, enabled)
}

fn about(app: &AppHandle) -> tauri::Result<PredefinedMenuItem<Wry>> {
    let build = zerolux::build::info();
    let metadata = AboutMetadata {
        name: Some("ZeroLux".into()),
        version: Some(build.version.into()),
        short_version: Some(build.channel.into()),
        comments: Some(format!(
            "{} · {}",
            &build.commit[..build.commit.len().min(8)],
            build.built_at
        )),
        website: Some(REPOSITORY.into()),
        ..Default::default()
    };
    PredefinedMenuItem::about(app, Some("About ZeroLux"), Some(metadata))
}

fn file(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    submenu(
        app,
        None,
        title("File", "&File"),
        items![
            of(app, "new-window"),
            of(app, "new-chat"),
            of(app, "new-session"),
            PredefinedMenuItem::separator(app),
            of(app, "new-workspace"),
            of(app, "open-folder"),
            of(app, "manage-workspaces"),
            PredefinedMenuItem::separator(app),
            PredefinedMenuItem::close_window(app, None),
        ],
    )
}

fn edit(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let mut edit: Items = vec![];
    // Windows and Linux have no system Undo and Redo for a web view: its own keys do them.
    if MAC {
        edit.extend(items![
            PredefinedMenuItem::undo(app, None),
            PredefinedMenuItem::redo(app, None),
            PredefinedMenuItem::separator(app),
        ]);
    }
    edit.extend(items![
        PredefinedMenuItem::cut(app, None),
        PredefinedMenuItem::copy(app, None),
        PredefinedMenuItem::paste(app, None),
        PredefinedMenuItem::select_all(app, None),
    ]);
    submenu(app, None, title("Edit", "&Edit"), edit)
}

fn view(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let mut view = items![
        of(app, "sidebar"),
        PredefinedMenuItem::separator(app),
        of(app, "command-menu"),
        PredefinedMenuItem::separator(app),
        of(app, "zoom-reset"),
        of(app, "zoom-in"),
        of(app, "zoom-out"),
        PredefinedMenuItem::separator(app),
    ];
    view.push(if MAC {
        Box::new(PredefinedMenuItem::fullscreen(app, None)?)
    } else {
        Box::new(of(app, "fullscreen")?)
    });
    if cfg!(debug_assertions) {
        view.extend(items![
            PredefinedMenuItem::separator(app),
            submenu(
                app,
                None,
                "Developer",
                items![of(app, "reload"), of(app, "devtools")]
            ),
        ]);
    }
    submenu(app, None, title("View", "&View"), view)
}

/// Back and forward, and the window's sections by their place on its bar.
fn go(app: &AppHandle, sections: &[Section]) -> tauri::Result<Submenu<Wry>> {
    let mut go = items![of(app, "back"), of(app, "forward")];
    if !sections.is_empty() {
        go.push(Box::new(PredefinedMenuItem::separator(app)?));
    }
    for (at, section) in sections.iter().enumerate() {
        let keys = (at < 9).then(|| format!("CmdOrCtrl+{}", at + 1));
        go.push(Box::new(item(
            app,
            &format!("go:{}", section.path),
            &section.label,
            keys.as_deref(),
            true,
        )?));
    }
    submenu(app, None, title("Go", "&Go"), go)
}

fn window(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let mut window = items![
        PredefinedMenuItem::minimize(app, None),
        PredefinedMenuItem::maximize(app, MAC.then_some("Zoom")),
    ];
    if MAC {
        window.extend(items![
            PredefinedMenuItem::separator(app),
            PredefinedMenuItem::bring_all_to_front(app, None),
        ]);
    }
    submenu(
        app,
        Some(WINDOW_SUBMENU_ID),
        title("Window", "&Window"),
        window,
    )
}

fn help(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let mut help = items![
        of(app, "help"),
        of(app, "shortcuts"),
        of(app, "whats-new"),
        PredefinedMenuItem::separator(app),
        of(app, "report-issue"),
        submenu(app, None, "Troubleshooting", items![of(app, "data-folder")]),
    ];
    // Windows and Linux keep the updates and About in Help.
    if !MAC {
        help.extend(items![
            PredefinedMenuItem::separator(app),
            update_item(app),
            about(app),
        ]);
    }
    submenu(app, Some(HELP_SUBMENU_ID), title("Help", "&Help"), help)
}

fn menu(app: &AppHandle, items: Items) -> tauri::Result<Menu<Wry>> {
    let items: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(AsRef::as_ref).collect();
    Menu::with_items(app, &items)
}

/// macOS's menu bar, for the window in front.
fn menu_bar(app: &AppHandle, sections: &[Section]) -> tauri::Result<Menu<Wry>> {
    let zerolux = submenu(
        app,
        None,
        "ZeroLux",
        items![
            about(app),
            update_item(app),
            PredefinedMenuItem::separator(app),
            of(app, "settings"),
            PredefinedMenuItem::separator(app),
            PredefinedMenuItem::services(app, None),
            PredefinedMenuItem::separator(app),
            PredefinedMenuItem::hide(app, None),
            PredefinedMenuItem::hide_others(app, None),
            PredefinedMenuItem::show_all(app, None),
            PredefinedMenuItem::separator(app),
            of(app, "quit"),
        ],
    );
    menu(
        app,
        items![
            zerolux,
            file(app),
            edit(app),
            view(app),
            go(app, sections),
            window(app),
            help(app),
        ],
    )
}

/// The window's menu on Windows and Linux: the same menus, with Settings and Quit at the end.
fn window_menu(app: &AppHandle, sections: &[Section]) -> tauri::Result<Menu<Wry>> {
    menu(
        app,
        items![
            file(app),
            edit(app),
            view(app),
            go(app, sections),
            window(app),
            help(app),
            PredefinedMenuItem::separator(app),
            of(app, "settings"),
            of(app, "quit"),
        ],
    )
}

/// The menu bar again, for the window in front as its bar is now.
fn refresh(app: &AppHandle) {
    if !MAC {
        return;
    }
    let sections = {
        let state = state(app);
        state
            .front
            .as_ref()
            .and_then(|label| state.sections.get(label))
            .cloned()
            .unwrap_or_default()
    };
    if let Err(error) = menu_bar(app, &sections).and_then(|menu| app.set_menu(menu).map(drop)) {
        eprintln!("The menu could not be updated: {error}");
    }
}

/// The menu as the app starts, following the updater from then on.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    app.manage(Mutex::new(State::default()));
    let handle = app.clone();
    app.listen_any("zerolux-update", move |event| {
        let Ok(update) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
            return;
        };
        let percent = match (update["downloaded"].as_f64(), update["total"].as_f64()) {
            (Some(done), Some(total)) if total > 0.0 => Some((done / total * 100.0) as u32),
            _ => None,
        };
        let update = Update {
            phase: update["phase"].as_str().unwrap_or_default().to_owned(),
            version: update["available"]["version"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            percent,
        };
        // A download reports every chunk: the menu changes with what it says.
        let changed = std::mem::replace(&mut state(&handle).update, update.clone()) != update;
        if changed {
            refresh(&handle);
        }
    });
    if MAC {
        app.set_menu(menu_bar(app, &[])?)?;
    }
    Ok(())
}

/// A window came in front: the menu speaks to it from now on.
pub fn focused(window: &tauri::Window) {
    if !workspace_window(window.label()) {
        return;
    }
    let app = window.app_handle();
    let changed = {
        let mut state = state(app);
        let changed = state.front.as_deref() != Some(window.label());
        state.front = Some(window.label().to_owned());
        changed
    };
    if changed {
        refresh(app);
    }
}

/// A window closed: what the menu kept of it goes.
pub fn closed(window: &tauri::Window) {
    let mut state = state(window.app_handle());
    state.sections.remove(window.label());
    state.zoom.remove(window.label());
}

fn zoom(app: &AppHandle, by: Option<f64>) {
    let Some(window) = front(app) else {
        return;
    };
    let level = {
        let mut state = state(app);
        let level = state.zoom.entry(window.label().to_owned()).or_insert(1.0);
        *level = by.map_or(1.0, |by| (*level + by).clamp(0.5, 3.0));
        *level
    };
    let _ = window.set_zoom(level);
}

fn open(app: &AppHandle, url: &str) {
    if let Err(error) = app.opener().open_url(url, None::<&str>) {
        eprintln!("Could not open {url}: {error}");
    }
}

/// What choosing the update command does now: install the update downloaded, download the
/// one found, or look for one. A failure is said where it was chosen.
async fn update(app: AppHandle) {
    let phase = state(&app).update.phase.clone();
    let done = match phase.as_str() {
        "ready" => crate::updates::install(&app).await,
        "available" => crate::updates::download(&app).await,
        _ => crate::updates::check(&app).await,
    };
    if let Err(error) = done {
        app.dialog().message(error).title("ZeroLux").show(|_| {});
    }
}

/// A command of the menu, of the window's menu button or of its keys.
pub fn run(app: &AppHandle, id: &str) {
    let to_window =
        id.starts_with("go:") || find(id).is_some_and(|command| command.runs == Runs::Window);
    if to_window {
        if let Some(window) = front(app) {
            let _ = window.emit_to(window.label(), "zerolux-command", id);
        }
        return;
    }
    if find(id).is_none() {
        return;
    }
    match id {
        "new-window" => crate::app::ask(app, crate::app::Action::NewWindow { id: None }),
        "manage-workspaces" => crate::app::show_manager(app, None),
        "new-workspace" => crate::app::show_manager_to(app, "new"),
        "open-folder" => {
            let app = app.clone();
            app.dialog().file().pick_folder(move |chosen| {
                if let Some(Ok(directory)) = chosen.map(|chosen| chosen.into_path()) {
                    crate::app::ask_and_tell(
                        &app,
                        crate::app::Action::OpenFolder {
                            directory: directory.to_string_lossy().into_owned(),
                        },
                    );
                }
            });
        }
        "check-updates" => {
            tauri::async_runtime::spawn(update(app.clone()));
        }
        "zoom-in" => zoom(app, Some(ZOOM_STEP)),
        "zoom-out" => zoom(app, Some(-ZOOM_STEP)),
        "zoom-reset" => zoom(app, None),
        "fullscreen" => {
            if let Some(window) = front(app) {
                let _ = window.set_fullscreen(!window.is_fullscreen().unwrap_or(false));
            }
        }
        "reload" => {
            if let Some(window) = front(app) {
                let _ = window.reload();
            }
        }
        #[cfg(debug_assertions)]
        "devtools" => {
            if let Some(window) = front(app) {
                window.open_devtools();
            }
        }
        "help" => open(app, &format!("{REPOSITORY}/tree/main/docs")),
        "whats-new" => open(app, &format!("{REPOSITORY}/releases")),
        "report-issue" => open(app, &format!("{REPOSITORY}/issues/new")),
        "data-folder" => match crate::app::data_root(app) {
            Ok(folder) => {
                if let Err(error) = app
                    .opener()
                    .open_path(folder.to_string_lossy(), None::<&str>)
                {
                    eprintln!("Could not open the data folder: {error}");
                }
            }
            Err(error) => eprintln!("Could not find the data folder: {error}"),
        },
        "quit" => app.exit(0),
        _ => {}
    }
}

fn workspace_only(window: &WebviewWindow) -> Result<(), String> {
    window
        .url()
        .ok()
        .and_then(|url| crate::chrome::workspace_profile(window.label(), &url).map(drop))
        .ok_or_else(|| "Only a workspace's own view has the menu".into())
}

/// The commands and their shortcuts, for the window's own keys and its list of shortcuts.
#[tauri::command]
pub fn menu_commands(window: WebviewWindow) -> Result<Vec<Command>, String> {
    workspace_only(&window)?;
    Ok(COMMANDS
        .iter()
        .filter(|command| command.here)
        .copied()
        .collect())
}

/// The sections of the window's bar, in their order.
#[tauri::command]
pub fn menu_sections(window: WebviewWindow, sections: Vec<Section>) -> Result<(), String> {
    workspace_only(&window)?;
    let app = window.app_handle();
    let front = {
        let mut state = state(app);
        state.sections.insert(window.label().to_owned(), sections);
        state.front.as_deref() == Some(window.label())
    };
    if front {
        refresh(app);
    }
    Ok(())
}

/// A command the window's own keys ask for, as its menu item would.
#[tauri::command]
pub fn menu_run(window: WebviewWindow, id: String) -> Result<(), String> {
    workspace_only(&window)?;
    let app = window.app_handle();
    state(app).front = Some(window.label().to_owned());
    run(app, &id);
    Ok(())
}

/// The window's menu, at `x`, `y` of the window, from its menu button on Windows and Linux.
#[tauri::command]
pub fn menu_popup(window: WebviewWindow, x: f64, y: f64) -> Result<(), String> {
    workspace_only(&window)?;
    let app = window.app_handle();
    let sections = {
        let mut state = state(app);
        state.front = Some(window.label().to_owned());
        state
            .sections
            .get(window.label())
            .cloned()
            .unwrap_or_default()
    };
    window_menu(app, &sections)
        .and_then(|menu| menu.popup_at(window.as_ref().window(), LogicalPosition::new(x, y)))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_command_here_is_found_by_its_own_id() {
        let here: Vec<_> = COMMANDS.iter().filter(|command| command.here).collect();
        for command in &here {
            assert!(std::ptr::eq(find(command.id).unwrap(), *command));
        }
        assert!(find("go:/chats").is_none());
    }
}
