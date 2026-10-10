#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod catalog;
mod chrome;
mod connection;
mod local;
mod preferences;

fn main() -> anyhow::Result<()> {
    // Before starting Tokio or Tauri threads. Never source the user's shell configuration.
    if let Some(path) = local::desktop_path(std::env::var_os("PATH"), std::env::var_os("HOME")) {
        // SAFETY: this is the executable's single-threaded bootstrap, before any runtime starts.
        unsafe { std::env::set_var("PATH", path) };
    }
    zerolux::cli::init_logging();
    // Native harness links use current_exe. These helpers must never open a webview.
    if matches!(
        std::env::args().nth(1).as_deref(),
        Some("agent-link" | "chat-send")
    ) {
        return tokio::runtime::Runtime::new()?.block_on(zerolux::cli::run());
    }
    app::run(preferences::LaunchOptions::read())
}
