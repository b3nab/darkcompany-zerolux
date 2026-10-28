//! What a marketplace shows of an extension before it is installed: its card. Its icon, its
//! images and video, its README and CHANGELOG, each checked when the package is made and named
//! by its SHA-256, so that a kernel verifies what an index gives as it verifies packages.

use std::path::Path;

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};

use super::manifest::{Links, Manifest};

const ICON_BYTES: u64 = 256 * 1024;
const IMAGE_BYTES: u64 = 2 * 1024 * 1024;
const VIDEO_BYTES: u64 = 50 * 1024 * 1024;
const TEXT_BYTES: u64 = 256 * 1024;
const IMAGES: usize = 6;

/// A file of the card: its path in the package, digest, size and kind.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Asset {
    pub name: String,
    pub sha256: String,
    pub size: u64,
    /// `icon`, `image`, `video` or `text`.
    pub kind: String,
    /// Where an index keeps it, absolute or relative to the index.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Card {
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub links: Option<Links>,
    #[serde(default)]
    pub icon: Option<Asset>,
    #[serde(default)]
    pub icon_dark: Option<Asset>,
    #[serde(default)]
    pub media: Vec<Asset>,
    #[serde(default)]
    pub readme: Option<Asset>,
    #[serde(default)]
    pub changelog: Option<Asset>,
}

impl Card {
    pub fn assets(&self) -> impl Iterator<Item = &Asset> {
        [&self.icon, &self.icon_dark, &self.readme, &self.changelog]
            .into_iter()
            .flatten()
            .chain(self.media.iter())
    }

    pub fn assets_mut(&mut self) -> impl Iterator<Item = &mut Asset> {
        [
            &mut self.icon,
            &mut self.icon_dark,
            &mut self.readme,
            &mut self.changelog,
        ]
        .into_iter()
        .flatten()
        .chain(self.media.iter_mut())
    }
}

/// What a file's bytes say it is, for those a card holds.
pub fn content_type(name: &str) -> &'static str {
    match name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("mp4") => "video/mp4",
        Some("md") => "text/markdown; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn asset(folder: &Path, name: &str, kind: &str) -> Result<Asset> {
    let bytes = std::fs::read(folder.join(name)).with_context(|| format!("No {name}"))?;
    Ok(Asset {
        name: name.to_owned(),
        sha256: super::package::sha256(&bytes),
        size: bytes.len() as u64,
        kind: kind.to_owned(),
        url: None,
    })
}

/// A PNG's width and height, from its header.
fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let number =
        |at: usize| u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    Some((number(16), number(20)))
}

fn image(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(&[0xFF, 0xD8, 0xFF])
        || (bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP")
}

fn mp4(bytes: &[u8]) -> bool {
    bytes.len() > 12 && &bytes[4..8] == b"ftyp"
}

/// Markdown as a card shows it: no HTML outside code, images only from `media/`.
fn check_markdown(folder: &Path, name: &str, text: &str) -> Result<()> {
    let mut prose = String::new();
    let mut fenced = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if !fenced {
            // Inline code is code too.
            let mut code = false;
            for c in line.chars() {
                if c == '`' {
                    code = !code;
                } else if !code {
                    prose.push(c);
                }
            }
            prose.push('\n');
        }
    }
    let html = prose.as_bytes().windows(2).any(|pair| {
        pair[0] == b'<' && (pair[1].is_ascii_alphabetic() || pair[1] == b'/' || pair[1] == b'!')
    });
    // An autolink, `<https://…>`, is Markdown, not HTML.
    let autolinks = prose.matches("<https://").count() + prose.matches("<http://").count();
    let tags = prose
        .as_bytes()
        .windows(2)
        .filter(|pair| {
            pair[0] == b'<' && (pair[1].is_ascii_alphabetic() || pair[1] == b'/' || pair[1] == b'!')
        })
        .count();
    if html && tags > autolinks {
        bail!("{name} has HTML; write it in Markdown");
    }
    let mut rest = prose.as_str();
    while let Some(at) = rest.find("![") {
        rest = &rest[at + 2..];
        let Some(open) = rest.find("](") else { break };
        let after = &rest[open + 2..];
        let Some(close) = after.find(')') else { break };
        let target = after[..close].split_whitespace().next().unwrap_or_default();
        ensure!(
            target.starts_with("media/")
                && super::manifest::inside(target)
                && folder.join(target).is_file(),
            "{name} shows {target}: an image of the README is a file in media/"
        );
        rest = &after[close..];
    }
    Ok(())
}

