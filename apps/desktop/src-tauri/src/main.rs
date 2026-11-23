#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
mod activity;
mod app;
mod autostart;
mod catalog;
mod chrome;
mod computer;
mod connection;
mod credentials;
mod extension_ui;
mod local;
mod menu;
mod notices;
mod notify;
mod preferences;
#[cfg(target_os = "macos")]
mod quit;
#[cfg(not(windows))]
mod restart;
mod tray;
mod updates;

fn main() -> anyhow::Result<()> {
    let agent_link = std::env::args().nth(1).as_deref() == Some("agent-link");
    // Resolve the user's runtime PATH before starting Tokio or Tauri threads.
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    let path = if agent_link {
        // The helper inherits its parent's resolved environment.
        local::desktop_path(std::env::var_os("PATH"), home)
    } else {
        local::runtime_path(std::env::var_os("PATH"), home)
    };
    if let Some(path) = path {
        // SAFETY: this is the executable's single-threaded bootstrap, before any runtime starts.
        unsafe { std::env::set_var("PATH", path) };
    }
    zerolux::cli::init_logging();
    // The LiveKit subscription helper must never open a webview.
    if agent_link {
        return tokio::runtime::Runtime::new()?.block_on(zerolux::cli::run());
    }
    app::run(preferences::LaunchOptions::read())
}
