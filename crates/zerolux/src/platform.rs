//! What differs between Unix and Windows, in one place: whether a process is alive, starting
//! one that outlives the kernel, private files and folders, programs on the PATH and the local
//! endpoints of the hosts that run sessions (Unix sockets, Windows named pipes).

use std::{
    fs::{Metadata, OpenOptions},
    io,
    path::{Path, PathBuf},
    pin::Pin,
    task::{Context, Poll},
};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// Starts children without leaking kernel descriptors during macOS socket creation.
pub(crate) fn std_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    isolate_descriptors(&mut command);
    command
}

pub(crate) fn command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    std_command(program).into()
}

pub(crate) fn isolate_descriptors(command: &mut std::process::Command) {
    // macOS has no atomic socket(SOCK_CLOEXEC): another thread may spawn between socket()
    // and fcntl(FD_CLOEXEC). Rust's posix_spawn also omits CLOEXEC_DEFAULT. Mark the child's
    // own descriptors after fork, keeping stdio and Rust's exec-error pipe until exec.
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: close_fds uses async-signal-safe operations; nothing is allocated here.
        unsafe {
            command.pre_exec(|| {
                close_fds::set_fds_cloexec(3, &[]);
                Ok(())
            });
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = command;
}

/// A path's real form, without links or `..`. On Windows it is the form people write
/// (`C:\work`), not the extended one (`\\?\C:\work`) that processes and people do not expect.
pub trait Canonical {
    fn canonical(&self) -> io::Result<PathBuf>;
}

impl<P: AsRef<Path> + ?Sized> Canonical for P {
    fn canonical(&self) -> io::Result<PathBuf> {
        dunce::canonicalize(self)
    }
}

/// Whether a process with this ID exists. One that exists but cannot be asked about, such as
/// another user's, is alive: only its absence is evidence.
pub fn alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        let Ok(pid) = i32::try_from(pid) else {
            return false;
        };
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None)
            != Err(nix::errno::Errno::ESRCH)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, ERROR_ACCESS_DENIED, GetLastError, STILL_ACTIVE},
            System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        };
        // SAFETY: plain Win32 calls on a handle this function opens and closes.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return GetLastError() == ERROR_ACCESS_DENIED;
            }
            let mut code = 0u32;
            let asked = GetExitCodeProcess(process, &mut code);
            CloseHandle(process);
            asked == 0 || code == STILL_ACTIVE as u32
        }
    }
}

/// What a program started with a cleared environment still needs from the kernel's: where
/// programs are and the user's folders, and on Windows what its system needs to start one,
/// open a socket and find temporary files.
pub fn essential_env() -> Vec<(&'static str, std::ffi::OsString)> {
    let names: &[&str] = if cfg!(windows) {
        &[
            "PATH",
            "PATHEXT",
            "SystemRoot",
            "SystemDrive",
            "windir",
            "ComSpec",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "HOMEDRIVE",
            "HOMEPATH",
        ]
    } else {
        &["PATH", "HOME", "TMPDIR", "LANG", "USER"]
    };
    names
        .iter()
        .filter_map(|name| std::env::var_os(name).map(|value| (*name, value)))
        .collect()
}

/// Starts `command` on its own: it outlives the kernel and has no terminal.
pub fn detach(command: &mut tokio::process::Command) {
    isolate_descriptors(command.as_std_mut());
    #[cfg(unix)]
    // SAFETY: setsid is async-signal-safe; nothing else runs between fork and exec.
    unsafe {
        command.pre_exec(|| nix::unistd::setsid().map(|_| ()).map_err(io::Error::from));
    }
    #[cfg(windows)]
    {
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
}

/// Opens files only for their owner, never through a link planted at the path.
pub fn private(options: &mut OpenOptions) -> &mut OpenOptions {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(nix::libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT: a link is opened itself, and then refused as not a
        // regular file. A user's profile is private to them by its permissions.
        options.custom_flags(0x0020_0000);
    }
    options
}

/// Whether a file or folder is its owner's alone. On Windows the user's profile, where the
/// kernel keeps its data, is private by its permissions.
pub fn is_private(metadata: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o077 == 0
    }
    #[cfg(windows)]
    {
        let _ = metadata;
        true
    }
}

