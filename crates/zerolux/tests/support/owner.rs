//! The owner of a fixture kernel started as a process: the real authentication service runs
//! from this checkout with this machine's `bun`; the owner is the instance's first account
//! and makes its workspace.
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

/// The fixture owner's workspace on a kernel, kept in `folder` (the kernel's data directory,
/// as a CLI's own workspace is): made by the first call, found again after a restart. The
/// address its people and agents call.
pub async fn workspace(kernel: &str, folder: &Path) -> String {
    let owner = client(kernel, Duration::from_secs(20)).await;
    let listed: serde_json::Value = owner
        .get(format!("{kernel}/api/workspaces"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = match listed["workspaces"].as_array().unwrap().as_slice() {
        [] => {
            let created: serde_json::Value = owner
                .post(format!("{kernel}/api/workspaces"))
                .json(&json!({ "name": "Fixture", "folder": std::path::absolute(folder).unwrap() }))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json()
                .await
                .unwrap();
            created["workspace"]["id"].as_str().unwrap().to_owned()
        }
        [only] => only["id"].as_str().unwrap().to_owned(),
        _ => panic!("the fixture owner has one workspace"),
    };
    format!("{kernel}/w/{id}")
}

/// A client that is the fixture owner: the instance's first account, signed up, or signed in
/// again when that already happened (a restarted kernel). One sign-in for every workspace at
/// `base`'s kernel.
pub async fn client(base: &str, timeout: Duration) -> Client {
    let kernel = reqwest::Url::parse(base)
        .unwrap()
        .origin()
        .ascii_serialization();
    let anonymous = Client::builder()
        .no_proxy()
        .timeout(timeout)
        .build()
        .unwrap();
    let health: serde_json::Value = anonymous
        .get(format!("{kernel}/api/health"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let response = if health["auth"]["setup_required"] == true {
        anonymous
            .post(format!("{kernel}/api/auth/sign-up/email"))
            .json(&json!({ "name": "Fixture owner", "email": EMAIL, "password": PASSWORD }))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
    } else {
        anonymous
            .post(format!("{kernel}/api/auth/sign-in/email"))
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
    Client::builder()
        .no_proxy()
        .timeout(timeout)
        .default_headers(headers)
        .build()
        .unwrap()
}

fn token_of(response: &reqwest::Response) -> String {
    response.headers()["set-auth-token"]
        .to_str()
        .unwrap()
        .to_owned()
}
