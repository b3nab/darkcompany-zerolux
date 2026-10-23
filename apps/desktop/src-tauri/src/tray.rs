//! ZeroLux in the system's tray: its mark, with how many requests wait for you; a menu; and on
//! macOS and Windows a panel under the mark with what every open workspace asks of you. The
//! panel is the packaged app's own page, kept loaded while hidden so it hears the workspaces all
//! the time: it alone, besides each workspace's own view, reads their kernels' addresses and
//! sign-ins. Linux's trays open only a menu, so there the menu holds the requests too.
use crate::{
    app::{Action, Commands, View},
    credentials,
    extension_ui::Kernels,
    local,
};
use serde::{Deserialize, Serialize};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, Rect, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
    image::Image,
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tokio::sync::oneshot;

pub const PANEL: &str = "tray";
const TRAY: &str = "zerolux";
/// The panel's width in points; its height follows what it shows.
const WIDTH: f64 = 380.0;
/// Between the mark and the panel, and the panel and the screen's edges, in points.
const GAP: f64 = 6.0;

/// What the panel reports for the mark and the menu.
#[derive(Clone, Default, Deserialize)]
pub struct Report {
    /// Whether any workspace's kernel answers.
    live: bool,
    /// The requests waiting for you, for the mark and Linux's menu.
    requests: Vec<Request>,
    /// Each plan's main line, for Linux's menu.
    plans: Vec<String>,
}

#[derive(Clone, Deserialize)]
struct Request {
    profile: String,
    id: String,
    title: String,
    /// What can be answered from a menu; the rest opens the app.
    choices: Vec<Choice>,
}

#[derive(Clone, Deserialize)]
struct Choice {
    id: String,
    label: String,
}

/// A workspace whose kernel the panel hears: one opened since the app started.
#[derive(Serialize)]
pub struct Workspace {
    profile: String,
    workspace: Option<String>,
    name: String,
    kernel: String,
    active: bool,
}

#[derive(Default)]
struct State {
    report: Report,
    /// Where the mark was last clicked, for placing the panel again as it grows.
    anchor: Option<Rect>,
    /// When the panel last hid by losing focus: a click on the mark meanwhile only closed it.
    hidden: Option<Instant>,
}

fn panel_only(window: &WebviewWindow) -> Result<(), String> {
    (window.label() == PANEL && window.url().ok().as_ref().is_some_and(local::app_page))
        .then_some(())
        .ok_or_else(|| "Only the tray's packaged panel may do this".into())
}

/// The mark, `size` pixels square: the ring in `ink`, its lit point in `dot` unless no kernel
/// answers, and a `badge` in the corner while something waits.
fn mark(size: u32, ink: [u8; 4], dot: Option<[u8; 4]>, badge: Option<[u8; 4]>) -> Image<'static> {
    // The logo's geometry (packages/theme/logo.ts), in its -320…320 box.
    const RADIUS: f64 = 208.0;
    const HALF_STROKE: f64 = 50.0;
    const ENDS: [(f64, f64); 2] = [(10.9, -207.7), (207.7, -10.9)];
    const DOT: (f64, f64, f64) = (147.1, -147.1, 66.0);
    const BADGE: (f64, f64, f64) = (210.0, 210.0, 105.0);
    let (open, close) = (ENDS[0].1.atan2(ENDS[0].0), ENDS[1].1.atan2(ENDS[1].0));
    let near = |x: f64, y: f64, (cx, cy): (f64, f64), r: f64| (x - cx).hypot(y - cy) <= r;
    let paint = |x: f64, y: f64| -> Option<[u8; 4]> {
        if let Some(badge) = badge {
            if near(x, y, (BADGE.0, BADGE.1), BADGE.2) {
                return Some(badge);
            }
            // A clear ring around the badge keeps it apart from the mark.
            if near(x, y, (BADGE.0, BADGE.1), BADGE.2 + 40.0) {
                return None;
            }
        }
        if let Some(dot) = dot
            && near(x, y, (DOT.0, DOT.1), DOT.2)
        {
            return Some(dot);
        }
        let angle = y.atan2(x);
        let on_arc = ((x.hypot(y) - RADIUS).abs() <= HALF_STROKE
            && !(angle > open && angle < close))
            || ENDS.iter().any(|&end| near(x, y, end, HALF_STROKE));
        on_arc.then_some(ink)
    };
    const SAMPLES: u32 = 4;
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    for py in 0..size {
        for px in 0..size {
            let (mut sum, mut hits) = ([0f64; 4], 0u32);
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let at = |p: u32, s: u32| {
                        (f64::from(p) + (f64::from(s) + 0.5) / f64::from(SAMPLES)) / f64::from(size)
                            * 640.0
                            - 320.0
                    };
                    if let Some(color) = paint(at(px, sx), at(py, sy)) {
                        for (total, channel) in sum.iter_mut().zip(color) {
                            *total += f64::from(channel);
                        }
                        hits += 1;
                    }
                }
            }
            if hits > 0 {
                let at = ((py * size + px) * 4) as usize;
                let coverage = f64::from(hits) / f64::from(SAMPLES * SAMPLES);
                for channel in 0..3 {
                    rgba[at + channel] = (sum[channel] / f64::from(hits)).round() as u8;
                }
                rgba[at + 3] = (sum[3] / f64::from(hits) * coverage).round() as u8;
            }
        }
    }
    Image::new_owned(rgba, size, size)
}

