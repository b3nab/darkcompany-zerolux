fn main() {
    println!("cargo:rerun-if-env-changed=ZEROLUX_UPDATE_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=ZEROLUX_UPDATE_TEST_FEEDS");
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
            "tray_notify",
            "update_status",
            "update_check",
            "update_channel",
            "update_download",
            "update_install",
        ]),
    ))
    .expect("build desktop permissions");
}
