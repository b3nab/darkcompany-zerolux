//! The images a session's agent names in what it writes, as `/tmp/run/browser.png`: read on the
//! session's own computer, for its people to see them where they are named.
//!
//! Whoever can give the session work can have its agent read any file of that computer, so they
//! see any image there; whoever can only read the session sees those of its folder. Only a
//! regular file whose extension names an image is read, and its type is the extension's, never
//! what its bytes claim.

use std::path::{Path, PathBuf};

use anyhow::Result;
use base64::Engine;
use serde_json::{Value, json};

use crate::store::Error;

/// As large as an image a person looks at gets.
const LARGEST: u64 = 25 * 1024 * 1024;

pub struct Media {
    pub bytes: Vec<u8>,
    pub media_type: &'static str,
    /// Changes whenever the file does: a file written again at the same path is shown anew.
    pub tag: String,
}

/// Each extension an image may have, with its type.
const TYPES: [(&str, &str); 7] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("avif", "image/avif"),
    ("bmp", "image/bmp"),
];

/// The image type its extension names; anything else is no image.
fn media_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    TYPES
        .iter()
        .find(|(known, _)| *known == extension)
        .map(|(_, kind)| *kind)
}

/// Where a path an agent wrote points: absolute, `~/…`, `file://…`, or from the session's folder.
fn resolve(folder: &Path, written: &str) -> Option<PathBuf> {
    let written = written.trim();
    if written.is_empty() || written.contains('\0') {
        return None;
    }
    if written.starts_with("file:") {
        return url::Url::parse(written).ok()?.to_file_path().ok();
    }
    if let Some(rest) = written.strip_prefix("~/") {
        return Some(PathBuf::from(std::env::var_os("HOME")?).join(rest));
    }
    let path = Path::new(written);
    Some(if path.is_absolute() {
        path.to_owned()
    } else {
        folder.join(path)
    })
}

/// The image at `written`, for someone who sees any image of this computer (`anywhere`) or only
/// those of the session's folder. What is not there, or not theirs to see, is not found.
pub async fn read(folder: &Path, written: &str, anywhere: bool) -> Result<Media> {
    let path = resolve(folder, written).ok_or(Error::NotFound)?;
    let media_type = media_type(&path)
        .ok_or_else(|| Error::Invalid("Name a PNG, JPEG, GIF, WebP, AVIF or BMP image".into()))?;
    let real = dunce::canonicalize(&path).map_err(|_| Error::NotFound)?;
    if !anywhere && !real.starts_with(dunce::canonicalize(folder).map_err(|_| Error::NotFound)?) {
        return Err(Error::NotFound.into());
    }
    let file = tokio::fs::File::open(&real)
        .await
        .map_err(|_| Error::NotFound)?;
    // The file opened is the one measured and read, even if the path changes meanwhile.
    let meta = file.metadata().await.map_err(|_| Error::NotFound)?;
    if !meta.is_file() {
        return Err(Error::NotFound.into());
    }
    if meta.len() > LARGEST {
        return Err(Error::Invalid("The image is larger than 25 MB".into()).into());
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    tokio::io::AsyncReadExt::read_to_end(
        &mut tokio::io::AsyncReadExt::take(file, LARGEST),
        &mut bytes,
    )
    .await?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |at| at.as_nanos());
    Ok(Media {
        tag: format!("\"{:x}-{modified:x}\"", bytes.len()),
        bytes,
        media_type,
    })
}

/// [`read`] for another computer's kernel: the image as JSON.
pub async fn read_json(folder: &Path, written: &str, anywhere: bool) -> Result<Value> {
    let media = read(folder, written, anywhere).await?;
    Ok(json!({
        "media_type": media.media_type,
        "tag": media.tag,
        "data": base64::engine::general_purpose::STANDARD.encode(&media.bytes),
    }))
}

/// The image [`read_json`] carried.
pub fn from_json(value: &Value) -> Result<Media> {
    let media_type = TYPES
        .iter()
        .map(|(_, kind)| *kind)
        .find(|kind| value["media_type"] == *kind)
        .ok_or(Error::NotFound)?;
    Ok(Media {
        bytes: base64::engine::general_purpose::STANDARD
            .decode(value["data"].as_str().ok_or(Error::NotFound)?)?,
        media_type,
        tag: value["tag"].as_str().unwrap_or_default().to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn a_written_path_points_where_the_agent_meant() {
        let folder = Path::new("/work");
        assert_eq!(
            resolve(folder, "/tmp/a.png").unwrap(),
            Path::new("/tmp/a.png")
        );
        assert_eq!(
            resolve(folder, "shots/a.png").unwrap(),
            Path::new("/work/shots/a.png")
        );
        assert_eq!(
            resolve(folder, "file:///tmp/a%20b.png").unwrap(),
            Path::new("/tmp/a b.png")
        );
        assert!(resolve(folder, "").is_none());
        assert!(resolve(folder, "a\0.png").is_none());
    }
}
