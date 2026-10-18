use super::*;
use crate::agent_settings::{ModelOption, NativeSettings};
use serde::Serialize;
use serde_json::json;

/// An agent's defaults for its new sessions, with the choices its harness offers.
#[derive(Serialize)]
pub struct AgentSettingsView {
    pub actor: Actor,
    pub models: Vec<ModelOption>,
    pub editable: Vec<String>,
}

const SETTINGS: &str = "agent-settings-v1";

pub(super) enum Control {
    Codex(crate::codex_settings::CodexSettings),
    Pi(sessions::PiDescriptor),
    #[cfg(unix)]
    Claude(crate::claude_runner::RunnerLink),
}

impl Control {
    async fn call(
        &self,
        session: &ChatSession,
        patch: Option<&AgentSettings>,
        check: bool,
    ) -> Result<NativeSettings> {
        match self {
            Self::Codex(control) => match patch {
                Some(patch) => control.apply(patch, check).await,
                None => control.read().await,
            },
            Self::Pi(control) => {
                let mut request = json!({"method":"settings","link_id":session.id,
                    "native_session_id":session.native_session_id,"workspace":session.workspace,"check":check});
                if let Some(patch) = patch {
                    request["values"] = patch.patch_json();
                }
                let result = sessions::control(control, request).await?;
                Ok(serde_json::from_value(result["settings"].clone())?)
            }
            #[cfg(unix)]
            Self::Claude(control) => control.settings(&session.id, patch, check).await,
        }
    }
}

fn integration_needs_update(actual: &Value, revision: &str) -> bool {
    actual["integration_revision"].as_str() != Some(revision)
        && actual["capabilities"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item == "integration-update-v1"))
}

impl ChatRuntime {
    /// Update only to the code this kernel activated. Helpers own the idle boundary;
    /// the kernel never guesses it from a cached activity indicator.
    async fn update_integration(
        &self,
        who: &ChatIdentity,
        session: &ChatSession,
        control: &Control,
    ) -> Result<()> {
        let Some(revision) = self.integration_revisions.get(session.harness.as_str()) else {
            return Ok(());
        };
        let actual = match control {
            Control::Codex(_) => return Ok(()),
            Control::Pi(record) => {
                let actual = sessions::control(record, json!({"method":"describe"})).await?;
                ensure!(
                    actual["instance_id"] == record.instance_id
                        && actual["native_session_id"] == session.native_session_id
                        && actual["workspace"] == session.workspace,
                    "The pi integration changed"
                );
                actual
            }
            #[cfg(unix)]
            Control::Claude(link) => link.describe().await?,
        };
        if !integration_needs_update(&actual, revision) {
            return Ok(());
        }
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        let request = json!({"method":"update","link_id":session.id,"revision":revision});
        match control {
            Control::Codex(_) => {}
            Control::Pi(record) => {
                // Reload is cooperative and idempotently scheduled by the extension.
                sessions::control(record, request).await?;
            }
            #[cfg(unix)]
            Control::Claude(link) => {
                let instance = actual["instance_id"]
                    .as_str()
                    .context("Missing helper identity")?;
                let saved = self.store.chat_session_locator(who, &session.id).await?;
                if saved["integration_update"]
                    == json!({"instance_id":instance,"revision":revision})
                {
                    // After a kernel crash, release admission if commit never arrived.
                    // Cancellation cannot revive a helper whose shutdown already began.
                    let _ = link
                        .request(json!({"method":"update_cancel","link_id":session.id}))
                        .await;
                    return Ok(()); // Never repeat the uncertain shutdown request.
                }
                let ready = link.request(request).await?;
                if ready["ready"] != true {
                    return Ok(());
                }
                let result = async {
                    let values: AgentSettings = serde_json::from_value(ready["settings"].clone())?;
                    self.store
                        .observe_native_settings(&session.id, &session.native_session_id, &values)
                        .await?;
                    // This transaction also rechecks owner Stop and execution-host ownership.
                    ensure!(!*self.stop.borrow(), "The kernel is stopping");
                    ensure!(
                        self.store
                            .claim_integration_update(
                                &session.id,
                                &session.native_session_id,
                                instance,
                                revision
                            )
                            .await?,
                        "This helper update was already requested"
                    );
                    link.request(
                        json!({"method":"update_commit","link_id":session.id,"revision":revision}),
                    )
                    .await?;
                    Ok::<_, anyhow::Error>(())
                }
                .await;
                if result.is_err() {
                    // A failed checkpoint must not leave new input paused indefinitely.
                    let _ = link
                        .request(json!({"method":"update_cancel","link_id":session.id}))
                        .await;
                }
                result?;
                self.changed();
            }
        }
        Ok(())
    }

