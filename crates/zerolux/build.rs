//! A release's kernel carries what it runs: with `ZEROLUX_CARRY` naming a folder, its web
//! app, sign-in, runners, `bun`, `uv` and `livekit-server` are packed into
//! the kernel. Without it, nothing is: a checkout's kernel uses the checkout and the PATH.

use std::{
    io::Write,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

/// What is carried, at the top of the folder; anything else there is not.
const CARRIED: [&str; 10] = [
    "web",
    "auth",
    "claude",
    "pi",
    "bun",
    "bun.exe",
    "livekit-server",
    "livekit-server.exe",
    "uv",
    "uv.exe",
];

fn main() {
    build_identity();
    println!("cargo::rustc-check-cfg=cfg(zerolux_carry)");
    println!("cargo::rerun-if-env-changed=ZEROLUX_CARRY");
    let Some(folder) = std::env::var_os("ZEROLUX_CARRY") else {
        return;
    };
    let folder = PathBuf::from(folder);
    assert!(
        folder.is_absolute() && folder.is_dir(),
        "ZEROLUX_CARRY must name a folder by its absolute path"
    );
    let mut files = Vec::new();
    for name in CARRIED {
        let path = folder.join(name);
        if path.is_dir() {
            list(&folder, &path, &mut files);
        } else if path.is_file() {
            files.push((path, name.to_owned()));
        }
    }
    for needed in ["web", "auth", "claude", "pi"] {
        assert!(
            files
                .iter()
                .any(|(_, name)| name.starts_with(&format!("{needed}/"))),
            "ZEROLUX_CARRY has no {needed}"
        );
    }
    files.sort();
    for (path, _) in &files {
        println!("cargo::rerun-if-changed={}", path.display());
    }
    let out = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let archive = out.join("carry.gz");
    let mut packed = flate2::write::GzEncoder::new(
        std::fs::File::create(&archive).expect("create the carried archive"),
        flate2::Compression::default(),
    );
    let mut hash = Sha256::new();
    // One entry after another: name, mode, length, bytes. Read back by `carry.rs`.
    for (path, name) in &files {
        let bytes = std::fs::read(path).expect("read a carried file");
        let mode = mode(path);
        let header = format!("{name}\0{mode:o}\0{}\0", bytes.len());
        for part in [header.as_bytes(), &bytes] {
            packed.write_all(part).expect("write the carried archive");
            hash.update(part);
        }
    }
    packed.finish().expect("finish the carried archive");
    let digest = hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    println!("cargo::rustc-cfg=zerolux_carry");
    println!(
        "cargo::rustc-env=ZEROLUX_CARRY_ARCHIVE={}",
        archive.display()
    );
    println!("cargo::rustc-env=ZEROLUX_CARRY_SHA256={digest}");
}

/// Keep the source identity in the executable, without rewriting release manifests.
fn build_identity() {
    use std::{process::Command, time::SystemTime};
    let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let git = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .current_dir(&root)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    };
    // Source changes, commits and checkouts must all invalidate a cached identity.
    if let Some(files) = git(&[
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
    ]) {
        for path in files.split('\0').filter(|path| !path.is_empty()) {
            println!("cargo::rerun-if-changed={}", root.join(path).display());
        }
    }
    for name in ["HEAD", "index", "packed-refs"] {
        if let Some(path) = git(&["rev-parse", "--git-path", name]) {
            let path = root.join(path);
            if path.exists() {
                println!("cargo::rerun-if-changed={}", path.display());
            }
        }
    }
    if let Some(reference) = git(&["symbolic-ref", "-q", "HEAD"])
        && let Some(path) = git(&["rev-parse", "--git-path", &reference])
    {
        let path = root.join(path);
        // A packed branch has no loose ref yet. Watch its nearest existing directory so a
        // commit creating that ref invalidates the identity without watching a missing file.
        if let Some(watched) = path.ancestors().find(|path| path.exists()) {
            println!("cargo::rerun-if-changed={}", watched.display());
        }
    }
    for name in ["VERSION", "CHANNEL", "COMMIT", "BUILT_AT"] {
        let key = format!("ZEROLUX_BUILD_{name}");
        println!("cargo::rerun-if-env-changed={key}");
        let value = std::env::var(&key).unwrap_or_default();
        println!("cargo::rustc-env={key}={value}");
    }
    let commit = git(&["rev-parse", "HEAD"]).unwrap_or_default();
    let dirty = git(&["status", "--porcelain", "--untracked-files=normal"])
        .is_some_and(|status| !status.is_empty());
    let seconds = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .expect("build date")
        .as_secs();
    println!("cargo::rustc-env=ZEROLUX_SOURCE_COMMIT={commit}");
    println!("cargo::rustc-env=ZEROLUX_SOURCE_DIRTY={dirty}");
    println!("cargo::rustc-env=ZEROLUX_BUILD_UNIX={seconds}");
    // The schema is the embedded migration history: every version of both dialects.
    let mut schema = Sha256::new();
    for provider in ["sqlite", "postgres"] {
        let history = root.join(format!("crates/zerolux/migrations/{provider}"));
        let mut versions: Vec<PathBuf> = std::fs::read_dir(history)
            .expect("migration history")
            .map(|entry| entry.expect("a migration").path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "sql"))
            .collect();
        versions.sort();
        for path in versions {
            schema.update(std::fs::read(path).expect("a migration"));
        }
    }
    println!(
        "cargo::rustc-env=ZEROLUX_BUILD_SCHEMA={:x}",
        schema.finalize()
    );
}

/// Every file under `dir`, with its name relative to `root` in `/` form.
fn list(root: &Path, dir: &Path, files: &mut Vec<(PathBuf, String)>) {
    for entry in std::fs::read_dir(dir).expect("read a carried folder") {
        let path = entry.expect("a carried entry").path();
        let kind = std::fs::metadata(&path).expect("a carried entry's kind");
        if kind.is_dir() {
            list(root, &path, files);
        } else if kind.is_file() {
            let name = path
                .strip_prefix(root)
                .expect("inside the carried folder")
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            files.push((path, name));
        }
    }
}

#[cfg(unix)]
fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .expect("a carried file's mode")
        .permissions()
        .mode()
        & 0o777
}

#[cfg(not(unix))]
fn mode(_path: &Path) -> u32 {
    0o644
}
