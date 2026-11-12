use super::*;
use crate::agent_settings::{ModelOption, NativeSettings, SettingsFailure};
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
    Codex(super::remote::CodexControl),
    Pi(super::remote::PiControl),
    Claude(super::remote::ClaudeControl),
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
                let result = control.control(request).await?;
                Ok(serde_json::from_value(result["settings"].clone())?)
            }
            Self::Claude(control) => control.settings(&session.id, patch, check).await,
        }
    }
}

fn integration_needs_update(actual: &Value, revision: &str, native: Option<&str>) -> bool {
    actual["integration_revision"].as_str() != Some(revision)
        || native.is_some_and(|revision| actual["native_revision"].as_str() != Some(revision))
}

fn supports_integration_target(actual: &Value) -> bool {
    actual["capabilities"]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item == "integration-target-v1"))
}

fn resolve_model(patch: &mut AgentSettings, installed: &[ModelOption], running: &[ModelOption]) {
    let Some(value) = &patch.model else { return };
    // These are native reset/hybrid controls, not aliases for one fixed model.
    if matches!(value.as_str(), "default" | "opusplan") {
        return;
    }
    let fresh = installed.iter().find(|option| option.value == *value);
    let previous = running.iter().find(|option| option.value == *value);
    if fresh.and_then(|option| option.resolved_model.as_ref())
        != previous.and_then(|option| option.resolved_model.as_ref())
        && let Some(resolved) = fresh.and_then(|option| option.resolved_model.clone())
    {
        patch.model = Some(resolved);
    }
}

fn update_was_cancelled(actual: &Value, instance: &str) -> bool {
    actual["instance_id"] == instance
        && actual["bound"] == true
        && actual["native_phase"] == "running"
        && actual["native_pid"].as_u64().is_some_and(|pid| pid > 0)
}

impl ChatRuntime {
    /// Update only to the code this kernel activated. Helpers own the idle boundary;
    /// the kernel never guesses it from a cached activity indicator.
    async fn update_integration(
        &self,
        who: &ChatIdentity,
        session: &ChatSession,
        control: &Control,
    ) -> Result<bool> {
        let actual = match control {
            Control::Codex(_) => return Ok(false),
            Control::Pi(record) => {
                let actual = record.control(json!({"method":"describe"})).await?;
                ensure!(
                    record
                        .instance_id()
                        .is_none_or(|instance| actual["instance_id"] == instance)
                        && actual["native_session_id"] == session.native_session_id
                        && actual["workspace"] == session.workspace,
                    "The pi integration changed"
                );
                actual
            }
            Control::Claude(link) => link.describe().await?,
        };
        let target = if session.harness == "claude-code" {
            Some(self.claude_target(session).await?)
        } else {
            None
        };
        let Some(revision) = target
            .as_ref()
            .and_then(|target| target["revision"].as_str())
            .or_else(|| {
                self.integration_revisions
                    .get(session.harness.as_str())
                    .map(String::as_str)
                    .or_else(|| actual["integration_revision"].as_str())
            })
        else {
            return Ok(false);
        };
        let native = if session.harness == "claude-code" {
            self.claude_revision(session).await?
        } else {
            None
        };
        if !integration_needs_update(&actual, revision, native.as_deref()) {
            return Ok(false);
        }
        if matches!(control, Control::Claude(_)) {
            if !supports_integration_target(&actual) {
                return Ok(false);
            }
        } else if !actual["capabilities"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item == "integration-update-v1"))
        {
            return Ok(false);
        }
        ensure!(!*self.stop.borrow(), "The kernel is stopping");
        let mut request = json!({"method":"update","link_id":session.id,"revision":revision});
        if let Some(target) = &target {
            request["entry"] = target["entry"].clone();
        }
        if let Some(native) = &native {
            request["native_revision"] = json!(native);
        }
        match control {
            Control::Codex(_) => {}
            Control::Pi(record) => {
                // Reload is cooperative and idempotently scheduled by the extension.
                record.control(request).await?;
            }
            Control::Claude(link) => {
                let instance = actual["instance_id"]
                    .as_str()
                    .context("Missing helper identity")?;
                let saved = self.store.chat_session_locator(who, &session.id).await?;
                let entry = target.as_ref().and_then(|target| target["entry"].as_str());
                let checkpoint = serde_json::to_string(&(revision, &native, entry))?;
                if saved["integration_update"]
                    == json!({"instance_id":instance,"revision":checkpoint})
                {
                    // After a kernel crash, release admission if commit never arrived.
                    // Cancellation cannot revive a helper whose shutdown already began.
                    let cancelled = link
                        .request(json!({"method":"update_cancel","link_id":session.id}))
                        .await
                        .is_ok();
                    if cancelled
                        && let Ok(current) = link.describe().await
                        && update_was_cancelled(&current, instance)
                        && self
                            .store
                            .clear_integration_update(
                                &session.id,
                                &session.native_session_id,
                                instance,
                                &checkpoint,
                                session.host_id.as_deref(),
                            )
                            .await?
                    {
                        return Ok(false);
                    }
                    return Ok(true); // Never repeat the uncertain shutdown request.
                }
                let ready = link.request(request).await?;
                if ready["ready"] != true {
                    // A background attempt must not leave native settings or new input
                    // blocked while the current turn finishes. Try again on observation.
                    link.request(json!({"method":"update_cancel","link_id":session.id}))
                        .await?;
                    return Ok(false);
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
                                &checkpoint,
                                session.host_id.as_deref(),
                            )
                            .await?,
                        "This helper update was already requested"
                    );
                    let mut commit =
                        json!({"method":"update_commit","link_id":session.id,"revision":revision});
                    if let Some(entry) = entry {
                        commit["entry"] = json!(entry);
                    }
                    if let Some(native) = &native {
                        commit["native_revision"] = json!(native);
                    }
                    link.request(commit).await?;
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
        Ok(true)
    }

