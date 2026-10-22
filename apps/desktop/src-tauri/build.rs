fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "workspace_action",
            "open_link",
            "choose_folder",
            "window_control",
            "read_workspace_credential",
            "write_workspace_credential",
        ]),
    ))
    .expect("build desktop permissions");
}
