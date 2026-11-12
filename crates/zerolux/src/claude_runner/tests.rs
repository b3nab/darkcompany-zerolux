use std::os::unix::fs::PermissionsExt;

use super::*;

mod startup;

#[tokio::test]
async fn catalog_is_scoped_to_account_and_folder_and_follows_installer_symlinks() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("project");
    let other = root.path().join("other");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::create_dir(&other).unwrap();
    let first = root.path().join("v1");
    let next = root.path().join("v2");
    let installed = root.path().join("claude");
    for (file, version) in [(&first, "first"), (&next, "second")] {
        std::fs::write(
            file,
            json!([{"value":version,"label":"Model","efforts":[]}]).to_string(),
        )
        .unwrap();
    }
    symlink(&first, &installed).unwrap();
    let entry = root.path().join("catalog.sh");
    std::fs::write(&entry, "[ \"$1\" = catalog ] || exit 9\nprintf '%s|%s\\n' \"$PWD\" \"$CLAUDE_CONFIG_DIR\" >> catalog-calls\ncat \"$ZEROLUX_CLAUDE_EXECUTABLE\"\n").unwrap();
    let registry = Registry::new(
        root.path().join("registry"),
        RunnerProgram {
            bun: "/bin/sh".into(),
            entry,
            kernel_executable: None,
            claude_cli: installed.clone(),
            pi_entry: None,
            sdk_executable: Some(installed.clone()),
        },
    );
    let alice = crate::homes::Homes::guest(root.path().join("alice"));
    let bob = crate::homes::Homes::guest(root.path().join("bob"));
    let cwd = workspace.to_str().unwrap();
    let revision = registry.native_revision().unwrap();
    assert_eq!(
        registry.catalog(cwd, &alice).await.unwrap()[0].value,
        "first"
    );
    registry.catalog(cwd, &alice).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(workspace.join("catalog-calls"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    registry.catalog(cwd, &bob).await.unwrap();
    let calls = std::fs::read_to_string(workspace.join("catalog-calls")).unwrap();
    assert_eq!(calls.lines().count(), 2);
    assert!(calls.contains(alice.claude().unwrap().to_str().unwrap()));
    assert!(calls.contains(bob.claude().unwrap().to_str().unwrap()));
    registry
        .catalog(other.to_str().unwrap(), &alice)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(other.join("catalog-calls"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    std::fs::remove_file(&installed).unwrap();
    symlink(&next, &installed).unwrap();
    assert_ne!(registry.native_revision().unwrap(), revision);
    assert_eq!(
        registry.catalog(cwd, &alice).await.unwrap()[0].value,
        "second"
    );
    assert_eq!(
        std::fs::read_to_string(workspace.join("catalog-calls"))
            .unwrap()
            .lines()
            .count(),
        3
    );
    assert!(
        !root.path().join("registry").exists(),
        "A catalog probe creates no session registry"
    );
}

#[tokio::test]
async fn catalog_reads_native_helper_metadata_and_rejects_failed_commands() {
    let root = tempfile::tempdir().unwrap();
    let entry = root.path().join("catalog.sh");
    std::fs::write(&entry, "printf '%s\\n' 'ZEROLUX_MODEL_CATALOG=[{\"value\":\"provider/native\",\"label\":\"Model\",\"efforts\":[\"high\"]}]' 'native table follows'\n").unwrap();
    let mut command = platform::command("/bin/sh");
    command.arg(&entry);
    let models = catalog_output(command, root.path().to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(models[0].value, "provider/native");
    assert_eq!(models[0].efforts, ["high"]);
    std::fs::write(&entry, "printf '[]\\n'\nexit 9\n").unwrap();
    let mut command = platform::command("/bin/sh");
    command.arg(&entry);
    assert!(
        catalog_output(command, root.path().to_str().unwrap())
            .await
            .is_err()
    );
}

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
    assert!(verify().is_err());
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
