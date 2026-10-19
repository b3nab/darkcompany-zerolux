//! A release's kernel carries what it runs: with `ZEROLUX_CARRY` naming a folder, its web
//! app, sign-in, runners, `bun` and `livekit-server` are packed into the kernel. Without it,
//! nothing is: a checkout's kernel uses the checkout and the PATH.

use std::{
    io::Write,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

/// What is carried, at the top of the folder; anything else there is not.
const CARRIED: [&str; 8] = [
    "web",
    "auth",
    "claude",
    "pi",
    "bun",
    "bun.exe",
    "livekit-server",
    "livekit-server.exe",
];

fn main() {
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