/// Checks what a package shows of its extension, and gives its card.
pub fn card(folder: &Path, manifest: &Manifest) -> Result<Card> {
    let identity = &manifest.extension;
    let mut card = Card {
        summary: identity.description.clone(),
        categories: identity.categories.clone(),
        keywords: identity.keywords.clone(),
        license: identity.license.clone(),
        links: manifest.links.clone(),
        ..Card::default()
    };
    for (path, dark) in [(&identity.icon, false), (&identity.icon_dark, true)] {
        let Some(path) = path else { continue };
        let found = asset(folder, path, "icon")?;
        let bytes = std::fs::read(folder.join(path))?;
        let size = png_size(&bytes).with_context(|| format!("{path} is not a PNG"))?;
        ensure!(
            size.0 == size.1 && (128..=1024).contains(&size.0),
            "{path} is {}×{}: an icon is square, 128 to 1024 pixels, 512 best",
            size.0,
            size.1
        );
        ensure!(found.size <= ICON_BYTES, "{path} is larger than 256 KB");
        if dark {
            card.icon_dark = Some(found);
        } else {
            card.icon = Some(found);
        }
    }
    let media = folder.join("media");
    if media.is_dir() {
        let mut names: Vec<String> = std::fs::read_dir(&media)?
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| !name.starts_with('.'))
            .collect();
        names.sort();
        let (mut images, mut videos) = (0, 0);
        for name in names {
            let path = format!("media/{name}");
            let bytes = std::fs::read(folder.join(&path))?;
            let size = bytes.len() as u64;
            if image(&bytes) {
                images += 1;
                ensure!(size <= IMAGE_BYTES, "{path} is larger than 2 MB");
                card.media.push(asset(folder, &path, "image")?);
            } else if mp4(&bytes) && name.to_ascii_lowercase().ends_with(".mp4") {
                videos += 1;
                ensure!(size <= VIDEO_BYTES, "{path} is larger than 50 MB");
                card.media.push(asset(folder, &path, "video")?);
            } else {
                bail!("{path} is not a PNG, JPEG or WebP image, or an MP4 video");
            }
        }
        ensure!(
            images <= IMAGES,
            "media/ has {images} images; up to {IMAGES}"
        );
        ensure!(videos <= 1, "media/ has {videos} videos; one at most");
    }
    for (name, readme) in [("README.md", true), ("CHANGELOG.md", false)] {
        let path = folder.join(name);
        if !path.is_file() {
            continue;
        }
        let found = asset(folder, name, "text")?;
        ensure!(found.size <= TEXT_BYTES, "{name} is larger than 256 KB");
        let text =
            std::fs::read_to_string(&path).with_context(|| format!("{name} is not UTF-8 text"))?;
        check_markdown(folder, name, &text)?;
        if readme {
            card.readme = Some(found);
        } else {
            card.changelog = Some(found);
        }
    }
    Ok(card)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(side: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        bytes.extend(side.to_be_bytes());
        bytes.extend(side.to_be_bytes());
        bytes.extend([8, 6, 0, 0, 0]);
        bytes
    }

    fn manifest(extra: &str) -> Manifest {
        Manifest::parse(&format!(
            "[extension]\nid = \"acme.notes\"\nname = \"Notes\"\nversion = \"0.0.1\"\npublisher = \"acme\"\ndescription = \"Notes\"\n{extra}\n[process]\ncommand = [\"bun\", \"main.ts\"]\n"
        ))
        .unwrap()
    }

    #[test]
    fn a_card_holds_what_the_package_shows_each_by_its_digest() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path();
        std::fs::write(folder.join("icon.png"), png(512)).unwrap();
        std::fs::create_dir_all(folder.join("media")).unwrap();
        std::fs::write(folder.join("media/1.png"), png(1000)).unwrap();
        let mut video = vec![0, 0, 0, 24];
        video.extend(b"ftypisom0000");
        std::fs::write(folder.join("media/2.mp4"), &video).unwrap();
        std::fs::write(
            folder.join("README.md"),
            "# Notes\n\n![A note](media/1.png)\n\n```html\n<div>code</div>\n```\nSee <https://example.com>.\n",
        )
        .unwrap();
        let manifest = manifest(
            "icon = \"icon.png\"\ncategories = [\"knowledge\"]\nkeywords = [\"notes\"]\nlicense = \"MIT\"",
        );
        let card = card(folder, &manifest).unwrap();
        assert_eq!(card.categories, ["knowledge"]);
        assert_eq!(card.icon.as_ref().unwrap().kind, "icon");
        assert_eq!(
            card.media
                .iter()
                .map(|m| m.kind.as_str())
                .collect::<Vec<_>>(),
            ["image", "video"]
        );
        assert_eq!(
            card.readme.as_ref().unwrap().sha256,
            super::super::package::sha256(&std::fs::read(folder.join("README.md")).unwrap())
        );
        assert_eq!(card.assets().count(), 4);

        // What a card does not take.
        std::fs::write(folder.join("README.md"), "<script>alert(1)</script>").unwrap();
        assert!(super::card(folder, &manifest).is_err());
        std::fs::write(
            folder.join("README.md"),
            "![x](https://tracker.example/x.png)",
        )
        .unwrap();
        assert!(super::card(folder, &manifest).is_err());
        std::fs::write(folder.join("README.md"), "# Notes").unwrap();
        std::fs::write(folder.join("media/3.webm"), b"\x1aE\xdf\xa3webm").unwrap();
        assert!(super::card(folder, &manifest).is_err());
        std::fs::remove_file(folder.join("media/3.webm")).unwrap();
        let mut wide = png(512);
        wide[16..20].copy_from_slice(&600u32.to_be_bytes());
        std::fs::write(folder.join("icon.png"), wide).unwrap();
        assert!(super::card(folder, &manifest).is_err());
    }

    #[test]
    fn categories_keywords_and_links_are_checked() {
        let parse = |extra: &str| {
            Manifest::parse(&format!(
                "[extension]\nid = \"acme.notes\"\nname = \"Notes\"\nversion = \"0.0.1\"\npublisher = \"acme\"\n{extra}\n[process]\ncommand = [\"bun\"]\n"
            ))
        };
        assert!(parse("categories = [\"files-storage\", \"knowledge\"]").is_ok());
        assert!(parse("categories = [\"storage\"]").is_err());
        assert!(parse("categories = [\"other\", \"knowledge\", \"automation\"]").is_err());
        assert!(parse("keywords = [\"a\", \"b\", \"c\", \"d\", \"e\"]").is_err());
        assert!(parse("icon = \"../icon.png\"").is_err());
        let with_links = |link: &str| {
            Manifest::parse(&format!(
                "[extension]\nid = \"acme.notes\"\nname = \"Notes\"\nversion = \"0.0.1\"\npublisher = \"acme\"\n[process]\ncommand = [\"bun\"]\n[links]\nhomepage = \"{link}\"\n"
            ))
        };
        assert!(with_links("https://acme.example").is_ok());
        assert!(with_links("http://acme.example").is_err());
    }
}
