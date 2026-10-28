//! An extension's process part: a program the kernel starts in the extension's folder and
//! talks to with JSON-RPC 2.0, one message per line on its standard input and output. Either
//! side asks; what it writes on standard error goes to its log.

use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{
        Arc, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{Mutex, mpsc, oneshot, watch},
};

/// How long the kernel waits for an extension's answer.
const ANSWER: Duration = Duration::from_secs(60);
/// How long a stopping extension has before it is ended.
const GRACE: Duration = Duration::from_secs(3);
/// The largest message either side may send.
const LINE: usize = 16 * 1024 * 1024;

type Pending = Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

/// What the kernel answers when an extension asks it something.
pub trait Kernel: Send + Sync + 'static {
    fn answer(
        &self,
        extension: String,
        method: String,
        params: Value,
    ) -> impl std::future::Future<Output = Result<Value>> + Send;
    fn heard(&self, extension: String, method: String, params: Value);
}

/// An extension's running part: a process, or a kernel module, both spoken to the same way.
pub struct Process {
    send: mpsc::UnboundedSender<String>,
    pending: Pending,
    next: AtomicU64,
    part: Mutex<Option<Part>>,
    ended: watch::Receiver<bool>,
}

enum Part {
    Child(Box<Child>),
    Module(Arc<super::library::Module>),
}

impl Process {
    /// Starts `command` in `folder`, with nothing of the kernel's environment but what a
    /// program needs to run.
    pub async fn start<K: Kernel>(
        extension: &str,
        folder: &Path,
        command: &[String],
        log: &Path,
        kernel: Weak<K>,
    ) -> Result<Arc<Self>> {
        let (program, args) = command.split_first().context("No command to run")?;
        if let Some(parent) = log.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)?;
        // A bare name is found as the kernel finds its own programs: `bun` beside it first.
        let program = if Path::new(program).components().count() == 1 {
            crate::platform::executable(program)
        } else {
            folder.join(program)
        };
        let mut child = Command::new(&program)
            .args(args)
            .current_dir(folder)
            .env_clear()
            .envs(crate::platform::essential_env())
            .env("ZEROLUX_EXTENSION", extension)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(log))
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("Cannot run `{}` for {extension}", program.display()))?;
        let mut stdin = child.stdin.take().context("No input to the extension")?;
        let stdout = child
            .stdout
            .take()
            .context("No output from the extension")?;
        let (send, mut outgoing) = mpsc::unbounded_channel::<String>();
        let pending: Pending = Arc::default();
        let (ended_tx, ended) = watch::channel(false);
        tokio::spawn(async move {
            while let Some(line) = outgoing.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err()
                    || stdin.write_all(b"\n").await.is_err()
                    || stdin.flush().await.is_err()
                {
                    break;
                }
            }
        });
        let process = Arc::new(Self {
            send: send.clone(),
            pending: pending.clone(),
            next: AtomicU64::new(1),
            part: Mutex::new(Some(Part::Child(Box::new(child)))),
            ended,
        });
        let extension = extension.to_owned();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                dispatch(&line, &kernel, &send, &extension, &pending);
            }
            // Its output closed: whatever was asked is not answered.
            pending.lock().expect("pending").clear();
            ended_tx.send_replace(true);
        });
        Ok(process)
    }

    /// Asks the extension, and waits a minute for its answer.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.request_within(method, params, ANSWER).await
    }

    /// Asks the extension, and waits for its answer as long as `limit`.
    pub async fn request_within(
        &self,
        method: &str,
        params: Value,
        limit: Duration,
    ) -> Result<Value> {
        if *self.ended.borrow() {
            bail!("The extension's process has ended");
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (answer, waiting) = oneshot::channel();
        self.pending.lock().expect("pending").insert(id, answer);
        let message = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        if self.send.send(message.to_string()).is_err() {
            self.pending.lock().expect("pending").remove(&id);
            bail!("The extension's process has ended");
        }
        match tokio::time::timeout(limit, waiting).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(error))) => bail!(crate::store::Error::Invalid(error)),
            Ok(Err(_)) => bail!("The extension's process ended before answering"),
            Err(_) => {
                self.pending.lock().expect("pending").remove(&id);
                bail!("The extension did not answer in time")
            }
        }
    }

    /// Tells the extension something, without waiting.
    pub fn notify(&self, method: &str, params: Value) {
        let message = json!({"jsonrpc": "2.0", "method": method, "params": params});
        let _ = self.send.send(message.to_string());
    }

    pub fn running(&self) -> bool {
        !*self.ended.borrow()
    }

    /// Asks it to stop, then ends it if it has not.
    pub async fn stop(&self) {
        self.notify("shutdown", json!({}));
        match self.part.lock().await.take() {
            Some(Part::Child(mut child)) => {
                if tokio::time::timeout(GRACE, child.wait()).await.is_err() {
                    let _ = child.kill().await;
                }
            }
            // The notice reaches it before it stops, in order.
            Some(Part::Module(module)) => {
                tokio::time::sleep(Duration::from_millis(50)).await;
                module.stop();
            }
            None => {}
        }
    }

    /// Loads the kernel module at `library` and starts it; `copies` keeps the loaded files.
    pub fn start_module<K: Kernel>(
        extension: &str,
        library: &Path,
        copies: &Path,
        kernel: Weak<K>,
    ) -> Result<Arc<Self>> {
        let (heard_by, mut heard) = mpsc::unbounded_channel::<String>();
        let module = Arc::new(super::library::Module::start(library, copies, heard_by)?);
        let (send, mut outgoing) = mpsc::unbounded_channel::<String>();
        let pending: Pending = Arc::default();
        let (ended_tx, ended) = watch::channel(false);
        {
            let module = module.clone();
            tokio::spawn(async move {
                while let Some(message) = outgoing.recv().await {
                    module.send(&message);
                }
            });
        }
        let process = Arc::new(Self {
            send: send.clone(),
            pending: pending.clone(),
            next: AtomicU64::new(1),
            part: Mutex::new(Some(Part::Module(module))),
            ended,
        });
        let extension = extension.to_owned();
        tokio::spawn(async move {
            while let Some(message) = heard.recv().await {
                dispatch(&message, &kernel, &send, &extension, &pending);
            }
            pending.lock().expect("pending").clear();
            ended_tx.send_replace(true);
        });
        Ok(process)
    }
}

