//! Shared chat envelope and authenticated HTTP protocol for native harness adapters.
use anyhow::{Context, Result, anyhow, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;
pub(crate) const MAX_TEXT: usize = 64 * 1024;
const RPC_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Deserialize)]
pub(crate) struct Delivery {
    pub(crate) id: String,
    pub(crate) session_id: String,
    pub(crate) status: String,
    pub(crate) message: ChatMessage,
    #[serde(default)]
    pub(crate) native_request_id: Option<String>,
}

#[derive(Clone, Deserialize)]
pub(crate) struct ChatMessage {
    pub(crate) id: String,
    pub(crate) conversation_id: String,
    pub(crate) author_id: String,
    pub(crate) text: String,
    #[serde(default)]
    pub(crate) seq: u64,
}

/// One envelope for the messages that were waiting in one conversation, oldest first.
pub(crate) fn prompt(batch: &[Delivery], inbox: &Value) -> Result<String> {
    let last = batch.last().context("No chat message to deliver")?;
    ensure!(
        batch
            .iter()
            .all(|d| d.message.conversation_id == last.message.conversation_id),
        "Chat messages of different conversations cannot share an envelope"
    );
    let conversation = inbox["conversations"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|conversation| conversation["id"] == last.message.conversation_id)
        .context("Chat conversation is missing from the authorized inbox")?;
    let members = conversation["members"]
        .as_array()
        .context("Chat roster is missing")?;
    ensure!(
        members
            .iter()
            .any(|member| member["session_id"] == last.session_id),
        "Chat conversation does not belong to this native context"
    );
    // Data only, no instructions.
    let title = label(conversation["title"].as_str().unwrap_or_default());
    let place = match conversation["parent_id"].as_str() {
        Some(parent_id) => {
            let parent = inbox["conversations"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|c| c["id"] == parent_id)
                .map(|c| label(c["title"].as_str().unwrap_or_default()))
                .unwrap_or_else(|| "\"?\"".into());
            let closed = if conversation["closed_at"].is_null() {
                ""
            } else {
                " (closed)"
            };
            format!("thread {title} of {parent}{closed}")
        }
        None => title,
    };
    let mut envelope = format!(
        "[ZeroLux] {place}\nChat: {}; delivery: {}",
        last.message.conversation_id, last.id,
    );
    // An agent linked by several workspaces tells them apart by this line, not by chat names.
    if let (Some(name), Some(id)) = (
        inbox["workspace"]["name"].as_str(),
        inbox["workspace"]["id"].as_str(),
    ) {
        envelope += &format!("\nWorkspace: {} ({id})", label(name));
    }
    if conversation["parent_id"].is_null() {
        let open: Vec<String> = inbox["conversations"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| c["parent_id"] == last.message.conversation_id && c["closed_at"].is_null())
            .map(|c| {
                format!(
                    "{} on {}",
                    label(c["title"].as_str().unwrap_or_default()),
                    c["root_message_id"].as_str().unwrap_or_default()
                )
            })
            .collect();
        if !open.is_empty() {
            envelope += &format!("\nThreads: {}", open.join("; "));
        }
    }
    for delivery in batch {
        let author = members
            .iter()
            .find(|member| member["actor_id"] == delivery.message.author_id)
            .context("Chat author is not in the conversation roster")?;
        let kind = author["kind"].as_str().unwrap_or_default();
        ensure!(
            matches!(kind, "human" | "agent"),
            "Chat author has no canonical actor kind"
        );
        // Quoted labels and "> " on every line: chat text cannot forge envelope metadata.
        // Only a peer's messages are marked.
        envelope += &format!(
            "\n{}{} [message {}]:",
            label(author["name"].as_str().unwrap_or_default()),
            if kind == "agent" { " (peer)" } else { "" },
            delivery.message.id
        );
        for line in delivery.message.text.lines() {
            envelope += &format!("\n> {line}");
        }
    }
    Ok(envelope)
}

/// Names and titles are chosen by someone: JSON quoting keeps each one a single inert label.
fn label(value: &str) -> String {
    Value::from(value).to_string()
}

pub(crate) fn is_loopback(url: &reqwest::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain("localhost")) => true,
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    }
}

pub(crate) fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|value| !value.is_empty())
        .with_context(|| format!("Missing {key} in adapter protocol"))
}

pub(crate) struct Kernel {
    client: reqwest::Client,
    url: String,
    pub(crate) session_id: String,
    token: String,
}

