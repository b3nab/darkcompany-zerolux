//! Packaged workspace UI may control its own window, never target another one.
use crate::local;
use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowAction {
    Minimize,
    ToggleMaximize,
    Close,
}

#[derive(Serialize)]
pub struct WindowState {
    maximized: bool,
}

/// The saved connection whose packaged workspace view this is, if it is one.
pub fn workspace_profile<'a>(label: &'a str, url: &tauri::Url) -> Option<&'a str> {
    let (id, generation) = label
        .strip_prefix("workspace-")
        .and_then(|label| label.rsplit_once('-'))?;
    (uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id)
        && generation.parse::<u64>().is_ok_and(|n| n > 0)
        && local::app_page(url))
    .then_some(id)
}

#[tauri::command]
pub async fn window_control(
    window: WebviewWindow,
    action: WindowAction,
) -> Result<WindowState, String> {
    if !window
        .url()
        .ok()
        .is_some_and(|url| workspace_profile(window.label(), &url).is_some())
    {
        return Err("Window controls belong to this packaged workspace view only".into());
    }
    let result = (|| -> tauri::Result<WindowState> {
        let maximized = window.is_maximized()?;
        match action {
            WindowAction::Minimize => window.minimize()?,
            WindowAction::ToggleMaximize => {
                if maximized {
                    window.unmaximize()?;
                } else {
                    window.maximize()?;
                }
                return Ok(WindowState {
                    maximized: window.is_maximized()?,
                });
            }
            WindowAction::Close => window.close()?,
        }
        Ok(WindowState { maximized })
    })();
    result.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_packaged_workspace_callers_can_use_window_controls() {
        let label = format!("workspace-{}-1", uuid::Uuid::new_v4());
        let page = tauri::Url::parse("tauri://localhost/index.html").unwrap();
        assert!(workspace_profile(&label, &page).is_some());
        for label in ["manager", "workspace-not-a-profile-1", "workspace-other"] {
            assert!(workspace_profile(label, &page).is_none());
        }
        for url in [
            "http://127.0.0.1:4310/",
            "https://company.example/",
            "tauri://localhost/desktop.html",
            "tauri://user@localhost/index.html",
            "http://tauri.localhost:4310/",
        ] {
            assert!(workspace_profile(&label, &url.parse().unwrap()).is_none());
        }
        assert!(serde_json::from_str::<WindowAction>("\"destroy\"").is_err());
    }
}