/// Whether the bar the mark sits in is light: Windows' taskbar follows its own setting; Linux's
/// panels follow the system's look.
#[cfg(not(target_os = "macos"))]
fn light_bar(app: &AppHandle) -> bool {
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        windows_registry::CURRENT_USER
            .open(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
            .and_then(|key| key.get_u32("SystemUsesLightTheme"))
            .is_ok_and(|light| light == 1)
    }
    #[cfg(not(target_os = "windows"))]
    {
        app.get_webview_window(PANEL)
            .and_then(|panel| panel.theme().ok())
            .is_some_and(|theme| theme == tauri::Theme::Light)
    }
}

/// The mark as the report says: on macOS a template the system colors, with the count beside
/// it; elsewhere in the logo's colors for the bar, with a badge while something waits.
fn show_state(app: &AppHandle, report: &Report) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id(TRAY) else {
        return Ok(());
    };
    let waiting = report.requests.len();
    let tooltip = match waiting {
        0 => "ZeroLux".to_owned(),
        1 => "ZeroLux: 1 request waits for you".to_owned(),
        n => format!("ZeroLux: {n} requests wait for you"),
    };
    #[cfg(target_os = "macos")]
    {
        let black = [0, 0, 0, 255];
        tray.set_icon(Some(mark(36, black, report.live.then_some(black), None)))?;
        tray.set_icon_as_template(true)?;
        tray.set_title((waiting > 0).then(|| waiting.to_string()))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let (ink, dot) = if light_bar(app) {
            ([5, 7, 11, 255], [11, 133, 118, 255])
        } else {
            ([232, 236, 243, 255], [60, 242, 216, 255])
        };
        let badge = (waiting > 0).then_some([255, 143, 61, 255]);
        tray.set_icon(Some(mark(32, ink, report.live.then_some(dot), badge)))?;
    }
    tray.set_tooltip(Some(tooltip))?;
    Ok(())
}

