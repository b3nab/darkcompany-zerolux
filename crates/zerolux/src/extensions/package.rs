//! An extension's package, `<id>-<version>.zlx`: its files in a gzipped tar, with `files.json`,
//! each file's path, size and SHA-256, and `SIGNATURE`, its publisher's Ed25519 signature of
//! `files.json`. A package is unpacked only when the signature is its publisher's and every
//! file is as signed.

use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use ed25519_dalek::{Signer, Verifier};
use serde::{Deserialize, Serialize};
use sha2::Digest;

use super::manifest::{FILE, Manifest};

/// What is never packed: what tools make and download.
pub const SKIPPED: &[&str] = &[
    ".git",
    "node_modules",
    ".venv",
    "__pycache__",
    "target",
    "dist",
    ".DS_Store",
];
/// The most a package may hold, unpacked.
const LARGEST: u64 = 1024 * 1024 * 1024;
const FILES: &str = "files.json";
const SIGNATURE: &str = "SIGNATURE";

/// A publisher's key: its name, and the Ed25519 key that signs its packages.
#[derive(Serialize, Deserialize)]
pub struct Key {
    pub publisher: String,
    /// The public key, in base64: what an index lists for the publisher.
    pub public: String,
    secret: String,
}

#[derive(Serialize, Deserialize)]
struct Signed {
    path: String,
    size: u64,
    sha256: String,
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The SHA-256 of some bytes, in hexadecimal.
pub fn sha256(bytes: &[u8]) -> String {
    hex(&sha2::Sha256::digest(bytes))
}

impl Key {
    /// A new key for `publisher`.
    pub fn new(publisher: &str) -> Result<Self> {
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret).map_err(|error| anyhow::anyhow!("{error}"))?;
        let signing = ed25519_dalek::SigningKey::from_bytes(&secret);
        Ok(Self {
            publisher: publisher.to_owned(),
            public: b64().encode(signing.verifying_key().to_bytes()),
            secret: b64().encode(secret),
        })
    }

    pub fn read(path: &Path) -> Result<Self> {
        serde_json::from_slice(
            &std::fs::read(path).with_context(|| format!("Cannot read {}", path.display()))?,
        )
        .context("Not a ZeroLux publisher key")
    }

    /// Keeps the key in a file only this system user reads.
    pub fn write(&self, path: &Path) -> Result<()> {
        ensure!(!path.exists(), "{} already exists", path.display());
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            crate::platform::private_dir(parent)?;
        }
        let mut file =
            crate::platform::private(std::fs::OpenOptions::new().create_new(true).write(true))
                .open(path)?;
        std::io::Write::write_all(&mut file, serde_json::to_string_pretty(self)?.as_bytes())?;
        Ok(())
    }

    fn signing(&self) -> Result<ed25519_dalek::SigningKey> {
        let secret: [u8; 32] = b64()
            .decode(&self.secret)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("Not a ZeroLux publisher key"))?;
        Ok(ed25519_dalek::SigningKey::from_bytes(&secret))
    }
}

/// The files of an extension's folder, as they are packed, by their path with `/`.
fn files(folder: &Path) -> Result<BTreeMap<String, PathBuf>> {
    let mut found = BTreeMap::new();
    let mut pending = vec![folder.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name();
            if SKIPPED.iter().any(|skipped| name == *skipped) {
                continue;
            }
            let kind = entry.file_type()?;
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() {
                let relative = entry.path().strip_prefix(folder)?.to_path_buf();
                let path = relative
                    .components()
                    .map(|part| part.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                found.insert(path, entry.path());
            }
        }
    }
    Ok(found)
}

