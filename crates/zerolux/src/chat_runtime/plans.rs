//! A person's harness subscriptions, read and kept up to date: from Codex's app-server for a
//! ChatGPT plan, and from a running Claude Code session for a Claude plan. Read again every
//! two minutes for whoever asked in the last day, and soon after a session's turn; who asked
//! hears `subscriptions.changed` when what they show changed.

use super::*;
use crate::subscriptions::{self, Subscription};
use serde_json::json;

const USAGE: &str = "usage-v1";
/// How old a reading may be before asking for it reads it again.
const FRESH_MS: i64 = 60_000;
/// How often the plans of whoever asked are read again.
const EVERY_MS: i64 = 120_000;
/// After a session's turn, how soon its person's plans are read again.
const AFTER_TURN_MS: i64 = 20_000;
/// How long after asking a person's plans are kept up to date.
const WATCH_MS: i64 = 24 * 3600 * 1000;

struct Kept {
    who: ChatIdentity,
    plans: Vec<Subscription>,
    read_at: i64,
    asked_at: i64,
    /// A turn ended since the last reading.
    due: bool,
}

#[derive(Default)]
pub struct Plans {
    people: std::sync::Mutex<HashMap<String, Kept>>,
}

/// The same plans, whenever read: what a person sees did not change.
fn same(a: &[Subscription], b: &[Subscription]) -> bool {
    let strip = |plans: &[Subscription]| {
        plans
            .iter()
            .map(|plan| Subscription {
                updated_at: 0,
                ..plan.clone()
            })
            .collect::<Vec<_>>()
    };
    strip(a) == strip(b)
}

impl ChatRuntime {
    /// `who`'s subscriptions, read now when asked to or when the last reading is old.
    pub async fn subscriptions(
        &self,
        who: &ChatIdentity,
        refresh: bool,
    ) -> Result<Vec<Subscription>> {
        if !who.is_person() {
            return Err(Error::Forbidden.into());
        }
        let actor = who.actor()?.to_owned();
        let now = crate::store::now_ms();
        {
            let mut people = self.plans.people.lock().unwrap();
            if let Some(kept) = people.get_mut(&actor) {
                kept.asked_at = now;
                if !refresh && now - kept.read_at < FRESH_MS {
                    return Ok(kept.plans.clone());
                }
            }
        }
        Ok(self.read_plans(who).await)
    }

    /// Uses one of the ChatGPT plan's earned resets: what Codex says it did.
    pub async fn reset_subscription(
        &self,
        who: &ChatIdentity,
        id: &str,
        credit: Option<&str>,
    ) -> Result<String> {
        if !who.is_person() {
            return Err(Error::Forbidden.into());
        }
        if !id.starts_with("chatgpt:") {
            return Err(Error::Invalid("Only a ChatGPT plan has resets to use here".into()).into());
        }
        let homes = self.store.homes(who).await?;
        let rpc = crate::codex::CodexRpc::connect(&sessions::codex_endpoint_in(&homes)?)
            .await
            .context("Codex is not running on this computer")?;
        let mut params = json!({"idempotencyKey": uuid::Uuid::new_v4().to_string()});
        if let Some(credit) = credit {
            params["creditId"] = json!(credit);
        }
        let done = rpc
            .request("account/rateLimitResetCredit/consume", params)
            .await?;
        self.read_plans(who).await;
        Ok(subscriptions::outcome(&done))
    }

