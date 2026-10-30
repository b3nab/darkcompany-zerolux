//! Human identity: the Better Auth service, a child of this kernel, one for the instance. It
//! identifies an account and keeps its sessions; in each workspace the kernel finds the person
//! bound to that account and authorizes every request itself. The service listens on loopback
//! only and answers no one without the control token this process made for it. See
//! `docs/foundations.md` for the contract.
//!
//! The kernel never reads the service's tables, and the service never reads the kernel's.
//! An unavailable service never becomes owner access: the request fails.

use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, bail};
use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, Request, Response, StatusCode, header},
};
use serde::Deserialize;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
};

use crate::db::Location;

const CONTROL_HEADER: &str = "x-zerolux-auth-service";
const ENROLL_HEADER: &str = "x-zerolux-auth-enroll";
const CLIENT_IP_HEADER: &str = "x-zerolux-client-ip";
const STARTUP: Duration = Duration::from_secs(30);
const SHUTDOWN: Duration = Duration::from_secs(8);
const REQUEST: Duration = Duration::from_secs(10);
/// What a public request may carry to the service, and nothing it could use to pose as the
/// kernel: the control and enroll headers are the kernel's alone.
const FORWARDED: [header::HeaderName; 9] = [
    header::AUTHORIZATION,
    header::COOKIE,
    header::CONTENT_TYPE,
    header::ORIGIN,
    header::REFERER,
    header::USER_AGENT,
    header::HeaderName::from_static("sec-fetch-site"),
    header::HeaderName::from_static("sec-fetch-mode"),
    header::HeaderName::from_static("sec-fetch-dest"),
];

/// How the service is started: from the checkout, or from an entrypoint shipped with the
/// binary. Secrets go over stdin, never the command line.
#[derive(Debug, Clone)]
pub struct AuthEntry {
    pub bun: PathBuf,
    pub entry: PathBuf,
}

impl AuthEntry {
    /// The service of this checkout, run from source.
    pub fn checkout(root: &Path) -> Self {
        Self {
            bun: crate::platform::executable("bun"),
            entry: root.join("services/auth/src/server.ts"),
        }
    }
}

/// A user the service knows, by the session their request carried.
#[derive(Debug, Clone, Deserialize)]
pub struct HumanSession {
    pub subject: String,
    pub session_id: String,
    pub expires_at: i64,
    pub name: String,
    pub email: String,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Startup {
    #[serde(rename = "ready")]
    Ready { version: u32, address: String },
    #[serde(rename = "failed")]
    Failed { reason: String },
}

pub struct AuthService {
    child: Mutex<Option<(Child, ChildStdin)>>,
    address: String,
    control_token: String,
    client: reqwest::Client,
}

impl AuthService {
    /// Starts the service for the instance `instance_id` on the same database as the kernel,
    /// with the instance's `secret`. `base_url` is the origin its clients sign in at;
    /// `trusted_origins` the other exact origins they come from.
    pub async fn start(
        entry: &AuthEntry,
        instance_id: &str,
        database: &Location,
        secret: &str,
        base_url: &str,
        trusted_origins: &[String],
    ) -> Result<Self> {
        let control_token = random_token();
        let database = match database {
            Location::Sqlite(path) => serde_json::json!({
                "kind": "sqlite",
                "path": std::path::absolute(path).context("Resolve the database path")?,
            }),
            Location::Postgres(url) => serde_json::json!({ "kind": "postgres", "url": url }),
        };
        let config = serde_json::json!({
            "version": 1,
                        "instance_id": instance_id,
            "database": database,
            "base_url": base_url,
            "trusted_origins": trusted_origins,
            "secret": secret,
            "control_token": control_token,
        });
        let mut child = Command::new(&entry.bun)
            .arg("--no-env-file")
            .arg(&entry.entry)
            .env_clear()
            .envs(crate::platform::essential_env())
            .env("NODE_ENV", "production")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| {
                format!(
                    "Start the authentication service {} with {}",
                    entry.entry.display(),
                    entry.bun.display()
                )
            })?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        stdin
            .write_all(format!("{config}\n").as_bytes())
            .await
            .context("Configure the authentication service")?;
        stdin.flush().await?;
        let mut lines = BufReader::new(stdout).lines();
        let first = tokio::time::timeout(STARTUP, lines.next_line()).await;
        let address = match first {
            Ok(Ok(Some(line))) => match serde_json::from_str::<Startup>(&line) {
                Ok(Startup::Ready {
                    version: 1,
                    address,
                }) => address,
                Ok(Startup::Ready { version, .. }) => {
                    let _ = child.kill().await;
                    bail!(
                        "The authentication service speaks protocol {version}; this kernel speaks 1"
                    )
                }
                Ok(Startup::Failed { reason }) => {
                    ended(child).await;
                    bail!("The authentication service could not start ({reason})")
                }
                Err(_) => {
                    let _ = child.kill().await;
                    bail!("The authentication service did not announce itself")
                }
            },
            Ok(Ok(None)) | Ok(Err(_)) => {
                ended(child).await;
                bail!("The authentication service ended before it was ready")
            }
            Err(_) => {
                let _ = child.kill().await;
                bail!("The authentication service did not start in time")
            }
        };
        // Whatever else it prints is diagnostics; it never prints secrets.
        tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
        Ok(Self {
            child: Mutex::new(Some((child, stdin))),
            address,
            control_token,
            client: reqwest::Client::builder()
                .timeout(REQUEST)
                .no_proxy()
                .build()
                .context("Build the authentication client")?,
        })
    }

