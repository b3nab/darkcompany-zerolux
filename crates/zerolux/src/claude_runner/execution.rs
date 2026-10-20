//! Native-child evidence, read while holding the SAME lease the Bun host writes.
use std::{io::Read, path::Path};

use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use serde::Deserialize;
use uuid::Uuid;

use super::private_file;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyOwner {
    pid: i32,
    instance_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Owner {
    version: u32,
    kind: String,
    native_session_id: String,
    workspace: String,
    instance_id: String,
    holder_pid: i32,
    #[serde(deserialize_with = "nullable_pid")]
    native_pid: Option<i32>,
    phase: String,
    started: bool,
    released: bool,
}

// Explicit null is evidence of no assigned child; a missing field is not.
fn nullable_pid<'de, D: serde::Deserializer<'de>>(
    value: D,
) -> std::result::Result<Option<i32>, D::Error> {
    Option::deserialize(value)
}

fn alive(pid: i32) -> bool {
    pid > 0 && crate::platform::alive(pid as u32)
}

pub(super) enum Purpose<'a> {
    Restore,
    Stop(Option<&'a str>),
}

/// A catalogue is additional exclusion evidence, never a replacement for this proof.
pub(super) fn verify_exit(
    registry: &Path,
    native_id: &str,
    workspace: &str,
    purpose: Purpose<'_>,
) -> Result<()> {
    let file = private_file(&registry.join(format!("{native_id}.lock")), false)
        .context("The native Claude execution has no readable process evidence")?;
    file.try_lock_exclusive()
        .context("Claude is still running this session")?;
    let metadata = file.metadata()?;
    ensure!(
        !crate::platform::linked_elsewhere(&metadata) && metadata.len() <= 64 * 1024,
        "Invalid Claude execution evidence"
    );
    let mut bytes = Vec::new();
    (&file).take(64 * 1024 + 1).read_to_end(&mut bytes)?;
    // Existing bootstrap hosts predate native-child metadata. Restore additionally
    // checks Claude's native catalogue, and the SDK must find this exact saved session.
    if let Ok(legacy) = serde_json::from_slice::<LegacyOwner>(&bytes) {
        ensure!(
            legacy.pid > 0 && Uuid::parse_str(&legacy.instance_id).is_ok(),
            "Invalid legacy Claude execution"
        );
        ensure!(
            !alive(legacy.pid),
            "The previous Claude execution host is still alive"
        );
        match purpose {
            Purpose::Restore => {}
            Purpose::Stop(Some(instance)) => ensure!(
                legacy.instance_id == instance,
                "The stopped Claude execution host changed"
            ),
            Purpose::Stop(None) => {
                anyhow::bail!("This Claude runner cannot confirm it stopped")
            }
        }
        return Ok(());
    }
    let owner: Owner = serde_json::from_slice(&bytes)
        .context("The native Claude execution has no verified process identity")?;
    ensure!(
        owner.version == 1
            && owner.kind == "claude-execution"
            && owner.native_session_id == native_id
            && owner.workspace == workspace
            && Uuid::parse_str(&owner.instance_id).is_ok()
            && owner.holder_pid > 0
            && owner.native_pid.is_none_or(|pid| pid > 0)
            && matches!(
                owner.phase.as_str(),
                "waiting" | "starting" | "running" | "exited"
            )
            && (owner.phase != "waiting" || owner.native_pid.is_none())
            && (owner.phase != "exited" || owner.started)
            && (owner.phase != "starting" || (owner.started && owner.native_pid.is_none()))
            && (owner.phase != "running" || (owner.started && owner.native_pid.is_some()))
            && (!owner.released || matches!(owner.phase.as_str(), "waiting" | "exited")),
        "Claude's process record does not match this session"
    );
    match purpose {
        Purpose::Stop(Some(instance)) => ensure!(
            owner.instance_id == instance,
            "The stopped Claude execution host changed"
        ),
        // A terminal conversation can predate its first managed child. The SDK checks
        // for that saved conversation before resume, including after a waiting host exits.
        Purpose::Restore | Purpose::Stop(None) => {}
    }
    ensure!(
        owner.phase != "starting",
        "Claude's start was not confirmed"
    );
    if !owner.released {
        if let Some(pid) = owner.native_pid {
            ensure!(
                owner.phase == "exited" || !alive(pid),
                "Claude is still running this session"
            );
        }
        ensure!(
            !alive(owner.holder_pid),
            "The previous Claude execution host is still alive"
        );
    }
    Ok(())
}
