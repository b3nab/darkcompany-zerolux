fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "workspace_action",
            "open_link",
            "choose_folder",
            "window_control",
            "read_workspace_credential",
            "write_workspace_credential",
            "tray_workspaces",
            "tray_credential",
            "tray_report",
            "tray_resize",
            "tray_hide",
            "tray_open",
            "tray_new_window",
        ]),
    ))
    .expect("build desktop permissions");
}
