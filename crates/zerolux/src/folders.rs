//! The folders of the kernel's computer, for its person to choose one from where they are:
//! a folder for a Storage location, a session's working folder.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::store::Error;

/// The most folders one listing gives.
const LISTED: usize = 5_000;

/// The person's home on this computer.
pub fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// The folders inside `path`, or inside the home without one: each `{name, path, hidden}`,
/// in order of name, with the folder itself, its parent and the home.
pub fn list(path: Option<&str>) -> Result<Value, Error> {
    let asked = match path.map(str::trim).filter(|path| !path.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => home().ok_or_else(|| Error::Invalid("This computer has no home folder".into()))?,
    };
    if !asked.is_absolute() {
        return Err(Error::Invalid("Give a folder's full path".into()));
    }
    let folder = dunce::canonicalize(&asked).map_err(|_| Error::NotFound)?;
    if !folder.is_dir() {
        return Err(Error::Invalid(format!(
            "{} is not a folder",
            folder.display()
        )));
    }
    let entries = std::fs::read_dir(&folder)
        .map_err(|error| Error::Invalid(format!("{} cannot be read: {error}", folder.display())))?;
    let mut folders: Vec<(String, PathBuf)> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().into_string().ok()?;
            // A link to a folder is a folder to choose too.
            entry.path().is_dir().then(|| (name, entry.path()))
        })
        .collect();
    folders.sort_by_key(|(name, _)| name.to_lowercase());
    let truncated = folders.len() > LISTED;
    folders.truncate(LISTED);
    let shown = |path: &Path| path.to_string_lossy().into_owned();
    Ok(json!({
        "path": shown(&folder),
        "name": folder.file_name().map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| shown(&folder)),
        "parent": folder.parent().map(shown),
        "home": home().map(|home| shown(&home)),
        "folders": folders.iter().map(|(name, path)| json!({
            "name": name, "path": shown(path), "hidden": name.starts_with('.'),
        })).collect::<Vec<_>>(),
        "truncated": truncated,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_lists_the_folders_in_it_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join("Projects/zerolux")).unwrap();
        std::fs::create_dir_all(root.join(".config")).unwrap();
        std::fs::create_dir_all(root.join("archive")).unwrap();
        std::fs::write(root.join("notes.txt"), "a file").unwrap();
        let listed = list(Some(&root.to_string_lossy())).unwrap();
        let names: Vec<&str> = listed["folders"]
            .as_array()
            .unwrap()
            .iter()
            .map(|folder| folder["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, [".config", "archive", "Projects"]);
        assert_eq!(listed["folders"][0]["hidden"], true);
        assert_eq!(
            listed["parent"],
            root.parent().unwrap().to_string_lossy().as_ref()
        );
        let inside = list(Some(&root.join("Projects").to_string_lossy())).unwrap();
        assert_eq!(inside["folders"][0]["name"], "zerolux");
        assert!(matches!(
            list(Some("relative/path")),
            Err(Error::Invalid(_))
        ));
        assert!(matches!(
            list(Some(&root.join("missing").to_string_lossy())),
            Err(Error::NotFound)
        ));
        assert!(matches!(
            list(Some(&root.join("notes.txt").to_string_lossy())),
            Err(Error::Invalid(_))
        ));
    }
}
