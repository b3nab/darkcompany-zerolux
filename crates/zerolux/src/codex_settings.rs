//! Settings controls on an already attached Codex thread. No resume, prompt, or replay.
use std::{collections::HashSet, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use tokio::sync::watch;

use crate::{
    agent_settings::{ModelOption, NativeSettings, codex_values},
    codex::CodexRpc,
    model::AgentSettings,
    store::Error,
};

#[cfg(test)]
mod tests;

#[derive(Clone)]
pub(crate) struct CodexSettings {
    pub rpc: CodexRpc,
    pub thread_id: String,
    /// The thread's folder, where its skills are found.
    pub workspace: String,
    pub state: watch::Sender<Value>,
    pub turn: watch::Sender<Option<String>>,
    pub ready: watch::Sender<bool>,
}

impl CodexSettings {
    pub fn values(&self) -> AgentSettings {
        codex_values(&self.state.borrow())
    }

    pub fn observe(&self, event: &Value) {
        if event["params"]["threadId"] != self.thread_id {
            return;
        }
        if event["method"] == "thread/settings/updated" {
            let native = &event["params"]["threadSettings"];
            if !native.is_object() {
                return;
            }
            let mut current = self.state.borrow().clone();
            for (source, target) in [
                ("model", "model"),
                ("effort", "reasoningEffort"),
                ("approvalPolicy", "approvalPolicy"),
                ("sandboxPolicy", "sandbox"),
                ("collaborationMode", "collaborationMode"),
            ] {
                if let Some(value) = native.get(source) {
                    current[target] = value.clone();
                }
            }
            self.state.send_replace(current);
        }
    }

    /// The owner's own input, typed into the thread from ZeroLux. Steered, it joins the
    /// running turn; queued, it waits in Codex's queue and starts the next one; with
    /// interrupt, the running turn stops first. `$name` names one of the thread's skills.
    /// An unconfirmed send is never repeated.
    pub async fn input(
        &self,
        text: &str,
        mode: crate::model::InputMode,
        images: &[String],
    ) -> Result<()> {
        let mut input = Vec::new();
        if !text.trim().is_empty() {
            input.push(json!({"type": "text", "text": text}));
        }
        input.extend(
            images
                .iter()
                .map(|path| json!({"type": "localImage", "path": path})),
        );
        if text.contains('$') {
            for skill in self.skills().await? {
                let named = format!("${}", skill["name"].as_str().unwrap_or_default());
                if text
                    .split(|c: char| c.is_whitespace())
                    .any(|word| word == named)
                {
                    input.push(json!({"type":"skill","name":skill["name"],"path":skill["path"]}));
                }
            }
        }
        let input = Value::Array(input);
        if mode == crate::model::InputMode::Interrupt {
            self.interrupt().await?;
        }
        let running = self.turn.borrow().clone();
        if let Some(turn) = running.filter(|_| mode == crate::model::InputMode::Steer) {
            match self
                .rpc
                .request(
                    "turn/steer",
                    json!({"threadId": self.thread_id, "expectedTurnId": turn,
                        "clientUserMessageId": uuid::Uuid::new_v4().to_string(), "input": input}),
                )
                .await
            {
                Ok(_) => return Ok(()),
                // Only a refusal proves nothing was delivered: the turn ended or cannot be
                // steered, so the input waits for the next turn.
                Err(error)
                    if error
                        .downcast_ref::<crate::codex::Rejected>()
                        .is_some_and(|refusal| refusal.0 == crate::codex::INVALID_REQUEST) => {}
                Err(error) => {
                    return Err(
                        error.context("Codex did not confirm the input; it was not sent again")
                    );
                }
            }
        }
        self.rpc
            .request(
                "thread/queue/add",
                json!({"threadId": self.thread_id,
                    "clientUserMessageId": uuid::Uuid::new_v4().to_string(), "input": input}),
            )
            .await
            .context("Codex did not confirm the input; it was not sent again")?;
        Ok(())
    }

    /// The thread's skills, enabled, for its folder.
    async fn skills(&self) -> Result<Vec<Value>> {
        let listed = self
            .rpc
            .request("skills/list", json!({"cwds": [self.workspace]}))
            .await
            .context("Codex did not list its skills")?;
        Ok(listed["data"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|entry| entry["skills"].as_array().cloned().unwrap_or_default())
            .filter(|skill| skill["enabled"] != false && skill["name"].is_string())
            .collect())
    }

    /// Codex's skills, as what the owner types to use them.
    pub async fn commands(&self) -> Result<Vec<crate::model::SessionCommand>> {
        Ok(self
            .skills()
            .await?
            .into_iter()
            .map(|skill| {
                let name = skill["name"].as_str().unwrap_or_default().to_owned();
                crate::model::SessionCommand {
                    invoke: format!("${name}"),
                    description: skill["interface"]["shortDescription"]
                        .as_str()
                        .or(skill["shortDescription"].as_str())
                        .or(skill["description"].as_str())
                        .unwrap_or_default()
                        .to_owned(),
                    argument_hint: None,
                    name,
                }
            })
            .collect())
    }

    /// What waits in Codex's queue for this thread, oldest first.
    pub async fn queue(&self) -> Result<Vec<crate::live::Queued>> {
        let listed = self
            .rpc
            .request(
                "thread/queue/list",
                json!({"threadId": self.thread_id, "limit": 50}),
            )
            .await
            .context("Codex did not list its queue")?;
        Ok(listed["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|queued| {
                let text = queued["input"]
                    .as_array()?
                    .iter()
                    .map(|part| match part["type"].as_str() {
                        Some("text") => part["text"].as_str().unwrap_or_default().to_owned(),
                        Some(kind) => format!("[{kind}]"),
                        None => String::new(),
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                Some(crate::live::Queued {
                    id: queued["id"].as_str()?.to_owned(),
                    text,
                })
            })
            .collect())
    }

    /// Takes a waiting input out of Codex's queue.
    pub async fn unqueue(&self, item: &str) -> Result<()> {
        self.rpc
            .request(
                "thread/queue/delete",
                json!({"threadId": self.thread_id, "queuedSubmissionId": item}),
            )
            .await
            .context("Codex did not take the input out of its queue")?;
        Ok(())
    }

    /// Rewrites a waiting input in Codex's queue.
    pub async fn requeue(&self, item: &str, text: &str) -> Result<()> {
        self.rpc
            .request(
                "thread/queue/update",
                json!({"threadId": self.thread_id, "queuedSubmissionId": item,
                    "input": [{"type": "text", "text": text}]}),
            )
            .await
            .context("Codex did not change the waiting input")?;
        Ok(())
    }

    /// The goal the thread works toward, as Codex keeps it.
    pub async fn goal(&self) -> Result<Option<crate::live::Goal>> {
        let reply = self
            .rpc
            .request("thread/goal/get", json!({"threadId": self.thread_id}))
            .await
            .context("Codex did not say the thread's goal")?;
        Ok(crate::live::Goal::from_codex(&reply["goal"]))
    }

    /// Sets the thread's goal, or changes what is given of it: Codex then works toward it
    /// across turns, within the token budget when there is one.
    pub async fn set_goal(
        &self,
        objective: Option<&str>,
        status: Option<&str>,
        token_budget: Option<i64>,
    ) -> Result<crate::live::Goal> {
        let mut params = json!({"threadId": self.thread_id});
        if let Some(objective) = objective {
            params["objective"] = json!(objective);
        }
        if let Some(status) = status {
            params["status"] = json!(match status {
                "usage_limited" => "usageLimited",
                "budget_limited" => "budgetLimited",
                status => status,
            });
        }
        if let Some(budget) = token_budget {
            params["tokenBudget"] = json!(budget);
        }
        let reply = self
            .rpc
            .request("thread/goal/set", params)
            .await
            .context("Codex did not set the goal")?;
        crate::live::Goal::from_codex(&reply["goal"]).context("Codex did not return the goal")
    }

    /// The thread no longer has a goal.
    pub async fn clear_goal(&self) -> Result<()> {
        self.rpc
            .request("thread/goal/clear", json!({"threadId": self.thread_id}))
            .await
            .context("Codex did not clear the goal")?;
        Ok(())
    }

    /// Stops the running turn, whoever started it. No turn running: nothing to stop.
    pub async fn interrupt(&self) -> Result<bool> {
        let Some(turn) = self.turn.borrow().clone() else {
            return Ok(false);
        };
        self.rpc
            .request(
                "turn/interrupt",
                json!({"threadId": self.thread_id, "turnId": turn}),
            )
            .await
            .context("Codex did not confirm the interruption")?;
        Ok(true)
    }

    /// Starts summarizing the thread's older history; Codex records the compaction itself.
    /// Not while a turn runs: compacting would cut it short.
    pub async fn compact(&self) -> Result<()> {
        ensure!(
            self.turn.borrow().is_none(),
            "Codex is working: wait for the turn to end or interrupt it"
        );
        self.rpc
            .request("thread/compact/start", json!({"threadId": self.thread_id}))
            .await
            .context("Codex did not confirm the compaction")?;
        Ok(())
    }

    pub async fn read(&self) -> Result<NativeSettings> {
        let models = models(&self.rpc).await?;
        let mut editable = Vec::new();
        if *self.ready.borrow() {
            editable.extend(["model".into(), "effort".into(), "collaboration_mode".into()]);
            if self.turn.borrow().is_none() {
                editable.extend(["approval_policy".into(), "sandbox".into()]);
            }
        }
        Ok(NativeSettings {
            values: self.values(),
            models,
            editable,
        })
    }

    pub async fn apply(&self, patch: &AgentSettings, check: bool) -> Result<NativeSettings> {
        let before = self.read().await?;
        before.validate(patch)?;
        let policy = patch
            .approval_policy
            .as_deref()
            .map(|value| match value {
                "untrusted" | "on-request" | "never" => Ok(value),
                _ => Err(Error::Invalid("Unknown Codex approval policy".into())),
            })
            .transpose()?;
        let sandbox = patch
            .sandbox
            .as_deref()
            .map(|value| match value {
                "read-only" => Ok(json!({"type":"readOnly"})),
                "workspace-write" => Ok(json!({"type":"workspaceWrite"})),
                "danger-full-access" => Ok(json!({"type":"dangerFullAccess"})),
                _ => Err(Error::Invalid("Unknown Codex sandbox".into())),
            })
            .transpose()?;
        if check || patch.fields().iter().all(|(_, value)| value.is_none()) {
            return Ok(before);
        }
        let turn = self.turn.borrow().clone();
        if turn.is_some() && (policy.is_some() || sandbox.is_some()) {
            return Err(Error::Invalid(
                "Codex changes approval policy and sandbox between turns; nothing was applied"
                    .into(),
            )
            .into());
        }
        let mut params = json!({"threadId":self.thread_id});
        if let Some(value) = &patch.model
            && patch.model != before.values.model
        {
            params["model"] = json!(value);
        }
        if let Some(value) = &patch.effort
            && patch.effort != before.values.effort
        {
            params["effort"] = json!(value);
        }
        if let Some(value) = policy
            && patch.approval_policy != before.values.approval_policy
        {
            params["approvalPolicy"] = json!(value);
        }
        if let Some(value) = sandbox
            && patch.sandbox != before.values.sandbox
        {
            params["sandboxPolicy"] = value;
        }
        // Planning first, or acting: Codex's mode for the next turns, with the model and
        // effort they run with.
        if let Some(mode) = &patch.collaboration_mode
            && patch.collaboration_mode != before.values.collaboration_mode
        {
            params["collaborationMode"] = json!({"mode": mode, "settings": {
                "model": patch.model.as_ref().or(before.values.model.as_ref()),
                "reasoning_effort": patch.effort.as_ref().or(before.values.effort.as_ref()),
                "developer_instructions": null,
            }});
        }
        let permissions_changed =
            params.get("approvalPolicy").is_some() || params.get("sandboxPolicy").is_some();
        let mut observed = self.state.subscribe();
        self.rpc.request("thread/settings/update", params).await?;
        if let Some(turn) = turn
            && (patch.model.is_some() || patch.effort.is_some())
        {
            let mut params = json!({"threadId":self.thread_id,"turnId":turn});
            if let Some(value) = &patch.model {
                params["model"] = json!(value);
            }
            if let Some(value) = &patch.effort {
                params["effort"] = json!(value);
            }
            let result = self.rpc.request("turn/settings/update", params).await?;
            ensure!(
                matches!(
                    result["status"].as_str(),
                    Some("applied" | "targetUnavailable")
                ),
                "Codex did not confirm the running turn's settings"
            );
            // targetUnavailable means that exact turn ended. The thread's confirmed
            // settings already apply to its next turn; never start or replay one here.
        }
        let confirmed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let snapshot = NativeSettings { values: self.values(), models: before.models.clone(), editable: before.editable.clone() };
                if snapshot.confirm(patch).is_ok() { return Ok::<_, anyhow::Error>(snapshot); }
                observed.changed().await?;
            }
        }).await.context("Codex accepted the change but its resulting settings were not confirmed; refresh before making another change")??;
        ensure!(
            !permissions_changed || self.turn.borrow().is_none(),
            "Codex changed the thread settings, but a turn started before confirmation; its running permissions were not changed"
        );
        Ok(confirmed)
    }
}