/// The menu: on Linux what waits for you and the plans first; everywhere the workspaces and
/// the app's own commands.
fn menu(app: &AppHandle, view: &View, report: &Report) -> tauri::Result<Menu<tauri::Wry>> {
    let mut items: Vec<Box<dyn IsMenuItem<tauri::Wry>>> = Vec::new();
    let separator = || PredefinedMenuItem::separator(app);
    if cfg!(target_os = "linux") {
        if report.requests.is_empty() {
            items.push(Box::new(MenuItem::new(
                app,
                "Nothing needs you",
                false,
                None::<&str>,
            )?));
        }
        for request in &report.requests {
            let key = format!("{}|{}", request.profile, request.id);
            let mut choices: Vec<Box<dyn IsMenuItem<tauri::Wry>>> = Vec::new();
            for choice in &request.choices {
                choices.push(Box::new(MenuItem::with_id(
                    app,
                    format!("tray-choose:{key}|{}", choice.id),
                    &choice.label,
                    true,
                    None::<&str>,
                )?));
            }
            if !request.choices.is_empty() {
                choices.push(Box::new(separator()?));
            }
            choices.push(Box::new(MenuItem::with_id(
                app,
                format!("tray-request:{key}"),
                "Open in ZeroLux",
                true,
                None::<&str>,
            )?));
            let choices: Vec<&dyn IsMenuItem<tauri::Wry>> =
                choices.iter().map(|item| item.as_ref()).collect();
            items.push(Box::new(Submenu::with_items(
                app,
                &request.title,
                true,
                &choices,
            )?));
        }
        items.push(Box::new(separator()?));
        for plan in &report.plans {
            items.push(Box::new(MenuItem::new(app, plan, false, None::<&str>)?));
        }
        if !report.plans.is_empty() {
            items.push(Box::new(separator()?));
        }
    }
    items.push(Box::new(MenuItem::with_id(
        app,
        "tray-open",
        "Open ZeroLux",
        true,
        None::<&str>,
    )?));
    items.push(Box::new(MenuItem::with_id(
        app,
        "tray-new-window",
        "New Window",
        true,
        Some("CmdOrCtrl+N"),
    )?));
    items.push(Box::new(separator()?));
    for profile in &view.profiles {
        let id = &profile.profile.id;
        items.push(Box::new(CheckMenuItem::with_id(
            app,
            format!("tray-workspace:{id}"),
            &profile.profile.name,
            true,
            view.active.as_deref() == Some(id.as_str()),
            None::<&str>,
        )?));
    }
    items.push(Box::new(MenuItem::with_id(
        app,
        "tray-workspaces",
        "Manage Workspaces…",
        true,
        None::<&str>,
    )?));
    items.push(Box::new(separator()?));
    items.push(Box::new(MenuItem::with_id(
        app,
        "tray-quit",
        "Quit ZeroLux",
        true,
        None::<&str>,
    )?));
    let items: Vec<&dyn IsMenuItem<tauri::Wry>> = items.iter().map(|item| item.as_ref()).collect();
    Menu::with_items(app, &items)
}

fn view(app: &AppHandle) -> View {
    app.state::<Commands>()
        .view
        .lock()
        .expect("desktop view lock")
        .clone()
}

