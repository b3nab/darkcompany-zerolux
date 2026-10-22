//! Signing in to another service with OAuth, for any extension: it names the service, the
//! person signs in there, and the service comes back to the kernel, which keeps the tokens
//! among the extension's secrets and renews them. Authorization code with PKCE.

use std::collections::HashMap;

use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::Digest;

use crate::store::Error;

/// How long a sign-in may take, from its start to the service's return.
const PENDING_MS: i64 = 15 * 60 * 1000;
/// A token this close to its end is renewed before it is given.
const MARGIN_MS: i64 = 60 * 1000;
/// Where the service sends the person back, on the kernel's own address.
pub const CALLBACK: &str = "/api/extensions/oauth/callback";

/// What an extension asks: the secret to keep the tokens in, and the service.
#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    pub secret: String,
    pub authorize_url: String,
    pub token_url: String,
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    /// More of the service's own parameters, such as `access_type=offline`.
    #[serde(default)]
    pub params: Map<String, Value>,
    /// The kernel's address as the person's device reaches it; the kernel's own by default.
    #[serde(default)]
    pub origin: Option<String>,
}

/// A sign-in under way.
#[derive(Debug, Clone)]
pub struct Pending {
    pub extension: String,
    pub request: Request,
    pub redirect_uri: String,
    verifier: String,
    expires: i64,
}

#[derive(Default)]
pub struct Flows {
    pending: std::sync::Mutex<HashMap<String, Pending>>,
}

fn random(bytes: usize) -> Result<String> {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).context("No randomness for a sign-in")?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buffer))
}

/// A service's address: HTTPS, or this computer's own for a service running here.
fn service(url: &str) -> Result<reqwest::Url> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|_| Error::Invalid(format!("`{url}` is not an address")))?;
    let local = matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    ensure!(
        parsed.scheme() == "https" || (parsed.scheme() == "http" && local),
        Error::Invalid(format!("`{url}` is not an HTTPS address"))
    );
    Ok(parsed)
}

impl Flows {
    /// Starts a sign-in: the address the person opens.
    pub fn start(&self, extension: &str, request: Request, origin: &str) -> Result<Value> {
        ensure!(
            !request.secret.is_empty() && request.secret.len() <= 200,
            Error::Invalid("A secret's name is 1 to 200 bytes".into())
        );
        ensure!(
            !request.client_id.is_empty(),
            Error::Invalid("Give the service's client ID".into())
        );
        service(&request.token_url)?;
        let mut url = service(&request.authorize_url)?;
        let origin = request
            .origin
            .as_deref()
            .filter(|origin| !origin.is_empty())
            .unwrap_or(origin)
            .trim_end_matches('/')
            .to_owned();
        let redirect_uri = format!("{origin}{CALLBACK}");
        let state = random(32)?;
        let verifier = random(48)?;
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(sha2::Sha256::digest(verifier.as_bytes()));
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("response_type", "code")
                .append_pair("client_id", &request.client_id)
                .append_pair("redirect_uri", &redirect_uri)
                .append_pair("state", &state)
                .append_pair("code_challenge", &challenge)
                .append_pair("code_challenge_method", "S256");
            if !request.scopes.is_empty() {
                query.append_pair("scope", &request.scopes.join(" "));
            }
            for (key, value) in &request.params {
                let value = match value {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                };
                query.append_pair(key, &value);
            }
        }
        let now = crate::store::now_ms();
        let mut pending = self.pending.lock().expect("sign-ins");
        pending.retain(|_, flow| flow.expires > now);
        pending.insert(
            state,
            Pending {
                extension: extension.to_owned(),
                request,
                redirect_uri: redirect_uri.clone(),
                verifier,
                expires: now + PENDING_MS,
            },
        );
        Ok(json!({"url": url.to_string(), "redirect_uri": redirect_uri}))
    }

    /// The sign-in a service's return belongs to, once.
    pub fn take(&self, state: &str) -> Option<Pending> {
        let flow = self.pending.lock().expect("sign-ins").remove(state)?;
        (flow.expires > crate::store::now_ms()).then_some(flow)
    }
}

/// What the service's token endpoint answered, kept with what renews it.
fn tokens(answer: &Value, request: &Request, previous: Option<&Value>) -> Result<Value> {
    let access = answer["access_token"]
        .as_str()
        .context("The service gave no access token")?;
    let expires_at = answer["expires_in"]
        .as_i64()
        .map(|seconds| crate::store::now_ms() + seconds * 1000);
    // A renewal may not send the refresh token again: the one held stays.
    let refresh = answer["refresh_token"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| previous.and_then(|held| held["refresh_token"].as_str().map(str::to_owned)));
    Ok(json!({
        "type": "oauth",
        "access_token": access,
        "refresh_token": refresh,
        "token_type": answer["token_type"].as_str().unwrap_or("Bearer"),
        "scope": answer["scope"].clone(),
        "expires_at": expires_at,
        "token_url": request.token_url,
        "client_id": request.client_id,
        "client_secret": request.client_secret,
    }))
}