/// Makes it private to its owner.
pub fn make_private(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if std::fs::symlink_metadata(path)?.is_dir() {
            0o700
        } else {
            0o600
        };
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
    }
    #[cfg(windows)]
    {
        let _ = path;
        Ok(())
    }
}

/// Creates a private folder, with its parents, and checks it is one: not a link, not open
/// to others.
pub fn private_dir(path: &Path) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || !is_private(&metadata) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{} must be a private folder", path.display()),
        ));
    }
    Ok(())
}

/// Whether a file has other names: a hard link would let one file pass for two.
pub fn linked_elsewhere(metadata: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        metadata.nlink() > 1
    }
    #[cfg(windows)]
    {
        let _ = metadata;
        false
    }
}

/// Whether two readings of a path are of the same file, not one put in its place.
pub fn same_file(a: &Metadata, b: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (a.dev(), a.ino()) == (b.dev(), b.ino())
    }
    #[cfg(windows)]
    {
        a.created().ok() == b.created().ok()
    }
}

static CARRIED: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// The folder of the programs a release carries with the kernel, such as `bun` and
/// `livekit-server`: set once, by the release's kernel or the desktop app, before they run.
pub fn carry(folder: PathBuf) {
    let _ = CARRIED.set(folder);
}

/// The folder of what a release carries, once set.
pub fn carried() -> Option<&'static Path> {
    CARRIED.get().map(PathBuf::as_path)
}

/// A program: the one a release carries, or else the one the PATH finds (with the extensions
/// of `PATHEXT` on Windows); its name alone when there is neither.
pub fn executable(name: &str) -> PathBuf {
    let names: Vec<String> = if cfg!(windows) && Path::new(name).extension().is_none() {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .filter(|extension| !extension.is_empty())
            .map(|extension| format!("{name}{}", extension.to_ascii_lowercase()))
            .collect()
    } else {
        vec![name.to_owned()]
    };
    CARRIED
        .get()
        .cloned()
        .into_iter()
        .chain(
            std::env::var_os("PATH")
                .as_deref()
                .map(std::env::split_paths)
                .into_iter()
                .flatten(),
        )
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|path| path.is_file())
        .and_then(|path| path.canonical().ok())
        .unwrap_or_else(|| PathBuf::from(name))
}

/// A connection to a local endpoint: a Unix socket's path, or a Windows named pipe
/// (`\\.\pipe\…`).
pub enum Local {
    #[cfg(unix)]
    Socket(tokio::net::UnixStream),
    #[cfg(windows)]
    Pipe(tokio::net::windows::named_pipe::NamedPipeClient),
}

/// Whether an endpoint is a Windows named pipe.
pub fn is_pipe(endpoint: &str) -> bool {
    endpoint.starts_with(r"\\.\pipe\") || endpoint.starts_with(r"\\?\pipe\")
}

impl Local {
    pub async fn connect(endpoint: &str) -> io::Result<Self> {
        #[cfg(unix)]
        {
            Ok(Self::Socket(
                tokio::net::UnixStream::connect(endpoint).await?,
            ))
        }
        #[cfg(windows)]
        {
            use tokio::net::windows::named_pipe::ClientOptions;
            if !is_pipe(endpoint) {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "On Windows a local endpoint is a named pipe",
                ));
            }
            // Every instance busy: another one is created as soon as one is taken.
            for _ in 0..100 {
                match ClientOptions::new().open(endpoint) {
                    Ok(pipe) => return Ok(Self::Pipe(pipe)),
                    Err(error)
                        if error.raw_os_error()
                            == Some(windows_sys::Win32::Foundation::ERROR_PIPE_BUSY as i32) =>
                    {
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                    Err(error) => return Err(error),
                }
            }
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "The named pipe stayed busy",
            ))
        }
    }
}