pub(crate) async fn models(rpc: &CodexRpc) -> Result<Vec<ModelOption>> {
    let mut result = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen = HashSet::new();
    for _ in 0..100 {
        let page = rpc
            .request(
                "model/list",
                json!({"limit":100,"cursor":cursor,"includeHidden":false}),
            )
            .await?;
        for model in page["data"]
            .as_array()
            .context("Codex did not return its model catalog")?
        {
            if model["hidden"] == true {
                continue;
            }
            result.push(ModelOption {
                value: model["model"]
                    .as_str()
                    .context("Missing native model value")?
                    .to_owned(),
                label: model["displayName"]
                    .as_str()
                    .context("Missing native model label")?
                    .to_owned(),
                resolved_model: None,
                efforts: model["supportedReasoningEfforts"]
                    .as_array()
                    .context("Missing native effort choices")?
                    .iter()
                    .map(|option| {
                        option["reasoningEffort"]
                            .as_str()
                            .map(str::to_owned)
                            .context("Invalid native effort choice")
                    })
                    .collect::<Result<_>>()?,
            });
        }
        cursor = page["nextCursor"].as_str().map(str::to_owned);
        let Some(cursor) = &cursor else {
            return Ok(result);
        };
        ensure!(
            seen.insert(cursor.clone()),
            "Codex repeated a catalog cursor"
        );
    }
    bail!("Codex model catalog exceeded its pagination bound")
}
