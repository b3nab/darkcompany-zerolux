//! An extension's kernel module: a library loaded into the kernel while it runs, speaking the
//! process part's JSON-RPC through four C functions (see the `zerolux-extension` SDK). A loaded
//! library stays in memory until the kernel stops: a module disabled, or replaced by a newer
//! one, is no longer called.

use std::{
    ffi::c_void,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use tokio::sync::mpsc;

/// The version of the C interface this kernel speaks.
pub const ABI: u32 = 1;

/// This computer, as a module's build is named for it: `macos-aarch64`, `linux-x86_64`,
/// `windows-x86_64`…
pub fn platform() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

/// A library's file name on this system.
pub fn file_name(library: &str) -> String {
    format!(
        "{}{library}{}",
        std::env::consts::DLL_PREFIX,
        std::env::consts::DLL_SUFFIX
    )
}

/// Where an extension's module is, for this computer: `kernel/<platform>/` in a package, or, in
/// a folder being worked on, what Cargo built in `target/release` or `target/debug`.
pub fn find(folder: &Path, library: &str) -> Result<PathBuf> {
    let file = file_name(library);
    [
        folder.join("kernel").join(platform()).join(&file),
        folder.join("target/release").join(&file),
        folder.join("target/debug").join(&file),
    ]
    .into_iter()
    .find(|path| path.is_file())
    .with_context(|| {
        format!(
            "No kernel module {file} for {} in kernel/{}/",
            platform(),
            platform()
        )
    })
}

#[repr(C)]
struct Host {
    kernel: *const c_void,
    send: extern "C" fn(kernel: *const c_void, message: *const u8, length: usize),
}

type Abi = unsafe extern "C" fn() -> u32;
type Start = unsafe extern "C" fn(*const Host) -> *mut c_void;
type Receive = unsafe extern "C" fn(*mut c_void, *const u8, usize);
type Stop = unsafe extern "C" fn(*mut c_void);

/// What the module says reaches the kernel here, from any of its threads.
extern "C" fn heard(kernel: *const c_void, message: *const u8, length: usize) {
    // SAFETY: `kernel` is the sender `start` leaked for this instance, never freed; `message`
    // holds `length` bytes for the duration of the call.
    let sender = unsafe { &*kernel.cast::<mpsc::UnboundedSender<String>>() };
    let bytes = unsafe { std::slice::from_raw_parts(message, length) };
    let _ = sender.send(String::from_utf8_lossy(bytes).into_owned());
}

/// A running instance of a module.
pub struct Module {
    instance: usize,
    receive: Receive,
    stop: Stop,
    stopped: std::sync::atomic::AtomicBool,
}

impl Module {
    /// Loads the library at `path` and starts an instance; what it says goes to `heard`. The file
    /// is loaded from a copy named by its content, so a rebuilt module is loaded anew.
    pub fn start(
        path: &Path,
        copies: &Path,
        heard_by: mpsc::UnboundedSender<String>,
    ) -> Result<Self> {
        use sha2::Digest;
        let bytes = std::fs::read(path)
            .with_context(|| format!("Cannot read the kernel module {}", path.display()))?;
        let digest: String = sha2::Sha256::digest(&bytes)
            .iter()
            .take(12)
            .map(|byte| format!("{byte:02x}"))
            .collect();
        crate::platform::private_dir(copies)?;
        let copy = copies.join(format!("{digest}{}", std::env::consts::DLL_SUFFIX));
        if !copy.is_file() {
            let staged = copies.join(format!(".{digest}.{}", uuid::Uuid::new_v4().simple()));
            std::fs::write(&staged, &bytes)?;
            std::fs::rename(&staged, &copy)?;
        }
        // SAFETY: loading runs the library's initializers; a kernel module is trusted code its
        // owner chose to enable, as the extension's documentation says.
        let library = unsafe { libloading::Library::new(&copy) }
            .with_context(|| format!("Cannot load the kernel module {}", path.display()))?;
        let (abi, start, receive, stop) = unsafe {
            (
                *library
                    .get::<Abi>(b"zerolux_extension_abi\0")
                    .context("It is not a ZeroLux kernel module")?,
                *library
                    .get::<Start>(b"zerolux_extension_start\0")
                    .context("It is not a ZeroLux kernel module")?,
                *library
                    .get::<Receive>(b"zerolux_extension_receive\0")
                    .context("It is not a ZeroLux kernel module")?,
                *library
                    .get::<Stop>(b"zerolux_extension_stop\0")
                    .context("It is not a ZeroLux kernel module")?,
            )
        };
        let version = unsafe { abi() };
        if version != ABI {
            bail!(
                "The kernel module speaks version {version} of the interface; this kernel speaks {ABI}"
            );
        }
        // Its code stays loaded until the kernel stops: something of it may still run.
        std::mem::forget(library);
        // The sender lives as long as the code that may call it.
        let kernel = Box::into_raw(Box::new(heard_by))
            .cast::<c_void>()
            .cast_const();
        let host = Host {
            kernel,
            send: heard,
        };
        let instance = unsafe { start(&host) };
        ensure!(!instance.is_null(), "The kernel module did not start");
        Ok(Self {
            instance: instance as usize,
            receive,
            stop,
            stopped: Default::default(),
        })
    }

    /// Carries one message to the module.
    pub fn send(&self, message: &str) {
        if self.stopped.load(std::sync::atomic::Ordering::Acquire) {
            return;
        }
        // SAFETY: the instance is live until `stop`, and the bytes outlive the call.
        unsafe {
            (self.receive)(
                self.instance as *mut c_void,
                message.as_ptr(),
                message.len(),
            )
        };
    }

    /// Stops the instance; it is not called again.
    pub fn stop(&self) {
        if !self.stopped.swap(true, std::sync::atomic::Ordering::AcqRel) {
            // SAFETY: the instance came from `start` and is stopped once.
            unsafe { (self.stop)(self.instance as *mut c_void) };
        }
    }
}

impl Drop for Module {
    fn drop(&mut self) {
        self.stop();
    }
}
