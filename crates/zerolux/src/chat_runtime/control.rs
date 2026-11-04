//! Agent Console controls on a running native session, the same for every harness.
use super::settings::Control;
use super::*;
use crate::model::{InputImage, InputMode, SessionCommand};
use serde_json::json;

const INTERRUPT: &str = "interrupt-v1";
const INPUT: &str = "input-v1";
/// Input with a mode (steer, queue, interrupt), and the owner's commands run as typed.
const INPUT_MODES: &str = "input-v2";
const COMMANDS: &str = "commands-v1";
/// Images with the owner's input.
const IMAGES: &str = "images-v1";
const IMAGE_TYPES: [(&str, &str); 4] = [
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
];
const IMAGE_BYTES: usize = 15 * 1024 * 1024;
const COMPACT: &str = "compact-v1";

impl ChatRuntime {
    /// Stops the native turn in progress, whoever started it. The session stays linked and
    /// its context is kept; an unconfirmed interruption is reported, never retried.
    /// With a queue, the whole queue then goes at once, as the next turn.
    pub async fn interrupt(&self, who: &ChatIdentity, id: &str) -> Result<bool> {
        // What the harness or its integration cannot do is said as it is.
        async {
            if !self.store.has_queue(id).await? {
                return self.interrupt_native(who, id).await;
            }
            let queued = self.store.take_queue(id, true).await?;
            let Some(next) = crate::queue::Due::joined(queued.clone()) else {
                return self.interrupt_native(who, id).await;
            };
            self.mark_queue_sent(id);
            match self
                .input_native(
                    &next.author,
                    id,
                    &next.text,
                    InputMode::Interrupt,
                    &next.images,
                )
                .await
            {
                Ok(()) => Ok(true),
                Err(error) => {
                    self.store.put_back(id, &queued).await?;
                    Err(error)
                }
            }
        }
        .await
        .map_err(|error: anyhow::Error| match error.downcast::<Error>() {
            Ok(error) => error.into(),
            Err(error) => Error::Invalid(format!("{error:#}")).into(),
        })
    }

    /// The owner's own input, typed into the session from ZeroLux: native user input, not a
    /// chat message, with the harness's commands run as in its terminal. `mode` says whether
    /// it joins a running turn, waits for its end, or replaces it; an idle session starts a
    /// turn with it. The native record shows it. An unconfirmed send is reported, never
    /// repeated.
    pub async fn input(
        &self,
        who: &ChatIdentity,
        id: &str,
        text: &str,
        mode: InputMode,
        images: &[InputImage],
    ) -> Result<Option<crate::queue::Queued>> {
        async {
            let session = self.store.chat_session(who, id).await?;
            // A session still connecting, as one just started, has no harness to take it yet:
            // whatever the mode, it waits in ZeroLux's queue and goes as soon as it connects.
            let connecting = session.stopped_at.is_none() && session.status == "connecting";
            if mode != InputMode::Queue && !connecting {
                return self
                    .input_native(who, id, text, mode, images)
                    .await
                    .map(|()| None);
            }
            // Queued, it waits in ZeroLux, never in the harness: unless nothing runs and nothing
            // waits, when it starts the next turn at once.
            if (text.trim().is_empty() && images.is_empty()) || text.len() > 64 * 1024 {
                return Err(Error::Invalid("Write up to 64 KiB, or send an image".into()).into());
            }
            decode_images(images)?;
            let busy = connecting
                || session.activity.as_deref() == Some("working")
                || self.queue_awaits(id)
                || self.store.has_queue(id).await?;
            if !busy {
                self.mark_queue_sent(id);
                self.input_native(who, id, text, InputMode::Steer, images)
                    .await?;
                return Ok(None);
            }
            Ok(Some(self.store.enqueue(who, id, text, images).await?))
        }
        .await
        .map_err(|error: anyhow::Error| match error.downcast::<Error>() {
            Ok(error) => error.into(),
            Err(error) => Error::Invalid(format!("{error:#}")).into(),
        })
    }

