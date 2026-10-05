use std::{fs::OpenOptions, path::PathBuf, process::Stdio, time::Duration};

use anyhow::{Context, bail};
use clap::Args;
use reqwest::Client;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

use crate::{
    harness::Harness,
    model::{AgentConnection, Claim, ClaimRequest, ConnectAgent, FinishRun, Run, Workspace},
    store::MAX_OUTPUT_BYTES,
};

#[derive(Debug, Args)]
pub struct WorkerOptions {
    #[arg(long, default_value = "http://127.0.0.1:4310")]
    pub server: String,
    #[arg(long)]
    pub project: String,
    /// ID of an explicitly hired agent. No placeholder/default actor is created.
    #[arg(long)]
    pub actor: String,
    /// Explicit working directory. Prefer a dedicated git worktree.
    #[arg(long)]
    pub workspace: PathBuf,
    /// Opt in to continuous execution. By default, claim at most one task.
    #[arg(long)]
    pub watch: bool,
    #[arg(long, default_value_t = 1800, value_parser = clap::value_parser!(u64).range(1..))]
    pub timeout_secs: u64,
    /// Start a fresh process using a built-in local preset, not an existing session.
    #[arg(
        long,
        value_enum,
        conflicts_with = "command",
        required_unless_present = "command"
    )]
    pub harness: Option<Harness>,
    /// Executable and fixed arguments after --. The task prompt is appended as one argument.
    #[arg(last = true, required_unless_present = "harness", num_args = 1..)]
    pub command: Vec<String>,
}

pub async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

pub async fn run(mut options: WorkerOptions) -> anyhow::Result<()> {
    let mut url = reqwest::Url::parse(&options.server).context("Invalid kernel URL")?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("Worker requires a plain loopback HTTP URL, without credentials, path or query");
    }
    if url.host_str() == Some("localhost") {
        url.set_host(Some("127.0.0.1"))?;
    }
    options.server = url.as_str().trim_end_matches('/').to_owned();
    options.workspace = options
        .workspace
        .canonicalize()
        .context("Workspace must already exist")?;
    if !options.workspace.is_dir() {
        bail!("Workspace must be a directory");
    }
    if let Some(harness) = options.harness {
        options.command = harness.command();
    }
    if options.command.is_empty() {
        bail!("Provide --harness or an executable after --");
    }

    // Keep one ZeroLux worker per directory. This does not lock out humans or external tools.
    let state_dir = options.workspace.join(".zerolux");
    std::fs::create_dir_all(&state_dir)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(state_dir.join("worker.lock"))?;
    fs2::FileExt::try_lock_exclusive(&lock)
        .context("Another ZeroLux worker is using this workspace")?;

    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()?;
    tracing::warn!(workspace = %options.workspace.display(), executable = %options.command[0], watch = options.watch,
        "Harness executes with YOUR local permissions. This is not a sandbox; use a dedicated worktree and review all changes.");
    if let Some(harness) = options.harness {
        let workspace: Workspace = client
            .get(format!("{}/api/workspace", options.server))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let actor = workspace
            .actors
            .iter()
            .find(|a| a.id == options.actor && !a.archived)
            .context("Unknown actor; hire the agent in the UI first")?;
        if actor.harness.as_deref() != Some(harness.id()) {
            bail!("The selected actor is not registered for {}", harness.id());
        }
    }
    let connection: AgentConnection = client.post(format!("{}/api/connections", options.server))
        .json(&ConnectAgent { actor_id: options.actor.clone(), project_id: options.project.clone(),
            mode: "process".into(), workspace: options.workspace.to_string_lossy().into_owned(), session_id: None })
        .send().await?.error_for_status().context("Cannot connect: restart an older kernel, or check whether this actor/workspace is already attached")?.json().await?;
    let result = work(&client, &options, &connection).await;
    let cleanup = client
        .post(format!(
            "{}/api/connections/{}/disconnect",
            options.server, connection.id
        ))
        .send()
        .await;
    if !matches!(cleanup, Ok(ref response) if response.status().is_success()) {
        tracing::warn!("Could not disconnect; the connection will expire automatically");
    }
    result
}