/// Packs the extension in `folder` into `out`, signed with `key`: its publisher's.
pub fn pack(folder: &Path, key: &Key, out: &Path) -> Result<PathBuf> {
    let manifest = Manifest::parse(
        &std::fs::read_to_string(folder.join(FILE))
            .with_context(|| format!("The folder has no {FILE}"))?,
    )?;
    ensure!(
        manifest.extension.publisher == key.publisher,
        "The key is {}'s; {} is {}'s",
        key.publisher,
        manifest.extension.id,
        manifest.extension.publisher
    );
    if let Some(kernel) = &manifest.kernel {
        ensure!(
            folder.join("kernel").is_dir(),
            "No kernel module in kernel/<platform>/ for {}: run `zerolux ext build` first",
            kernel.library
        );
    }
    let files = files(folder)?;
    let mut signed = Vec::new();
    for (path, file) in &files {
        let bytes = std::fs::read(file)?;
        signed.push(Signed {
            path: path.clone(),
            size: bytes.len() as u64,
            sha256: sha256(&bytes),
        });
    }
    let listed = serde_json::to_vec_pretty(&signed)?;
    let signature = key.signing()?.sign(&listed);
    std::fs::create_dir_all(out)?;
    let package = out.join(format!(
        "{}-{}.zlx",
        manifest.extension.id, manifest.extension.version
    ));
    let mut archive = tar::Builder::new(flate2::write::GzEncoder::new(
        std::fs::File::create(&package)?,
        flate2::Compression::default(),
    ));
    let mut add = |path: &str, bytes: &[u8]| -> Result<()> {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        archive.append_data(&mut header, path, bytes)?;
        Ok(())
    };
    add(FILES, &listed)?;
    add(SIGNATURE, b64().encode(signature.to_bytes()).as_bytes())?;
    for (path, file) in &files {
        add(path, &std::fs::read(file)?)?;
    }
    archive.into_inner()?.finish()?;
    Ok(package)
}

/// Unpacks a package into `into`, which must not exist, once its signature is `public`'s and
/// every file is as signed; its manifest.
pub fn unpack(package: &[u8], public: &str, into: &Path) -> Result<Manifest> {
    let public: [u8; 32] = b64()
        .decode(public)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("Not a publisher's public key"))?;
    let public = ed25519_dalek::VerifyingKey::from_bytes(&public)?;
    let mut entries = BTreeMap::new();
    let mut total = 0u64;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(package));
    for entry in archive.entries()? {
        let mut entry = entry?;
        ensure!(
            entry.header().entry_type().is_file(),
            "A package holds files only"
        );
        let path = entry.path()?.into_owned();
        ensure!(
            path.components()
                .all(|part| matches!(part, std::path::Component::Normal(_))),
            "A package's file is outside it"
        );
        total += entry.size();
        ensure!(total <= LARGEST, "The package is too large");
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes)?;
        let path = path
            .components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        ensure!(
            entries.insert(path, bytes).is_none(),
            "A package's file is there twice"
        );
    }
    let listed = entries
        .remove(FILES)
        .context("The package lists no files")?;
    let signature = entries
        .remove(SIGNATURE)
        .context("The package is not signed")?;
    let signature: [u8; 64] = b64()
        .decode(signature.trim_ascii())?
        .try_into()
        .map_err(|_| anyhow::anyhow!("The package's signature is invalid"))?;
    if public
        .verify(&listed, &ed25519_dalek::Signature::from_bytes(&signature))
        .is_err()
    {
        bail!("The package is not signed by its publisher");
    }
    let signed: Vec<Signed> = serde_json::from_slice(&listed)?;
    ensure!(
        signed.len() == entries.len(),
        "The package holds files it does not list"
    );
    for file in &signed {
        let bytes = entries
            .get(&file.path)
            .with_context(|| format!("The package lacks {}", file.path))?;
        ensure!(
            bytes.len() as u64 == file.size && sha256(bytes) == file.sha256,
            "{} is not as its publisher signed it",
            file.path
        );
    }
    let manifest = Manifest::parse(
        std::str::from_utf8(entries.get(FILE).context("The package has no manifest")?)
            .context("The package's manifest is not text")?,
    )?;
    ensure!(!into.exists(), "{} already exists", into.display());
    let parent = into.parent().context("Nowhere to unpack")?;
    std::fs::create_dir_all(parent)?;
    let staging = parent.join(format!(".unpacking-{}", uuid::Uuid::new_v4().simple()));
    for (path, bytes) in &entries {
        let file = staging.join(path);
        std::fs::create_dir_all(file.parent().context("A file without a folder")?)?;
        std::fs::write(&file, bytes)?;
    }
    std::fs::rename(&staging, into)?;
    Ok(manifest)
}