/// One message from an extension's part: a request to the kernel, a notice, or an answer.
fn dispatch<K: Kernel>(
    line: &str,
    kernel: &Weak<K>,
    send: &mpsc::UnboundedSender<String>,
    extension: &str,
    pending: &Pending,
) {
    if line.len() > LINE {
        return;
    }
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return;
    };
    let method = message["method"].as_str().map(str::to_owned);
    match (method, message.get("id").cloned()) {
        // It asks the kernel.
        (Some(method), Some(id)) => {
            let (kernel, send, extension) = (kernel.clone(), send.clone(), extension.to_owned());
            let params = message["params"].clone();
            tokio::spawn(async move {
                let answer = match kernel.upgrade() {
                    Some(kernel) => kernel.answer(extension, method, params).await,
                    None => Err(anyhow::anyhow!("The kernel is stopping")),
                };
                let reply = match answer {
                    Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
                    Err(error) => json!({"jsonrpc": "2.0", "id": id,
                        "error": {"code": -32000, "message": format!("{error:#}")}}),
                };
                let _ = send.send(reply.to_string());
            });
        }
        // It tells the kernel something.
        (Some(method), None) => {
            if let Some(kernel) = kernel.upgrade() {
                kernel.heard(extension.to_owned(), method, message["params"].clone());
            }
        }
        // It answers the kernel.
        (None, Some(id)) => {
            let Some(id) = id.as_u64() else { return };
            let answer = match message.get("error") {
                Some(error) => Err(error["message"]
                    .as_str()
                    .unwrap_or("The extension failed")
                    .to_owned()),
                None => Ok(message["result"].clone()),
            };
            if let Some(waiting) = pending.lock().expect("pending").remove(&id) {
                let _ = waiting.send(answer);
            }
        }
        (None, None) => {}
    }
}