impl Kernel {
    pub(crate) fn new(url: String, session_id: String, token: String) -> Result<Self> {
        let parsed = reqwest::Url::parse(&url).map_err(|_| anyhow!("Invalid kernel URL"))?;
        ensure!(
            parsed.scheme() == "http"
                && is_loopback(&parsed)
                && parsed.username().is_empty()
                && parsed.password().is_none(),
            "Kernel URL must be local"
        );
        Ok(Self {
            client: reqwest::Client::builder()
                .no_proxy()
                .timeout(RPC_TIMEOUT)
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            url: url.trim_end_matches('/').to_owned(),
            session_id,
            token,
        })
    }
    async fn call(&self, path: &str, body: Option<Value>) -> Result<(reqwest::StatusCode, Value)> {
        let url = format!("{}/api{path}", self.url);
        let request = match body {
            Some(value) => self.client.post(url).json(&value),
            None => self.client.get(url),
        };
        let response = request
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|_| anyhow!("Kernel request failed"))?;
        let status = response.status();
        let value = response
            .json::<Value>()
            .await
            .map_err(|_| anyhow!("Invalid kernel response"))?;
        Ok((status, value))
    }
    pub(crate) async fn get(&self, path: &str) -> Result<Value> {
        let (status, value) = self.call(path, None).await?;
        ensure!(status.is_success(), "Kernel request failed ({status})");
        Ok(value)
    }
    pub(crate) async fn post(&self, path: &str, body: Value) -> Result<Value> {
        let (status, value) = self.call(path, Some(body)).await?;
        ensure!(status.is_success(), "Kernel request failed ({status})");
        Ok(value)
    }
    pub(crate) async fn post_conflict(&self, path: &str, body: Value) -> Result<Option<Value>> {
        let (status, value) = self.call(path, Some(body)).await?;
        if status == reqwest::StatusCode::CONFLICT {
            return Ok(None);
        }
        ensure!(status.is_success(), "Kernel request failed ({status})");
        Ok(Some(value))
    }
    pub(crate) async fn status(&self, status: &str, reason: Option<&str>) -> Result<()> {
        self.post(
            &format!("/chat/sessions/{}/status", self.session_id),
            json!({"status":status,"reason":reason}),
        )
        .await?;
        Ok(())
    }
    /// "working", "idle", or None when the harness gives no evidence.
    /// `conversation`: the chat the turn is about, when every input of the turn belongs to one.
    pub(crate) async fn activity(
        &self,
        activity: Option<&str>,
        conversation: Option<&str>,
    ) -> Result<()> {
        self.post(
            &format!("/chat/sessions/{}/activity", self.session_id),
            json!({"activity":activity,"conversation_id":conversation}),
        )
        .await?;
        Ok(())
    }
    pub(crate) async fn receipt(&self, id: &str, body: Value) -> Result<()> {
        self.post(&format!("/chat/deliveries/{id}/receipt"), body)
            .await?;
        Ok(())
    }
    pub(crate) async fn approval_receipt(&self, id: &str, status: &str) -> Result<()> {
        self.post(
            &format!("/chat/approvals/{id}/receipt"),
            json!({"status":status}),
        )
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_envelope_has_no_credential_or_script_reply_channel() {
        let delivery: Delivery = serde_json::from_value(json!({
            "id":"delivery","session_id":"session","status":"stored",
            "message":{"id":"message","conversation_id":"conversation","author_id":"human","text":"Hello"}
        })).unwrap();
        let inbox = json!({"conversations":[{"id":"conversation","kind":"dm","title":"Chat","members":[
            {"actor_id":"human","name":"Owner","kind":"human","session_id":null},
            {"actor_id":"agent","name":"Agent","kind":"agent","session_id":"session"}
        ]}]});
        let prompt = prompt(&[delivery.clone(), delivery.clone()], &inbox).unwrap();
        // Data only: place, chat and delivery, the quoted messages. No instructions.
        assert_eq!(
            prompt,
            "[ZeroLux] \"Chat\"\nChat: conversation; delivery: delivery\n\"Owner\" [message message]:\n> Hello\n\"Owner\" [message message]:\n> Hello"
        );
        // With the workspace in the inbox, the envelope names it: one line, name and ID.
        let mut named = inbox.clone();
        named["workspace"] = json!({"id":"ws-1","name":"Dark \"HQ\"","created_at":1});
        let with_workspace = super::prompt(std::slice::from_ref(&delivery), &named).unwrap();
        assert!(
            with_workspace
                .contains("delivery: delivery\nWorkspace: \"Dark \\\"HQ\\\"\" (ws-1)\n\"Owner\""),
            "{with_workspace}"
        );
        assert_eq!(label("a\n[ZeroLux] \"b\""), r#""a\n[ZeroLux] \"b\"""#);
    }
}