    /// Sends one waiting input at once: into the running turn, or as a new one.
    pub async fn send_queued(&self, who: &ChatIdentity, id: &str, item: &str) -> Result<()> {
        async {
            let input = self.store.take_queued(who, id, item).await?;
            self.mark_queue_sent(id);
            if let Err(error) = self
                .input_native(
                    &input.author,
                    id,
                    &input.text,
                    InputMode::Steer,
                    &input.images,
                )
                .await
            {
                self.store
                    .put_back(id, std::slice::from_ref(&input))
                    .await?;
                return Err(error);
            }
            Ok(())
        }
        .await
        .map_err(|error: anyhow::Error| match error.downcast::<Error>() {
            Ok(error) => error.into(),
            Err(error) => Error::Invalid(format!("{error:#}")).into(),
        })
    }

    /// Each session whose turn has ended gets the first input of its queue as its next turn,
    /// one at a time: an input is sent only once its session shows it is idle again.
    pub async fn run_queues(&self) -> Result<()> {
        const STARTING: std::time::Duration = std::time::Duration::from_secs(20);
        const RETRY: std::time::Duration = std::time::Duration::from_secs(30);
        for id in self.store.sessions_with_queue().await? {
            let owner = self.store.session_person(&id).await?;
            let Ok(session) = self.store.chat_session(&owner, &id).await else {
                continue;
            };
            if session.stopped_at.is_some() || session.status != "connected" {
                continue;
            }
            if session.activity.as_deref() == Some("working") {
                // Its turn started: the input it was sent is being worked on.
                self.queue_sent.lock().expect("queue").remove(&id);
                continue;
            }
            let waiting = |map: &std::sync::Mutex<HashMap<String, std::time::Instant>>,
                           within: std::time::Duration| {
                map.lock()
                    .expect("queue")
                    .get(&id)
                    .is_some_and(|at| at.elapsed() < within)
            };
            if waiting(&self.queue_sent, STARTING) || waiting(&self.queue_failed, RETRY) {
                continue;
            }
            let Some(next) = self.store.take_queue(&id, false).await?.pop() else {
                continue;
            };
            self.mark_queue_sent(&id);
            if let Err(error) = self
                .input_native(
                    &next.author,
                    &id,
                    &next.text,
                    InputMode::Steer,
                    &next.images,
                )
                .await
            {
                tracing::warn!(
                    session = id,
                    error = format!("{error:#}"),
                    "A queued input was not sent"
                );
                self.store
                    .put_back(&id, std::slice::from_ref(&next))
                    .await?;
                self.queue_failed
                    .lock()
                    .expect("queue")
                    .insert(id.clone(), std::time::Instant::now());
            }
        }
        Ok(())
    }

    fn mark_queue_sent(&self, id: &str) {
        self.queue_sent
            .lock()
            .expect("queue")
            .insert(id.to_owned(), std::time::Instant::now());
        self.queue_failed.lock().expect("queue").remove(id);
    }

