//! Public projection of native configuration. Catalogs and confirmations belong to the harness.
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{model::AgentSettings, store::Error};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ModelOption {
    pub value: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_model: Option<String>,
    pub efforts: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NativeSettings {
    pub values: AgentSettings,
    pub models: Vec<ModelOption>,
    pub editable: Vec<String>,
}

impl NativeSettings {
    pub(crate) fn confirm(&self, patch: &AgentSettings) -> Result<(), Error> {
        for (field, value) in patch.fields() {
            let Some(value) = value else { continue };
            let actual = self
                .values
                .fields()
                .into_iter()
                .find(|(name, _)| *name == field)
                .and_then(|(_, value)| value);
            if actual == Some(value) {
                continue;
            }
            if field == "model"
                && self.models.iter().any(|model| {
                    (model.value == value || model.resolved_model.as_deref() == Some(value))
                        && (actual == Some(model.value.as_str())
                            || actual.is_some() && actual == model.resolved_model.as_deref())
                })
            {
                continue;
            }
            return Err(Error::Invalid(format!(
                "The harness did not confirm the requested {field}; refresh before making another change"
            )));
        }
        Ok(())
    }

    /// Check every field before any native mutation. Efforts are model-specific, never guessed.
    pub fn validate(&self, patch: &AgentSettings) -> Result<(), Error> {
        for (field, value) in patch.fields() {
            let Some(value) = value else { continue };
            if !self.editable.iter().any(|name| name == field) {
                return Err(Error::Invalid(format!(
                    "The native session cannot change {field} right now"
                )));
            }
            validate_choice(value, field)?;
        }
        if patch.model.is_some() || patch.effort.is_some() {
            let value = patch.model.as_ref().or(self.values.model.as_ref());
            let model = self
                .models
                .iter()
                .find(|model| {
                    value.is_some_and(|value| {
                        model.value == *value || model.resolved_model.as_ref() == Some(value)
                    })
                })
                .ok_or_else(|| Error::Invalid("The harness does not offer this model".into()))?;
            if let Some(effort) = &patch.effort
                && !model.efforts.contains(effort)
            {
                return Err(Error::Invalid(
                    "The harness does not offer this effort for this model".into(),
                ));
            }
        }
        Ok(())
    }
}

pub(crate) fn patch(value: Value) -> Result<AgentSettings, Error> {
    if !value
        .as_object()
        .is_some_and(|fields| fields.values().all(Value::is_string))
    {
        return Err(Error::Invalid(
            "Agent settings must be concrete native choices".into(),
        ));
    }
    let patch: AgentSettings = serde_json::from_value(value)
        .map_err(|_| Error::Invalid("Invalid agent settings".into()))?;
    for (field, value) in patch.fields() {
        if let Some(value) = value {
            validate_choice(value, field)?;
        }
    }
    Ok(patch)
}

fn validate_choice(value: &str, field: &str) -> Result<(), Error> {
    let value = crate::store::text(value, field, 200, true)?;
    if value.chars().any(char::is_control) {
        return Err(Error::Invalid(
            "Native settings cannot contain control characters".into(),
        ));
    }
    Ok(())
}

impl AgentSettings {
    pub(crate) fn fields(&self) -> [(&'static str, Option<&str>); 5] {
        [
            ("model", self.model.as_deref()),
            ("effort", self.effort.as_deref()),
            ("permission_mode", self.permission_mode.as_deref()),
            ("approval_policy", self.approval_policy.as_deref()),
            ("sandbox", self.sandbox.as_deref()),
        ]
    }

    pub(crate) fn patch_json(&self) -> Value {
        Value::Object(
            self.fields()
                .into_iter()
                .filter_map(|(field, value)| {
                    value.map(|value| (field.to_owned(), Value::String(value.trim().to_owned())))
                })
                .collect(),
        )
    }
}

/// Keep unfamiliar native policies visible rather than mislabelling them as a supported preset.
pub(crate) fn native_policy(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        Value::Object(_) => Some(value.to_string()),
        _ => None,
    }
}

pub(crate) fn codex_values(settings: &Value) -> AgentSettings {
    let sandbox = &settings["sandbox"];
    AgentSettings {
        model: settings["model"].as_str().map(str::to_owned),
        effort: settings["reasoningEffort"].as_str().map(str::to_owned),
        permission_mode: None,
        approval_policy: native_policy(&settings["approvalPolicy"]),
        sandbox: match sandbox["type"].as_str() {
            Some("readOnly") => Some("read-only".into()),
            Some("workspaceWrite") => Some("workspace-write".into()),
            Some("dangerFullAccess") => Some("danger-full-access".into()),
            _ => native_policy(sandbox),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn patches_do_not_accept_resets_unknown_fields_or_non_string_values() {
        for value in [
            json!(null),
            json!([]),
            json!({"model":null}),
            json!({"effort":42}),
            json!({"model":" "}),
            json!({"token":"private"}),
            json!({"model":"bad\nvalue"}),
            json!({"model":"x".repeat(201)}),
        ] {
            assert!(patch(value).is_err());
        }
        assert_eq!(
            patch(json!({"effort":"native-effort"}))
                .unwrap()
                .effort
                .as_deref(),
            Some("native-effort")
        );
    }

    #[test]
    fn validation_and_confirmation_use_native_aliases_and_model_specific_efforts() {
        let snapshot = NativeSettings {
            values: AgentSettings {
                model: Some("native-version".into()),
                effort: Some("native-effort".into()),
                ..AgentSettings::default()
            },
            models: vec![ModelOption {
                value: "native-alias".into(),
                resolved_model: Some("native-version".into()),
                label: "Native choice".into(),
                efforts: vec!["native-effort".into()],
            }],
            editable: vec!["model".into(), "effort".into()],
        };
        let choice = patch(json!({"model":"native-alias","effort":"native-effort"})).unwrap();
        snapshot.validate(&choice).unwrap();
        snapshot.confirm(&choice).unwrap();
        assert!(
            snapshot
                .validate(&patch(json!({"effort":"invented"})).unwrap())
                .is_err()
        );
        assert!(
            snapshot
                .validate(&patch(json!({"permission_mode":"auto"})).unwrap())
                .is_err()
        );
        assert!(
            snapshot
                .confirm(&patch(json!({"model":"different-native-model"})).unwrap())
                .is_err()
        );
    }
}
