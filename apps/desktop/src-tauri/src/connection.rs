//! A saved connection names a workspace, not just an address. Verify its identity before
//! opening the UI, including when its configured address changes.
use std::time::Duration;

use anyhow::{Context, Result, ensure};

/// A ZeroLux a kernel is, verified by its `/api/health`: an instance of workspaces, or an
/// older kernel of one workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedKernel {
    /// The kernel's address.
    pub url: tauri::Url,
    /// The instance's ID; an older kernel's, its workspace's.
    pub id: String,
    /// What to call it: the computer, or an older kernel's workspace.
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

/// Asks the kernel who it is. With `expected_id`, a different instance is an error: the
/// desktop never adopts another identity silently.
pub async fn verify(value: &str, expected_id: Option<&str>) -> Result<VerifiedKernel> {
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
    let declares = |capability: &str| {
        health["capabilities"]
            .as_array()
            .is_some_and(|all| all.iter().any(|one| one == capability))
    };
    let named = |value: &serde_json::Value| {
        value
            .as_str()
            .filter(|id| !id.trim().is_empty())
            .map(str::to_owned)
    };
    let (id, name) = if declares("instance-auth-v1") {
        let id = named(&health["instance"]["id"])
            .with_context(|| format!("The kernel at {url} did not name its instance"))?;
        (id, url.host_str().unwrap_or("ZeroLux").to_owned())
    } else {
        ensure!(
            !declares("workspaces-v1"),
            "The kernel at {url} runs a version of ZeroLux this app cannot use; update it"
        );
        let id = named(&health["workspace"]["id"]).with_context(|| {
            format!("The kernel at {url} did not name its workspace; update it first")
        })?;
        let name = named(&health["workspace"]["name"]).unwrap_or_else(|| "Workspace".into());
        (id, name)
    };
    if let Some(expected) = expected_id {
        ensure!(
            expected == id,
            "The kernel at {url} is a different ZeroLux than this saved connection"
        );
    }
    Ok(VerifiedKernel { url, id, name })
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
            r#"{{"name":"zerolux","api_version":{version},"version":"0.0.1-dev","capabilities":["chat-v1","auth-v1"],"workspace":{{"id":"{id}","name":"Workspace","created_at":1}}}}"#,
            version = zerolux::api::API_VERSION
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
        assert!(verify(&url, Some("ws-other")).await.is_err());
    }

    #[tokio::test]
    async fn an_instance_is_known_by_its_id_and_a_kernel_of_the_unsupported_version_is_refused() {
        let url = fixture(
            "200 OK",
            r#"{"name":"zerolux","capabilities":["workspaces-v1","instance-auth-v1"],"instance":{"id":"aspen"},"auth":{"setup_required":false}}"#.to_owned(),
        )
        .await;
        let verified = verify(&url, Some("aspen")).await.unwrap();
        assert_eq!(verified.id, "aspen");
        assert_eq!(verified.name, "127.0.0.1");
        assert!(verify(&url, Some("birch")).await.is_err());
        for body in [
            r#"{"name":"zerolux","capabilities":["workspaces-v1","instance-auth-v1"]}"#,
            r#"{"name":"zerolux","capabilities":["workspaces-v1"],"workspaces":[{"id":"aspen","name":"Aspen"}]}"#,
        ] {
            let url = fixture("200 OK", body.to_owned()).await;
            assert!(verify(&url, None).await.is_err(), "{body}");
        }
    }

    #[tokio::test]
    async fn foreign_services_and_old_kernels_are_refused() {
        let cases = [
            (
                "200 OK",
                r#"{"name":"other","workspace":{"id":"x"}}"#.to_owned(),
            ),
            (
                "200 OK",
                r#"{"name":"zerolux","version":"0.0.1-dev"}"#.to_owned(),
            ),
            (
                "200 OK",
                r#"{"name":"zerolux","workspace":{"id":""}}"#.to_owned(),
            ),
            ("503 Service Unavailable", "{}".to_owned()),
            ("302 Found", "{}".to_owned()),
            (
                "200 OK",
                format!(r#"{{"name":"zerolux","pad":"{}"}}"#, "x".repeat(MAX_BODY)),
            ),
        ];
        for (status, body) in cases {
            let url = fixture(status, body).await;
            assert!(verify(&url, None).await.is_err(), "{status}");
        }
        let url = fixture("200 OK", "not json".to_owned()).await;
        let error = verify(&url, None).await.unwrap_err();
        assert!(error.downcast_ref::<serde_json::Error>().is_some());
    }

    #[tokio::test]
    async fn nothing_answering_is_a_clear_error_not_a_fallback() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let error = verify(&format!("http://127.0.0.1:{port}"), None)
            .await
            .unwrap_err();
        assert!(error.downcast_ref::<reqwest::Error>().unwrap().is_connect());
    }
}
