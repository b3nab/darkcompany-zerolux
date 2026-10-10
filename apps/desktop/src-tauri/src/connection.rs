//! A saved connection names a workspace, not just an address. Verify its identity before
//! opening the UI, including when its configured address changes.
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};

/// A kernel whose `/api/health` answered, and the workspace it serves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedWorkspace {
    pub url: tauri::Url,
    pub id: String,
    pub name: String,
}

const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_BODY: usize = 64 * 1024;

/// A kernel's HTTP origin. Credentials, paths, queries and fragments are not addresses.
/// Connecting to a remote origin does not authenticate its workspace or expose a local kernel.
pub fn kernel_url(value: &str) -> Result<tauri::Url> {
    let mut url = tauri::Url::parse(value.trim()).context("Enter the kernel address as a URL")?;
    ensure!(
        matches!(url.scheme(), "http" | "https"),
        "The kernel address must start with http:// or https://"
    );
    ensure!(
        url.username().is_empty() && url.password().is_none(),
        "The kernel address must not carry credentials"
    );
    ensure!(
        url.query().is_none() && url.fragment().is_none(),
        "The kernel address must not carry a query or a fragment"
    );
    ensure!(
        matches!(url.path(), "" | "/"),
        "The kernel address must not carry a path"
    );
    let host = url
        .host_str()
        .context("The kernel address must include a host")?;
    if host.eq_ignore_ascii_case("localhost") {
        // One origin for one kernel: `localhost` and `127.0.0.1` would be two webview storages.
        url.set_host(Some("127.0.0.1"))
            .context("Normalize the kernel address")?;
    }
    url.set_path("/");
    Ok(url)
}

