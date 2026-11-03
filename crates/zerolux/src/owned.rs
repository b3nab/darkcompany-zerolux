//! The processes the kernel runs while it runs, each with everything it starts in turn.
//!
//! Each runs in a tree of its own, made with process-wrap: a process group on Unix, a job
//! object on Windows. Stopping one asks the whole tree to end, then ends what is left: also
//! what its first process started before it ended. Dropping one ends its tree at once.
//!
//! On Windows the job ends with the kernel, however the kernel ends. On Unix nothing ends a
//! tree with its owner, so each tree has a watcher of its own: a small shell in the tree's
//! process group, holding one end of a pipe whose other end only the kernel holds. Told that
//! the tree is done, it leaves; when the pipe closes without that, the kernel has ended,
//! however it ended, and the watcher ends the whole group. Its being in the group keeps the
//! group's number from going to anything else meanwhile. The kernel also keeps a note of its
//! trees on this computer: the next kernel to start ends those whose first process is still
//! the same process, by its start time, should a watcher have been ended too.

use std::{io, process::ExitStatus, time::Duration};

use process_wrap::tokio::{ChildWrapper, CommandWrap};
use tokio::process::{ChildStdin, ChildStdout, Command};

/// A process the kernel started, with what it starts.
#[derive(Debug)]
pub struct Owned {
    child: Box<dyn ChildWrapper>,
    /// Its first process, which leads its tree: kept, since a process waited for has no ID.
    pid: Option<u32>,
    /// Its tree has been ended: nothing of it is signalled again.
    ended: bool,
    /// The pipe its watcher holds the other end of.
    #[cfg(unix)]
    tether: Option<std::io::PipeWriter>,
}

impl Owned {
    /// Starts `command` in a tree of its own.
    pub fn spawn(command: Command) -> io::Result<Self> {
        let mut command = CommandWrap::from(command);
        #[cfg(unix)]
        command.wrap(process_wrap::tokio::ProcessGroup::leader());
        #[cfg(windows)]
        command
            .wrap(process_wrap::tokio::JobObject)
            .wrap(process_wrap::tokio::KillOnDrop);
        let child = command.spawn()?;
        let pid = child.id();
        #[cfg(unix)]
        if let Some(pid) = pid {
            note::add(pid);
        }
        Ok(Self {
            #[cfg(unix)]
            tether: pid.and_then(|pid| tether(pid).ok()),
            child,
            pid,
            ended: false,
        })
    }

    pub fn id(&self) -> Option<u32> {
        self.pid
    }

    pub fn stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin().take()
    }

    pub fn stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout().take()
    }

    /// Waits for its first process to end. What that process started may still run.
    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        self.child.wait().await
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    /// Ends its whole tree: asked first (SIGTERM on Unix) and given `grace`, then forced.
    pub async fn stop(&mut self, grace: Duration) {
        if self.ended {
            return;
        }
        #[cfg(unix)]
        self.untether();
        #[cfg(unix)]
        let _ = self.child.signal(nix::libc::SIGTERM);
        let _ = tokio::time::timeout(grace, self.whole_tree_ended()).await;
        self.end();
        let _ = self.child.wait().await;
    }

    /// Forces its whole tree to end, without waiting.
    fn end(&mut self) {
        if self.ended {
            return;
        }
        #[cfg(unix)]
        self.untether();
        let _ = self.child.start_kill();
        self.ended = true;
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            note::remove(pid);
        }
    }

    /// Tells its watcher that the kernel ends the tree itself.
    #[cfg(unix)]
    fn untether(&mut self) {
        use std::io::Write;
        if let Some(mut tether) = self.tether.take() {
            let _ = tether.write_all(b"done\n");
        }
    }

    /// Until no process of its tree runs.
    async fn whole_tree_ended(&mut self) {
        let _ = self.child.wait().await;
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            while group_alive(pid) {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        self.end();
    }
}

/// What a tree's watcher runs, in the tree's group, with the pipe on its input: it ignores the
/// signals the kernel sends the group, and leaves when told the tree is done. When the pipe
/// closes without that, it asks the whole group to end, then forces it. It runs in the
/// background of a shell that leaves at once, so it is no child of the kernel's.
#[cfg(unix)]
const WATCHER: &str = "exec 3<&0; (trap '' TERM INT HUP; IFS= read -r said <&3; \
    [ \"$said\" = done ] && exit 0; kill -TERM 0; sleep 3; kill -KILL 0) & exit 0";

