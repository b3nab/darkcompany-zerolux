//! The kernel's local channel: a Unix socket, or a named pipe on Windows, that only the system
//! user running the kernel can open. Whoever opens it acts as the workspace's owner, as anyone
//! who can read the kernel's data folder already could. `zerolux ext dev` uses it. One JSON
//! request per line, one JSON answer per line.

use std::{path::Path, sync::Arc};

use anyhow::{Context, Result};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

use crate::chat_runtime::ChatRuntime;

/// The file in the data folder that names the channel.
const ENDPOINT_FILE: &str = "kernel.endpoint";

/// Where the kernel with this data folder listens, as written by it.
pub fn endpoint_of(data_dir: &Path) -> Result<String> {
    let text = std::fs::read_to_string(data_dir.join(ENDPOINT_FILE)).with_context(|| {
        format!(
            "No kernel is running with the data folder {}",
            data_dir.display()
        )
    })?;
    Ok(text.trim().to_owned())
}

/// The data folder's own name for its channel.
fn digest(data_dir: &Path) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(data_dir.to_string_lossy().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn endpoint_for(data_dir: &Path) -> Result<String> {
    #[cfg(unix)]
    {
        let path = data_dir.join("kernel.sock");
        // An address longer than a socket's goes in a private folder of its own.
        if path.as_os_str().len() < 100 {
            return Ok(path.to_string_lossy().into_owned());
        }
        let digest = digest(data_dir);
        let folder = std::env::temp_dir().join(format!("zerolux-{}", &digest[..12]));
        crate::platform::private_dir(&folder)?;
        Ok(folder.join("kernel.sock").to_string_lossy().into_owned())
    }
    #[cfg(windows)]
    {
        let digest = digest(data_dir);
        Ok(format!(r"\\.\pipe\zerolux-kernel-{}", &digest[..16]))
    }
}

/// Listens until the kernel stops, answering each connection's requests as the owner.
pub async fn serve(data_dir: &Path, runtime: Arc<ChatRuntime>) -> Result<()> {
    serve_with_handoff(data_dir, runtime, None).await
}

pub(crate) async fn serve_with_handoff(
    data_dir: &Path,
    runtime: Arc<ChatRuntime>,
    handoff: Option<crate::handoff::Control>,
) -> Result<()> {
    let endpoint = endpoint_for(data_dir)?;
    let mut connections = tokio::task::JoinSet::new();
    #[cfg(unix)]
    {
        let _ = std::fs::remove_file(&endpoint);
        let listener = tokio::net::UnixListener::bind(&endpoint)
            .with_context(|| format!("Cannot listen on {endpoint}"))?;
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&endpoint, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::write(data_dir.join(ENDPOINT_FILE), &endpoint)?;
        loop {
            let (stream, _) = listener.accept().await?;
            while connections.try_join_next().is_some() {}
            connections.spawn(connection(stream, runtime.clone(), handoff.clone()));
        }
    }
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ServerOptions;
        let mut server = ServerOptions::new()
            .first_pipe_instance(true)
            .reject_remote_clients(true)
            .create(&endpoint)
            .with_context(|| format!("Cannot listen on {endpoint}"))?;
        std::fs::write(data_dir.join(ENDPOINT_FILE), &endpoint)?;
        loop {
            server.connect().await?;
            let connected = server;
            server = ServerOptions::new()
                .reject_remote_clients(true)
                .create(&endpoint)?;
            while connections.try_join_next().is_some() {}
            connections.spawn(connection(connected, runtime.clone(), handoff.clone()));
        }
    }
}

