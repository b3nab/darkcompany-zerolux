//! Where extensions are found: indexes on HTTPS, each listing its publishers' keys and their
//! extensions' versions with a package for each computer (`macos-aarch64`, …) or for any. Anyone
//! may host one. A kernel reads those `ZEROLUX_EXTENSION_INDEXES` names; otherwise one run from a
//! checkout, in development, reads only its local marketplace, `marketplace/index.json` in its
//! data folder, which `bun run marketplace` writes from the checkout's own extensions, and a
//! release none yet. Development never reaches a marketplace in production.

use std::collections::BTreeMap;

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};

/// The largest package a kernel downloads.
const LARGEST: usize = 512 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Index {
    pub name: String,
    /// Each publisher's public key, in base64, which signs its packages.
    pub publishers: BTreeMap<String, Publisher>,
    pub extensions: Vec<Listing>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Publisher {
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Listing {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub publisher: String,
    pub versions: Vec<Release>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Release {
    pub version: String,
    /// The kernel versions it works with, as a semver range.
    pub kernel: Option<String>,
    /// What its package runs: `kernel`, `process`; a package that runs anything else is refused.
    #[serde(default)]
    pub parts: Vec<String>,
    /// A package for each computer, or `any`.
    pub packages: BTreeMap<String, Package>,
    /// What a marketplace shows of it: its icon, images, video, README and CHANGELOG, each
    /// with its address and digest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card: Option<super::card::Card>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Package {
    /// Where to download it, absolute or relative to the index.
    pub url: String,
    pub sha256: String,
}

/// The indexes this kernel reads.
pub fn indexes(data_dir: &std::path::Path) -> Vec<String> {
    match std::env::var("ZEROLUX_EXTENSION_INDEXES") {
        Ok(listed) if !listed.trim().is_empty() => listed
            .split(',')
            .map(|url| url.trim().to_owned())
            .filter(|url| !url.is_empty())
            .collect(),
        _ if crate::platform::carried().is_none() => {
            let local = std::path::absolute(data_dir.join("marketplace/index.json"))
                .unwrap_or_else(|_| data_dir.join("marketplace/index.json"));
            reqwest::Url::from_file_path(&local)
                .map(|url| vec![url.to_string()])
                .unwrap_or_default()
        }
        _ => Vec::new(),
    }
}

/// A local marketplace's file, from its `file:` address.
fn local_file(url: &reqwest::Url) -> Option<std::path::PathBuf> {
    (url.scheme() == "file")
        .then(|| url.to_file_path().ok())
        .flatten()
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()?)
}

pub async fn read(url: &str) -> Result<Index> {
    if let Some(path) = reqwest::Url::parse(url).ok().as_ref().and_then(local_file) {
        let text = tokio::fs::read_to_string(&path).await.with_context(|| {
            format!(
                "No local marketplace at {}: run `bun run marketplace`",
                path.display()
            )
        })?;
        return serde_json::from_str(&text)
            .with_context(|| format!("{url} is not an extension index"));
    }
    let response = client()?
        .get(url)
        .send()
        .await
        .with_context(|| format!("Cannot reach {url}"))?;
    let status = response.status();
    anyhow::ensure!(
        status.is_success(),
        "{url} did not give its index ({status})"
    );
    response
        .json()
        .await
        .with_context(|| format!("{url} is not an extension index"))
}

impl Release {
    /// Whether it works with this kernel, and its package for this computer.
    pub fn package(&self) -> Option<&Package> {
        let fits = self.kernel.as_deref().is_none_or(|range| {
            semver::VersionReq::parse(range)
                .is_ok_and(|range| range.matches(&super::manifest::kernel_version()))
        });
        if !fits {
            return None;
        }
        self.packages
            .get(&super::library::platform())
            .or_else(|| self.packages.get("any"))
    }
}

impl Listing {
    /// Its newest version that runs here.
    pub fn newest(&self) -> Option<&Release> {
        self.versions
            .iter()
            .filter(|release| release.package().is_some())
            .filter_map(|release| {
                semver::Version::parse(&release.version)
                    .ok()
                    .map(|version| (version, release))
            })
            .max_by(|(a, _), (b, _)| a.cmp(b))
            .map(|(_, release)| release)
    }
}

/// Downloads a package, as big as allowed, checked against its digest.
pub async fn download(index: &str, package: &Package) -> Result<Vec<u8>> {
    let url = reqwest::Url::parse(index)?.join(&package.url)?;
    if let Some(path) = local_file(&url) {
        let bytes = tokio::fs::read(&path)
            .await
            .with_context(|| format!("Cannot read {}", path.display()))?;
        ensure!(
            super::package::sha256(&bytes) == package.sha256.to_lowercase(),
            "The package is not the one its index lists"
        );
        return Ok(bytes);
    }
    let mut response = client()?
        .get(url.clone())
        .send()
        .await
        .with_context(|| format!("Cannot download {url}"))?
        .error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        bytes.extend_from_slice(&chunk);
        ensure!(bytes.len() <= LARGEST, "The package is too large");
    }
    ensure!(
        super::package::sha256(&bytes) == package.sha256.to_lowercase(),
        "The package is not the one its index lists"
    );
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_checkout_reads_its_local_marketplace_only() {
        let dir = tempfile::tempdir().unwrap();
        // SAFETY: this test alone reads it, and leaves it unset.
        unsafe { std::env::remove_var("ZEROLUX_EXTENSION_INDEXES") };
        let indexes = indexes(dir.path());
        assert_eq!(indexes.len(), 1);
        assert!(indexes[0].starts_with("file://"), "{indexes:?}");
        assert!(read(&indexes[0]).await.is_err());
        let folder = dir.path().join("marketplace");
        std::fs::create_dir_all(folder.join("packages")).unwrap();
        std::fs::write(folder.join("packages/a.zlx"), b"package").unwrap();
        std::fs::write(
            folder.join("index.json"),
            serde_json::json!({"name": "Local", "publishers": {}, "extensions": []}).to_string(),
        )
        .unwrap();
        assert_eq!(read(&indexes[0]).await.unwrap().name, "Local");
        let package = Package {
            url: "packages/a.zlx".into(),
            sha256: super::super::package::sha256(b"package"),
        };
        assert_eq!(download(&indexes[0], &package).await.unwrap(), b"package");
        let wrong = Package {
            sha256: "0".repeat(64),
            ..package
        };
        assert!(download(&indexes[0], &wrong).await.is_err());
    }
}
