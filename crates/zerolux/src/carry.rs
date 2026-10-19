//! What a release's kernel carries inside itself, so that one file runs it all: the web app,
//! sign-in, the runners of the sessions it starts, `bun`, `uv` and `livekit-server`. They are
//! written out once per release into the data folder, checked, and run from there.
// A checkout's kernel carries nothing: what writes it out runs only in its tests.
#![cfg_attr(not(zerolux_carry), allow(dead_code))]

use std::{
    io::Read,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};

#[cfg(zerolux_carry)]
static ARCHIVE: &[u8] = include_bytes!(env!("ZEROLUX_CARRY_ARCHIVE"));
#[cfg(zerolux_carry)]
const DIGEST: &str = env!("ZEROLUX_CARRY_SHA256");

/// The folder of what this kernel carries, written out under `data_dir` if it is not there
/// yet, with its programs found first from now on. `None` for a kernel built without, as in
/// a checkout.
pub fn unpack(data_dir: &Path) -> Result<Option<PathBuf>> {
    #[cfg(zerolux_carry)]
    {
        let folder = unpack_into(ARCHIVE, DIGEST, &data_dir.join("runtime"))?;
        crate::platform::carry(folder.clone());
        Ok(Some(folder))
    }
    #[cfg(not(zerolux_carry))]
    {
        let _ = data_dir;
        Ok(None)
    }
}

/// Marks a folder written out in full.
const COMPLETE: &str = ".complete";

/// Writes the archive out as `runtime/<digest>`, once: a folder there in full is used as it
/// is. A partial one, left by an interrupted start, is written again.
fn unpack_into(archive: &[u8], digest: &str, runtime: &Path) -> Result<PathBuf> {
    let folder = runtime.join(&digest[..16]);
    if folder.join(COMPLETE).is_file() {
        return Ok(folder);
    }
    crate::platform::private_dir(runtime)?;
    let staging = runtime.join(format!(".{}-{}", &digest[..16], std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    let written = write(archive, digest, &staging);
    if let Err(error) = written {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    std::fs::write(staging.join(COMPLETE), digest)?;
    match std::fs::rename(&staging, &folder) {
        Ok(()) => {}
        // Another start wrote it meanwhile.
        Err(_) if folder.join(COMPLETE).is_file() => {
            let _ = std::fs::remove_dir_all(&staging);
        }
        Err(_) => {
            let _ = std::fs::remove_dir_all(&folder);
            std::fs::rename(&staging, &folder)
                .with_context(|| format!("Cannot write {}", folder.display()))?;
        }
    }
    Ok(folder)
}

/// One field of an entry's header, up to its NUL; `None` where the archive ends.
fn field(input: &mut impl Read, hash: &mut sha2::Sha256) -> Result<Option<String>> {
    use sha2::Digest;
    let mut bytes = Vec::new();
    let mut byte = [0u8];
    loop {
        if input.read(&mut byte)? == 0 {
            ensure!(bytes.is_empty(), "The carried archive ends in an entry");
            return Ok(None);
        }
        hash.update(byte);
        if byte[0] == 0 {
            return Ok(Some(String::from_utf8(bytes)?));
        }
        ensure!(bytes.len() < 4096, "The carried archive has no entry here");
        bytes.push(byte[0]);
    }
}

/// The archive's entries, one after another: name, mode, length, bytes; its digest checked.
fn write(archive: &[u8], digest: &str, into: &Path) -> Result<()> {
    use sha2::{Digest, Sha256};
    let mut input = std::io::BufReader::new(flate2::read::GzDecoder::new(archive));
    let mut hash = Sha256::new();
    while let Some(name) = field(&mut input, &mut hash)? {
        let mode = u32::from_str_radix(&field(&mut input, &mut hash)?.context("No mode")?, 8)?;
        let length: usize = field(&mut input, &mut hash)?
            .context("No length")?
            .parse()?;
        ensure!(
            !name.is_empty()
                && name
                    .split('/')
                    .all(|part| !part.is_empty() && part != "." && part != ".."),
            "The carried archive names a file outside its folder"
        );
        let path = into.join(&name);
        std::fs::create_dir_all(path.parent().context("A file has a folder")?)?;
        let mut bytes = vec![0; length];
        input.read_exact(&mut bytes)?;
        hash.update(&bytes);
        std::fs::write(&path, &bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode & 0o755))?;
        }
        #[cfg(not(unix))]
        let _ = mode;
    }
    let actual = hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    ensure!(
        actual == digest,
        "The carried archive is damaged; download the kernel again"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    fn archive(entries: &[(&str, u32, &[u8])]) -> (Vec<u8>, String) {
        use sha2::{Digest, Sha256};
        let mut packed = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut hash = Sha256::new();
        for (name, mode, bytes) in entries {
            let header = format!("{name}\0{mode:o}\0{}\0", bytes.len());
            for part in [header.as_bytes(), bytes] {
                packed.write_all(part).unwrap();
                hash.update(part);
            }
        }
        let digest = hash
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        (packed.finish().unwrap(), digest)
    }

    #[test]
    fn what_a_release_carries_is_written_out_once_and_checked() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = dir.path().join("runtime");
        let (packed, digest) = archive(&[
            ("bun", 0o755, b"#!/bin/sh\n"),
            ("web/index.html", 0o644, b"<html></html>"),
        ]);
        let folder = unpack_into(&packed, &digest, &runtime).unwrap();
        assert_eq!(
            std::fs::read(folder.join("web/index.html")).unwrap(),
            b"<html></html>"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(folder.join("bun"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o755);
        }
        // Once there in full, it is used as it is.
        std::fs::write(folder.join("web/index.html"), b"changed").unwrap();
        assert_eq!(unpack_into(&packed, &digest, &runtime).unwrap(), folder);
        assert_eq!(
            std::fs::read(folder.join("web/index.html")).unwrap(),
            b"changed"
        );

        // A damaged archive, or one naming a file outside, is refused and leaves nothing.
        let (packed, _) = archive(&[("bun", 0o755, b"x")]);
        let wrong = "0".repeat(64);
        assert!(unpack_into(&packed, &wrong, &runtime).is_err());
        assert!(!runtime.join(&wrong[..16]).exists());
        let (packed, digest) = archive(&[("../escape", 0o644, b"x")]);
        assert!(unpack_into(&packed, &digest, &runtime).is_err());
        assert!(!dir.path().join("escape").exists());
    }
}