/// Builds the kernel module of the extension in `folder`, a Cargo package, for this computer,
/// and puts it in `kernel/<platform>/`, where a package carries it.
pub fn build(folder: &Path) -> Result<PathBuf> {
    let manifest = Manifest::parse(
        &std::fs::read_to_string(folder.join(FILE))
            .with_context(|| format!("The folder has no {FILE}"))?,
    )?;
    let library = manifest
        .kernel
        .context("The extension has no kernel module to build")?
        .library;
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let output = std::process::Command::new(cargo)
        .args([
            "build",
            "--release",
            "--message-format=json-render-diagnostics",
        ])
        .current_dir(folder)
        .stderr(std::process::Stdio::inherit())
        .output()
        .context("Cannot run cargo")?;
    ensure!(output.status.success(), "The build failed");
    let file = super::library::file_name(&library);
    let built = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .flat_map(|message| message["filenames"].as_array().cloned().unwrap_or_default())
        .filter_map(|path| path.as_str().map(PathBuf::from))
        .find(|path| path.file_name().is_some_and(|name| name == file.as_str()))
        .with_context(|| format!("The build made no {file}"))?;
    let into = folder.join("kernel").join(super::library::platform());
    std::fs::create_dir_all(&into)?;
    std::fs::copy(&built, into.join(&file))?;
    Ok(into.join(file))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_package_unpacks_only_as_its_publisher_signed_it() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("notes");
        std::fs::create_dir_all(folder.join("ui/node_modules")).unwrap();
        std::fs::write(
            folder.join(FILE),
            "[extension]\nid = \"acme.notes\"\nname = \"Notes\"\nversion = \"1.0.0\"\npublisher = \"acme\"\n\n[process]\ncommand = [\"bun\", \"run\", \"main.ts\"]\n",
        )
        .unwrap();
        std::fs::write(folder.join("main.ts"), "// notes").unwrap();
        std::fs::write(folder.join("ui/index.html"), "<p>notes</p>").unwrap();
        std::fs::write(folder.join("ui/node_modules/big.js"), "skipped").unwrap();
        let key = Key::new("acme").unwrap();
        let package = pack(&folder, &key, &dir.path().join("out")).unwrap();
        assert!(package.ends_with("acme.notes-1.0.0.zlx"));
        let bytes = std::fs::read(&package).unwrap();
        let into = dir.path().join("installed");
        let manifest = unpack(&bytes, &key.public, &into).unwrap();
        assert_eq!(manifest.extension.id, "acme.notes");
        assert_eq!(
            std::fs::read_to_string(into.join("ui/index.html")).unwrap(),
            "<p>notes</p>"
        );
        assert!(!into.join("ui/node_modules").exists());
        // Another publisher's key, or a key that is not acme's, is refused.
        let other = Key::new("acme").unwrap();
        assert!(unpack(&bytes, &other.public, &dir.path().join("a")).is_err());
        assert!(pack(&folder, &Key::new("other").unwrap(), &dir.path().join("b")).is_err());
        // A file changed after signing is refused.
        std::fs::write(folder.join("main.ts"), "// changed").unwrap();
        let mut tampered = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::default(),
        ));
        let mut original = tar::Archive::new(flate2::read::GzDecoder::new(&bytes[..]));
        for entry in original.entries().unwrap() {
            let mut entry = entry.unwrap();
            let path = entry.path().unwrap().into_owned();
            let mut content = Vec::new();
            entry.read_to_end(&mut content).unwrap();
            if path == Path::new("main.ts") {
                content = b"// changed".to_vec();
            }
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tampered
                .append_data(&mut header, &path, &content[..])
                .unwrap();
        }
        let tampered = tampered.into_inner().unwrap().finish().unwrap();
        let refused = unpack(&tampered, &key.public, &dir.path().join("c")).unwrap_err();
        assert!(format!("{refused:#}").contains("main.ts"), "{refused:#}");
        // A key file is read back as written, and never overwritten.
        let file = dir.path().join("keys/acme.key");
        key.write(&file).unwrap();
        assert_eq!(Key::read(&file).unwrap().public, key.public);
        assert!(key.write(&file).is_err());
    }
}
