//! A guest's own harness accounts on a host open to them, kept in their own harness folders:
//! Claude Code with their token or API key, Codex signed in through its own daemon, and pi
//! with their providers' keys. Secrets are written once, readable by the kernel's user only,
//! and never shown again.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{homes::Homes, sessions};

/// How Claude Code signs in for a guest: the long-lived token `claude setup-token` prints, or an
/// Anthropic API key. Given to it in its own environment.
const CLAUDE_FILE: &str = "zerolux-account.json";
/// How long a Codex device sign-in may wait for the person.
const DEVICE_WAIT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

#[derive(Debug, Clone, Serialize, Default)]
pub struct Accounts {
    pub claude: Claude,
    pub codex: Codex,
    pub pi: Pi,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Claude {
    /// `oauth_token` or `api_key`; none until given.
    pub method: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Codex {
    pub signed_in: bool,
    /// `chatgpt` or `api_key`.
    pub method: Option<String>,
    pub email: Option<String>,
    pub plan: Option<String>,
    /// Why Codex could not say.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Pi {
    /// The providers pi has a key or a sign-in for.
    pub providers: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaudeAccount {
    pub oauth_token: Option<String>,
    pub api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodexAccount {
    pub api_key: Option<String>,
    /// Sign in with ChatGPT on another device, with a code.
    #[serde(default)]
    pub device_code: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PiAccount {
    pub provider: String,
    pub api_key: String,
}

fn secret(value: &str, label: &str) -> Result<String> {
    let value = value.trim();
    ensure!(
        !value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_whitespace),
        crate::store::Error::Invalid(format!("Paste the {label} on its own"))
    );
    Ok(value.to_owned())
}

/// Writes `value` to `path`, readable by the kernel's user only, replacing what was there.
fn write_private(path: &Path, value: &Value) -> Result<()> {
    let staged = path.with_extension("next");
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&staged)?;
        file.write_all(serde_json::to_string_pretty(value)?.as_bytes())?;
        file.sync_all()?;
    }
    std::fs::rename(&staged, path)?;
    Ok(())
}

fn read_json(path: &Path) -> Value {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| json!({}))
}

fn guest(homes: &Homes) -> Result<PathBuf> {
    match homes.root() {
        Some(root) => Ok(root.to_owned()),
        None => bail!(crate::store::Error::Invalid(
            "On your own computer your harnesses use its accounts; sign in to them there".into()
        )),
    }
}

/// What a guest's Claude Code is started with: their token or key, and nothing of the
/// computer's.
pub fn claude_env(homes: &Homes) -> Vec<(&'static str, String)> {
    let Some(dir) = homes.claude() else {
        return Vec::new();
    };
    let account = read_json(&dir.join(CLAUDE_FILE));
    match (account["oauth_token"].as_str(), account["api_key"].as_str()) {
        (Some(token), _) => vec![("CLAUDE_CODE_OAUTH_TOKEN", token.to_owned())],
        (None, Some(key)) => vec![("ANTHROPIC_API_KEY", key.to_owned())],
        _ => Vec::new(),
    }
}

/// The guest's accounts, as far as each harness says.
pub async fn read(homes: &Homes) -> Result<Accounts> {
    let root = guest(homes)?;
    let claude = read_json(&root.join("claude").join(CLAUDE_FILE));
    let method = ["oauth_token", "api_key"]
        .into_iter()
        .find(|key| claude[key].is_string())
        .map(str::to_owned);
    let pi = read_json(&root.join("pi/auth.json"));
    let codex = match codex_account(homes).await {
        Ok(codex) => codex,
        Err(error) => Codex {
            error: Some(format!("{error:#}")),
            ..Codex::default()
        },
    };
    Ok(Accounts {
        claude: Claude { method },
        codex,
        pi: Pi {
            providers: pi
                .as_object()
                .map(|providers| providers.keys().cloned().collect())
                .unwrap_or_default(),
        },
    })
}

async fn codex_account(homes: &Homes) -> Result<Codex> {
    let endpoint = sessions::ensure_codex_daemon_in(homes).await?;
    let rpc = crate::codex::CodexRpc::connect(&endpoint).await?;
    let reply = rpc
        .request("account/read", json!({}))
        .await
        .context("Codex did not say its account")?;
    let account = &reply["account"];
    Ok(Codex {
        signed_in: account.is_object(),
        method: match account["type"].as_str() {
            Some("apiKey") => Some("api_key".into()),
            Some(other) => Some(other.to_owned()),
            None => None,
        },
        email: account["email"].as_str().map(str::to_owned),
        plan: account["planType"].as_str().map(str::to_owned),
        error: None,
    })
}

/// Claude Code with the guest's token from `claude setup-token`, or their API key; or, with
/// neither, without either.
pub fn set_claude(homes: &Homes, account: ClaudeAccount) -> Result<()> {
    let root = guest(homes)?;
    let value = match (account.oauth_token, account.api_key) {
        (Some(token), None) => json!({"oauth_token": secret(&token, "token")?}),
        (None, Some(key)) => json!({"api_key": secret(&key, "API key")?}),
        (None, None) => {
            let path = root.join("claude").join(CLAUDE_FILE);
            if path.exists() {
                std::fs::remove_file(path)?;
            }
            return Ok(());
        }
        _ => bail!(crate::store::Error::Invalid(
            "Give a token or an API key, not both".into()
        )),
    };
    homes.prepare()?;
    write_private(&root.join("claude").join(CLAUDE_FILE), &value)
}

/// Signs the guest's Codex in with their API key, or starts a ChatGPT sign-in with a code to
/// enter on another device: its address and code. The daemon finishes it and keeps the account.
pub async fn set_codex(homes: &Homes, account: CodexAccount) -> Result<Value> {
    guest(homes)?;
    let endpoint = sessions::ensure_codex_daemon_in(homes).await?;
    let rpc = crate::codex::CodexRpc::connect(&endpoint).await?;
    match (account.api_key, account.device_code) {
        (Some(key), false) => {
            rpc.request(
                "account/login/start",
                json!({"type": "apiKey", "apiKey": secret(&key, "API key")?}),
            )
            .await
            .context("Codex did not take the API key")?;
            Ok(json!({"signed_in": true}))
        }
        (None, true) => {
            let mut events = rpc.subscribe();
            let reply = rpc
                .request("account/login/start", json!({"type": "chatgptDeviceCode"}))
                .await
                .context(
                    "Codex did not start the sign-in; device codes may need enabling in ChatGPT's security settings",
                )?;
            let login = reply["loginId"].as_str().map(str::to_owned);
            // The sign-in belongs to this connection: it stays open until Codex finishes it.
            tokio::spawn(async move {
                let _ = tokio::time::timeout(DEVICE_WAIT, async {
                    while let Ok(event) = events.recv().await {
                        if event["method"] == "account/login/completed"
                            && event["params"]["loginId"].as_str() == login.as_deref()
                        {
                            break;
                        }
                    }
                })
                .await;
                drop(rpc);
            });
            Ok(json!({"verification_url": reply["verificationUrl"],
                "user_code": reply["userCode"]}))
        }
        _ => bail!(crate::store::Error::Invalid(
            "Give an API key, or ask for a code to sign in with ChatGPT".into()
        )),
    }
}

/// Signs the guest's Codex out.
pub async fn clear_codex(homes: &Homes) -> Result<()> {
    guest(homes)?;
    let endpoint = sessions::ensure_codex_daemon_in(homes).await?;
    let rpc = crate::codex::CodexRpc::connect(&endpoint).await?;
    rpc.request("account/logout", json!({}))
        .await
        .context("Codex did not sign out")?;
    Ok(())
}

/// The guest's key for one of pi's providers, as pi keeps it; or, with an empty key, none.
pub fn set_pi(homes: &Homes, account: PiAccount) -> Result<()> {
    let root = guest(homes)?;
    let provider = account.provider.trim();
    ensure!(
        !provider.is_empty()
            && provider.len() <= 100
            && provider
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')),
        crate::store::Error::Invalid("Name the provider as pi does, such as `anthropic`".into())
    );
    homes.prepare()?;
    let path = root.join("pi/auth.json");
    let mut auth = read_json(&path);
    if !auth.is_object() {
        auth = json!({});
    }
    if account.api_key.trim().is_empty() {
        if let Some(providers) = auth.as_object_mut() {
            providers.remove(provider);
        }
    } else {
        auth[provider] = json!({"type": "api_key", "key": secret(&account.api_key, "API key")?});
    }
    write_private(&path, &auth)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_guests_claude_and_pi_accounts_stay_in_their_folders_and_private() {
        let dir = tempfile::tempdir().unwrap();
        let homes = Homes::guest(dir.path().join("ada"));
        assert!(claude_env(&homes).is_empty());
        set_claude(
            &homes,
            ClaudeAccount {
                oauth_token: Some(" sk-ant-oat-fixture ".into()),
                api_key: None,
            },
        )
        .unwrap();
        assert_eq!(
            claude_env(&homes),
            vec![("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat-fixture".to_owned())]
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("ada/claude").join(CLAUDE_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o077, 0);
        }
        assert!(
            set_claude(
                &homes,
                ClaudeAccount {
                    oauth_token: Some("a".into()),
                    api_key: Some("b".into()),
                },
            )
            .is_err()
        );
        set_claude(
            &homes,
            ClaudeAccount {
                oauth_token: None,
                api_key: None,
            },
        )
        .unwrap();
        assert!(claude_env(&homes).is_empty());
        set_pi(
            &homes,
            PiAccount {
                provider: "anthropic".into(),
                api_key: "sk-fixture".into(),
            },
        )
        .unwrap();
        let auth = read_json(&dir.path().join("ada/pi/auth.json"));
        assert_eq!(
            auth["anthropic"],
            json!({"type":"api_key","key":"sk-fixture"})
        );
        assert!(
            set_pi(
                &homes,
                PiAccount {
                    provider: "../x".into(),
                    api_key: "k".into(),
                },
            )
            .is_err()
        );
        // The computer's own accounts are not ZeroLux's to set.
        assert!(
            set_claude(
                &Homes::own(),
                ClaudeAccount {
                    oauth_token: Some("t".into()),
                    api_key: None,
                },
            )
            .is_err()
        );
    }
}
