//! What a person's harness subscriptions have left: one entry per account, the plan's usage
//! rows as its provider gives them, extra usage, credit and earned resets. Read from the
//! harnesses ZeroLux already runs: Codex's app-server for a ChatGPT plan, a running Claude Code
//! session for a Claude plan. Kept in memory only: what the providers say now is the truth.

use serde::Serialize;
use serde_json::Value;

/// A plan's usage row.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Limit {
    /// `session`, `weekly_all` or `weekly_scoped` (a model's or a bucket's own week).
    pub kind: String,
    /// `session` or `weekly`: rows show grouped under it, in order.
    pub group: String,
    /// The model or bucket a scoped row is for.
    pub label: Option<String>,
    /// Share of the window used, 0-100.
    pub percent: f64,
    /// When the window starts again, in milliseconds.
    pub resets_at: Option<i64>,
    /// The provider's reading of the row (`normal`, `warning`, `critical`), when it gives one.
    pub severity: Option<String>,
    /// The provider's headline row, when it picks one.
    pub active: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExtraUsage {
    pub enabled: bool,
    /// Spent this month, in minor units of `currency`.
    pub used: Option<f64>,
    pub limit: Option<f64>,
    pub currency: Option<String>,
    pub percent: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Credits {
    pub balance: Option<String>,
    pub unlimited: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ResetCredit {
    pub id: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Resets {
    pub available: i64,
    pub credits: Vec<ResetCredit>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Subscription {
    /// `<provider>:<account>`.
    pub id: String,
    /// `claude` or `chatgpt`.
    pub provider: String,
    /// The provider's plan: `max`, `pro`, `plus`…
    pub plan: Option<String>,
    pub account: Option<String>,
    /// Whether the plan can be used now; unknown when the provider does not say.
    pub allowed: Option<bool>,
    pub limits: Vec<Limit>,
    pub extra_usage: Option<ExtraUsage>,
    pub credits: Option<Credits>,
    pub resets: Option<Resets>,
    pub updated_at: i64,
    /// Why it could not be read this time; what was read before stays.
    pub error: Option<String>,
}

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// Seconds since the epoch, as milliseconds.
fn seconds(value: &Value) -> Option<i64> {
    value.as_i64().map(|seconds| seconds * 1000)
}

fn iso(value: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()
        .map(|at| at.timestamp_millis())
}

/// A ChatGPT plan from Codex's `account/read` and `account/rateLimits/read`; none for an API
/// key or no account.
pub fn from_codex(account: &Value, usage: &Value, now: i64) -> Option<Subscription> {
    let account = &account["account"];
    if account["type"] != "chatgpt" {
        return None;
    }
    let main = &usage["rateLimits"];
    let mut buckets: Vec<&Value> = vec![];
    if let Some(by_id) = usage["rateLimitsByLimitId"].as_object() {
        // The main bucket first, then the others in the order they came.
        let mut others: Vec<(&String, &Value)> = by_id.iter().collect();
        others.sort_by_key(|(id, _)| *id != "codex");
        buckets.extend(others.into_iter().map(|(_, bucket)| bucket));
    }
    if buckets.is_empty() && main.is_object() {
        buckets.push(main);
    }
    let mut limits = vec![];
    for bucket in &buckets {
        let scoped = bucket["limitId"].as_str().is_some_and(|id| id != "codex");
        let label = scoped
            .then(|| text(&bucket["limitName"]).or_else(|| text(&bucket["limitId"])))
            .flatten();
        for window in [&bucket["primary"], &bucket["secondary"]] {
            let Some(percent) = window["usedPercent"].as_f64() else {
                continue;
            };
            let weekly = window["windowDurationMins"]
                .as_i64()
                .is_some_and(|minutes| minutes > 24 * 60);
            limits.push(Limit {
                kind: match (weekly, scoped) {
                    (false, _) => "session",
                    (true, false) => "weekly_all",
                    (true, true) => "weekly_scoped",
                }
                .into(),
                group: if weekly { "weekly" } else { "session" }.into(),
                label: label.clone(),
                percent,
                resets_at: seconds(&window["resetsAt"]),
                severity: None,
                active: None,
            });
        }
    }
    let credits = &main["credits"];
    let resets = &usage["rateLimitResetCredits"];
    let email = text(&account["email"]);
    Some(Subscription {
        id: format!(
            "chatgpt:{}",
            text(&usage["accountId"])
                .or_else(|| email.clone())
                .unwrap_or_else(|| "account".into())
        ),
        provider: "chatgpt".into(),
        plan: text(&main["planType"]).or_else(|| text(&account["planType"])),
        account: email,
        allowed: usage["ordinaryUsageAllowed"].as_bool(),
        limits,
        extra_usage: None,
        credits: credits.is_object().then(|| Credits {
            balance: text(&credits["balance"]),
            unlimited: credits["unlimited"].as_bool().unwrap_or(false),
        }),
        resets: resets.is_object().then(|| Resets {
            available: resets["availableCount"].as_i64().unwrap_or(0),
            credits: resets["credits"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|credit| credit["status"] == "available")
                .filter_map(|credit| {
                    Some(ResetCredit {
                        id: text(&credit["id"])?,
                        title: text(&credit["title"]),
                        description: text(&credit["description"]),
                        expires_at: seconds(&credit["expiresAt"]),
                    })
                })
                .collect(),
        }),
        updated_at: now,
        error: None,
    })
}

/// A Claude plan from a Claude Code session: its `accountInfo()`, its plan usage
/// (`get_usage`), and the last rate-limit event it heard. None for an API key or a cloud
/// provider, where plan limits do not apply.
pub fn from_claude(
    account: &Value,
    usage: &Value,
    event: &Value,
    now: i64,
) -> Option<Subscription> {
    let first_party = account["apiProvider"]
        .as_str()
        .is_none_or(|provider| provider == "firstParty");
    if !first_party || usage["rate_limits_available"] == false {
        return None;
    }
    let windows = &usage["rate_limits"];
    let mut limits = vec![];
    let mut row = |kind: &str, group: &str, label: Option<String>, window: &Value| {
        if let Some(percent) = window["utilization"].as_f64() {
            limits.push(Limit {
                kind: kind.into(),
                group: group.into(),
                label,
                percent,
                resets_at: iso(&window["resets_at"]),
                severity: None,
                active: None,
            });
        }
    };
    row("session", "session", None, &windows["five_hour"]);
    row("weekly_all", "weekly", None, &windows["seven_day"]);
    match windows["model_scoped"].as_array() {
        Some(models) => {
            for model in models {
                row(
                    "weekly_scoped",
                    "weekly",
                    text(&model["display_name"]),
                    model,
                );
            }
        }
        None => {
            row(
                "weekly_scoped",
                "weekly",
                Some("Opus".into()),
                &windows["seven_day_opus"],
            );
            row(
                "weekly_scoped",
                "weekly",
                Some("Sonnet".into()),
                &windows["seven_day_sonnet"],
            );
        }
    }
    let extra = &windows["extra_usage"];
    let info = &event["rate_limit_info"];
    let email = text(&account["email"]);
    Some(Subscription {
        id: format!(
            "claude:{}",
            email
                .clone()
                .or_else(|| text(&account["organization"]))
                .unwrap_or_else(|| "account".into())
        ),
        provider: "claude".into(),
        plan: text(&usage["subscription_type"]).or_else(|| text(&account["subscriptionType"])),
        account: email,
        allowed: info["status"].as_str().map(|status| status != "rejected"),
        limits,
        extra_usage: extra.is_object().then(|| ExtraUsage {
            enabled: extra["is_enabled"].as_bool().unwrap_or(false),
            used: extra["used_credits"].as_f64(),
            limit: extra["monthly_limit"].as_f64(),
            currency: text(&extra["currency"]),
            percent: extra["utilization"].as_f64(),
        }),
        credits: None,
        resets: None,
        updated_at: now,
        error: None,
    })
}

/// What redeeming an earned reset did, as Codex says it.
pub fn outcome(codex: &Value) -> String {
    match codex["outcome"].as_str().unwrap_or("unknown") {
        "nothingToReset" => "nothing_to_reset".into(),
        "noCredit" => "no_credit".into(),
        "alreadyRedeemed" => "already_redeemed".into(),
        other => other.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_chatgpt_plan_shows_each_window_of_each_bucket_its_credit_and_earned_resets() {
        let account =
            json!({"account": {"type": "chatgpt", "email": "ines@example.com", "planType": "pro"}});
        let usage = json!({
            "accountId": "acct-1",
            "ordinaryUsageAllowed": true,
            "rateLimits": {"limitId": "codex", "planType": "pro",
                "primary": {"usedPercent": 42, "windowDurationMins": 300, "resetsAt": 1_800_000_000},
                "secondary": {"usedPercent": 7, "windowDurationMins": 10080, "resetsAt": 1_800_500_000},
                "credits": {"hasCredits": true, "unlimited": false, "balance": "12.50"}},
            "rateLimitsByLimitId": {
                "gpt-5.5-max": {"limitId": "gpt-5.5-max", "limitName": "GPT-5.5 Max",
                    "secondary": {"usedPercent": 90, "windowDurationMins": 10080}},
                "codex": {"limitId": "codex",
                    "primary": {"usedPercent": 42, "windowDurationMins": 300, "resetsAt": 1_800_000_000},
                    "secondary": {"usedPercent": 7, "windowDurationMins": 10080, "resetsAt": 1_800_500_000}}},
            "rateLimitResetCredits": {"availableCount": 2, "credits": [
                {"id": "r1", "status": "available", "grantedAt": 1, "resetType": "codexRateLimits",
                    "title": "Thanks", "expiresAt": 1_900_000_000},
                {"id": "r0", "status": "redeemed", "grantedAt": 1, "resetType": "codexRateLimits"}]}
        });
        let plan = from_codex(&account, &usage, 5).unwrap();
        assert_eq!(plan.id, "chatgpt:acct-1");
        assert_eq!(plan.plan.as_deref(), Some("pro"));
        assert_eq!(plan.allowed, Some(true));
        let rows: Vec<(&str, &str, Option<&str>, f64)> = plan
            .limits
            .iter()
            .map(|row| {
                (
                    row.kind.as_str(),
                    row.group.as_str(),
                    row.label.as_deref(),
                    row.percent,
                )
            })
            .collect();
        assert_eq!(
            rows,
            [
                ("session", "session", None, 42.0),
                ("weekly_all", "weekly", None, 7.0),
                ("weekly_scoped", "weekly", Some("GPT-5.5 Max"), 90.0)
            ]
        );
        assert_eq!(plan.limits[0].resets_at, Some(1_800_000_000_000));
        assert_eq!(
            plan.credits.as_ref().unwrap().balance.as_deref(),
            Some("12.50")
        );
        let resets = plan.resets.unwrap();
        assert_eq!(resets.available, 2);
        assert_eq!(resets.credits.len(), 1);
        assert_eq!(resets.credits[0].expires_at, Some(1_900_000_000_000));
    }

    #[test]
    fn no_plan_shows_for_an_api_key_or_no_account() {
        let usage = json!({"rateLimits": {}});
        assert!(from_codex(&json!({"account": {"type": "apiKey"}}), &usage, 0).is_none());
        assert!(from_codex(&json!({"account": null}), &usage, 0).is_none());
        let account = json!({"apiProvider": "bedrock"});
        assert!(from_claude(&account, &json!({}), &json!({}), 0).is_none());
        let account = json!({"email": "ines@example.com", "apiProvider": "firstParty"});
        assert!(
            from_claude(
                &account,
                &json!({"rate_limits_available": false}),
                &json!({}),
                0
            )
            .is_none()
        );
    }

    #[test]
    fn a_claude_plan_shows_its_windows_its_models_and_its_extra_usage() {
        let account = json!({"email": "ines@example.com", "subscriptionType": "max", "apiProvider": "firstParty"});
        let usage = json!({
            "subscription_type": "max",
            "rate_limits_available": true,
            "rate_limits": {
                "five_hour": {"utilization": 31.5, "resets_at": "2026-10-23T14:00:00Z"},
                "seven_day": {"utilization": 12, "resets_at": "2026-10-28T09:00:00+00:00"},
                "seven_day_opus": {"utilization": 99, "resets_at": null},
                "model_scoped": [{"display_name": "Fable", "utilization": 40, "resets_at": null}],
                "extra_usage": {"is_enabled": true, "monthly_limit": 5000, "used_credits": 1200,
                    "utilization": 24, "currency": "USD"}
            }
        });
        let event =
            json!({"rate_limit_info": {"status": "rejected", "rateLimitType": "five_hour"}});
        let plan = from_claude(&account, &usage, &event, 9).unwrap();
        assert_eq!(plan.id, "claude:ines@example.com");
        assert_eq!(plan.plan.as_deref(), Some("max"));
        assert_eq!(plan.allowed, Some(false));
        let rows: Vec<(&str, Option<&str>)> = plan
            .limits
            .iter()
            .map(|row| (row.kind.as_str(), row.label.as_deref()))
            .collect();
        // The server's per-model rows stand for its older Opus and Sonnet fields.
        assert_eq!(
            rows,
            [
                ("session", None),
                ("weekly_all", None),
                ("weekly_scoped", Some("Fable"))
            ]
        );
        assert_eq!(
            plan.limits[0].resets_at,
            Some(
                chrono::DateTime::parse_from_rfc3339("2026-10-23T14:00:00Z")
                    .unwrap()
                    .timestamp_millis()
            )
        );
        let extra = plan.extra_usage.unwrap();
        assert_eq!((extra.used, extra.limit), (Some(1200.0), Some(5000.0)));
        assert_eq!(
            from_claude(&account, &usage, &json!({}), 9)
                .unwrap()
                .allowed,
            None
        );
    }

    #[test]
    fn an_earned_reset_says_what_it_did() {
        assert_eq!(outcome(&json!({"outcome": "reset"})), "reset");
        assert_eq!(outcome(&json!({"outcome": "noCredit"})), "no_credit");
        assert_eq!(
            outcome(&json!({"outcome": "nothingToReset"})),
            "nothing_to_reset"
        );
    }
}
