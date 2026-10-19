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

pub struct Process {
    send: mpsc::UnboundedSender<String>,
    pending: Pending,
    next: AtomicU64,
    child: Mutex<Option<Child>>,
    ended: watch::Receiver<bool>,
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
        let mut child = Command::new(program)
            .args(args)
            .current_dir(folder)
            .env_clear()
            .envs(
                ["PATH", "HOME", "TMPDIR", "LANG", "USER"]
                    .into_iter()
                    .filter_map(|name| std::env::var_os(name).map(|value| (name, value))),
            )
            .env("ZEROLUX_EXTENSION", extension)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(log))
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("Cannot run `{program}` for {extension}"))?;
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
            child: Mutex::new(Some(child)),
            ended,
        });
        let extension = extension.to_owned();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.len() > LINE {
                    continue;
                }
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let method = message["method"].as_str().map(str::to_owned);
                match (method, message.get("id").cloned()) {
                    // It asks the kernel.
                    (Some(method), Some(id)) => {
                        let (kernel, send, extension) =
                            (kernel.clone(), send.clone(), extension.clone());
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
                            kernel.heard(extension.clone(), method, message["params"].clone());
                        }
                    }
                    // It answers the kernel.
                    (None, Some(id)) => {
                        let Some(id) = id.as_u64() else { continue };
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
            // Its output closed: whatever was asked is not answered.
            pending.lock().expect("pending").clear();
            ended_tx.send_replace(true);
        });
        Ok(process)
    }

    /// Asks the extension, and waits for its answer.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
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
        match tokio::time::timeout(ANSWER, waiting).await {
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
        let Some(mut child) = self.child.lock().await.take() else {
            return;
        };
        if tokio::time::timeout(GRACE, child.wait()).await.is_err() {
            let _ = child.kill().await;
        }
    }
}