    /// An input of its queue was just sent to the session, and its turn has not shown yet.
    fn queue_awaits(&self, id: &str) -> bool {
        self.queue_sent
            .lock()
            .expect("queue")
            .get(id)
            .is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(20))
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
        if !who.is_person() {
            return Err(Error::Forbidden.into());
        }
        let instructions = instructions.map(str::trim).filter(|text| !text.is_empty());
        if instructions.is_some_and(|text| text.len() > 16 * 1024) {
            return Err(Error::Invalid("Instructions up to 16 KiB".into()).into());
        }
        let session = self
            .store
            .sessions(who)
            .await?
            .into_iter()
            .find(|session| session.id == id)
            .ok_or(Error::NotFound)?;
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
                record.control(
                    json!({"method":"compact","link_id":session.id,"instructions":instructions}),
                )
                .await?;
                Ok(())
            }
            // Claude Code runs its own /compact command when it arrives as user input,
            // after the turn in progress.
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

    /// Takes a waiting input out of the queue, or rewrites it with `text`: ZeroLux's queue, or
    /// the harness's own, which Codex keeps open to this.
    pub async fn change_queued(
        &self,
        who: &ChatIdentity,
        id: &str,
        item: &str,
        text: Option<&str>,
    ) -> Result<()> {
        async {
            if !who.is_person() {
                return Err(Error::Forbidden.into());
            }
            if text.is_some_and(|text| text.trim().is_empty() || text.len() > 64 * 1024) {
                return Err(Error::Invalid("Write from 1 byte to 64 KiB".into()).into());
            }
            if self.store.is_queued(id, item).await? {
                match text {
                    Some(text) => self.store.edit_queued(who, id, item, text).await?,
                    None => drop(self.store.take_queued(who, id, item).await?),
                }
                return Ok(());
            }
            let session = self.store.chat_session(who, id).await?;
            match self.native_control(who, &session, INPUT).await? {
                Control::Codex(control) => match text {
                    Some(text) => control.requeue(item, text).await,
                    None => control.unqueue(item).await,
                },
                // Not in any queue: it was sent already.
                _ => Err(Error::NotFound.into()),
            }
        }
        .await
        .map_err(|error: anyhow::Error| match error.downcast::<Error>() {
            Ok(error) => error.into(),
            Err(error) => Error::Invalid(format!("{error:#}")).into(),
        })
    }

    /// The goal a session works toward on its own across turns: Codex's. With a change, it is
    /// set; with `clear`, the session no longer has one.
    pub async fn goal(
        &self,
        who: &ChatIdentity,
        id: &str,
        change: Option<crate::model::GoalChange>,
        clear: bool,
    ) -> Result<Option<crate::live::Goal>> {
        async {
            if !who.is_person() {
                return Err(Error::Forbidden.into());
            }
            if let Some(change) = &change {
                if change.objective.is_none()
                    && change.status.is_none()
                    && change.token_budget.is_none()
                {
                    return Err(Error::Invalid("Nothing to change".into()).into());
                }
                if change
                    .objective
                    .as_ref()
                    .is_some_and(|text| text.trim().is_empty() || text.len() > 64 * 1024)
                {
                    return Err(Error::Invalid("Write the goal in 1 byte to 64 KiB".into()).into());
                }
                if change
                    .status
                    .as_deref()
                    .is_some_and(|status| !matches!(status, "active" | "paused" | "complete"))
                {
                    return Err(
                        Error::Invalid("A goal is made active, paused or complete".into()).into(),
                    );
                }
                if change.token_budget.is_some_and(|budget| budget <= 0) {
                    return Err(Error::Invalid("A token budget is above 0".into()).into());
                }
            }
            let session = self.store.chat_session(who, id).await?;
            match self.native_control(who, &session, INPUT).await? {
                Control::Codex(control) => match (change, clear) {
                    (_, true) => control.clear_goal().await.map(|()| None),
                    (Some(change), _) => control
                        .set_goal(
                            change.objective.as_deref().map(str::trim),
                            change.status.as_deref(),
                            change.token_budget,
                        )
                        .await
                        .map(Some),
                    (None, _) => control.goal().await,
                },
                _ => bail!("Goals belong to Codex sessions"),
            }
        }
        .await
        .map_err(|error: anyhow::Error| match error.downcast::<Error>() {
            Ok(error) => error.into(),
            Err(error) => Error::Invalid(format!("{error:#}")).into(),
        })
    }

    /// The commands and skills the session's harness offers, as they are typed.
    pub async fn commands(&self, who: &ChatIdentity, id: &str) -> Result<Vec<SessionCommand>> {
        self.commands_native(who, id)
            .await
            .map_err(|error| match error.downcast::<Error>() {
                Ok(error) => error.into(),
                Err(error) => Error::Invalid(format!("{error:#}")).into(),
            })
    }

    async fn commands_native(&self, who: &ChatIdentity, id: &str) -> Result<Vec<SessionCommand>> {
        if !who.is_person() {
            return Err(Error::Forbidden.into());
        }
        let session = self.store.chat_session(who, id).await?;
        let listed = match self.native_control(who, &session, COMMANDS).await? {
            Control::Codex(control) => return control.commands().await,
            Control::Pi(record) => {
                record
                    .control(json!({"method":"commands","link_id":session.id}))
                    .await?
            }
            Control::Claude(link) => {
                runner_offers(&link, COMMANDS).await?;
                link.request(json!({"method":"commands","link_id":session.id}))
                    .await?
            }
        };
        Ok(serde_json::from_value(listed["commands"].clone())?)
    }

    /// The owner's images, saved for the session's harness to read: each one's file and type.
    fn save_images(
        &self,
        id: &str,
        images: &[InputImage],
        decoded: Vec<(&'static str, Vec<u8>)>,
    ) -> Result<Vec<(String, String)>> {
        save_images_in(&self.attachments, id, images, decoded)
    }

    async fn input_elsewhere(
        &self,
        session: &ChatSession,
        control: Control,
        text: &str,
        mode: InputMode,
        images: &[InputImage],
    ) -> Result<()> {
        // The images go with the input; the computer keeps them where its harness reads them.
        let request = json!({"method":"input","link_id":session.id,"text":text,"mode":mode,
            "images": images.iter().map(|image| json!({"media_type": image.media_type,
                "data": image.data})).collect::<Vec<_>>()});
        match control {
            Control::Codex(control) => control.request(request).await.map(drop),
            Control::Pi(record) => record.control(request).await.map(drop),
            Control::Claude(link) => link.request(request).await.map(drop),
        }
    }

    async fn input_native(
        &self,
        who: &ChatIdentity,
        id: &str,
        text: &str,
        mode: InputMode,
        images: &[InputImage],
    ) -> Result<()> {
        if !who.is_person() {
            return Err(Error::Forbidden.into());
        }
        if (text.trim().is_empty() && images.is_empty()) || text.len() > 64 * 1024 {
            return Err(Error::Invalid("Write up to 64 KiB, or send an image".into()).into());
        }
        let session = self
            .store
            .sessions(who)
            .await?
            .into_iter()
            .find(|session| session.id == id)
            .ok_or(Error::NotFound)?;
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
            ensure!(
                mode == InputMode::Steer && images.is_empty(),
                "Claude Code in a terminal takes text only"
            );
            return crate::claude::write_inbox(std::path::Path::new(socket), text).await;
        }
        // The first integrations take input only as it comes, without a mode or images.
        let capability = if !images.is_empty() {
            IMAGES
        } else if mode == InputMode::Steer {
            INPUT
        } else {
            INPUT_MODES
        };
        let decoded = decode_images(images)?;
        let control = self.native_control(who, &session, capability).await?;
        if self.remote_host(&session).is_some() {
            return self
                .input_elsewhere(&session, control, text, mode, images)
                .await;
        }
        if let Control::Claude(link) = &control {
            runner_offers(link, capability).await?;
        }
        let saved = self.save_images(id, images, decoded)?;
        let request = json!({"method":"input","link_id":session.id,"text":text,"mode":mode,
            "images": saved.iter().map(|(path, media_type)| json!({"path":path,"media_type":media_type})).collect::<Vec<_>>()});
        // How long the harness takes to take an input: what the Console waits for.
        let started = std::time::Instant::now();
        let _took = scopeguard_log(id, &session.harness, started);
        match control {
            Control::Codex(control) => {
                let paths: Vec<String> = saved.into_iter().map(|(path, _)| path).collect();
                control.input(text, mode, &paths).await
            }
            Control::Pi(record) => {
                record.control(request).await?;
                Ok(())
            }
            Control::Claude(link) => {
                link.request(request).await?;
                Ok(())
            }
        }
    }

    async fn interrupt_native(&self, who: &ChatIdentity, id: &str) -> Result<bool> {
        if !who.is_person() {
            return Err(Error::Forbidden.into());
        }
        let session = self
            .store
            .sessions(who)
            .await?
            .into_iter()
            .find(|session| session.id == id)
            .ok_or(Error::NotFound)?;
        if session.harness == "claude-code" && self.owned_mode(who, id).await?.is_none() {
            bail!("Claude Code in a terminal cannot be interrupted from ZeroLux");
        }
        let interrupted = match self.native_control(who, &session, INTERRUPT).await? {
            Control::Codex(control) => control.interrupt().await?,
            Control::Pi(record) => {
                let result = record
                    .control(json!({"method":"interrupt","link_id":session.id}))
                    .await?;
                result["interrupted"] == true
            }
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

/// Logs, when dropped, how long an input took to reach the harness.
fn scopeguard_log<'a>(
    session: &'a str,
    harness: &'a str,
    started: std::time::Instant,
) -> impl Drop + 'a {
    struct Took<'a>(&'a str, &'a str, std::time::Instant);
    impl Drop for Took<'_> {
        fn drop(&mut self) {
            tracing::info!(
                session = self.0,
                harness = self.1,
                elapsed_ms = self.2.elapsed().as_millis() as u64,
                "Input handed to the harness"
            );
        }
    }
    Took(session, harness, started)
}

