//! The owner of a fixture kernel started as a process: the real authentication service runs
//! from this checkout with this machine's `bun`, and the owner signs up with the setup
//! credential the kernel wrote in its data directory.
#![allow(dead_code)]

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    time::Duration,
};

use reqwest::Client;
use serde_json::json;

const EMAIL: &str = "owner@example.test";
const PASSWORD: &str = "correct horse battery";

/// `--auth-entry <checkout>/services/auth/src/server.ts`.
pub fn auth_entry_args() -> [OsString; 2] {
    let entry = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../services/auth/src/server.ts");
    ["--auth-entry".into(), entry.into()]
}

/// The directory of this machine's `bun`, for a fixture's otherwise bare PATH.
pub fn bun_dir() -> PathBuf {
    std::env::var_os("PATH")
        .as_deref()
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .find(|directory| directory.join("bun").is_file())
        .expect("bun is installed")
}

/// A kernel's first workspace: the address its people and agents call.
pub async fn workspace(kernel: &str) -> String {
    let health: serde_json::Value = Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("{kernel}/api/health"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = health["workspaces"][0]["id"]
        .as_str()
        .expect("the kernel serves a workspace");
    format!("{kernel}/w/{id}")
}

/// A client that is the owner: the first account, signed up and claimed, or signed in again
/// when that already happened (a restarted kernel).
pub async fn client(base: &str, timeout: Duration) -> Client {
    let anonymous = Client::builder()
        .no_proxy()
        .timeout(timeout)
        .build()
        .unwrap();
    let health: serde_json::Value = anonymous
        .get(format!("{base}/api/health"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let first = health["auth"]["setup_required"] == true;
    let response = if first {
        anonymous
            .post(format!("{base}/api/auth/sign-up/email"))
            .json(&json!({ "name": "Fixture owner", "email": EMAIL, "password": PASSWORD }))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
    } else {
        anonymous
            .post(format!("{base}/api/auth/sign-in/email"))
            .json(&json!({ "email": EMAIL, "password": PASSWORD }))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
    };
    let token = token_of(&response);
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::AUTHORIZATION,
        format!("Bearer {token}").parse().unwrap(),
    );
    let owner = Client::builder()
        .no_proxy()
        .timeout(timeout)
        .default_headers(headers)
        .build()
        .unwrap();
    if first {
        owner
            .post(format!("{base}/api/auth/claim"))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
    }
    owner
}

fn token_of(response: &reqwest::Response) -> String {
    response.headers()["set-auth-token"]
        .to_str()
        .unwrap()
        .to_owned()
}