/// A watcher for the tree led by `pid`: the end of the pipe the kernel keeps.
#[cfg(unix)]
fn tether(pid: u32) -> io::Result<std::io::PipeWriter> {
    let (read, write) = std::io::pipe()?;
    let pgid = i32::try_from(pid).map_err(io::Error::other)?;
    let mut shell = std::process::Command::new("/bin/sh");
    std::os::unix::process::CommandExt::process_group(&mut shell, pgid);
    let status = shell
        .args(["-c", WATCHER])
        .stdin(read)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;
    if !status.success() {
        return Err(io::Error::other("The tree's watcher did not start"));
    }
    Ok(write)
}

/// Whether a process of the group led by `pid` still runs.
#[cfg(unix)]
fn group_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pid), None).is_ok()
}

/// Ends, in its next kernel, the trees a kernel left running on this computer.
pub async fn end_left_behind() {
    #[cfg(unix)]
    if let Some(folder) = note::folder() {
        note::end_left_behind_in(&folder).await;
    }
}

/// The note of this kernel's trees: one file per kernel, named by its process ID and start
/// time, listing the first process of each tree with its start time. A kernel removes its
/// trees from it as it ends them.
#[cfg(unix)]
mod note {
    use std::{
        path::{Path, PathBuf},
        sync::{LazyLock, Mutex},
        time::Duration,
    };

    use serde::{Deserialize, Serialize};

    #[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
    pub(super) struct Tree {
        pub pid: u32,
        pub started: u64,
    }

    /// This kernel's file, and its trees.
    pub(super) static NOTE: LazyLock<Mutex<(Option<PathBuf>, Vec<Tree>)>> = LazyLock::new(|| {
        let file = folder()
            .zip(started(std::process::id()))
            .map(|(folder, started)| folder.join(format!("{}-{started}.json", std::process::id())));
        Mutex::new((file, Vec::new()))
    });

    /// Where the kernels of this computer's user keep their notes.
    pub(super) fn folder() -> Option<PathBuf> {
        let user = nix::unistd::getuid();
        Some(std::env::temp_dir().join(format!("zerolux-trees-{user}")))
    }

    pub(super) fn add(pid: u32) {
        let Some(started) = started(pid) else {
            return;
        };
        let mut note = NOTE.lock().expect("trees note");
        note.1.push(Tree { pid, started });
        write(&note.0, &note.1);
    }

    pub(super) fn remove(pid: u32) {
        let mut note = NOTE.lock().expect("trees note");
        let before = note.1.len();
        note.1.retain(|tree| tree.pid != pid);
        if note.1.len() != before {
            write(&note.0, &note.1);
        }
    }

