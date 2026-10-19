use std::os::unix::fs::PermissionsExt;

use super::*;

mod startup;

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

#[test]
fn a_free_lease_requires_native_child_exit_evidence() {
    let root = tempfile::tempdir().unwrap();
    let native = Uuid::new_v4().to_string();
    let instance = Uuid::new_v4().to_string();
    let workspace = root.path().to_str().unwrap();
    let path = root.path().join(format!("{native}.lock"));
    let write = |value: &Value| {
        std::fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    };
    let verify =
        || execution::verify_exit(root.path(), &native, workspace, execution::Purpose::Restore);
    let verify_stop = || {
        execution::verify_exit(
            root.path(),
            &native,
            workspace,
            execution::Purpose::Stop(None),
        )
    };
    assert!(verify().is_err());
    let running = json!({"version":1,"kind":"claude-execution", "nativeSessionId":native,
        "workspace":workspace,"instanceId":instance, "holderPid":std::process::id(),
        "nativePid":std::process::id(),"phase":"running","started":true,"released":false});
    write(&running);
    assert!(
        verify_stop().is_err(),
        "A missing host does not confirm its child's Stop"
    );
    assert!(
        format!("{:#}", verify().unwrap_err()).contains("free helper lease is not proof of death")
    );
    for patch in [
        json!({"nativePid":null,"phase":"starting"}),
        json!({"nativePid":0}),
        json!({"workspace":"/another"}),
        json!({"version":2}),
    ] {
        let mut value = running.clone();
        value
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        write(&value);
        let before = std::fs::read(&path).unwrap();
        assert!(verify().is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
    write(&json!({"pid":std::process::id(),"instance_id":instance})); // Legacy has no native PID.
    assert!(verify().is_err());
    assert!(verify_stop().is_err());
    let mut waiting = running.clone();
    waiting["phase"] = json!("waiting");
    waiting["started"] = json!(false);
    waiting["nativePid"] = Value::Null;
    waiting["released"] = json!(true);
    write(&waiting);
    assert!(verify_stop().is_ok());
    assert!(
        verify().is_ok(),
        "The SDK checks saved history; a terminal conversation can predate its managed host"
    );
    waiting.as_object_mut().unwrap().remove("nativePid");
    write(&waiting);
    assert!(
        verify_stop().is_err(),
        "Missing nativePid is not explicit null"
    );
    let mut exited = running;
    exited["phase"] = json!("exited");
    exited["released"] = json!(true);
    write(&exited);
    assert!(verify_stop().is_ok());
    assert!(verify().is_ok(), "Positive exit/release survives PID reuse");
    assert!(
        execution::verify_exit(
            root.path(),
            &native,
            workspace,
            execution::Purpose::Stop(Some(&instance))
        )
        .is_ok()
    );
    assert!(
        execution::verify_exit(
            root.path(),
            &native,
            workspace,
            execution::Purpose::Stop(Some("other"))
        )
        .is_err()
    );
    let lease = private_file(&path, false).unwrap();
    lease.try_lock_exclusive().unwrap();
    assert!(
        verify().is_err(),
        "The proof must be read under the same exclusive lease"
    );
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
