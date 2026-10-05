#![cfg(unix)]

//! The kernel and the owned runner must agree on one OS lease. Only deterministic Bun
//! subprocesses run here; no Claude Code, credentials, or model are used.
use std::{
    fs::OpenOptions, os::unix::fs::OpenOptionsExt, path::PathBuf, process::Stdio, time::Duration,
};

use fs2::FileExt;
use tokio::io::{AsyncBufReadExt, BufReader};

#[tokio::test]
async fn rust_and_bun_agree_on_the_runner_lease_and_process_death_releases_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fixture.lock");
    let open = || {
        OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(&path)
            .unwrap()
    };
    let module = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../extensions/claude/src/lock.ts")
        .canonicalize()
        .unwrap();
    let script = format!(
        "import {{ lockSession }} from {};\n\
         const release = lockSession({}, 'fixture-holder');\n\
         if (!release) process.exit(3);\n\
         console.log('fixture-ready'); setInterval(() => {{}}, 1000)",
        serde_json::to_string(&module).unwrap(),
        serde_json::to_string(&path).unwrap(),
    );
    let spawn = || {
        tokio::process::Command::new("bun")
            .args(["-e", &script])
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .current_dir(dir.path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    };
    let lease = open();
    lease.try_lock_exclusive().unwrap();
    let status = tokio::time::timeout(Duration::from_secs(5), spawn().wait())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        status.code(),
        Some(3),
        "the Bun runner cannot take a Rust-held lease"
    );
    drop(lease);
    let mut child = spawn();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(5), output.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(line, "fixture-ready\n");
    let contender = open();
    assert!(
        contender.try_lock_exclusive().is_err(),
        "the kernel sees the runner-held lease"
    );
    child.kill().await.unwrap();
    child.wait().await.unwrap();
    contender.try_lock_exclusive().unwrap();
    // No PID check, unlink, inode replacement, timeout, or stolen lock is involved.
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "fixture-holder");
}
