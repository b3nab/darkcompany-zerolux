//! The files of a session's folder, for the owner to mention while writing to it.

use std::path::Path;

use anyhow::{Context, Result};

/// Files listed at most, and paths searched.
const LISTED: usize = 200;
const SEARCHED: usize = 50_000;

/// Paths relative to `folder` that match `query`, best first. In a git repository, the files
/// git tracks or would track; elsewhere, the folder's files, hidden ones aside.
pub async fn find(folder: &Path, query: &str, limit: usize) -> Result<Vec<String>> {
    let paths = match tracked(folder).await {
        Some(paths) => paths,
        None => {
            let folder = folder.to_owned();
            tokio::task::spawn_blocking(move || walk(&folder)).await??
        }
    };
    Ok(rank(paths, query, limit.min(LISTED)))
}

async fn tracked(folder: &Path) -> Option<Vec<String>> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio::process::Command::new("git")
            .arg("-C")
            .arg(folder)
            .args([
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(
        output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .take(SEARCHED)
            .map(|path| String::from_utf8_lossy(path).into_owned())
            .collect(),
    )
}

fn walk(folder: &Path) -> Result<Vec<String>> {
    let mut found = Vec::new();
    let mut pending = vec![folder.to_owned()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                pending.push(path);
            } else if kind.is_file() {
                found.push(
                    path.strip_prefix(folder)
                        .context("A file outside the folder")?
                        .to_string_lossy()
                        .into_owned(),
                );
                if found.len() == SEARCHED {
                    return Ok(found);
                }
            }
        }
    }
    Ok(found)
}

/// The paths whose letters contain the query's in order, ignoring case: those whose file
/// name does first, then the shorter ones.
fn rank(paths: Vec<String>, query: &str, limit: usize) -> Vec<String> {
    let query = query.trim().to_lowercase();
    let contains = |text: &str| {
        let mut letters = text.chars().flat_map(char::to_lowercase);
        query
            .chars()
            .all(|wanted| letters.any(|letter| letter == wanted))
    };
    let mut matched: Vec<(bool, usize, String)> = paths
        .into_iter()
        .filter(|path| contains(path))
        .map(|path| {
            let name = path.rsplit('/').next().unwrap_or(&path).to_owned();
            (!contains(&name), path.len(), path)
        })
        .collect();
    matched.sort();
    matched
        .into_iter()
        .take(limit)
        .map(|(_, _, path)| path)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_that_match_come_first_then_shorter_paths() {
        let paths = vec![
            "docs/chat.md".to_owned(),
            "crates/zerolux/src/chat.rs".to_owned(),
            "apps/web/src/ChatView.tsx".to_owned(),
            "README.md".to_owned(),
            "crates/zerolux/src/chat_runtime/control.rs".to_owned(),
        ];
        assert_eq!(
            rank(paths.clone(), "chat", 3),
            vec![
                "docs/chat.md",
                "apps/web/src/ChatView.tsx",
                "crates/zerolux/src/chat.rs"
            ]
        );
        assert_eq!(
            rank(paths.clone(), "crc", 10)[0],
            "crates/zerolux/src/chat.rs"
        );
        assert_eq!(rank(paths.clone(), "", 2).len(), 2);
        assert!(rank(paths, "zzz", 10).is_empty());
    }

    #[tokio::test]
    async fn a_folder_outside_git_lists_its_visible_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src/nested")).unwrap();
        std::fs::create_dir_all(dir.path().join(".hidden")).unwrap();
        std::fs::write(dir.path().join("src/nested/main.rs"), "").unwrap();
        std::fs::write(dir.path().join(".hidden/secret"), "").unwrap();
        std::fs::write(dir.path().join("notes.md"), "").unwrap();
        let mut found = find(dir.path(), "", 10).await.unwrap();
        found.sort();
        assert_eq!(found, vec!["notes.md", "src/nested/main.rs"]);
    }
}