    fn write(file: &Option<PathBuf>, trees: &[Tree]) {
        let Some(file) = file else {
            return;
        };
        if trees.is_empty() {
            let _ = std::fs::remove_file(file);
            return;
        }
        let Some(folder) = file.parent() else {
            return;
        };
        if crate::platform::private_dir(folder).is_err() {
            return;
        }
        let written = file.with_extension("tmp");
        if std::fs::write(&written, serde_json::to_vec(trees).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&written, file);
        }
    }

    /// Ends the trees of the kernels whose notes are in `folder` and that no longer run.
    pub(super) async fn end_left_behind_in(folder: &Path) {
        let Ok(entries) = std::fs::read_dir(folder) else {
            return;
        };
        let mut left = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let Some((pid, started_at)) = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .filter(|_| path.extension().is_some_and(|ext| ext == "json"))
                .and_then(|stem| stem.split_once('-'))
                .and_then(|(pid, at)| Some((pid.parse().ok()?, at.parse().ok()?)))
            else {
                continue;
            };
            // A kernel that still runs keeps its trees.
            if started(pid) == Some(started_at) {
                continue;
            }
            if let Ok(text) = std::fs::read(&path)
                && let Ok(trees) = serde_json::from_slice::<Vec<Tree>>(&text)
            {
                left.extend(trees);
            }
            let _ = std::fs::remove_file(&path);
        }
        // Only a first process that is still the same process: a number given to another
        // process since is never signalled.
        let same = |tree: &Tree| started(tree.pid) == Some(tree.started);
        let signal = |tree: &Tree, signal| {
            if let Ok(pid) = i32::try_from(tree.pid) {
                let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pid), signal);
            }
        };
        left.retain(same);
        for tree in &left {
            signal(tree, nix::sys::signal::Signal::SIGTERM);
        }
        for _ in 0..60 {
            left.retain(same);
            if left.is_empty() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        for tree in left.iter().filter(|tree| same(tree)) {
            signal(tree, nix::sys::signal::Signal::SIGKILL);
        }
    }

    /// When the process `pid` started, in microseconds: two processes given the same number
    /// never share it.
    #[cfg(target_os = "macos")]
    pub(super) fn started(pid: u32) -> Option<u64> {
        use nix::libc;
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        // SAFETY: the buffer is a `proc_bsdinfo` of the size given.
        let read = unsafe {
            libc::proc_pidinfo(
                i32::try_from(pid).ok()?,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        (read == size).then(|| info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
    }

    /// When the process `pid` started, in clock ticks since the computer started.
    #[cfg(not(target_os = "macos"))]
    pub(super) fn started(pid: u32) -> Option<u64> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // The name, in parentheses, may hold spaces; the start time is the 22nd field.
        let (_, after) = stat.rsplit_once(')')?;
        after.split_whitespace().nth(19)?.parse().ok()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn leader(command: &str) -> std::process::Child {
            use std::os::unix::process::CommandExt;
            std::process::Command::new("/bin/sh")
                .args(["-c", command])
                .process_group(0)
                .spawn()
                .unwrap()
        }

        fn gone(pid: u32) -> bool {
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None).is_err()
        }

        #[tokio::test]
        async fn trees_a_kernel_left_running_end_when_their_first_process_is_the_same() {
            let folder = tempfile::tempdir().unwrap();
            // A kernel that ended: a process that has already ended.
            let mut ended = std::process::Command::new("/bin/sh")
                .args(["-c", "exit 0"])
                .spawn()
                .unwrap();
            let owner = ended.id();
            ended.wait().unwrap();
            let mut left = leader("sleep 600");
            let mut other = leader("sleep 600");
            let trees = [
                Tree {
                    pid: left.id(),
                    started: started(left.id()).unwrap(),
                },
                // Its number now belongs to another process.
                Tree {
                    pid: other.id(),
                    started: started(other.id()).unwrap() + 1,
                },
            ];
            std::fs::write(
                folder.path().join(format!("{owner}-1.json")),
                serde_json::to_vec(&trees).unwrap(),
            )
            .unwrap();
            // A kernel that still runs: this one.
            let mut kept = leader("sleep 600");
            let mine = std::process::id();
            std::fs::write(
                folder
                    .path()
                    .join(format!("{mine}-{}.json", started(mine).unwrap())),
                serde_json::to_vec(&[Tree {
                    pid: kept.id(),
                    started: started(kept.id()).unwrap(),
                }])
                .unwrap(),
            )
            .unwrap();

            end_left_behind_in(folder.path()).await;

            assert!(left.wait().is_ok());
            assert!(other.try_wait().unwrap().is_none());
            assert!(kept.try_wait().unwrap().is_none());
            for child in [&mut other, &mut kept] {
                child.kill().unwrap();
                child.wait().unwrap();
            }
            assert!(gone(left.id()));
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// A tree whose first process starts another and ends: the other's process ID.
    async fn tree() -> (Owned, u32) {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "sleep 600 >/dev/null 2>&1 & echo $!"])
            .stdout(std::process::Stdio::piped());
        let mut owned = Owned::spawn(command).unwrap();
        let mut out = String::new();
        tokio::io::AsyncReadExt::read_to_string(&mut owned.stdout().unwrap(), &mut out)
            .await
            .unwrap();
        (owned, out.trim().parse().unwrap())
    }

    fn noted(pid: u32) -> bool {
        let note = note::NOTE.lock().unwrap();
        note.1.iter().any(|tree| tree.pid == pid)
    }

    async fn ends(pid: u32) -> bool {
        for _ in 0..100 {
            if nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None).is_err() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }

    #[tokio::test]
    async fn stopping_a_process_ends_what_it_started_after_it_ended() {
        let (mut owned, started) = tree().await;
        let leader = owned.id().unwrap();
        assert!(noted(leader));
        owned.wait().await.unwrap();
        assert!(nix::sys::signal::kill(nix::unistd::Pid::from_raw(started as i32), None).is_ok());
        owned.stop(Duration::from_secs(1)).await;
        assert!(ends(started).await);
        // Ended, it leaves the note: a kernel that starts later has nothing of it to end.
        assert!(!noted(leader));
    }

    #[tokio::test]
    async fn a_tree_ends_when_its_kernel_ends_without_stopping_it() {
        let (mut owned, started) = tree().await;
        // The kernel ends however it ends: its end of the pipe closes, nothing more is said.
        drop(owned.tether.take());
        std::mem::forget(owned);
        assert!(ends(started).await);
    }

    #[tokio::test]
    async fn a_stopped_tree_ends_without_waiting_for_its_watcher() {
        let (mut owned, started) = tree().await;
        let begun = std::time::Instant::now();
        owned.stop(Duration::from_secs(10)).await;
        assert!(ends(started).await);
        assert!(begun.elapsed() < Duration::from_secs(3));
        assert!(!group_alive(owned.id().unwrap()));
    }

    #[tokio::test]
    async fn dropping_a_process_ends_what_it_started() {
        let (owned, started) = tree().await;
        drop(owned);
        assert!(ends(started).await);
    }
}