    async fn claude_revision(&self, session: &ChatSession) -> Result<Option<String>> {
        match self.remote_host(session) {
            Some(host) => Ok(serde_json::from_value(
                self.hosts.call(&host, "claude.revision", json!({})).await?,
            )?),
            None => self.runners.native_revision(),
        }
    }

    async fn claude_target(&self, session: &ChatSession) -> Result<Value> {
        match self.remote_host(session) {
            Some(host) => self.hosts.call(&host, "claude.target", json!({})).await,
            None => self.runners.target(),
        }
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

    pub(super) async fn settings_gate(&self, id: &str) -> Arc<Mutex<()>> {
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
        // A session on a joined computer is controlled there.
        if let Some(host) = self.remote_host(session) {
            let (hosts, native, workspace) = (
                self.hosts.clone(),
                session.native_session_id.clone(),
                session.workspace.clone(),
            );
            return Ok(match session.harness.as_str() {
                "codex" => Control::Codex(super::remote::CodexControl::There {
                    hosts,
                    host,
                    session: session.id.clone(),
                }),
                "pi" => Control::Pi(super::remote::PiControl::There {
                    hosts,
                    host,
                    session: session.id.clone(),
                    descriptor:
                        self.store.chat_session_locator(who, &session.id).await?["descriptor"]
                            .as_str()
                            .map(str::to_owned),
                }),
                _ => Control::Claude(super::remote::ClaudeControl::There {
                    hosts,
                    host,
                    native,
                    workspace,
                    mode: self
                        .owned_mode(who, &session.id)
                        .await?
                        .context("This native terminal does not expose this control")?,
                }),
            });
        }
        if session.harness == "codex" {
            return self
                .agents
                .lock()
                .await
                .get(&session.id)
                .filter(|agent| !agent.task.is_finished())
                .and_then(|agent| agent.settings.clone())
                .map(|control| Control::Codex(super::remote::CodexControl::Here(control)))
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
            return Ok(Control::Pi(super::remote::PiControl::Here(record)));
        }
        if let Some(mode) = self.owned_mode(who, &session.id).await? {
            let link = self
                .runners
                .find(&session.native_session_id, &session.workspace, mode)
                .await?
                .context("The Claude runner is unavailable")?;
            return Ok(Control::Claude(super::remote::ClaudeControl::Here(link)));
        }
        bail!("This native terminal does not expose this control")
    }

    /// Choices from the harness installed on the chosen computer, with its person's account.
    pub async fn settings_catalog(
        &self,
        who: &ChatIdentity,
        harness: &str,
    ) -> Result<Vec<ModelOption>> {
        self.settings_catalog_at(who, harness, None, None).await
    }

    pub async fn settings_catalog_at(
        &self,
        who: &ChatIdentity,
        harness: &str,
        host: Option<&str>,
        workspace: Option<&str>,
    ) -> Result<Vec<ModelOption>> {
        if !who.is_person() {
            return Err(Error::Forbidden.into());
        }
        let remote = host.filter(|host| !host.is_empty() && Some(*host) != self.store.host());
        if let Some(host) = remote {
            ensure!(
                self.store.host_person(host).await? == who.actor_id,
                Error::Forbidden
            );
            if matches!(harness, "claude-code" | "codex" | "pi") {
                let op = match harness {
                    "claude-code" => "claude.catalog",
                    "pi" => "pi.catalog",
                    _ => "codex.catalog",
                };
                return Ok(serde_json::from_value(
                    self.hosts
                        .call(host, op, json!({"workspace": workspace}))
                        .await?,
                )?);
            }
        } else if matches!(harness, "claude-code" | "codex" | "pi") {
            let homes = self.store.homes(who).await?;
            if harness == "codex" {
                let endpoint = sessions::ensure_codex_daemon_in(&homes).await?;
                let rpc = crate::codex::CodexRpc::connect(&endpoint).await?;
                return crate::codex_settings::models(&rpc).await;
            }
            let folder = match workspace.filter(|folder| !folder.trim().is_empty()) {
                Some(folder) => PathBuf::from(folder),
                None => self
                    .store
                    .project_folder()
                    .await?
                    .unwrap_or(std::env::current_dir()?),
            };
            return if harness == "pi" {
                self.pi_runners
                    .catalog(&folder.to_string_lossy(), &homes)
                    .await
            } else {
                self.runners
                    .catalog(&folder.to_string_lossy(), &homes)
                    .await
            };
        }
        bail!("This harness does not expose a model catalog")
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
        .validate_for(harness, &patch)?;
        let actor = self.store.set_agent_settings(who, id, patch).await?;
        self.changed();
        Ok(actor)
    }

    /// What a running session runs with, as its harness reports it, and what it offers.
    pub async fn session_settings(&self, who: &ChatIdentity, id: &str) -> Result<NativeSettings> {
        let session = self.store.chat_session(who, id).await?;
        let gate = self.settings_gate(id).await;
        let _guard = gate.lock().await;
        let mut snapshot = self.observe_session_settings(who, &session).await?;
        if session.harness == "claude-code" {
            snapshot.models = self.claude_catalog(who, &session).await?;
        }
        Ok(snapshot)
    }

    pub(super) async fn observe_session_settings(
        &self,
        who: &ChatIdentity,
        session: &ChatSession,
    ) -> Result<NativeSettings> {
        let control = self.native_control(who, session, SETTINGS).await?;
        let snapshot = control.call(session, None, false).await?;
        self.store
            .observe_native_settings(&session.id, &session.native_session_id, &snapshot.values)
            .await?;
        Ok(snapshot)
    }

    async fn claude_catalog(
        &self,
        who: &ChatIdentity,
        session: &ChatSession,
    ) -> Result<Vec<ModelOption>> {
        if let Some(host) = self.remote_host(session) {
            return Ok(serde_json::from_value(
                self.hosts
                    .call(
                        &host,
                        "claude.catalog",
                        json!({"workspace": session.workspace}),
                    )
                    .await?,
            )?);
        }
        let homes = crate::homes::Homes::of_locator(
            &self.store.chat_session_locator(who, &session.id).await?,
        );
        self.runners.catalog(&session.workspace, &homes).await
    }

    /// Finish an already committed handoff, never require an upgrade to change settings.
    async fn settings_control(&self, who: &ChatIdentity, session: &ChatSession) -> Result<Control> {
        if session.harness != "claude-code" {
            return self.native_control(who, session, SETTINGS).await;
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(50);
        loop {
            ensure!(!*self.stop.borrow(), "The kernel is stopping");
            let current = self.store.chat_session(who, &session.id).await?;
            ensure!(current.stopped_at.is_none(), Error::StoppedByOwner);
            let locator = self.store.chat_session_locator(who, &current.id).await?;
            let checkpoint = &locator["integration_update"];
            if !checkpoint.is_object() {
                return self.native_control(who, &current, SETTINGS).await;
            }
            let mode = self
                .owned_mode(who, &current.id)
                .await?
                .context("The session is not owned")?;
            let host = self.remote_host(&current);
            let link = if let Some(host) = &host {
                Some(super::remote::ClaudeControl::There {
                    hosts: self.hosts.clone(),
                    host: host.clone(),
                    native: current.native_session_id.clone(),
                    workspace: current.workspace.clone(),
                    mode,
                })
            } else {
                self.runners
                    .find(&current.native_session_id, &current.workspace, mode)
                    .await
                    .ok()
                    .flatten()
                    .map(super::remote::ClaudeControl::Here)
            };
            let actual = match &link {
                Some(link) => link.describe().await.ok(),
                None => None,
            };
            let instance = checkpoint["instance_id"]
                .as_str()
                .context("Missing update identity")?;
            let revision = checkpoint["revision"]
                .as_str()
                .context("Missing update revision")?;
            if actual
                .as_ref()
                .is_some_and(|actual| actual["instance_id"] == instance)
            {
                let link = link.as_ref().expect("described helper");
                // An acknowledged cancellation cannot revive a committed shutdown.
                if link
                    .request(json!({"method":"update_cancel","link_id":current.id}))
                    .await
                    .is_ok()
                    && let Ok(actual) = link.describe().await
                    && update_was_cancelled(&actual, instance)
                {
                    self.store
                        .clear_integration_update(
                            &current.id,
                            &current.native_session_id,
                            instance,
                            revision,
                            current.host_id.as_deref(),
                        )
                        .await?;
                }
            } else if let Some(host) = host {
                let _ = self.restore_claude_on(who, &current, &host).await;
            } else if (actual.is_some() || !self.runners.is_leased(&current.native_session_id)?)
                && self.reconnect_owned(who, &current, mode).await.is_ok()
            {
                self.store
                    .clear_integration_update(
                        &current.id,
                        &current.native_session_id,
                        instance,
                        revision,
                        current.host_id.as_deref(),
                    )
                    .await?;
            }
            ensure!(
                tokio::time::Instant::now() < deadline,
                SettingsFailure::Unconfirmed
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// The command is sent once. An uncertain acknowledgement only permits observation.
    async fn claude_settings_command(
        &self,
        control: &Control,
        session: &ChatSession,
        command: &str,
        value: &str,
        deadline: tokio::time::Instant,
    ) -> Result<NativeSettings> {
        let Control::Claude(link) = control else {
            unreachable!()
        };
        let patch: AgentSettings = serde_json::from_value(json!({(command): value}))?;
        let _ack = link
            .request(json!({"method":"input", "link_id":session.id,
            "text":format!("/{command} {value}"), "mode":"steer"}))
            .await;
        loop {
            ensure!(!*self.stop.borrow(), "The kernel is stopping");
            if let Ok(Ok(snapshot)) =
                tokio::time::timeout_at(deadline, control.call(session, None, false)).await
            {
                self.store
                    .observe_native_settings(
                        &session.id,
                        &session.native_session_id,
                        &snapshot.values,
                    )
                    .await?;
                self.changed();
                // This is the running harness's catalog: a stale alias cannot confirm
                // the concrete ID that the newly installed harness resolved for us.
                if snapshot.confirm(&patch).is_ok() {
                    return Ok(snapshot);
                }
            }
            ensure!(
                tokio::time::Instant::now() < deadline,
                SettingsFailure::Unconfirmed
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
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
        let mut patch: AgentSettings = serde_json::from_value(input.patch_json())?;
        let control = self.settings_control(who, &session).await?;
        let mut commands = Vec::new();
        let mut native_patch = patch.clone();
        let mut checked = false;
        let models = if let Control::Claude(link) = &control {
            let before = control.call(&session, None, false).await?;
            let mut choices = before.clone();
            choices.models = self.claude_catalog(who, &session).await?;
            choices.validate_for(&session.harness, &patch)?;
            resolve_model(&mut patch, &choices.models, &before.models);
            native_patch = patch.clone();
            match control.call(&session, Some(&patch), true).await {
                Ok(_) => checked = true,
                Err(error) if before.validate(&patch).is_ok() => return Err(error),
                Err(_) => {}
            }
            if !checked {
                // Older wrappers reject choices absent from their startup catalog even
                // though Claude itself accepts them through its built-in commands.
                for (command, value) in [("model", &patch.model), ("effort", &patch.effort)] {
                    if let Some(value) = value {
                        ensure!(
                            !value.chars().any(char::is_whitespace) && !value.starts_with('-'),
                            Error::Invalid("Choose a single native setting value".into())
                        );
                        let field: AgentSettings =
                            serde_json::from_value(json!({(command): value}))?;
                        if before.confirm(&field).is_err()
                            || command == "effort" && patch.model.is_some()
                        {
                            commands.push((command, value.clone()));
                        }
                    }
                }
                let listed = link
                    .request(json!({"method":"commands", "link_id":session.id}))
                    .await?;
                for (command, _) in &commands {
                    ensure!(
                        listed["commands"]
                            .as_array()
                            .is_some_and(|items| items.iter().any(|item| item["name"] == *command
                                && item["invoke"] == format!("/{command}"))),
                        Error::Invalid("Claude does not expose this setting command".into())
                    );
                }
                native_patch.model = None;
                native_patch.effort = None;
            }
            Some(choices.models)
        } else {
            None
        };
        // Validate the remaining native fields too, before any command changes a value.
        if !checked {
            control.call(&session, Some(&native_patch), true).await?;
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(50);
        for (command, value) in commands {
            self.claude_settings_command(&control, &session, command, &value, deadline)
                .await?;
        }
        let mut snapshot = if native_patch
            .fields()
            .iter()
            .any(|(_, value)| value.is_some())
        {
            match control.call(&session, Some(&native_patch), false).await {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    // A setter can fail after one field changed. Keep the actual state;
                    // never retry a mutation whose acknowledgement is uncertain.
                    if let Ok(snapshot) = control.call(&session, None, false).await {
                        self.store
                            .observe_native_settings(
                                &session.id,
                                &session.native_session_id,
                                &snapshot.values,
                            )
                            .await?;
                        self.changed();
                        if snapshot.confirm(&patch).is_ok() {
                            return Ok(NativeSettings {
                                models: models.unwrap_or(snapshot.models.clone()),
                                ..snapshot
                            });
                        }
                    }
                    return Err(error);
                }
            }
        } else {
            control.call(&session, None, false).await?
        };
        self.store
            .observe_native_settings(&session.id, &session.native_session_id, &snapshot.values)
            .await?;
        self.changed();
        snapshot
            .confirm(&patch)
            .map_err(|_| SettingsFailure::Unconfirmed)?;
        if let Some(models) = models {
            snapshot.models = models;
        }
        Ok(snapshot)
    }

    /// Observe, never enforce: choosing a model in the native harness is reflected here too.
    pub async fn refresh_settings(&self) -> Result<()> {
        for session in self
            .store
            .all_sessions()
            .await?
            .into_iter()
            .filter(|session| {
                session.stopped_at.is_none()
                    && matches!(session.status.as_str(), "connected" | "attention")
            })
        {
            let who = ChatIdentity::person(&session.owner_id);
            let gate = self.settings_gate(&session.id).await;
            let Ok(_guard) = gate.try_lock() else {
                continue;
            };
            if let Some(host) = self.remote_host(&session) {
                if session.harness != "claude-code" || !self.hosts.online(&host).await {
                    continue;
                }
                // A committed remote update must finish even if the request's client
                // disconnected. Its checkpoint authorizes recovery, never a new input.
                if let Ok(locator) = self.store.chat_session_locator(&who, &session.id).await
                    && locator["integration_update"].is_object()
                {
                    let _ = self.restore_claude_on(&who, &session, &host).await;
                }
            }
            if session.status != "connected" {
                continue;
            }
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
        collaboration_mode: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changed_aliases_use_the_new_id_but_native_controls_keep_their_semantics() {
        let choices = |resolved: &str| -> Vec<ModelOption> {
            ["family", "default", "opusplan"]
                .into_iter()
                .map(|value| ModelOption {
                    value: value.into(),
                    label: String::new(),
                    resolved_model: Some(resolved.into()),
                    efforts: vec![],
                })
                .collect()
        };
        for (value, expected) in [
            ("family", "current-id"),
            ("default", "default"),
            ("opusplan", "opusplan"),
            ("concrete-id", "concrete-id"),
        ] {
            let mut patch = AgentSettings {
                model: Some(value.into()),
                ..Default::default()
            };
            resolve_model(&mut patch, &choices("current-id"), &choices("previous-id"));
            assert_eq!(patch.model.as_deref(), Some(expected));
        }
        let mut unchanged = AgentSettings {
            model: Some("family".into()),
            ..Default::default()
        };
        resolve_model(
            &mut unchanged,
            &choices("current-id"),
            &choices("current-id"),
        );
        assert_eq!(unchanged.model.as_deref(), Some("family"));
    }

    #[test]
    fn only_the_same_running_bound_helper_can_cancel_a_shutdown_checkpoint() {
        let actual = json!({"instance_id":"helper", "bound":true,
            "native_phase":"running", "native_pid":123});
        assert!(update_was_cancelled(&actual, "helper"));
        assert!(!update_was_cancelled(&actual, "another"));
        for patch in [
            json!({"bound":false}),
            json!({"native_phase":"closing"}),
            json!({"native_phase":"exited"}),
            json!({"native_pid":null}),
        ] {
            let mut changed = actual.clone();
            changed
                .as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            assert!(!update_was_cancelled(&changed, "helper"));
        }
    }

    #[test]
    fn installed_native_changes_require_an_update_even_when_helper_code_is_current() {
        let mut actual = json!({"integration_revision":"helper", "native_revision":"old",
            "capabilities":["integration-update-v1"]});
        assert!(integration_needs_update(&actual, "helper", Some("new")));
        assert!(!integration_needs_update(&actual, "helper", Some("old")));
        actual.as_object_mut().unwrap().remove("native_revision");
        assert!(integration_needs_update(&actual, "helper", Some("new")));
        assert!(!integration_needs_update(&actual, "helper", None));
        assert!(integration_needs_update(&actual, "updated-helper", None));
        actual["capabilities"] = json!([]);
        assert!(integration_needs_update(
            &actual,
            "updated-helper",
            Some("new")
        ));
    }
}