    /// Reads `who`'s plans from their harnesses, keeps them, and tells them when they changed.
    /// A harness that cannot be read keeps what it showed, with why.
    async fn read_plans(&self, who: &ChatIdentity) -> Vec<Subscription> {
        let Ok(actor) = who.actor().map(str::to_owned) else {
            return vec![];
        };
        let now = crate::store::now_ms();
        let before = self
            .plans
            .people
            .lock()
            .unwrap()
            .get(&actor)
            .map(|kept| kept.plans.clone())
            .unwrap_or_default();
        let kept = |provider: &str, error: Option<String>| -> Vec<Subscription> {
            before
                .iter()
                .filter(|plan| plan.provider == provider)
                .map(|plan| Subscription {
                    error: error.clone().or(plan.error.clone()),
                    ..plan.clone()
                })
                .collect()
        };
        let mut plans = vec![];
        match self.chatgpt_plan(who, now).await {
            Ok(Some(plan)) => plans.push(plan),
            Ok(None) => {}
            Err(error) => plans.extend(kept("chatgpt", Some(format!("{error:#}")))),
        }
        match self.claude_plan(who, now).await {
            Ok(Some(Some(plan))) => plans.push(plan),
            Ok(Some(None)) => {}
            // No Claude session runs: what was read last stays.
            Ok(None) => plans.extend(kept("claude", None)),
            Err(error) => plans.extend(kept("claude", Some(format!("{error:#}")))),
        }
        let changed = !same(&before, &plans);
        {
            let mut people = self.plans.people.lock().unwrap();
            let entry = people.entry(actor.clone()).or_insert_with(|| Kept {
                who: who.clone(),
                plans: vec![],
                read_at: 0,
                asked_at: now,
                due: false,
            });
            entry.plans = plans.clone();
            entry.read_at = now;
            entry.due = false;
        }
        if changed {
            let _ = self
                .livekit
                .notify(
                    &json!({"type": "subscriptions.changed", "subscriptions": plans}),
                    &[actor],
                )
                .await;
        }
        plans
    }

    /// The ChatGPT plan of `who`'s Codex, if its app-server runs and is signed in with ChatGPT.
    async fn chatgpt_plan(&self, who: &ChatIdentity, now: i64) -> Result<Option<Subscription>> {
        let homes = self.store.homes(who).await?;
        let Ok(rpc) = crate::codex::CodexRpc::connect(&sessions::codex_endpoint_in(&homes)?).await
        else {
            return Ok(None);
        };
        let account = rpc.request("account/read", json!({})).await?;
        if account["account"]["type"] != "chatgpt" {
            return Ok(None);
        }
        let usage = rpc.request("account/rateLimits/read", json!({})).await?;
        Ok(subscriptions::from_codex(&account, &usage, now))
    }

    /// The Claude plan, from the first of `who`'s Claude sessions on this computer that can
    /// tell it: none when no session runs, `Some(None)` when its account has no plan.
    async fn claude_plan(
        &self,
        who: &ChatIdentity,
        now: i64,
    ) -> Result<Option<Option<Subscription>>> {
        let mut failed = None;
        for session in self.store.sessions(who).await? {
            if session.harness != "claude"
                || session.stopped_at.is_some()
                || session.status != "connected"
                || session.host_id.as_deref() != self.store.host()
            {
                continue;
            }
            let read = async {
                let super::settings::Control::Claude(link) =
                    self.native_control(who, &session, USAGE).await?
                else {
                    bail!("Not a Claude session");
                };
                let described = link.describe().await?;
                ensure!(
                    described["capabilities"]
                        .as_array()
                        .is_some_and(|values| values.iter().any(|value| value == USAGE)),
                    "The Claude runner needs an update to read the plan"
                );
                link.request(json!({"method": "usage", "link_id": session.id}))
                    .await
            };
            match read.await {
                Ok(read) => {
                    return Ok(Some(subscriptions::from_claude(
                        &read["account"],
                        &read["usage"],
                        &read["rate_limit"],
                        now,
                    )));
                }
                Err(error) => failed = Some(error),
            }
        }
        match failed {
            Some(error) => Err(error),
            None => Ok(None),
        }
    }

    /// After a session's turn, its person's plans are read again soon.
    pub(super) async fn plans_after_turn(&self, session: &str) {
        let Ok(owner) = self.store.session_person(session).await else {
            return;
        };
        let Ok(actor) = owner.actor() else {
            return;
        };
        if let Some(kept) = self.plans.people.lock().unwrap().get_mut(actor) {
            kept.due = true;
        }
    }

    /// Keeps the plans of whoever asked in the last day up to date.
    pub(super) fn watch_plans(runtime: std::sync::Weak<Self>) {
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                let Some(runtime) = runtime.upgrade() else {
                    return;
                };
                if *runtime.stop.borrow() {
                    return;
                }
                let now = crate::store::now_ms();
                let due: Vec<ChatIdentity> = runtime
                    .plans
                    .people
                    .lock()
                    .unwrap()
                    .values()
                    .filter(|kept| {
                        now - kept.asked_at < WATCH_MS
                            && (now - kept.read_at >= EVERY_MS
                                || (kept.due && now - kept.read_at >= AFTER_TURN_MS))
                    })
                    .map(|kept| kept.who.clone())
                    .collect();
                for who in due {
                    runtime.read_plans(&who).await;
                }
            }
        });
    }
}