/// A Claude runner started before a control existed says it needs an update.
async fn runner_offers(link: &super::remote::ClaudeControl, capability: &str) -> Result<()> {
    let actual = link.describe().await?;
    ensure!(
        actual["capabilities"]
            .as_array()
            .is_some_and(|values| values.iter().any(|value| value == capability)),
        "The Claude runner needs an update for this control"
    );
    Ok(())
}

/// The owner's images, checked and decoded: each one's file extension and bytes.
/// Keeps a session's images in `root`, readable by the kernel's user only: their paths and
/// media types.
pub(crate) fn save_images_in(
    root: &std::path::Path,
    id: &str,
    images: &[InputImage],
    decoded: Vec<(&'static str, Vec<u8>)>,
) -> Result<Vec<(String, String)>> {
    let folder = root.join(id);
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(&folder)?;
    decoded
        .into_iter()
        .zip(images)
        .map(|((extension, bytes), image)| {
            use std::io::Write;
            let path = folder.join(format!("{}.{extension}", uuid::Uuid::new_v4()));
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            options.open(&path)?.write_all(&bytes)?;
            Ok((
                path.to_string_lossy().into_owned(),
                image.media_type.clone(),
            ))
        })
        .collect()
}

/// A joined computer's images, sent with input: kept on it, and named by path in the request.
pub(crate) fn localize_images(
    root: &std::path::Path,
    session: &str,
    request: &mut Value,
) -> Result<()> {
    let images: Vec<InputImage> = request["images"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|image| image["data"].is_string())
        .map(|image| {
            Ok(InputImage {
                media_type: image["media_type"].as_str().unwrap_or_default().to_owned(),
                data: image["data"].as_str().unwrap_or_default().to_owned(),
            })
        })
        .collect::<Result<_>>()?;
    if images.is_empty() {
        return Ok(());
    }
    let decoded = decode_images(&images)?;
    let saved = save_images_in(root, session, &images, decoded)?;
    request["images"] = json!(
        saved
            .iter()
            .map(|(path, media_type)| json!({"path": path, "media_type": media_type}))
            .collect::<Vec<_>>()
    );
    Ok(())
}

fn decode_images(images: &[InputImage]) -> Result<Vec<(&'static str, Vec<u8>)>, Error> {
    use base64::Engine;
    if images.len() > 10 {
        return Err(Error::Invalid("Send up to 10 images at a time".into()));
    }
    let mut decoded = Vec::with_capacity(images.len());
    for image in images {
        let extension = IMAGE_TYPES
            .iter()
            .find(|(media, _)| *media == image.media_type)
            .map(|(_, extension)| *extension)
            .ok_or_else(|| Error::Invalid("Send PNG, JPEG, GIF or WebP images".into()))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(image.data.trim())
            .map_err(|_| Error::Invalid("An image is not valid base64".into()))?;
        decoded.push((extension, bytes));
    }
    if decoded.iter().map(|(_, bytes)| bytes.len()).sum::<usize>() > IMAGE_BYTES {
        return Err(Error::Invalid("Images up to 15 MiB in all".into()));
    }
    Ok(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(media_type: &str, data: &str) -> InputImage {
        InputImage {
            media_type: media_type.into(),
            data: data.into(),
        }
    }

    #[test]
    fn images_are_checked_before_anything_is_sent() {
        assert_eq!(
            decode_images(&[image("image/png", "AQID"), image("image/jpeg", "BAU=")]).unwrap(),
            vec![("png", vec![1, 2, 3]), ("jpg", vec![4, 5])]
        );
        assert!(decode_images(&[image("image/svg+xml", "AQID")]).is_err());
        assert!(decode_images(&[image("image/png", "not base64!")]).is_err());
        assert!(decode_images(&vec![image("image/png", "AQID"); 11]).is_err());
        let big = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            vec![0u8; IMAGE_BYTES + 1],
        );
        assert!(decode_images(&[image("image/png", &big)]).is_err());
    }
}
