//! Extensions' own pages in a workspace view, from that workspace's kernel only.
//! `zerolux-ui://localhost/<key>/<file>` (`http://zerolux-ui.localhost/…` on Windows) is the
//! kernel's `/api/extension-ui/<key>/<file>`, so the view lets in this scheme and no other origin.
use std::{collections::HashMap, sync::Mutex};

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder, http};

pub const SCHEME: &str = "zerolux-ui";

/// Each workspace view's kernel, by profile.
#[derive(Default)]
pub struct Kernels(Mutex<HashMap<String, tauri::Url>>);

impl Kernels {
    pub fn set(&self, profile: &str, kernel: &tauri::Url) {
        self.0
            .lock()
            .expect("kernels lock")
            .insert(profile.to_owned(), kernel.clone());
    }

    pub fn get(&self, profile: &str) -> Option<tauri::Url> {
        self.0.lock().expect("kernels lock").get(profile).cloned()
    }

    pub fn all(&self) -> HashMap<String, tauri::Url> {
        self.0.lock().expect("kernels lock").clone()
    }
}

/// Whether a view may open this address in itself: an extension's page.
pub fn page(url: &tauri::Url) -> bool {
    let host = url.host_str();
    (url.scheme() == SCHEME && host == Some("localhost"))
        || (url.scheme() == "http" && host == Some("zerolux-ui.localhost"))
}

/// The kernel path a request names, when it is an extension's file under its key, in its
/// workspace's `w/<id>` on a kernel of several, and nothing else: no way up, no other route.
fn kernel_path(path: &str) -> Option<String> {
    let path = path.strip_prefix('/')?;
    let (workspace, path) = match path.strip_prefix("w/") {
        Some(rest) => {
            let (id, rest) = rest.split_once('/')?;
            (
                id.bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                    .then(|| format!("w/{id}/"))?,
                rest,
            )
        }
        None => (String::new(), path),
    };
    let (key, file) = path.split_once('/')?;
    let plain = |part: &str| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-~".contains(&byte))
    };
    (key.len() == 64
        && key.bytes().all(|byte| byte.is_ascii_hexdigit())
        && file.split('/').all(plain))
    .then(|| format!("{workspace}api/extension-ui/{key}/{file}"))
}

pub fn serve<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = context.app_handle().clone();
    let label = context.webview_label().to_owned();
    let path = request.uri().path().to_owned();
    tauri::async_runtime::spawn(async move {
        let response = fetch(&app, &label, &path).await.unwrap_or_else(|error| {
            eprintln!("An extension's page could not be served: {error:#}");
            http::Response::builder()
                .status(http::StatusCode::NOT_FOUND)
                .body(Vec::new())
                .expect("an empty response")
        });
        responder.respond(response);
    });
}

async fn fetch<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    path: &str,
) -> Result<http::Response<Vec<u8>>> {
    let view = app.get_webview_window(label).context("No such view")?;
    let url = view.url()?;
    // The tray's panel shows the rows of the workspace in front.
    let profile = if label == crate::tray::PANEL && crate::local::app_page(&url) {
        crate::app::active_profile(app).context("No workspace in front")?
    } else {
        crate::chrome::workspace_profile(label, &url)
            .context("Not a workspace view")?
            .to_owned()
    };
    let kernel = app
        .state::<Kernels>()
        .0
        .lock()
        .expect("kernels lock")
        .get(&profile)
        .cloned()
        .context("No kernel for this view")?;
    let address = kernel.join(&kernel_path(path).context("Not an extension's file")?)?;
    let answer = reqwest::get(address).await?;
    let mut response = http::Response::builder().status(answer.status().as_u16());
    // Its kind, and the sandbox the kernel puts a page in.
    for name in ["content-type", "x-content-type-options"] {
        if let Some(value) = answer.headers().get(name) {
            response = response.header(name, value.as_bytes());
        }
    }
    if let Some(policy) = answer.headers().get("content-security-policy") {
        let origin = kernel.origin().ascii_serialization();
        response = response.header(
            "content-security-policy",
            own_files(policy.to_str()?, &origin),
        );
    }
    Ok(response.body(answer.bytes().await?.to_vec())?)
}

/// The kernel's policy for a page, with the kernel, by its origin or as `'self'`, named as this
/// scheme, where the page's files now come from. A sandboxed page has no origin of its own, and
/// WebKit matches `'self'` against that.
fn own_files(policy: &str, kernel: &str) -> String {
    let here = "zerolux-ui://localhost http://zerolux-ui.localhost";
    policy
        .split(' ')
        .map(|source| match source.trim_end_matches(';') {
            "'self'" => source.replacen("'self'", here, 1),
            origin if origin == kernel => source.replacen(kernel, here, 1),
            _ => source.to_owned(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn only_an_extensions_file_under_its_key_reaches_the_kernel() {
        assert_eq!(
            kernel_path(&format!("/{KEY}/native/board.js")).as_deref(),
            Some(&*format!("api/extension-ui/{KEY}/native/board.js"))
        );
        assert_eq!(
            kernel_path(&format!("/w/aspen-1/{KEY}/index.html")).as_deref(),
            Some(&*format!("w/aspen-1/api/extension-ui/{KEY}/index.html"))
        );
        for path in [
            format!("/w/../{KEY}/index.html"),
            format!("/w/aspen/api/{KEY}/index.html"),
            format!("/{KEY}/../../auth/session"),
            format!("/{KEY}/%2e%2e/health"),
            format!("/{KEY}/./index.html"),
            format!("/{KEY}//index.html"),
            format!("/{KEY}/"),
            format!("/{KEY}"),
            "/not-a-key/index.html".into(),
            format!("/{}/index.html", &KEY[1..]),
        ] {
            assert_eq!(kernel_path(&path), None, "{path}");
        }
    }

    #[test]
    fn a_pages_own_files_load_under_the_kernels_policy() {
        let kernel = "http://192.0.2.1:4310";
        let here = "zerolux-ui://localhost http://zerolux-ui.localhost";
        for named in ["'self'", kernel] {
            assert_eq!(
                own_files(
                    &format!(
                        "sandbox allow-scripts allow-forms; default-src {named} 'unsafe-inline' data:"
                    ),
                    kernel
                ),
                format!(
                    "sandbox allow-scripts allow-forms; default-src {here} 'unsafe-inline' data:"
                )
            );
        }
        // Another origin stays as the kernel names it.
        assert_eq!(
            own_files("default-src http://192.0.2.1:4311;", kernel),
            "default-src http://192.0.2.1:4311;"
        );
    }

    #[test]
    fn a_view_opens_only_this_scheme_besides_its_own_pages() {
        let url = |text: &str| tauri::Url::parse(text).unwrap();
        assert!(page(&url(&format!(
            "zerolux-ui://localhost/{KEY}/index.html"
        ))));
        assert!(page(&url(&format!(
            "http://zerolux-ui.localhost/{KEY}/index.html"
        ))));
        assert!(!page(&url("zerolux-ui://192.0.2.1/index.html")));
        assert!(!page(&url(
            "https://zerolux-ui.localhost.example/index.html"
        )));
        assert!(!page(&url(
            "http://192.0.2.1:4317/api/extension-ui/x/index.html"
        )));
    }
}