/// The mark and menu again, after the workspaces or the report changed.
fn refresh(app: &AppHandle) {
    let report = app
        .state::<Mutex<State>>()
        .lock()
        .expect("tray lock")
        .report
        .clone();
    let result = (|| -> tauri::Result<()> {
        show_state(app, &report)?;
        if let Some(tray) = app.tray_by_id(TRAY) {
            tray.set_menu(Some(menu(app, &view(app), &report)?))?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("The tray could not be updated: {error}");
    }
}

/// The workspaces changed: the menu shows them, and the panel hears them.
pub fn changed(app: &AppHandle) {
    refresh(app);
    if let Some(panel) = app.get_webview_window(PANEL) {
        let _ = panel.emit_to(PANEL, "zerolux-tray-workspaces", ());
    }
}

/// The panel under the mark (above it where the bar is at the bottom), within the screen, in
/// points. macOS gives the mark in its own screen's pixels and Windows in the desktop's, so the
/// screen is the one holding the mark at its scale: on macOS the one whose menu bar it is in.
fn place(panel: &WebviewWindow, anchor: Rect) -> tauri::Result<()> {
    let holding = panel
        .available_monitors()?
        .into_iter()
        .filter_map(|monitor| {
            let scale = monitor.scale_factor();
            let at = anchor.position.to_logical::<f64>(scale);
            let size = anchor.size.to_logical::<f64>(scale);
            let origin = monitor.position().to_logical::<f64>(scale);
            let extent = monitor.size().to_logical::<f64>(scale);
            let (x, y) = (at.x + size.width / 2.0, at.y + size.height / 2.0);
            (x >= origin.x
                && x < origin.x + extent.width
                && y >= origin.y
                && y < origin.y + extent.height)
                .then_some((y - origin.y, monitor, at, size))
        });
    let Some((_, monitor, at, size)) = holding.min_by(|a, b| a.0.total_cmp(&b.0)) else {
        return Ok(());
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let origin = area.position.to_logical::<f64>(scale);
    let extent = area.size.to_logical::<f64>(scale);
    let panel_size = panel.outer_size()?.to_logical::<f64>(panel.scale_factor()?);
    let (left, top) = (origin.x, origin.y);
    let (right, bottom) = (left + extent.width, top + extent.height);
    let x = (at.x + size.width / 2.0 - panel_size.width / 2.0)
        .clamp(left + GAP, (right - panel_size.width - GAP).max(left + GAP));
    let y = if at.y + size.height / 2.0 < (top + bottom) / 2.0 {
        (at.y + size.height + GAP).max(top + GAP)
    } else {
        (at.y - panel_size.height - GAP).min(bottom - panel_size.height - GAP)
    };
    // macOS places windows in points; Windows in the desktop's pixels, at that screen's scale.
    #[cfg(target_os = "macos")]
    let position: tauri::Position = tauri::LogicalPosition::new(x, y).into();
    #[cfg(not(target_os = "macos"))]
    let position: tauri::Position =
        PhysicalPosition::new((x * scale).round() as i32, (y * scale).round() as i32).into();
    panel.set_position(position)
}

fn toggle(app: &AppHandle, anchor: Rect) {
    let Some(panel) = app.get_webview_window(PANEL) else {
        return;
    };
    let state = app.state::<Mutex<State>>();
    let mut state = state.lock().expect("tray lock");
    state.anchor = Some(anchor);
    let just_hidden = state
        .hidden
        .take()
        .is_some_and(|hidden| hidden.elapsed() < Duration::from_millis(300));
    drop(state);
    if just_hidden || panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
        return;
    }
    let shown = place(&panel, anchor)
        .and_then(|()| panel.show())
        .and_then(|()| panel.set_focus());
    if let Err(error) = shown {
        eprintln!("The tray panel could not open: {error}");
    }
    let _ = panel.emit_to(PANEL, "zerolux-tray-shown", ());
}

/// Asks the desktop to act, as its own menu does, and waits for it.
async fn act(app: &AppHandle, action: Action) -> Result<(), String> {
    let (reply, answer) = oneshot::channel();
    app.state::<Commands>()
        .send
        .try_send((action, reply))
        .map_err(|_| "The desktop is busy or closing".to_owned())?;
    answer
        .await
        .map_err(|_| "The desktop is closing".to_owned())?
        .map(drop)
}

fn on_menu(app: &AppHandle, id: &str) {
    let ask = |action| crate::app::ask(app, action);
    match id {
        "tray-open" => ask(Action::Reopen),
        "tray-new-window" => ask(Action::NewWindow { id: None }),
        "tray-workspaces" => crate::app::show_manager(app, None),
        "tray-quit" => app.exit(0),
        _ => {
            if let Some(profile) = id.strip_prefix("tray-workspace:") {
                ask(Action::Open {
                    id: profile.to_owned(),
                });
            } else if let Some(chosen) = id.strip_prefix("tray-choose:") {
                let mut parts = chosen.splitn(3, '|');
                if let (Some(profile), Some(request), Some(choice)) =
                    (parts.next(), parts.next(), parts.next())
                {
                    let chosen =
                        serde_json::json!({ "profile": profile, "id": request, "choice": choice });
                    let _ = app.emit_to(PANEL, "zerolux-tray-choose", chosen);
                }
            } else if let Some(request) = id.strip_prefix("tray-request:")
                && let Some((profile, request)) = request.split_once('|')
            {
                let opened = serde_json::json!({ "profile": profile, "id": request });
                let _ = app.emit_to(PANEL, "zerolux-tray-request", opened);
            }
        }
    }
}

/// On every space, a full-screen app's included, as the system's own menus are.
#[cfg(target_os = "macos")]
fn over_full_screen(panel: &WebviewWindow) -> tauri::Result<()> {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
    let window = panel.ns_window()?.cast::<NSWindow>();
    // SAFETY: the panel's own NSWindow, alive as long as the panel; this runs in the app's
    // setup, on the main thread.
    let window = unsafe { &*window };
    window.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    Ok(())
}

/// The mark in the tray and its panel, hidden until the mark is clicked.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    app.manage(Mutex::new(State::default()));
    let platform = serde_json::to_string(std::env::consts::OS).expect("platform");
    let script = format!(
        "if ((location.protocol==='tauri:' && location.host==='localhost') || location.origin==='http://tauri.localhost') Object.defineProperty(window,'zeroluxTray',{{value:Object.freeze({{platform:{platform}}})}});"
    );
    let links = app.clone();
    let panel = WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App("index.html".into()))
        .title("ZeroLux")
        .inner_size(WIDTH, 480.0)
        .visible(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .initialization_script(script)
        .on_navigation(move |next| {
            let allowed = local::app_page(next);
            if !allowed && local::external_link(next) {
                crate::app::open_external(&links, next);
            }
            allowed
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()?;
    #[cfg(target_os = "macos")]
    over_full_screen(&panel)?;
    let handle = app.clone();
    panel.on_window_event(move |event| match event {
        // Like any menu, it goes when you click elsewhere.
        tauri::WindowEvent::Focused(false) => {
            if let Some(panel) = handle.get_webview_window(PANEL)
                && panel.is_visible().unwrap_or(false)
            {
                let _ = panel.hide();
                handle
                    .state::<Mutex<State>>()
                    .lock()
                    .expect("tray lock")
                    .hidden = Some(Instant::now());
            }
        }
        tauri::WindowEvent::ThemeChanged(_) => refresh(&handle),
        _ => {}
    });
    let state = Report::default();
    TrayIconBuilder::with_id(TRAY)
        .tooltip("ZeroLux")
        .menu(&menu(app, &view(app), &state)?)
        // The mark opens the panel; the menu is the right click's (Linux has only the menu).
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                toggle(tray.app_handle(), rect);
            }
        })
        .build(app)?;
    refresh(app);
    Ok(())
}

