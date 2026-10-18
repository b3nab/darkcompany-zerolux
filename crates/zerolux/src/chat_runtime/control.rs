//! Agent Console controls on a running native session, the same for every harness.
use super::settings::Control;
use super::*;
use serde_json::json;

const INTERRUPT: &str = "interrupt-v1";
const INPUT: &str = "input-v1";
const COMPACT: &str = "compact-v1";

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

    /// The owner's own input, typed into the session from ZeroLux: native user input, not a
    /// chat message. It joins a running turn or starts the next one; the native record shows
    /// it. An unconfirmed send is reported, never repeated.
    pub async fn input(&self, who: &ChatIdentity, id: &str, text: &str) -> Result<()> {
        self.input_native(who, id, text)
            .await
            .map_err(|error| match error.downcast::<Error>() {
                Ok(error) => error.into(),
                Err(error) => Error::Invalid(format!("{error:#}")).into(),
            })
    }

    /// Summarizes the session's older history so its context has room again, with the
    /// harness's own compaction, as `/compact [instructions]` does in its terminal. Accepted
    /// means started: the summary, or why it failed, arrives in the session's native record.
    pub async fn compact(
        &self,
        who: &ChatIdentity,
        id: &str,
        instructions: Option<&str>,
    ) -> Result<()> {
        self.compact_native(who, id, instructions)
            .await
            .map_err(|error| match error.downcast::<Error>() {
                Ok(error) => error.into(),
                Err(error) => Error::Invalid(format!("{error:#}")).into(),
            })
    }

    async fn compact_native(
        &self,
        who: &ChatIdentity,
        id: &str,
        instructions: Option<&str>,
    ) -> Result<()> {
        if !who.is_owner() {
            return Err(Error::Forbidden.into());
        }
        let instructions = instructions.map(str::trim).filter(|text| !text.is_empty());
        if instructions.is_some_and(|text| text.len() > 16 * 1024) {
            return Err(Error::Invalid("Instructions up to 16 KiB".into()).into());
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
            bail!("Claude Code in a terminal compacts there, with /compact");
        }
        match self.native_control(who, &session, COMPACT).await? {
            Control::Codex(control) => {
                ensure!(
                    instructions.is_none(),
                    "Codex compacts without instructions"
                );
                control.compact().await
            }
            Control::Pi(record) => {
                sessions::control(
                    &record,
                    json!({"method":"compact","link_id":session.id,"instructions":instructions}),
                )
                .await?;
                Ok(())
            }
            // Claude Code runs its own /compact command when it arrives as user input,
            // after the turn in progress.
            #[cfg(unix)]
            Control::Claude(link) => {
                let actual = link.describe().await?;
                ensure!(
                    actual["capabilities"]
                        .as_array()
                        .is_some_and(|values| values.iter().any(|value| value == INPUT)),
                    "The Claude runner needs an update for this control"
                );
                let text = match instructions {
                    Some(instructions) => format!("/compact {instructions}"),
                    None => "/compact".into(),
                };
                link.request(json!({"method":"input","link_id":session.id,"text":text}))
                    .await?;
                Ok(())
            }
        }
    }

    async fn input_native(&self, who: &ChatIdentity, id: &str, text: &str) -> Result<()> {
        if !who.is_owner() {
            return Err(Error::Forbidden.into());
        }
        if text.trim().is_empty() || text.len() > 64 * 1024 {
            return Err(Error::Invalid("Write from 1 byte to 64 KiB".into()).into());
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
            ensure!(
                session.stopped_at.is_none() && session.status == "connected",
                "The native session is not connected"
            );
            ensure!(
                session.host_id.as_deref() == self.store.host(),
                "The session belongs to another kernel host"
            );
            let locator = self.store.chat_session_locator(who, id).await?;
            let socket = locator["socket"]
                .as_str()
                .context("The Claude Code inbox is unavailable")?;
            return crate::claude::write_inbox(std::path::Path::new(socket), text).await;
        }
        match self.native_control(who, &session, INPUT).await? {
            Control::Codex(control) => control.input(text).await,
            Control::Pi(record) => {
                sessions::control(
                    &record,
                    json!({"method":"input","link_id":session.id,"text":text}),
                )
                .await?;
                Ok(())
            }
            #[cfg(unix)]
            Control::Claude(link) => {
                let actual = link.describe().await?;
                ensure!(
                    actual["capabilities"]
                        .as_array()
                        .is_some_and(|values| values.iter().any(|value| value == INPUT)),
                    "The Claude runner needs an update for this control"
                );
                link.request(json!({"method":"input","link_id":session.id,"text":text}))
                    .await?;
                Ok(())
            }
        }
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