    /// The user behind a request's cookie or signed bearer token, if any. `Err` is the
    /// service being unavailable, which is not an anonymous request.
    pub async fn session(
        &self,
        headers: &HeaderMap,
        client: Option<std::net::IpAddr>,
    ) -> Result<Option<HumanSession>> {
        let response = self
            .private(
                reqwest::Method::GET,
                "/internal/session",
                headers,
                None,
                client,
                false,
            )
            .await?;
        if response.status() != StatusCode::OK {
            bail!(
                "The authentication service answered {} to a session check",
                response.status()
            );
        }
        Ok(response.json().await?)
    }

    /// Whether the instance has any account yet: until then, signing up needs no invitation.
    pub async fn has_accounts(&self) -> Result<bool> {
        #[derive(Deserialize)]
        struct Accounts {
            exists: bool,
        }
        let response = self
            .private(
                reqwest::Method::GET,
                "/internal/accounts",
                &HeaderMap::new(),
                None,
                None,
                false,
            )
            .await?;
        if response.status() != StatusCode::OK {
            bail!(
                "The authentication service answered {} to an accounts check",
                response.status()
            );
        }
        Ok(response.json::<Accounts>().await?.exists)
    }

    /// Better Auth's own endpoint for a public request: status, cookies and the signed token
    /// come back as they are. `enroll` is the kernel's permission for a signup to happen.
    pub async fn proxy(
        &self,
        request: Request<Body>,
        enroll: bool,
        client: Option<std::net::IpAddr>,
    ) -> Result<Response<Body>> {
        let (parts, body) = request.into_parts();
        // The public path, as the client sent it: a nested router sees it without its prefix.
        let original = parts.extensions.get::<axum::extract::OriginalUri>();
        let uri = original.map_or(&parts.uri, |o| &o.0);
        let path = uri.path_and_query().map_or("/", |p| p.as_str());
        let body = axum::body::to_bytes(body, 64 * 1024)
            .await
            .context("Read the authentication request")?;
        let response = self
            .private(
                parts.method,
                path,
                &parts.headers,
                Some(body),
                client,
                enroll,
            )
            .await?;
        let status = response.status();
        let mut out = Response::builder().status(status);
        for (name, value) in response.headers() {
            if matches!(
                name.as_str(),
                "set-cookie" | "set-auth-token" | "content-type" | "cache-control" | "vary"
            ) {
                out = out.header(name, value);
            }
        }
        let body = response
            .bytes()
            .await
            .context("Read the service's answer")?;
        Ok(out
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(body))?)
    }

    /// Only the listed public headers cross; the kernel's own (control, enroll, client
    /// address) are set here and never taken from the caller.
    async fn private(
        &self,
        method: reqwest::Method,
        path: &str,
        headers: &HeaderMap,
        body: Option<axum::body::Bytes>,
        client: Option<std::net::IpAddr>,
        enroll: bool,
    ) -> Result<reqwest::Response> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.address))
            .header(CONTROL_HEADER, &self.control_token);
        for name in FORWARDED {
            for value in headers.get_all(&name) {
                request = request.header(&name, value);
            }
        }
        if let Some(client) = client {
            request = request.header(CLIENT_IP_HEADER, client.to_string());
        }
        if enroll {
            request = request.header(ENROLL_HEADER, HeaderValue::from_static("1"));
        }
        if let Some(body) = body {
            request = request.body(body);
        }
        request
            .send()
            .await
            .context("The authentication service is not answering")
    }

    /// Ends the service: its stdin closes, it stops; a service that does not is killed.
    pub async fn shutdown(&self) {
        let Some((mut child, stdin)) = self.child.lock().await.take() else {
            return;
        };
        drop(stdin);
        if tokio::time::timeout(SHUTDOWN, child.wait()).await.is_err() {
            let _ = child.kill().await;
        }
    }
}

fn random_token() -> String {
    crate::store::random_token()
}

/// Ends a child that already reported failure, within a deadline.
async fn ended(mut child: Child) {
    if tokio::time::timeout(SHUTDOWN, child.wait()).await.is_err() {
        let _ = child.kill().await;
    }
}

/// A file only this user reads, written whole or not at all.
pub(crate) async fn write_private(path: &Path, content: &str) -> Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    {
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(&temporary)
            .await
            .with_context(|| format!("Write {}", temporary.display()))?;
        file.write_all(content.as_bytes()).await?;
        file.flush().await?;
    }
    tokio::fs::rename(&temporary, path)
        .await
        .with_context(|| format!("Place {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_private_file_is_replaced_whole_with_private_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");
        std::fs::write(&path, "old").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        write_private(&path, "new").await.unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            1,
            "no leftovers"
        );
    }
}