/// The workspaces the panel hears: those opened since the app started, with their kernels.
#[tauri::command]
pub fn tray_workspaces(
    window: WebviewWindow,
    kernels: tauri::State<'_, Kernels>,
) -> Result<Vec<Workspace>, String> {
    panel_only(&window)?;
    let view = view(window.app_handle());
    let kernels = kernels.all();
    Ok(view
        .profiles
        .iter()
        .filter_map(|profile| {
            let profile = &profile.profile;
            Some(Workspace {
                kernel: kernels
                    .get(&profile.id)?
                    .as_str()
                    .trim_end_matches('/')
                    .to_owned(),
                profile: profile.id.clone(),
                workspace: profile.workspace_id.clone(),
                name: profile.name.clone(),
                active: view.active.as_deref() == Some(profile.id.as_str()),
            })
        })
        .collect())
}

/// A workspace's sign-in, for the panel to read its kernel.
#[tauri::command]
pub fn tray_credential(
    window: WebviewWindow,
    profile: String,
    workspace: String,
) -> Result<Option<String>, String> {
    panel_only(&window)?;
    Ok(credentials::read_saved(&profile, &workspace))
}

/// What waits for you, for the mark and the menu; the notifications of the rest go.
#[tauri::command]
pub fn tray_report(window: WebviewWindow, report: Report) -> Result<(), String> {
    panel_only(&window)?;
    let waiting = report
        .requests
        .iter()
        .map(|request| format!("{}|{}", request.profile, request.id))
        .collect();
    crate::notify::keep_only(window.app_handle(), &waiting);
    window
        .app_handle()
        .state::<Mutex<State>>()
        .lock()
        .expect("tray lock")
        .report = report;
    refresh(window.app_handle());
    Ok(())
}

