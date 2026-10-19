//! The code in a session's folder: what git says has changed, the changes themselves, a
//! file's text, and the owner's git actions on them.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Serialize;

use crate::store::Error;

/// A diff or a file the Console shows at most.
const SHOWN: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    /// The branch checked out; none when HEAD is detached.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changes: Vec<Change>,
}

/// A changed path, with git's two letters: the index's and the working tree's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Change {
    pub path: String,
    /// Where a renamed or copied file came from.
    pub from: Option<String>,
    pub staged: String,
    pub unstaged: String,
}

/// `git` in `folder`, bounded; its own message on failure.
async fn git(folder: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        tokio::process::Command::new("git")
            .arg("-C")
            .arg(folder)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .context("git timed out")?
    .context("Cannot run git")?;
    // `git diff --no-index` exits 1 when the files differ.
    if !output.status.success()
        && !(output.status.code() == Some(1) && args.contains(&"--no-index"))
    {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(Error::Invalid(if message.is_empty() {
            "git failed".into()
        } else {
            message
        })
        .into());
    }
    Ok(output.stdout)
}

/// The commit checked out.
pub async fn head(folder: &Path) -> Result<String> {
    Ok(
        String::from_utf8_lossy(&git(folder, &["rev-parse", "HEAD"]).await?)
            .trim()
            .to_owned(),
    )
}

/// The branch checked out, or `HEAD` when it is detached.
pub async fn branch(folder: &Path) -> Result<String> {
    Ok(
        String::from_utf8_lossy(&git(folder, &["rev-parse", "--abbrev-ref", "HEAD"]).await?)
            .trim()
            .to_owned(),
    )
}

/// What git says about the folder's repository.
pub async fn status(folder: &Path) -> Result<Status> {
    // Each untracked file on its own, never a folder of them.
    let out = git(
        folder,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
            "-z",
        ],
    )
    .await?;
    Ok(parse_status(&String::from_utf8_lossy(&out)))
}

fn parse_status(out: &str) -> Status {
    let mut status = Status {
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        changes: Vec::new(),
    };
    let mut fields = out.split('\0').filter(|field| !field.is_empty());
    while let Some(field) = fields.next() {
        let mut parts = field.splitn(2, ' ');
        let (kind, rest) = (
            parts.next().unwrap_or_default(),
            parts.next().unwrap_or_default(),
        );
        match kind {
            "#" => {
                let mut header = rest.splitn(2, ' ');
                match (header.next(), header.next()) {
                    (Some("branch.head"), Some(head)) if head != "(detached)" => {
                        status.branch = Some(head.to_owned())
                    }
                    (Some("branch.upstream"), Some(upstream)) => {
                        status.upstream = Some(upstream.to_owned())
                    }
                    (Some("branch.ab"), Some(counts)) => {
                        for count in counts.split(' ') {
                            if let Some(ahead) = count.strip_prefix('+') {
                                status.ahead = ahead.parse().unwrap_or_default();
                            } else if let Some(behind) = count.strip_prefix('-') {
                                status.behind = behind.parse().unwrap_or_default();
                            }
                        }
                    }
                    _ => {}
                }
            }
            // Ordinary, renamed or copied (its origin is the next field), and unmerged.
            "1" | "2" | "u" => {
                let skip = match kind {
                    "1" => 7,
                    "2" => 8,
                    _ => 9,
                };
                let columns: Vec<&str> = rest.splitn(skip + 1, ' ').collect();
                let letters = columns.first().copied().unwrap_or("..");
                let path = columns.get(skip).copied().unwrap_or_default().to_owned();
                let from = (kind == "2").then(|| fields.next().unwrap_or_default().to_owned());
                status.changes.push(Change {
                    path,
                    from,
                    staged: letters.chars().next().unwrap_or('.').to_string(),
                    unstaged: letters.chars().nth(1).unwrap_or('.').to_string(),
                });
            }
            "?" => status.changes.push(Change {
                path: rest.to_owned(),
                from: None,
                staged: ".".into(),
                unstaged: "?".into(),
            }),
            _ => {}
        }
    }
    status
}

/// A path the owner names, inside the folder.
fn inside(folder: &Path, path: &str) -> Result<PathBuf> {
    let relative = Path::new(path);
    if path.is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(Error::Invalid("Name a path inside the session's folder".into()).into());
    }
    Ok(folder.join(relative))
}