impl AsyncRead for Local {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            Self::Socket(stream) => Pin::new(stream).poll_read(cx, buf),
            #[cfg(windows)]
            Self::Pipe(pipe) => Pin::new(pipe).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Local {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            #[cfg(unix)]
            Self::Socket(stream) => Pin::new(stream).poll_write(cx, buf),
            #[cfg(windows)]
            Self::Pipe(pipe) => Pin::new(pipe).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            Self::Socket(stream) => Pin::new(stream).poll_flush(cx),
            #[cfg(windows)]
            Self::Pipe(pipe) => Pin::new(pipe).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            Self::Socket(stream) => Pin::new(stream).poll_shutdown(cx),
            #[cfg(windows)]
            Self::Pipe(pipe) => Pin::new(pipe).poll_shutdown(cx),
        }
    }
}

#[cfg(test)]
pub(crate) async fn rebind_after_close(address: std::net::SocketAddr) -> tokio::net::TcpListener {
    use std::time::Duration;

    // Even after its owner closes a CLOEXEC descriptor, a concurrent fork may retain it
    // until exec or exit. Allow this OS handoff. In the inheritance regressions the child
    // stays alive throughout, so a leak past exec still fails.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match tokio::net::TcpListener::bind(address).await {
                Ok(listener) => return listener,
                Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(error) => panic!("{address}: {error}"),
            }
        }
    })
    .await
    .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn children_preserve_stdio_without_inheriting_listeners() {
        use std::{net::TcpListener, os::fd::AsRawFd, process::Stdio};
        use tokio::io::AsyncWriteExt;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        // Reproduce the interval between socket() and fcntl(FD_CLOEXEC) deterministically.
        // SAFETY: the descriptor belongs to this listener and is still open.
        assert_eq!(
            unsafe { nix::libc::fcntl(listener.as_raw_fd(), nix::libc::F_SETFD, 0) },
            0
        );
        let mut child = command("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        drop(listener);
        let _released = rebind_after_close(address).await;
        assert!(child.try_wait().unwrap().is_none());
        let mut input = child.stdin.take().unwrap();
        input.write_all(b"fixture\n").await.unwrap();
        drop(input);
        let output = child.wait_with_output().await.unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"fixture\n");
        assert!(output.stderr.is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_missing_program_is_reported_as_a_spawn_error() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            std_command(directory.path().join("missing"))
                .spawn()
                .unwrap_err()
                .kind(),
            io::ErrorKind::NotFound
        );
    }

    #[test]
    fn this_process_is_alive_and_an_unused_id_is_not() {
        assert!(alive(std::process::id()));
        assert!(!alive(0));
        assert!(!alive(u32::MAX - 7));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_named_pipe_is_reached_as_a_local_endpoint() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::windows::named_pipe::ServerOptions;
        let name = format!(r"\\.\pipe\zerolux-test-{}", std::process::id());
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&name)
            .unwrap();
        let answer = tokio::spawn(async move {
            server.connect().await.unwrap();
            let mut server = server;
            let mut line = [0u8; 5];
            server.read_exact(&mut line).await.unwrap();
            server.write_all(&line).await.unwrap();
        });
        let mut client = Local::connect(&name).await.unwrap();
        client.write_all(b"hello").await.unwrap();
        let mut echoed = [0u8; 5];
        client.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"hello");
        answer.await.unwrap();
        assert!(Local::connect("/not/a/pipe").await.is_err());
    }

    #[test]
    fn a_private_folder_is_created_and_checked() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("a/b");
        private_dir(&folder).unwrap();
        assert!(is_private(&std::fs::metadata(&folder).unwrap()));
        let file = folder.join("f");
        private(OpenOptions::new().write(true).create(true))
            .open(&file)
            .unwrap();
        let metadata = std::fs::metadata(&file).unwrap();
        assert!(is_private(&metadata) && !linked_elsewhere(&metadata));
        assert!(same_file(&metadata, &std::fs::metadata(&file).unwrap()));
    }
}
