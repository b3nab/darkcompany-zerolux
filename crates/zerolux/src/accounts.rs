//! A person's harness accounts on a host: the computer's own for its person, and for a guest
//! their own, kept in their harness folders. Claude Code says whether it is signed in and signs
//! in again from ZeroLux; a guest's Claude Code also takes their token or API key, Codex signs
//! in through its own daemon, and pi keeps a guest's providers' keys. Secrets are written once,
//! readable by the kernel's user only, and never shown again.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{homes::Homes, sessions};

/// How Claude Code signs in for a guest: the long-lived token `claude setup-token` prints, or an
/// Anthropic API key. Given to it in its own environment.
const CLAUDE_FILE: &str = "zerolux-account.json";
/// How long a Codex device sign-in, or a Claude Code sign-in, may wait for the person.
const DEVICE_WAIT: Duration = Duration::from_secs(15 * 60);
/// How long Claude Code may take to say its account, or the address to sign in at.
const CLAUDE_WAIT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, Default)]
pub struct Accounts {
    pub claude: Claude,
    pub codex: Codex,
    pub pi: Pi,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Claude {
    /// How it signs in: a guest's `oauth_token` or `api_key` given to ZeroLux; otherwise as
    /// Claude Code says, `claude.ai`, `oauth_token`, `api_key`, `api_key_helper` or
    /// `third_party`. None while it is signed out.
    pub method: Option<String>,
    /// Claude Code can work: its sign-in is there.
    pub signed_in: bool,
    pub email: Option<String>,
    /// Its plan, as Claude Code names it (`max`).
    pub plan: Option<String>,
    /// A sign-in started from ZeroLux waits for the person.
    pub signing_in: bool,
    /// Why Claude Code could not say.
    pub error: Option<String>,
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

/// A guest's folders: what only a guest keeps through ZeroLux.
fn guest(homes: &Homes) -> Result<PathBuf> {
    match homes.root() {
        Some(root) => Ok(root.to_owned()),
        None => bail!(crate::store::Error::Invalid(
            "On your own computer, sign in to the harnesses directly".into()
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

/// The person's accounts, as far as each harness says.
pub async fn read(homes: &Homes) -> Result<Accounts> {
    let given = homes
        .claude()
        .map(|dir| read_json(&dir.join(CLAUDE_FILE)))
        .unwrap_or_else(|| json!({}));
    let given = ["oauth_token", "api_key"]
        .into_iter()
        .find(|key| given[key].is_string())
        .map(str::to_owned);
    let mut claude = match claude_status(&crate::platform::executable("claude"), homes).await {
        Ok(status) => status,
        Err(error) => Claude {
            error: Some(format!("{error:#}")),
            ..Claude::default()
        },
    };
    claude.method = given.or(claude.method);
    claude.signing_in = signing_in(homes);
    let pi = match homes.pi() {
        Some(dir) => read_json(&dir.join("auth.json")),
        None => sessions::agent_dir()
            .map(|dir| read_json(&dir.join("auth.json")))
            .unwrap_or_else(|_| json!({})),
    };
    let codex = match codex_account(homes).await {
        Ok(codex) => codex,
        Err(error) => Codex {
            error: Some(format!("{error:#}")),
            ..Codex::default()
        },
    };
    Ok(Accounts {
        claude,
        codex,
        pi: Pi {
            providers: pi
                .as_object()
                .map(|providers| providers.keys().cloned().collect())
                .unwrap_or_default(),
        },
    })
}

/// Claude Code's account as `claude auth status` says it: signed in when it exits with 0.
async fn claude_status(program: &Path, homes: &Homes) -> Result<Claude> {
    let mut command = crate::platform::command(program);
    command
        .args(["auth", "status", "--json"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    homes.apply(&mut command);
    let output = tokio::time::timeout(CLAUDE_WAIT, command.output())
        .await
        .context("Claude Code did not say its account in time")?
        .context("Cannot run Claude Code")?;
    let status: Value =
        serde_json::from_slice(&output.stdout).context("Claude Code did not say its account")?;
    let signed_in = output.status.success() && status["loggedIn"] != false;
    let text = |key: &str| status[key].as_str().map(str::to_owned);
    Ok(Claude {
        method: text("authMethod").filter(|method| signed_in && method != "none"),
        signed_in,
        email: text("email"),
        plan: text("subscriptionType"),
        signing_in: false,
        error: None,
    })
}

/// A Claude Code sign-in waiting for the person: the address to sign in at, and Claude Code's
/// input, for the code the browser shows when it cannot return to this computer.
struct Login {
    url: String,
    code: tokio::sync::mpsc::Sender<String>,
}

/// Sign-ins in progress, one per Claude Code configuration on this computer.
static LOGINS: LazyLock<Mutex<HashMap<String, Arc<Login>>>> = LazyLock::new(Default::default);

fn login_key(homes: &Homes) -> String {
    homes
        .claude()
        .map_or_else(String::new, |dir| dir.to_string_lossy().into_owned())
}

fn signing_in(homes: &Homes) -> bool {
    LOGINS.lock().unwrap().contains_key(&login_key(homes))
}

/// The address `claude auth login` prints to sign in from any browser.
fn login_url(output: &str) -> Option<String> {
    let after = &output[output.find("visit:")? + "visit:".len()..];
    let start = after.find("https://")?;
    let url: String = after[start..]
        .chars()
        .take_while(|c| !c.is_whitespace() && !c.is_control())
        .collect();
    (url.len() > "https://".len()).then_some(url)
}

/// Starts Claude Code's own sign-in with the person's Claude subscription, or joins the one
/// already waiting, and answers the address to sign in at. With `browser`, Claude Code also
/// opens the computer's browser, which returns to it by itself; otherwise the browser shows a
/// code to give back with [`claude_login_code`]. `done` hears whether it signed in.
pub async fn start_claude_login(
    program: &Path,
    homes: &Homes,
    browser: bool,
    done: impl FnOnce(bool) + Send + 'static,
) -> Result<String> {
    let key = login_key(homes);
    if let Some(login) = LOGINS.lock().unwrap().get(&key) {
        return Ok(login.url.clone());
    }
    homes.prepare()?;
    let mut command = crate::platform::command(program);
    command
        .args(["auth", "login", "--claudeai"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    homes.apply(&mut command);
    if !browser {
        // Claude Code opens the browser through `BROWSER` when it is set: nothing opens here.
        #[cfg(unix)]
        command.env("BROWSER", "true");
    }
    let mut child = command.spawn().context("Cannot run Claude Code")?;
    let mut stdin = child.stdin.take().context("Claude Code has no input")?;
    let stdout = child.stdout.take().context("Claude Code has no output")?;
    let stderr = child.stderr.take().context("Claude Code has no output")?;
    let (said, mut hear) = tokio::sync::mpsc::unbounded_channel::<String>();
    for mut stream in [
        Box::new(stdout) as Box<dyn tokio::io::AsyncRead + Send + Unpin>,
        Box::new(stderr),
    ] {
        let said = said.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buffer = [0u8; 4096];
            while let Ok(read) = stream.read(&mut buffer).await {
                if read == 0
                    || said
                        .send(String::from_utf8_lossy(&buffer[..read]).into())
                        .is_err()
                {
                    break;
                }
            }
        });
    }
    drop(said);
    let mut output = String::new();
    let url = tokio::time::timeout(CLAUDE_WAIT, async {
        while let Some(text) = hear.recv().await {
            output.push_str(&text);
            if let Some(url) = login_url(&output) {
                return Some(url);
            }
        }
        None
    })
    .await
    .ok()
    .flatten();
    let Some(url) = url else {
        let _ = child.kill().await;
        let said = output.lines().map(str::trim).rfind(|line| !line.is_empty());
        bail!(
            "Claude Code did not start its sign-in{}",
            said.map(|line| format!(": {line}")).unwrap_or_default()
        );
    };
    let (code, mut codes) = tokio::sync::mpsc::channel::<String>(1);
    let login = Arc::new(Login {
        url: url.clone(),
        code,
    });
    LOGINS.lock().unwrap().insert(key.clone(), login.clone());
    tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let finished = tokio::time::timeout(DEVICE_WAIT, async {
            loop {
                tokio::select! {
                    status = child.wait() => return status.is_ok_and(|status| status.success()),
                    Some(code) = codes.recv() => {
                        let _ = stdin.write_all(format!("{code}\n").as_bytes()).await;
                        let _ = stdin.flush().await;
                    }
                    // Its output is only read so that it never blocks.
                    Some(_) = hear.recv() => {}
                }
            }
        })
        .await;
        let signed_in = finished.unwrap_or(false);
        if !signed_in {
            let _ = child.kill().await;
        }
        {
            let mut logins = LOGINS.lock().unwrap();
            if logins
                .get(&key)
                .is_some_and(|kept| Arc::ptr_eq(kept, &login))
            {
                logins.remove(&key);
            }
        }
        done(signed_in);
    });
    Ok(url)
}

/// Gives the waiting sign-in the code its browser showed.
pub async fn claude_login_code(homes: &Homes, code: &str) -> Result<()> {
    let code = secret(code, "code")?;
    let login = LOGINS.lock().unwrap().get(&login_key(homes)).cloned();
    let login = login.context(crate::store::Error::Invalid(
        "No sign-in is waiting; start it again".into(),
    ))?;
    login
        .code
        .send(code)
        .await
        .map_err(|_| crate::store::Error::Invalid("The sign-in ended; start it again".into()))?;
    Ok(())
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

/// Signs the person's Codex in with their API key, or starts a ChatGPT sign-in with a code to
/// enter on another device: its address and code. The daemon finishes it and keeps the account.
pub async fn set_codex(homes: &Homes, account: CodexAccount) -> Result<Value> {
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
                    "Codex did not start the sign-in; enable device code sign-in in ChatGPT's security settings",
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

/// Signs the person's Codex out.
pub async fn clear_codex(homes: &Homes) -> Result<()> {
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

    /// A Claude Code that signs in once given `good#state`, and says so after.
    #[cfg(unix)]
    fn fake_claude(dir: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let program = dir.join("claude");
        std::fs::write(
            &program,
            r#"#!/bin/sh
state="$(dirname "$0")/signed-in"
case "$1 $2" in
"auth status")
  if [ -f "$state" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.test","subscriptionType":"max"}'; exit 0; fi
  echo '{"loggedIn":false,"authMethod":"none"}'; exit 1;;
"auth login")
  printf 'Opening browser to sign in\nIf the browser did not open, visit: \033]8;;https://example.test/authorize?code=true\033\\https://example.test/authorize?code=true\033]8;;\033\\\nPaste code here if prompted > '
  read code
  if [ "$code" = "good#state" ]; then touch "$state"; exit 0; fi
  echo "Login failed"; exit 1;;
esac
"#,
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        program
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn claude_code_signs_in_again_with_the_code_its_browser_shows() {
        let dir = tempfile::tempdir().unwrap();
        let program = fake_claude(dir.path());
        let homes = Homes::guest(dir.path().join("ada"));
        let before = claude_status(&program, &homes).await.unwrap();
        assert!(!before.signed_in);
        assert_eq!(before.method, None);
        let (heard, hear) = tokio::sync::oneshot::channel();
        let url = start_claude_login(&program, &homes, false, move |signed_in| {
            let _ = heard.send(signed_in);
        })
        .await
        .unwrap();
        assert_eq!(url, "https://example.test/authorize?code=true");
        assert!(signing_in(&homes));
        // Asking again joins the sign-in already waiting.
        let again = start_claude_login(&program, &homes, false, |_| {})
            .await
            .unwrap();
        assert_eq!(again, url);
        claude_login_code(&homes, " good#state ").await.unwrap();
        assert!(hear.await.unwrap());
        assert!(!signing_in(&homes));
        let after = claude_status(&program, &homes).await.unwrap();
        assert!(after.signed_in);
        assert_eq!(after.method.as_deref(), Some("claude.ai"));
        assert_eq!(after.plan.as_deref(), Some("max"));
        assert!(claude_login_code(&homes, "good#state").await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_wrong_code_ends_the_sign_in_signed_out() {
        let dir = tempfile::tempdir().unwrap();
        let program = fake_claude(dir.path());
        let homes = Homes::guest(dir.path().join("ada"));
        let (heard, hear) = tokio::sync::oneshot::channel();
        start_claude_login(&program, &homes, false, move |signed_in| {
            let _ = heard.send(signed_in);
        })
        .await
        .unwrap();
        claude_login_code(&homes, "wrong").await.unwrap();
        assert!(!hear.await.unwrap());
        assert!(!signing_in(&homes));
        assert!(!claude_status(&program, &homes).await.unwrap().signed_in);
    }

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