async fn connection<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    stream: S,
    runtime: Arc<ChatRuntime>,
    handoff: Option<crate::handoff::Control>,
) {
    let (read, mut write) = tokio::io::split(stream);
    let mut lines = BufReader::new(read).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Ok(request) = serde_json::from_str::<Value>(&line)
            && matches!(
                request["method"].as_str(),
                Some("kernel.describe" | "kernel.handoff")
            )
        {
            if request["method"] == "kernel.handoff"
                && let Some(control) = handoff.clone()
            {
                // This transaction outlives the runtime it stops. It retains no runtime or
                // database handle; every other local request is cancelled with the listener.
                tokio::spawn(async move {
                    if let Err(error) = control.exchange(&request, &mut lines, &mut write).await {
                        let _ = crate::handoff::write_answer(
                            &mut write,
                            json!({"error": format!("{error:#}")}),
                        )
                        .await;
                    }
                });
                return;
            }
            let result = match handoff.as_ref() {
                Some(control) if request["method"] == "kernel.describe" => {
                    crate::handoff::write_answer(
                        &mut write,
                        json!({"result": control.configuration.info}),
                    )
                    .await
                }
                Some(control) => control.exchange(&request, &mut lines, &mut write).await,
                None => Err(anyhow::anyhow!(
                    "This kernel is not a CLI workspace available for adoption"
                )),
            };
            if let Err(error) = result {
                let _ = crate::handoff::write_answer(
                    &mut write,
                    json!({"error": format!("{error:#}")}),
                )
                .await;
            }
            return;
        }
        if handoff
            .as_ref()
            .is_some_and(|control| control.busy.load(std::sync::atomic::Ordering::Acquire))
        {
            let _ = crate::handoff::write_answer(
                &mut write,
                json!({"error": "The kernel is handing this workspace to the desktop"}),
            )
            .await;
            return;
        }
        let answer = match serde_json::from_str::<Value>(&line) {
            Ok(request) => match answer(&runtime, &request).await {
                Ok(result) => json!({"result": result}),
                Err(error) => json!({"error": format!("{error:#}")}),
            },
            Err(_) => json!({"error": "A request is one line of JSON"}),
        };
        let mut text = answer.to_string();
        text.push('\n');
        if write.write_all(text.as_bytes()).await.is_err() {
            return;
        }
    }
}

async fn answer(runtime: &ChatRuntime, request: &Value) -> Result<Value> {
    let owner = runtime.store.chat_identity(None).await?;
    let params = &request["params"];
    let text = |key: &str| params[key].as_str().unwrap_or_default().to_owned();
    match request["method"].as_str().unwrap_or_default() {
        // Installs, or installs again, an extension from its folder, as one being worked on.
        "extensions.dev" => Ok(json!(
            runtime
                .extensions
                .install_folder(&owner, &text("folder"))
                .await?
        )),
        // The extensions, as they are now.
        "extensions.list" => Ok(json!(runtime.extensions.list().await?)),
        // An extension's log from a byte offset.
        "extensions.log" => {
            let after = params["after"].as_u64().unwrap_or(0);
            let log = runtime.extensions.log_path(&text("id"))?;
            let output = crate::background_processes::read_log(&log, after)?;
            Ok(json!(output))
        }
        other => anyhow::bail!("The kernel does not know `{other}`"),
    }
}

/// Asks the kernel with this data folder, as its owner.
pub struct Client {
    lines: tokio::io::Lines<BufReader<tokio::io::ReadHalf<crate::platform::Local>>>,
    write: tokio::io::WriteHalf<crate::platform::Local>,
}

impl Client {
    pub async fn connect(data_dir: &Path) -> Result<Self> {
        let endpoint = endpoint_of(data_dir)?;
        let stream = crate::platform::Local::connect(&endpoint)
            .await
            .with_context(|| format!("The kernel at {endpoint} does not answer"))?;
        let (read, write) = tokio::io::split(stream);
        Ok(Self {
            lines: BufReader::new(read).lines(),
            write,
        })
    }

    pub async fn ask(&mut self, method: &str, params: Value) -> Result<Value> {
        let mut text = json!({"method": method, "params": params}).to_string();
        text.push('\n');
        self.write.write_all(text.as_bytes()).await?;
        let line = self
            .lines
            .next_line()
            .await?
            .context("The kernel closed the channel")?;
        let mut answer: Value = serde_json::from_str(&line)?;
        if let Some(error) = answer["error"].as_str() {
            anyhow::bail!("{error}");
        }
        Ok(answer["result"].take())
    }
}