/// The panel as tall as what it shows, within the screen.
#[tauri::command]
pub fn tray_resize(window: WebviewWindow, height: f64) -> Result<(), String> {
    panel_only(&window)?;
    let result = (|| -> tauri::Result<()> {
        let scale = window.scale_factor()?;
        let tallest = match window.current_monitor()? {
            Some(monitor) => f64::from(monitor.work_area().size.height) / scale - 4.0 * GAP,
            None => height,
        };
        window.set_size(LogicalSize::new(WIDTH, height.clamp(120.0, tallest)))?;
        let anchor = window
            .app_handle()
            .state::<Mutex<State>>()
            .lock()
            .expect("tray lock")
            .anchor;
        if let Some(anchor) = anchor {
            place(&window, anchor)?;
        }
        Ok(())
    })();
    result.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn tray_hide(window: WebviewWindow) -> Result<(), String> {
    panel_only(&window)?;
    window.hide().map_err(|error| error.to_string())
}

/// A workspace in front, at a page of its own when one is named; the panel goes.
#[tauri::command]
pub async fn tray_open(
    window: WebviewWindow,
    profile: String,
    path: Option<String>,
) -> Result<(), String> {
    panel_only(&window)?;
    let _ = window.hide();
    let app = window.app_handle();
    act(
        app,
        Action::Open {
            id: profile.clone(),
        },
    )
    .await?;
    if let Some(path) = path.filter(|path| path.starts_with('/') && !path.starts_with("//")) {
        let prefix = format!("workspace-{profile}-");
        if let Some(view) = app
            .webview_windows()
            .into_values()
            .filter(|view| view.label().starts_with(&prefix))
            .max_by_key(|view| crate::app::generation_of(view.label()))
        {
            view.emit_to(view.label(), "zerolux-open", path)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// Another window of a workspace.
#[tauri::command]
pub async fn tray_new_window(window: WebviewWindow, profile: String) -> Result<(), String> {
    panel_only(&window)?;
    let _ = window.hide();
    act(window.app_handle(), Action::NewWindow { id: Some(profile) }).await
}

/// A new request, as a system notification.
#[tauri::command]
pub fn tray_notify(window: WebviewWindow, ask: crate::notify::Ask) -> Result<(), String> {
    panel_only(&window)?;
    crate::notify::show(window.app_handle(), ask);
    Ok(())
}

/// Where ZeroLux's releases are published.
const RELEASES: &str = "https://api.github.com/repos/b3nab/darkcompany-zerolux/releases/latest";

/// A newer release of the app than this one.
#[derive(Serialize)]
pub struct Release {
    version: String,
    url: String,
}

/// The newest published release, when it is newer than this app: the panel offers it. Nothing
/// when it cannot be read.
#[tauri::command]
pub async fn tray_release(window: WebviewWindow) -> Result<Option<Release>, String> {
    panel_only(&window)?;
    #[derive(Deserialize)]
    struct Latest {
        tag_name: String,
        html_url: String,
    }
    let answer = reqwest::Client::new()
        .get(RELEASES)
        .header("User-Agent", "ZeroLux")
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !answer.status().is_success() {
        return Ok(None);
    }
    let latest: Latest = answer.json().await.map_err(|error| error.to_string())?;
    let Ok(version) = semver::Version::parse(latest.tag_name.trim_start_matches('v')) else {
        return Ok(None);
    };
    let current = semver::Version::parse(&window.app_handle().package_info().version.to_string())
        .map_err(|error| error.to_string())?;
    Ok((version > current).then(|| Release {
        version: version.to_string(),
        url: latest.html_url,
    }))
}