async fn work(
    client: &Client,
    options: &WorkerOptions,
    connection: &AgentConnection,
) -> anyhow::Result<()> {
    loop {
        client
            .post(format!(
                "{}/api/connections/{}/heartbeat",
                options.server, connection.id
            ))
            .send()
            .await?
            .error_for_status()?;
        let claim: Option<Claim> = client
            .post(format!("{}/api/worker/claim", options.server))
            .json(&ClaimRequest {
                project_id: options.project.clone(),
                actor_id: options.actor.clone(),
                connection_id: Some(connection.id.clone()),
            })
            .send()
            .await
            .context("Contact kernel")?
            .error_for_status()?
            .json()
            .await?;
        if let Some(claim) = claim {
            tracing::info!(task = %claim.task.id, title = %claim.task.title, run = %claim.run.id, "Executing task");
            let result = execute(client, options, &claim).await;
            let finished: Run = client
                .post(format!(
                    "{}/api/worker/runs/{}/finish",
                    options.server, claim.run.id
                ))
                .json(&result)
                .send()
                .await
                .context("Report run; inspect workspace before retrying if delivery failed")?
                .error_for_status()?
                .json()
                .await?;
            tracing::info!(run = %finished.id, status = %finished.status, "Run recorded; human review required before completion or retry");
            if !options.watch {
                if finished.status == "failed" {
                    bail!("Harness failed; see run output in ZeroLux");
                }
                break;
            }
            // A termination request is also recorded as a failed run, but must stop watch mode.
            if result.failure_reason.as_deref() == Some("Worker interrupted") {
                break;
            }
        } else if !options.watch {
            tracing::info!("No queued task for this project and actor");
            break;
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(2)) => {},
            _ = shutdown_signal() => break,
        }
    }
    Ok(())
}

async fn execute(client: &Client, options: &WorkerOptions, claim: &Claim) -> FinishRun {
    let mut command = Command::new(&options.command[0]);
    command
        .args(&options.command[1..])
        .arg(&claim.prompt)
        .current_dir(&options.workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env_remove("PI_SESSION_ID")
        .env_remove("PI_SESSION_FILE");
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return FinishRun {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: None,
                failure_reason: Some(format!("Cannot start harness: {error}")),
            };
        }
    };
    #[cfg(unix)]
    let process_group = ProcessGroup(child.id().expect("spawned child PID"));
    let stdout = tokio::spawn(capture(child.stdout.take().expect("stdout pipe")));
    let stderr = tokio::spawn(capture(child.stderr.take().expect("stderr pipe")));
    let deadline = tokio::time::sleep(Duration::from_secs(options.timeout_secs));
    tokio::pin!(deadline);
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    let (exit_code, mut failure_reason) = loop {
        tokio::select! {
            status = child.wait() => break match status {
                Ok(status) => (status.code(), if status.success() { None } else { Some(format!("Harness exited: {status}")) }),
                Err(error) => (None, Some(format!("Cannot wait for harness: {error}"))),
            },
            _ = &mut deadline => break (None, Some("Harness timed out".into())),
            _ = shutdown_signal() => break (None, Some("Worker interrupted".into())),
            _ = heartbeat.tick() => {
                let response = client.post(format!("{}/api/worker/runs/{}/heartbeat", options.server, claim.run.id)).send().await;
                if !matches!(response, Ok(ref response) if response.status().is_success()) {
                    break (None, Some("Kernel heartbeat failed; stopping harness to avoid a stale run".into()));
                }
            }
        }
    };
    // Kill descendants as well on Unix, including background processes left after a normal exit.
    #[cfg(unix)]
    drop(process_group);
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    let (stdout, stderr) = tokio::join!(collect(stdout), collect(stderr));
    let stdout = stdout.unwrap_or_else(|error| {
        failure_reason.get_or_insert(error);
        String::new()
    });
    let stderr = stderr.unwrap_or_else(|error| {
        failure_reason.get_or_insert(error);
        String::new()
    });
    FinishRun {
        stdout,
        stderr,
        exit_code,
        failure_reason,
    }
}

#[cfg(unix)]
struct ProcessGroup(u32);
#[cfg(unix)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(self.0 as i32),
            nix::sys::signal::Signal::SIGKILL,
        );
    }
}

async fn capture(mut reader: impl AsyncRead + Unpin) -> std::io::Result<String> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let keep = count.min(MAX_OUTPUT_BYTES.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&buffer[..keep]);
        truncated |= keep < count;
    }
    // Lossy decoding can expand invalid UTF-8. Bound the final serialized text as well.
    let mut output = String::from_utf8_lossy(&bytes).into_owned();
    truncated |= output.len() > MAX_OUTPUT_BYTES;
    if truncated {
        const MARKER: &str = "\n[output truncated]";
        let mut end = (MAX_OUTPUT_BYTES - MARKER.len()).min(output.len());
        while !output.is_char_boundary(end) {
            end -= 1;
        }
        output.truncate(end);
        output.push_str(MARKER);
    }
    Ok(output)
}

async fn collect(
    mut task: tokio::task::JoinHandle<std::io::Result<String>>,
) -> Result<String, String> {
    match tokio::time::timeout(Duration::from_secs(2), &mut task).await {
        Ok(Ok(Ok(output))) => Ok(output),
        Ok(Ok(Err(error))) => Err(format!("Cannot read harness output: {error}")),
        Ok(Err(error)) => Err(format!("Output reader failed: {error}")),
        Err(_) => {
            task.abort();
            Err("Harness output pipe did not close".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn output_is_bounded_even_with_invalid_utf8() {
        let bytes = vec![0xff; MAX_OUTPUT_BYTES * 2];
        let output = capture(bytes.as_slice()).await.unwrap();
        assert!(output.len() <= MAX_OUTPUT_BYTES);
        assert!(output.ends_with("[output truncated]"));
    }
}
