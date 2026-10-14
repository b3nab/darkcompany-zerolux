//! Fingerprint installed helper code once per kernel activation, never watch development edits.
use std::path::Path;

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

/// Kept byte-for-byte compatible with packages/bridge/src/integration-code.ts.
pub(crate) fn revision(entry: &Path) -> Result<String> {
    fn add(hash: &mut Sha256, name: &str, path: &Path) -> Result<()> {
        hash.update(name.as_bytes());
        hash.update([0]);
        hash.update(std::fs::read(path)?);
        hash.update([0]);
        Ok(())
    }
    fn visit(hash: &mut Sha256, directory: &Path, prefix: &str) -> Result<()> {
        let mut files = std::fs::read_dir(directory)?.collect::<std::io::Result<Vec<_>>>()?;
        files.sort_by_key(|entry| entry.file_name());
        for entry in files {
            let filename = entry.file_name();
            let filename = filename.to_str().context("Non-UTF8 integration filename")?;
            if filename == "fixtures" || filename.contains(".test.") {
                continue;
            }
            let name = format!("{prefix}/{filename}");
            let kind = entry.file_type()?;
            if kind.is_dir() {
                visit(hash, &entry.path(), &name)?;
            } else if kind.is_file() && filename.ends_with(".ts") {
                add(hash, &name, &entry.path())?;
            }
        }
        Ok(())
    }
    let mut hash = Sha256::new();
    let directory = entry.parent().context("Missing integration directory")?;
    if entry.extension().is_some_and(|ext| ext == "ts")
        && directory.file_name().is_some_and(|name| name == "src")
    {
        let root = directory
            .ancestors()
            .nth(3)
            .context("Missing checkout root")?;
        visit(&mut hash, directory, "integration")?;
        visit(&mut hash, &root.join("packages/bridge/src"), "bridge")?;
        add(&mut hash, "lock", &root.join("bun.lock"))?;
    } else {
        add(&mut hash, "entry", entry)?;
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revision_tracks_code_not_test_or_session_data() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let src = temp.path().join("extensions/example/src");
        std::fs::create_dir_all(&src)?;
        std::fs::create_dir_all(temp.path().join("packages/bridge/src"))?;
        std::fs::write(temp.path().join("bun.lock"), "fixture")?;
        let entry = src.join("entry.ts");
        std::fs::write(&entry, "export {};")?;
        let original = revision(&entry)?;
        std::fs::write(src.join("entry.test.ts"), "test only")?;
        std::fs::write(src.join("session.json"), "private")?;
        assert_eq!(revision(&entry)?, original);
        std::fs::write(temp.path().join("packages/bridge/src/change.ts"), "code")?;
        assert_ne!(revision(&entry)?, original);
        Ok(())
    }
}