/// Asks the kernel who it is. With `expected_id`, a different workspace is an error: the
/// desktop never adopts another identity silently.
pub async fn verify(value: &str, expected_id: Option<&str>) -> Result<VerifiedWorkspace> {
    let url = kernel_url(value)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .build()
        .context("Prepare the kernel check")?;
    let mut response = client
        .get(url.join("api/health").expect("health path"))
        .send()
        .await
        .with_context(|| format!("No ZeroLux kernel answered at {url}"))?;
    ensure!(
        response.status().is_success(),
        "The kernel at {url} answered {} to the health check",
        response.status()
    );
    if let Some(length) = response.content_length() {
        ensure!(
            length as usize <= MAX_BODY,
            "The health answer is too large"
        );
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.context("Read the health answer")? {
        ensure!(
            body.len() + chunk.len() <= MAX_BODY,
            "The health answer is too large"
        );
        body.extend_from_slice(&chunk);
    }
    let health: serde_json::Value =
        serde_json::from_slice(&body).context("The health answer is not JSON")?;
    ensure!(
        health["name"] == "zerolux",
        "The service at {url} is not a ZeroLux kernel"
    );
    let id = match health["workspace"]["id"].as_str() {
        Some(id) if !id.trim().is_empty() => id.to_owned(),
        _ => bail!("The kernel at {url} did not name its workspace; update it first"),
    };
    if let Some(expected) = expected_id {
        ensure!(
            expected == id,
            "The kernel at {url} serves a different workspace than this saved connection"
        );
    }
    ensure!(
        health["api_version"].as_u64() == Some(zerolux::api::API_VERSION as u64),
        "The kernel at {url} is not compatible with this desktop interface. Update the kernel and desktop to matching API versions."
    );
    let name = health["workspace"]["name"]
        .as_str()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Workspace")
        .to_owned();
    Ok(VerifiedWorkspace { url, id, name })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[test]
    fn kernel_origins_are_normalized_without_credentials_or_hidden_paths() {
        for (input, expected) in [
            ("http://127.0.0.1:4310", "http://127.0.0.1:4310/"),
            ("  http://localhost:4310/ ", "http://127.0.0.1:4310/"),
            ("http://LOCALHOST:4310", "http://127.0.0.1:4310/"),
            ("http://[::1]:4310", "http://[::1]:4310/"),
            ("https://127.0.0.1", "https://127.0.0.1/"),
            ("https://COMPANY.example:443", "https://company.example/"),
            ("http://192.0.2.7:4310", "http://192.0.2.7:4310/"),
            ("http://office.example:4310", "http://office.example:4310/"),
        ] {
            assert_eq!(kernel_url(input).unwrap().as_str(), expected, "{input}");
        }
        for denied in [
            "127.0.0.1:4310",
            "ftp://127.0.0.1:4310",
            "http://user@127.0.0.1:4310",
            "http://user:secret@127.0.0.1:4310",
            "http://127.0.0.1:4310/chats",
            "http://127.0.0.1:4310/?x=1",
            "http://127.0.0.1:4310/#frag",
            "http://",
            "",
        ] {
            assert!(kernel_url(denied).is_err(), "{denied}");
        }
    }

    /// A fixture kernel: one HTTP answer per connection, then the listener ends.
    async fn fixture(status: &'static str, body: String) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut request = [0u8; 1024];
                let _ = socket.read(&mut request).await;
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        format!("http://localhost:{}", address.port())
    }

    fn health(id: &str) -> String {
        format!(
            r#"{{"name":"zerolux","api_version":1,"version":"0.0.1-dev","capabilities":["chat-v1"],"workspace":{{"id":"{id}","name":"Workspace","created_at":1}}}}"#
        )
    }

    #[tokio::test]
    async fn a_zerolux_kernel_is_verified_and_its_workspace_identity_is_kept() {
        let url = fixture("200 OK", health("ws-1")).await;
        let verified = verify(&url, None).await.unwrap();
        assert_eq!(verified.id, "ws-1");
        assert_eq!(verified.name, "Workspace");
        assert!(verified.url.as_str().starts_with("http://127.0.0.1:"));
        assert_eq!(verify(&url, Some("ws-1")).await.unwrap(), verified);
        let error = verify(&url, Some("ws-other")).await.unwrap_err();
        assert!(
            format!("{error:#}").contains("different workspace"),
            "{error:#}"
        );
    }

    #[tokio::test]
    async fn foreign_services_and_old_kernels_are_refused() {
        let cases = [
            (
                "200 OK",
                r#"{"name":"other","workspace":{"id":"x"}}"#.to_owned(),
                "not a ZeroLux kernel",
            ),
            (
                "200 OK",
                r#"{"name":"zerolux","version":"0.0.1-dev"}"#.to_owned(),
                "did not name its workspace",
            ),
            (
                "200 OK",
                r#"{"name":"zerolux","workspace":{"id":""}}"#.to_owned(),
                "did not name its workspace",
            ),
            (
                "200 OK",
                r#"{"name":"zerolux","workspace":{"id":"old"}}"#.to_owned(),
                "not compatible",
            ),
            (
                "200 OK",
                r#"{"name":"zerolux","api_version":2,"workspace":{"id":"future"}}"#.to_owned(),
                "not compatible",
            ),
            ("200 OK", "not json".to_owned(), "not JSON"),
            ("503 Service Unavailable", "{}".to_owned(), "answered 503"),
            ("302 Found", "{}".to_owned(), "answered 302"),
            (
                "200 OK",
                format!(r#"{{"name":"zerolux","pad":"{}"}}"#, "x".repeat(MAX_BODY)),
                "too large",
            ),
        ];
        for (status, body, expected) in cases {
            let url = fixture(status, body).await;
            let error = verify(&url, None).await.unwrap_err();
            assert!(
                format!("{error:#}").contains(expected),
                "{status}: {error:#}"
            );
        }
    }

    #[tokio::test]
    async fn nothing_answering_is_a_clear_error_not_a_fallback() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let error = verify(&format!("http://127.0.0.1:{port}"), None)
            .await
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("No ZeroLux kernel answered"),
            "{error:#}"
        );
    }
}
