use super::*;

// No harness is started: this test process is the live claimant, its socket is missing,
// and its helper lease is free. Neither absence can authorize a replacement writer.
#[tokio::test]
async fn a_live_claimant_with_unreachable_control_is_not_absent() {
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::new(root.path().join("runners"), RunnerProgram::default());
    registry.prepare_directory().unwrap();
    let native = Uuid::new_v4().to_string();
    let workspace = root.path().to_str().unwrap();
    let mut record = json!({
        "version": 1,
        "kind": "claude-runner",
        "instance_id": Uuid::new_v4().to_string(),
        "endpoint": root.path().join("missing.sock"),
        "nonce": "a".repeat(64),
        "pid": std::process::id(),
        "native_session_id": native,
        "workspace": workspace,
        "permission_mode": "default"
    });
    let path = registry.path.join("claim.json");
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(!registry.is_leased(&native).unwrap());
    let result = registry
        .find(&native, workspace, PermissionMode::Default)
        .await;
    assert!(
        result.is_err(),
        "An unreachable live claimant is not absent"
    );
    assert!(
        format!("{:#}", result.err().unwrap()).contains("live Claude runner could not be verified")
    );
    for pid in [0, -1] {
        record["pid"] = json!(pid);
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        let result = registry
            .find(&native, workspace, PermissionMode::Default)
            .await;
        assert!(
            result.is_err(),
            "An invalid process identity proves no death"
        );
        assert!(format!("{:#}", result.err().unwrap()).contains("no valid process identity"));
    }
}

#[tokio::test]
async fn an_empty_registry_has_no_claimant() {
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::new(root.path().join("runners"), RunnerProgram::default());
    assert!(
        registry
            .find(
                &Uuid::new_v4().to_string(),
                root.path().to_str().unwrap(),
                PermissionMode::Default
            )
            .await
            .unwrap()
            .is_none()
    );
}
