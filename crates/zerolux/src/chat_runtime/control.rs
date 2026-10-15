//! Agent Console controls on a running native session, the same for every harness.
use super::settings::Control;
use super::*;
use serde_json::json;

const INTERRUPT: &str = "interrupt-v1";

impl ChatRuntime {
    /// Stops the native turn in progress, whoever started it. The session stays linked and
    /// its context is kept; an unconfirmed interruption is reported, never retried.
    pub async fn interrupt(&self, who: &ChatIdentity, id: &str) -> Result<bool> {
        // What the harness or its integration cannot do is said as it is.
        self.interrupt_native(who, id)
            .await
            .map_err(|error| match error.downcast::<Error>() {
                Ok(error) => error.into(),
                Err(error) => Error::Invalid(format!("{error:#}")).into(),
            })
    }

    async fn interrupt_native(&self, who: &ChatIdentity, id: &str) -> Result<bool> {
        if !who.is_owner() {
            return Err(Error::Forbidden.into());
        }
        let session = self
            .store
            .chat_sessions(who)
            .await?
            .into_iter()
            .find(|session| session.id == id)
            .ok_or(Error::NotFound)?;
        #[cfg(unix)]
        if session.harness == "claude-code" && self.owned_mode(who, id).await?.is_none() {
            bail!("Claude Code in a terminal cannot be interrupted from ZeroLux");
        }
        let interrupted = match self.native_control(who, &session, INTERRUPT).await? {
            Control::Codex(control) => control.interrupt().await?,
            Control::Pi(record) => {
                let result =
                    sessions::control(&record, json!({"method":"interrupt","link_id":session.id}))
                        .await?;
                result["interrupted"] == true
            }
            #[cfg(unix)]
            Control::Claude(link) => {
                let actual = link.describe().await?;
                ensure!(
                    actual["capabilities"]
                        .as_array()
                        .is_some_and(|values| values.iter().any(|value| value == INTERRUPT)),
                    "The Claude runner needs an update for this control"
                );
                let result = link
                    .request(json!({"method":"interrupt","link_id":session.id}))
                    .await?;
                result["interrupted"] == true
            }
        };
        Ok(interrupted)
    }
}