/// The changes git sees, for a path or all of them: those not staged yet, or the staged ones.
/// An untracked file shows as added whole.
pub async fn diff(folder: &Path, path: Option<&str>, staged: bool) -> Result<String> {
    let mut args = vec!["diff", "--no-color", "--no-ext-diff"];
    if staged {
        args.push("--cached");
    }
    let mut out = match path {
        Some(path) => {
            inside(folder, path)?;
            let untracked = !staged
                && git(folder, &["ls-files", "--error-unmatch", "--", path])
                    .await
                    .is_err();
            if untracked {
                git(
                    folder,
                    &["diff", "--no-color", "--no-index", "--", "/dev/null", path],
                )
                .await?
            } else {
                args.extend(["--", path]);
                git(folder, &args).await?
            }
        }
        None => git(folder, &args).await?,
    };
    out.truncate(SHOWN);
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// A file's text, as it is in the folder now.
pub async fn file(folder: &Path, path: &str) -> Result<String> {
    let full = inside(folder, path)?;
    let canonical = dunce::canonicalize(&full).map_err(|_| Error::NotFound)?;
    if !canonical.starts_with(dunce::canonicalize(folder)?) {
        return Err(Error::Invalid("Name a path inside the session's folder".into()).into());
    }
    let bytes = tokio::fs::read(&canonical)
        .await
        .map_err(|_| Error::NotFound)?;
    if bytes.len() > SHOWN {
        return Err(Error::Invalid("The file is too large to show".into()).into());
    }
    String::from_utf8(bytes).map_err(|_| Error::Invalid("The file is not text".into()).into())
}

/// Paths the owner acts on, each inside the folder.
fn paths<'a>(folder: &Path, paths: &'a [String]) -> Result<Vec<&'a str>> {
    if paths.is_empty() || paths.len() > 1_000 {
        return Err(Error::Invalid("Name from 1 to 1,000 paths".into()).into());
    }
    paths
        .iter()
        .map(|path| inside(folder, path).map(|_| path.as_str()))
        .collect()
}

/// Stages the paths' changes for the next commit.
pub async fn stage(folder: &Path, names: &[String]) -> Result<()> {
    let names = paths(folder, names)?;
    git(folder, &[&["add", "--"][..], &names].concat()).await?;
    Ok(())
}

/// Takes the paths' changes out of the next commit; the working tree keeps them.
pub async fn unstage(folder: &Path, names: &[String]) -> Result<()> {
    let names = paths(folder, names)?;
    git(
        folder,
        &[&["restore", "--staged", "--"][..], &names].concat(),
    )
    .await?;
    Ok(())
}

/// Throws away the paths' changes that are not staged: a tracked file goes back to its staged
/// or committed version, an untracked one is removed.
pub async fn discard(folder: &Path, names: &[String]) -> Result<()> {
    let names = paths(folder, names)?;
    let mut tracked = Vec::new();
    for name in names {
        if git(folder, &["ls-files", "--error-unmatch", "--", name])
            .await
            .is_ok()
        {
            tracked.push(name);
        } else {
            git(folder, &["clean", "-f", "-q", "--", name]).await?;
        }
    }
    if !tracked.is_empty() {
        git(
            folder,
            &[&["restore", "--worktree", "--"][..], &tracked].concat(),
        )
        .await?;
    }
    Ok(())
}

/// Commits what is staged, with the owner's message; the new commit's ID.
pub async fn commit(folder: &Path, message: &str) -> Result<String> {
    let message = message.trim();
    if message.is_empty() || message.len() > 64 * 1024 {
        return Err(Error::Invalid("Write a commit message up to 64 KiB".into()).into());
    }
    git(folder, &["commit", "-q", "-m", message]).await?;
    let id = git(folder, &["rev-parse", "HEAD"]).await?;
    Ok(String::from_utf8_lossy(&id).trim().to_owned())
}

/// Pushes the branch; one without an upstream gets one on `origin`.
pub async fn push(folder: &Path) -> Result<()> {
    if status(folder).await?.upstream.is_some() {
        git(folder, &["push", "-q"]).await?;
    } else {
        git(folder, &["push", "-q", "--set-upstream", "origin", "HEAD"]).await?;
    }
    Ok(())
}

/// `gh` in `folder`, bounded; its output, or its own message on failure.
pub(crate) async fn gh(folder: &Path, args: &[&str]) -> Result<std::process::Output> {
    tokio::time::timeout(
        std::time::Duration::from_secs(60),
        tokio::process::Command::new("gh")
            .args(args)
            .current_dir(folder)
            .env("GH_PROMPT_DISABLED", "1")
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .context("gh timed out")?
    .map_err(|_| {
        Error::Invalid("Install GitHub's gh and sign in to it for pull requests".into()).into()
    })
}

/// The pull request of the branch, with its checks; none when there is none.
pub async fn pull_request(folder: &Path) -> Result<Option<serde_json::Value>> {
    let output = gh(
        folder,
        &[
            "pr",
            "view",
            "--json",
            "number,url,title,state,isDraft,mergeable,reviewDecision,statusCheckRollup,headRefName,baseRefName",
        ],
    )
    .await?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr);
        if message.contains("no pull requests found") {
            return Ok(None);
        }
        return Err(Error::Invalid(message.trim().to_owned()).into());
    }
    Ok(Some(serde_json::from_slice(&output.stdout)?))
}