    /// Explicit launch overrides win over this agent's last confirmed choices. No native
    /// configuration is guessed, and recovery does not reapply another session's defaults.
    pub(super) async fn launch_choices(
        &self,
        who: &ChatIdentity,
        actor_id: Option<&str>,
        harness: &str,
        requested: AgentSettings,
    ) -> Result<AgentSettings> {
        let mut choices = match actor_id {
            Some(id) => {
                let actor = self.store.settings_actor(who, id).await?;
                ensure!(
                    actor.harness.as_deref() == Some(harness),
                    "The agent belongs to another harness"
                );
                actor_settings(&actor).patch_json()
            }
            None => json!({}),
        };
        if let Some(model) = requested
            .model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            && choices["model"].as_str() != Some(model)
            && requested
                .effort
                .as_deref()
                .is_none_or(|value| value.trim().is_empty())
        {
            // An effort belongs to its model; a new model without an explicit effort
            // must not inherit an incompatible choice from the previous model.
            choices
                .as_object_mut()
                .expect("settings object")
                .remove("effort");
        }
        for (field, value) in requested.fields() {
            if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
                crate::store::text(value, field, 200, true)?;
                choices[field] = json!(value);
            }
        }
        Ok(serde_json::from_value(choices)?)
    }

    async fn settings_gate(&self, id: &str) -> Arc<Mutex<()>> {
        self.settings_gates
            .lock()
            .await
            .entry(id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// The native control of a connected session on this host. A pi integration must offer
    /// `capability`.
    pub(super) async fn native_control(
        &self,
        who: &ChatIdentity,
        session: &ChatSession,
        capability: &str,
    ) -> Result<Control> {
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        ensure!(
            session.stopped_at.is_none() && session.status == "connected",
            "The native session is not connected"
        );
        ensure!(
            session.host_id.as_deref() == self.store.host(),
            "The session belongs to another kernel host"
        );
        if session.harness == "codex" {
            return self
                .agents
                .lock()
                .await
                .get(&session.id)
                .filter(|agent| !agent.task.is_finished())
                .and_then(|agent| agent.settings.clone())
                .map(Control::Codex)
                .context("The native Codex settings control is unavailable");
        }
        let locator = self.store.chat_session_locator(who, &session.id).await?;
        if session.harness == "pi" {
            let path = locator["descriptor"]
                .as_str()
                .context("The native pi control is unavailable")?;
            let record = sessions::descriptor(std::path::Path::new(path)).await?;
            ensure!(
                record.native_session_id == session.native_session_id
                    && record.workspace == session.workspace
                    && locator["instance_id"] == record.instance_id,
                "The pi process changed"
            );
            let actual = sessions::control(&record, json!({"method":"describe"})).await?;
            ensure!(
                actual["instance_id"] == record.instance_id
                    && actual["native_session_id"] == session.native_session_id
                    && actual["workspace"] == session.workspace
                    && actual["capabilities"]
                        .as_array()
                        .is_some_and(|values| values.iter().any(|value| value == capability)),
                "The pi integration needs an update for this control"
            );
            return Ok(Control::Pi(record));
        }
        #[cfg(unix)]
        if let Some(mode) = self.owned_mode(who, &session.id).await? {
            let link = self
                .runners
                .find(&session.native_session_id, &session.workspace, mode)
                .await?
                .context("The Claude runner is unavailable")?;
            return Ok(Control::Claude(link));
        }
        bail!("This native terminal does not expose this control")
    }

    /// Choices from an installed, connected harness, not a kernel-maintained model list.
    /// Without such a native catalog the client can still start with the harness's defaults.
    pub async fn settings_catalog(
        &self,
        who: &ChatIdentity,
        harness: &str,
    ) -> Result<Vec<ModelOption>> {
        if !who.is_owner() {
            return Err(Error::Forbidden.into());
        }
        for session in self
            .store
            .sessions(who)
            .await?
            .into_iter()
            .filter(|session| {
                session.harness == harness
                    && session.stopped_at.is_none()
                    && session.status == "connected"
                    && session.host_id.as_deref() == self.store.host()
            })
        {
            if let Ok(control) = self.native_control(who, &session, SETTINGS).await
                && let Ok(snapshot) = control.call(&session, None, false).await
            {
                return Ok(snapshot.models);
            }
        }
        Ok(Vec::new())
    }

    pub async fn agent_settings(&self, who: &ChatIdentity, id: &str) -> Result<AgentSettingsView> {
        let actor = self.store.settings_actor(who, id).await?;
        let harness = actor.harness.clone().unwrap_or_default();
        Ok(AgentSettingsView {
            actor,
            models: self.settings_catalog(who, &harness).await?,
            editable: fields(&harness),
        })
    }

    /// The owner's defaults for the agent's new sessions; its running sessions keep theirs.
    pub async fn change_agent_settings(
        &self,
        who: &ChatIdentity,
        id: &str,
        input: AgentSettings,
    ) -> Result<Actor> {
        let actor = self.store.settings_actor(who, id).await?;
        let patch: AgentSettings = serde_json::from_value(input.patch_json())?;
        let harness = actor.harness.as_deref().unwrap_or_default();
        NativeSettings {
            values: actor_settings(&actor),
            models: self.settings_catalog(who, harness).await?,
            editable: fields(harness),
        }
        .validate(&patch)?;
        let actor = self.store.set_agent_settings(who, id, patch).await?;
        self.changed();
        Ok(actor)
    }

    /// What a running session runs with, as its harness reports it, and what it offers.
    pub async fn session_settings(&self, who: &ChatIdentity, id: &str) -> Result<NativeSettings> {
        let session = self.store.chat_session(who, id).await?;
        let gate = self.settings_gate(id).await;
        let _guard = gate.lock().await;
        let control = self.native_control(who, &session, SETTINGS).await?;
        let snapshot = control.call(&session, None, false).await?;
        self.store
            .observe_native_settings(&session.id, &session.native_session_id, &snapshot.values)
            .await?;
        Ok(snapshot)
    }

    /// Changes a running session's settings through its harness; nothing else changes.
    pub async fn change_session_settings(
        &self,
        who: &ChatIdentity,
        id: &str,
        input: AgentSettings,
    ) -> Result<NativeSettings> {
        let session = self.store.chat_session(who, id).await?;
        let gate = self.settings_gate(id).await;
        let _guard = gate.lock().await;
        let patch: AgentSettings = serde_json::from_value(input.patch_json())?;
        let control = self.native_control(who, &session, SETTINGS).await?;
        control.call(&session, Some(&patch), true).await?;
        let snapshot = control.call(&session, Some(&patch), false).await?;
        self.store
            .observe_native_settings(&session.id, &session.native_session_id, &snapshot.values)
            .await?;
        self.changed();
        Ok(snapshot)
    }

    /// Observe, never enforce: choosing a model in the native harness is reflected here too.
    pub async fn refresh_settings(&self) -> Result<()> {
        let who = self.store.chat_identity(None).await?;
        for session in self
            .store
            .sessions(&who)
            .await?
            .into_iter()
            .filter(|session| {
                session.stopped_at.is_none()
                    && session.status == "connected"
                    && session.host_id.as_deref() == self.store.host()
            })
        {
            let gate = self.settings_gate(&session.id).await;
            let Ok(_guard) = gate.try_lock() else {
                continue;
            };
            let Ok(control) = self.native_control(&who, &session, SETTINGS).await else {
                continue;
            };
            let result = match &control {
                Control::Codex(control) => Ok(control.values()),
                _ => control
                    .call(&session, None, false)
                    .await
                    .map(|snapshot| snapshot.values),
            };
            if let Ok(values) = result {
                let _ = self
                    .store
                    .observe_native_settings(&session.id, &session.native_session_id, &values)
                    .await;
            }
            if let Err(error) = self.update_integration(&who, &session, &control).await {
                tracing::warn!(session_id = session.id, error = %error, "Integration update deferred");
            }
        }
        Ok(())
    }
}

fn actor_settings(actor: &Actor) -> AgentSettings {
    AgentSettings {
        model: actor.model.clone(),
        effort: actor.effort.clone(),
        permission_mode: actor.permission_mode.clone(),
        approval_policy: actor.approval_policy.clone(),
        sandbox: actor.sandbox.clone(),
    }
}

fn fields(harness: &str) -> Vec<String> {
    let mut fields = vec!["model".into(), "effort".into()];
    match harness {
        "claude-code" => fields.push("permission_mode".into()),
        "codex" => fields.extend(["approval_policy".into(), "sandbox".into()]),
        _ => {}
    }
    fields
}
