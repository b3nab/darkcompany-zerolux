//! Where extensions are found: indexes on HTTPS, each listing its publishers' keys and their
//! extensions' versions with a package for each computer (`macos-aarch64`, …) or for any. Anyone
//! may host one; a kernel reads ZeroLux's own, or those `ZEROLUX_EXTENSION_INDEXES` names.

use std::collections::BTreeMap;

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};

/// ZeroLux's own index.
pub const OFFICIAL: &str =
    "https://raw.githubusercontent.com/b3nab/darkcompany-zerolux/main/marketplace/index.json";
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Package {
    /// Where to download it, absolute or relative to the index.
    pub url: String,
    pub sha256: String,
}

/// The indexes this kernel reads.
pub fn indexes() -> Vec<String> {
    match std::env::var("ZEROLUX_EXTENSION_INDEXES") {
        Ok(listed) if !listed.trim().is_empty() => listed
            .split(',')
            .map(|url| url.trim().to_owned())
            .filter(|url| !url.is_empty())
            .collect(),
        _ => vec![OFFICIAL.to_owned()],
    }
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()?)
}

pub async fn read(url: &str) -> Result<Index> {
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

/// This kernel's version, as ranges are matched against it.
fn kernel_version() -> semver::Version {
    let mut version = semver::Version::parse(env!("CARGO_PKG_VERSION")).expect("a version");
    version.pre = semver::Prerelease::EMPTY;
    version
}

impl Release {
    /// Whether it works with this kernel, and its package for this computer.
    pub fn package(&self) -> Option<&Package> {
        let fits = self.kernel.as_deref().is_none_or(|range| {
            semver::VersionReq::parse(range).is_ok_and(|range| range.matches(&kernel_version()))
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
