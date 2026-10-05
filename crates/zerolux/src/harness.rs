use std::{path::PathBuf, process::Stdio, time::Duration};

use clap::ValueEnum;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum Harness {
    Pi,
    ClaudeCode,
    Codex,
}

impl Harness {
    pub fn id(self) -> &'static str {
        match self {
            Self::Pi => "pi",
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
        }
    }

    // Fixed local presets only. Never resolve an executable from server-supplied task data.
    pub fn command(self) -> Vec<String> {
        let args: &[&str] = match self {
            Self::Pi => &["pi", "--print", "--"],
            Self::ClaudeCode => &[
                "claude",
                "--print",
                "--permission-prompts",
                "none",
                "--output-format",
                "text",
            ],
            Self::Codex => &["codex", "exec", "--color", "never"],
        };
        args.iter().map(|s| (*s).to_owned()).collect()
    }
}

#[derive(Debug, Serialize)]
pub struct HarnessProbe {
    harness: Harness,
    executable: String,
    path: Option<PathBuf>,
    version: Option<String>,
    error: Option<String>,
}

/// Explicitly invoked from the terminal, never from an API request or on server startup.
pub async fn doctor() -> Vec<HarnessProbe> {
    let mut result = Vec::new();
    for harness in [Harness::Pi, Harness::ClaudeCode, Harness::Codex] {
        let executable = harness.command().remove(0);
        let path = std::env::var_os("PATH").and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|dir| dir.join(&executable))
                .find(|path| path.is_file())
        });
        let mut probe = HarnessProbe {
            harness,
            executable,
            path,
            version: None,
            error: None,
        };
        if let Some(path) = &probe.path {
            let output = tokio::time::timeout(
                Duration::from_secs(5),
                Command::new(path)
                    .arg("--version")
                    .stdin(Stdio::null())
                    .kill_on_drop(true)
                    .output(),
            )
            .await;
            match output {
                Ok(Ok(output)) if output.status.success() => {
                    probe.version = Some(
                        String::from_utf8_lossy(&output.stdout)
                            .trim()
                            .chars()
                            .take(300)
                            .collect(),
                    );
                }
                Ok(Ok(output)) => {
                    probe.error = Some(format!("Version probe exited {}", output.status))
                }
                Ok(Err(error)) => probe.error = Some(error.to_string()),
                Err(_) => probe.error = Some("Version probe timed out".into()),
            }
        } else {
            probe.error = Some("Not found on PATH".into());
        }
        result.push(probe);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_start_fresh_processes_without_permission_bypass() {
        assert_eq!(Harness::Pi.command(), ["pi", "--print", "--"]);
        assert_eq!(
            Harness::ClaudeCode.command(),
            [
                "claude",
                "--print",
                "--permission-prompts",
                "none",
                "--output-format",
                "text"
            ]
        );
        assert_eq!(
            Harness::Codex.command(),
            ["codex", "exec", "--color", "never"]
        );
        for harness in [Harness::Pi, Harness::ClaudeCode, Harness::Codex] {
            let json = serde_json::to_string(&harness).unwrap();
            assert_eq!(serde_json::from_str::<Harness>(&json).unwrap(), harness);
        }
    }
}