async fn post(url: &str, form: &[(&str, &str)]) -> Result<Value> {
    let response = reqwest::Client::new()
        .post(service(url)?)
        .header("Accept", "application/json")
        .form(form)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .context("The service could not be reached")?;
    let status = response.status();
    let answer: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let reason = answer["error_description"]
            .as_str()
            .or(answer["error"].as_str())
            .unwrap_or("no reason given");
        bail!("The service refused ({status}): {reason}");
    }
    Ok(answer)
}

/// Exchanges the code the service came back with for tokens.
pub async fn exchange(flow: &Pending, code: &str) -> Result<Value> {
    let request = &flow.request;
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", flow.redirect_uri.as_str()),
        ("client_id", request.client_id.as_str()),
        ("code_verifier", flow.verifier.as_str()),
    ];
    if let Some(secret) = request.client_secret.as_deref() {
        form.push(("client_secret", secret));
    }
    tokens(&post(&request.token_url, &form).await?, request, None)
}

/// Whether kept tokens are due for renewal.
pub fn due(held: &Value) -> bool {
    held["expires_at"]
        .as_i64()
        .is_some_and(|until| until - MARGIN_MS <= crate::store::now_ms())
}

/// Renews kept tokens with their refresh token.
pub async fn renew(held: &Value) -> Result<Value> {
    let refresh = held["refresh_token"]
        .as_str()
        .context("Sign in again: the service gave no refresh token")?;
    let request = Request {
        secret: String::new(),
        authorize_url: String::new(),
        token_url: held["token_url"]
            .as_str()
            .context("These are not tokens of a sign-in")?
            .to_owned(),
        client_id: held["client_id"].as_str().unwrap_or_default().to_owned(),
        client_secret: held["client_secret"].as_str().map(str::to_owned),
        scopes: Vec::new(),
        params: Map::new(),
        origin: None,
    };
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
        ("client_id", request.client_id.as_str()),
    ];
    if let Some(secret) = request.client_secret.as_deref() {
        form.push(("client_secret", secret));
    }
    let answer = post(&request.token_url, &form)
        .await
        .context("Sign in again")?;
    tokens(&answer, &request, Some(held))
}

/// The page the person sees once the service sent them back.
pub fn page(done: Result<(), String>) -> String {
    let (title, text) = match done {
        Ok(()) => (
            "Signed in",
            "Signed in. You can close this page.".to_owned(),
        ),
        Err(reason) => ("Not signed in", format!("Not signed in: {reason}")),
    };
    let escape = |text: &str| {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" \
         content=\"width=device-width\"><title>{}</title><style>body{{font:16px system-ui;\
         margin:20vh auto;max-width:28rem;padding:0 1rem;text-align:center}}</style></head>\
         <body><p>{}</p></body></html>",
        escape(title),
        escape(&text)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> Request {
        serde_json::from_value(json!({
            "secret": "drive:work", "authorize_url": "https://accounts.example/auth",
            "token_url": "https://accounts.example/token", "client_id": "client",
            "scopes": ["a", "b"], "params": {"access_type": "offline"}}))
        .unwrap()
    }

    #[test]
    fn a_sign_in_asks_with_pkce_and_comes_back_to_the_kernel_once() {
        let flows = Flows::default();
        let started = flows
            .start("x.drive", request(), "http://127.0.0.1:4310/")
            .unwrap();
        let url = reqwest::Url::parse(started["url"].as_str().unwrap()).unwrap();
        let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(
            query["redirect_uri"],
            "http://127.0.0.1:4310/api/extensions/oauth/callback"
        );
        assert_eq!(query["scope"], "a b");
        assert_eq!(query["access_type"], "offline");
        assert_eq!(query["code_challenge_method"], "S256");
        let flow = flows.take(&query["state"]).unwrap();
        assert_eq!(flow.extension, "x.drive");
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(sha2::Sha256::digest(flow.verifier.as_bytes()));
        assert_eq!(query["code_challenge"], challenge);
        assert!(flows.take(&query["state"]).is_none(), "once");
        let mut plain = request();
        plain.token_url = "http://accounts.example/token".into();
        assert!(flows.start("x.drive", plain, "http://127.0.0.1").is_err());
    }

    #[test]
    fn renewed_tokens_keep_the_refresh_token_they_were_not_sent_again() {
        let held = tokens(
            &json!({"access_token": "a1", "refresh_token": "r1", "expires_in": 3600}),
            &request(),
            None,
        )
        .unwrap();
        assert!(!due(&held));
        let renewed = tokens(
            &json!({"access_token": "a2", "expires_in": 30}),
            &request(),
            Some(&held),
        )
        .unwrap();
        assert_eq!(renewed["refresh_token"], "r1");
        assert!(due(&renewed));
    }
}