/// Opens a pull request for the branch; its address.
pub async fn open_pull_request(
    folder: &Path,
    title: &str,
    body: &str,
    draft: bool,
) -> Result<String> {
    let title = title.trim();
    if title.is_empty() || title.len() > 1_000 || body.len() > 64 * 1024 {
        return Err(
            Error::Invalid("A title up to 1,000 bytes and a body up to 64 KiB".into()).into(),
        );
    }
    let mut args = vec!["pr", "create", "--title", title, "--body", body];
    if draft {
        args.push("--draft");
    }
    let output = gh(folder, &args).await?;
    if !output.status.success() {
        return Err(
            Error::Invalid(String::from_utf8_lossy(&output.stderr).trim().to_owned()).into(),
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .rev()
        .find(|line| line.starts_with("http"))
        .unwrap_or_default()
        .to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_status_reads_the_branch_and_every_kind_of_change() {
        let out = [
            "# branch.oid 1234",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -1",
            "1 .M N... 100644 100644 100644 aaa bbb src/lib.rs",
            "1 A. N... 000000 100644 100644 000 ccc docs/new file.md",
            "2 R. N... 100644 100644 100644 ddd eee R100 src/now.rs",
            "src/before.rs",
            "u UU N... 100644 100644 100644 100644 f g h conflict.txt",
            "? notes.txt",
        ]
        .join("\0");
        let status = parse_status(&out);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!((status.ahead, status.behind), (2, 1));
        let summary: Vec<_> = status
            .changes
            .iter()
            .map(|c| {
                (
                    c.path.as_str(),
                    c.from.as_deref(),
                    c.staged.as_str(),
                    c.unstaged.as_str(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                ("src/lib.rs", None, ".", "M"),
                ("docs/new file.md", None, "A", "."),
                ("src/now.rs", Some("src/before.rs"), "R", "."),
                ("conflict.txt", None, "U", "U"),
                ("notes.txt", None, ".", "?"),
            ]
        );
    }

    #[tokio::test]
    async fn changes_and_files_are_read_inside_the_folder_only() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path();
        git(folder, &["init", "-q", "-b", "main"]).await.unwrap();
        git(folder, &["config", "user.email", "fixture@example.test"])
            .await
            .unwrap();
        git(folder, &["config", "user.name", "Fixture"])
            .await
            .unwrap();
        // Files as written, whatever line endings this computer's git converts to.
        git(folder, &["config", "core.autocrlf", "false"])
            .await
            .unwrap();
        std::fs::write(folder.join("a.txt"), "one\n").unwrap();
        git(folder, &["add", "a.txt"]).await.unwrap();
        git(
            folder,
            &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "first"],
        )
        .await
        .unwrap();
        std::fs::write(folder.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(folder.join("b.txt"), "new\n").unwrap();
        std::fs::create_dir(folder.join("new")).unwrap();
        std::fs::write(folder.join("new/c.txt"), "deep\n").unwrap();
        let status = status(folder).await.unwrap();
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.changes.len(), 3);
        assert!(status.changes.iter().any(|c| c.path == "new/c.txt"));
        assert!(
            diff(folder, Some("new/c.txt"), false)
                .await
                .unwrap()
                .contains("+deep")
        );
        std::fs::remove_dir_all(folder.join("new")).unwrap();
        let changed = diff(folder, Some("a.txt"), false).await.unwrap();
        assert!(changed.contains("+two"));
        let added = diff(folder, Some("b.txt"), false).await.unwrap();
        assert!(added.contains("+new"));
        assert!(diff(folder, None, true).await.unwrap().is_empty());
        assert_eq!(file(folder, "a.txt").await.unwrap(), "one\ntwo\n");
        assert!(file(folder, "../outside").await.is_err());
        assert!(file(folder, "/etc/hosts").await.is_err());
        assert!(diff(folder, Some("../x"), false).await.is_err());
        // The owner stages, unstages, throws away and commits.
        stage(folder, &["a.txt".into()]).await.unwrap();
        assert!(diff(folder, None, true).await.unwrap().contains("+two"));
        unstage(folder, &["a.txt".into()]).await.unwrap();
        assert!(diff(folder, None, true).await.unwrap().is_empty());
        discard(folder, &["b.txt".into()]).await.unwrap();
        assert!(!folder.join("b.txt").exists());
        stage(folder, &["a.txt".into()]).await.unwrap();
        git(folder, &["config", "commit.gpgsign", "false"])
            .await
            .unwrap();
        let id = commit(folder, "second").await.unwrap();
        assert_eq!(id.len(), 40);
        assert!(super::status(folder).await.unwrap().changes.is_empty());
        std::fs::write(folder.join("a.txt"), "changed\n").unwrap();
        discard(folder, &["a.txt".into()]).await.unwrap();
        assert_eq!(file(folder, "a.txt").await.unwrap(), "one\ntwo\n");
        assert!(stage(folder, &["../escape".into()]).await.is_err());
        assert!(commit(folder, "  ").await.is_err());
    }
}
