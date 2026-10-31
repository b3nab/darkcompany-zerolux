//! Agent Console events: the native record of pi, Claude Code and Codex in one model.
//!
//! A projection of the native record, never a copy: every event names the byte offset of
//! the record it comes from, and `/output` still serves the records themselves. Records
//! that say nothing about the agent's work (bookkeeping, settings, token counts) project
//! to no event.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::native_output::Record;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    /// Input the agent received: a person's, another agent's, or a ZeroLux envelope. An
    /// envelope names its chat and delivery: the turn it opens belongs to that chat.
    Input {
        text: String,
        chat: Option<String>,
        delivery: Option<String>,
    },
    /// What the agent writes.
    Text {
        text: String,
    },
    /// Reasoning the harness records in readable form.
    Thinking {
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        id: String,
        output: Value,
        error: bool,
    },
    TurnStarted,
    /// `completed`, `interrupted` or `error`.
    TurnEnded {
        status: String,
    },
    Error {
        message: String,
    },
    /// The harness compacted its context.
    Compacted {
        summary: Option<String>,
    },
    /// A command the owner gave the harness itself rather than the agent, as typed:
    /// `/compact keep the plan`. It opens no turn.
    Command {
        text: String,
    },
    /// What the harness told the agent by itself, as a background task that ended: its
    /// summary, not anyone's input.
    Notice {
        text: String,
    },
}

/// How a session's record ends, for the Console's inbox.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Tail {
    /// When the native record last grew, in ms.
    pub output_at: Option<i64>,
    /// `completed`, `interrupted` or `error`; none while a turn runs, or before the first.
    pub last_turn: Option<String>,
    /// The agent's latest text on one line, or else its latest step, up to 200 characters.
    pub summary: Option<String>,
}

const SUMMARY_CHARS: usize = 200;

/// The end of a session's events: how its last turn ended and its latest line.
pub fn tail(items: &[Item], output_at: Option<i64>) -> Tail {
    // Compaction and commands happen between turns; anything else after the last end is a
    // turn running.
    let last_turn = items
        .iter()
        .rev()
        .find(|item| !matches!(item.event, Event::Compacted { .. } | Event::Command { .. }))
        .and_then(|item| match &item.event {
            Event::TurnEnded { status } => Some(status.clone()),
            Event::Error { .. } => Some("error".into()),
            _ => None,
        });
    let latest =
        |pick: fn(&Event) -> Option<String>| items.iter().rev().find_map(|i| pick(&i.event));
    let summary = latest(|event| match event {
        Event::Text { text } => Some(text.clone()),
        _ => None,
    })
    .or_else(|| {
        latest(|event| match event {
            Event::ToolCall { name, input, .. } => Some(step(name, input)),
            _ => None,
        })
    })
    .map(|text| one_line(&text))
    .filter(|line| !line.is_empty());
    Tail {
        output_at,
        last_turn,
        summary,
    }
}

/// A tool call in a few words: its name and what it works on.
fn step(name: &str, input: &Value) -> String {
    let detail = [
        "command",
        "cmd",
        "file_path",
        "path",
        "pattern",
        "query",
        "url",
        "description",
    ]
    .iter()
    .find_map(|key| input[*key].as_str())
    .or_else(|| input.as_str());
    match detail {
        Some(detail) => format!("{name}: {detail}"),
        None => name.to_owned(),
    }
}

fn one_line(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= SUMMARY_CHARS {
        return line;
    }
    let cut: String = line.chars().take(SUMMARY_CHARS - 1).collect();
    format!("{}…", cut.trim_end())
}

#[derive(Debug, Clone, Serialize)]
pub struct Item {
    /// Byte offset of the native record this event comes from.
    pub at: u64,
    /// The record's own timestamp, as the harness wrote it.
    pub time: Option<String>,
    #[serde(flatten)]
    pub event: Event,
}

/// The chat and delivery an envelope names, in the current format or an earlier one.
fn envelope(text: &str) -> (Option<String>, Option<String>) {
    for line in text.lines() {
        // The retired reply helper: `… chat-send … --to <chat> --reply <delivery>`.
        if let Some(start) = line.find(" --to ") {
            let mut words = line[start + 6..].split_whitespace();
            if let (Some(chat), Some("--reply"), Some(delivery)) =
                (words.next(), words.next(), words.next())
            {
                return (Some(chat.to_owned()), Some(delivery.to_owned()));
            }
        }
        if let Some(rest) = line.strip_prefix("Chat: ")
            && let Some((chat, delivery)) = rest.split_once("; delivery: ")
        {
            return (Some(chat.to_owned()), Some(delivery.trim().to_owned()));
        }
        if let Some(start) = line.find(" with chat \"") {
            let rest = &line[start + 12..];
            if let Some((chat, rest)) = rest.split_once("\" and reply_to \"")
                && let Some((delivery, _)) = rest.split_once('"')
            {
                return (Some(chat.to_owned()), Some(delivery.to_owned()));
            }
        }
    }
    (None, None)
}

fn input(text: String) -> Event {
    let (chat, delivery) = envelope(&text);
    Event::Input {
        text,
        chat,
        delivery,
    }
}

/// The text of a content value: a string, or the text blocks of an array.
fn text_of(content: &Value, kinds: &[&str]) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| {
                block["type"]
                    .as_str()
                    .is_some_and(|kind| kinds.contains(&kind))
            })
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn some_text(text: &str, make: impl FnOnce(String) -> Event) -> Option<Event> {
    (!text.trim().is_empty()).then(|| make(text.to_owned()))
}

fn pi(record: &Value) -> Vec<Event> {
    match record["type"].as_str() {
        Some("message") => {
            let message = &record["message"];
            let content = &message["content"];
            match message["role"].as_str() {
                Some("user") => vec![input(text_of(content, &["text"]))],
                Some("assistant") => {
                    let mut events: Vec<Event> = content
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|block| match block["type"].as_str() {
                            Some("text") => {
                                some_text(block["text"].as_str()?, |text| Event::Text { text })
                            }
                            Some("thinking") => some_text(block["thinking"].as_str()?, |text| {
                                Event::Thinking { text }
                            }),
                            Some("toolCall") => Some(Event::ToolCall {
                                id: block["id"].as_str()?.to_owned(),
                                name: block["name"].as_str()?.to_owned(),
                                input: block["arguments"].clone(),
                            }),
                            _ => None,
                        })
                        .collect();
                    match message["stopReason"].as_str() {
                        Some("error") => {
                            events.push(Event::Error {
                                message: message["errorMessage"]
                                    .as_str()
                                    .unwrap_or("The model returned an error")
                                    .to_owned(),
                            });
                            events.push(Event::TurnEnded {
                                status: "error".into(),
                            });
                        }
                        Some("aborted") => events.push(Event::TurnEnded {
                            status: "interrupted".into(),
                        }),
                        Some("stop") => events.push(Event::TurnEnded {
                            status: "completed".into(),
                        }),
                        _ => {}
                    }
                    events
                }
                Some("toolResult") => vec![Event::ToolResult {
                    id: message["toolCallId"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    output: content.clone(),
                    error: message["isError"] == true,
                }],
                _ => Vec::new(),
            }
        }
        Some("custom_message") => vec![input(text_of(&record["content"], &["text"]))],
        Some("compaction") => vec![Event::Compacted {
            summary: record["summary"].as_str().map(str::to_owned),
        }],
        // ZeroLux's extension keeps the compaction asked of pi, which pi does not record.
        Some("custom") if record["customType"] == "zerolux-compaction-requested" => {
            vec![compact_command(
                record["data"]["instructions"].as_str().unwrap_or_default(),
            )]
        }
        // pi reports a failed compaction only to its extensions; ZeroLux's keeps it here.
        Some("custom") if record["customType"] == "zerolux-compaction-failed" => {
            vec![Event::Error {
                message: record["data"]["error"]
                    .as_str()
                    .unwrap_or("Compaction failed")
                    .to_owned(),
            }]
        }
        _ => Vec::new(),
    }
}

/// `/compact`, with the instructions given to it.
fn compact_command(instructions: &str) -> Event {
    let instructions = instructions.trim();
    Event::Command {
        text: if instructions.is_empty() {
            "/compact".into()
        } else {
            format!("/compact {instructions}")
        },
    }
}

/// A background task's notice, as Claude Code gives it to the model:
/// `<task-notification>…<summary>Background command "…" completed</summary>…`. Its summary,
/// or its text without tags.
fn task_notice(text: &str) -> Option<Event> {
    let text = text.trim_start();
    if !text.starts_with("<task-notification>") {
        return None;
    }
    let summary = text
        .find("<summary>")
        .map(|start| &text[start + "<summary>".len()..])
        .and_then(|rest| {
            rest.find("</summary>")
                .map(|end| rest[..end].trim().to_owned())
        })
        .filter(|summary| !summary.is_empty());
    let text = summary.unwrap_or_else(|| {
        let mut plain = String::new();
        let mut inside = false;
        for c in text.chars() {
            match c {
                '<' => inside = true,
                '>' => inside = false,
                c if !inside => plain.push(c),
                _ => {}
            }
        }
        plain.split_whitespace().collect::<Vec<_>>().join(" ")
    });
    Some(Event::Notice { text })
}

/// A command typed in Claude Code, as it records it:
/// `<command-name>/compact</command-name> … <command-args>keep the plan</command-args>`.
fn claude_command(text: &str) -> Option<Event> {
    let between = |open: &str, close: &str| {
        let start = text.find(open)? + open.len();
        let end = start + text[start..].find(close)?;
        Some(text[start..end].trim().to_owned())
    };
    if !text.trim_start().starts_with("<command-name>") {
        return None;
    }
    let name = between("<command-name>", "</command-name>")?;
    let args = between("<command-args>", "</command-args>").unwrap_or_default();
    Some(Event::Command {
        text: if args.is_empty() {
            name
        } else {
            format!("{name} {args}")
        },
    })
}

fn claude(record: &Value) -> Vec<Event> {
    match record["type"].as_str() {
        Some("user") if record["isCompactSummary"] == true => vec![Event::Compacted {
            summary: Some(text_of(&record["message"]["content"], &["text"])),
        }],
        // What Claude Code writes for itself around a command: a caveat for the model, and
        // the command's own output.
        Some("user") if record["isMeta"] == true => Vec::new(),
        Some("user") => {
            let content = &record["message"]["content"];
            let mut events = Vec::new();
            let text = text_of(content, &["text"]);
            if let Some(command) = claude_command(&text) {
                events.push(command);
            } else if let Some(notice) = task_notice(&text) {
                events.push(notice);
            // Claude Code writes an interruption as the user's line.
            } else if text.starts_with("[Request interrupted by user") {
                events.push(Event::TurnEnded {
                    status: "interrupted".into(),
                });
            // A command's output is Claude Code's own, for its terminal.
            } else if !text.trim().is_empty() && !text.starts_with("<local-command-stdout>") {
                events.push(input(text));
            }
            for block in content.as_array().into_iter().flatten() {
                if block["type"] == "tool_result" {
                    events.push(Event::ToolResult {
                        id: block["tool_use_id"].as_str().unwrap_or_default().to_owned(),
                        output: block["content"].clone(),
                        error: block["is_error"] == true,
                    });
                    // Other agents' messages reach a managed session through its inbox
                    // tool: each envelope it returns is input of its chat.
                    let text = text_of(&block["content"], &["text"]);
                    for envelope in text
                        .split("\n\n")
                        .filter(|part| part.starts_with("[ZeroLux]"))
                    {
                        let input = input(envelope.to_owned());
                        if matches!(&input, Event::Input { chat: Some(_), .. }) {
                            events.push(input);
                        }
                    }
                }
            }
            events
        }
        Some("assistant") => {
            let message = &record["message"];
            if record["isApiErrorMessage"] == true {
                return vec![Event::Error {
                    message: text_of(&message["content"], &["text"]),
                }];
            }
            message["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|block| match block["type"].as_str() {
                    Some("text") => some_text(block["text"].as_str()?, |text| Event::Text { text }),
                    Some("thinking") => {
                        some_text(block["thinking"].as_str()?, |text| Event::Thinking { text })
                    }
                    Some("tool_use") => Some(Event::ToolCall {
                        id: block["id"].as_str()?.to_owned(),
                        name: block["name"].as_str()?.to_owned(),
                        input: block["input"].clone(),
                    }),
                    _ => None,
                })
                .collect()
        }
        Some("attachment") if record["attachment"]["type"] == "queued_command" => {
            let attachment = &record["attachment"];
            match attachment["prompt"].as_str() {
                Some(prompt) => vec![task_notice(prompt).unwrap_or_else(|| {
                    if attachment["commandMode"] == "task-notification" {
                        Event::Notice {
                            text: prompt.trim().to_owned(),
                        }
                    } else {
                        input(prompt.to_owned())
                    }
                })],
                None => Vec::new(),
            }
        }
        Some("system") => match record["subtype"].as_str() {
            Some("turn_duration") => vec![Event::TurnEnded {
                status: "completed".into(),
            }],
            Some("compact_boundary") => vec![Event::Compacted { summary: None }],
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// What Codex writes as user input for the model and never shows as anyone's: its
/// environment, instructions, skills, shell commands, aborted turns and subagents' notices,
/// each a whole fragment between its markers, as Codex itself recognizes them.
const CODEX_CONTEXT: &[(&str, &str)] = &[
    ("<environment_context>", "</environment_context>"),
    ("<user_instructions>", "</user_instructions>"),
    ("# agents.md instructions for ", "</instructions>"),
    ("<skill>", "</skill>"),
    ("<user_shell_command>", "</user_shell_command>"),
    ("<turn_aborted>", "</turn_aborted>"),
    ("<subagent_notification>", "</subagent_notification>"),
];

/// A Codex user message: the person's or another agent's input, or Codex's own context.
/// A message holding any context fragment is Codex's; a subagent's notice is told as such.
fn codex_user(content: &Value) -> Vec<Event> {
    let fragments: Vec<&str> = match content {
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block["type"] == "input_text")
            .filter_map(|block| block["text"].as_str())
            .collect(),
        Value::String(text) => vec![text.as_str()],
        _ => Vec::new(),
    };
    let context = |text: &str| {
        let text = text.trim().to_ascii_lowercase();
        CODEX_CONTEXT
            .iter()
            .find(|(open, close)| text.starts_with(open) && text.ends_with(close))
            .map(|(open, _)| *open)
    };
    if fragments.iter().any(|text| context(text).is_some()) {
        return fragments
            .iter()
            .filter(|text| context(text) == Some("<subagent_notification>"))
            .filter_map(|text| subagent_notice(text))
            .collect();
    }
    vec![input(text_of(content, &["input_text"]))]
}

/// `<subagent_notification>{"agent_path":"/root/a","status":{"completed":"…"}}</…>`: how a
/// subagent ended, in one line. Statuses that end nothing tell nothing.
fn subagent_notice(text: &str) -> Option<Event> {
    let body = text
        .trim()
        .strip_prefix("<subagent_notification>")?
        .strip_suffix("</subagent_notification>")?;
    let notice: Value = serde_json::from_str(body.trim()).ok()?;
    let agent = notice["agent_path"].as_str()?;
    let status = &notice["status"];
    let ended = if status.get("completed").is_some() {
        "completed".to_owned()
    } else if let Some(error) = status["errored"].as_str() {
        format!("failed: {}", error.lines().next().unwrap_or_default())
    } else {
        match status.as_str()? {
            "shutdown" => "shut down".to_owned(),
            "not_found" => "was not found".to_owned(),
            _ => return None,
        }
    };
    Some(Event::Notice {
        text: format!("Agent {agent} {ended}"),
    })
}

fn codex(record: &Value) -> Vec<Event> {
    let payload = &record["payload"];
    match (record["type"].as_str(), payload["type"].as_str()) {
        (Some("response_item"), Some("message")) => match payload["role"].as_str() {
            Some("user") => codex_user(&payload["content"]),
            Some("assistant") => {
                some_text(&text_of(&payload["content"], &["output_text"]), |text| {
                    Event::Text { text }
                })
                .into_iter()
                .collect()
            }
            _ => Vec::new(),
        },
        (Some("response_item"), Some("reasoning")) => {
            let summary = text_of(&payload["summary"], &["summary_text"]);
            some_text(&summary, |text| Event::Thinking { text })
                .into_iter()
                .collect()
        }
        (Some("response_item"), Some("function_call" | "custom_tool_call")) => {
            let raw = payload
                .get("arguments")
                .or_else(|| payload.get("input"))
                .cloned()
                .unwrap_or(Value::Null);
            // Arguments are a JSON string; a custom tool's input is plain text.
            let input = raw
                .as_str()
                .and_then(|text| serde_json::from_str(text).ok())
                .unwrap_or(raw);
            vec![Event::ToolCall {
                id: payload["call_id"].as_str().unwrap_or_default().to_owned(),
                name: payload["name"].as_str().unwrap_or_default().to_owned(),
                input,
            }]
        }
        (Some("response_item"), Some("function_call_output" | "custom_tool_call_output")) => {
            vec![Event::ToolResult {
                id: payload["call_id"].as_str().unwrap_or_default().to_owned(),
                output: payload["output"].clone(),
                error: false,
            }]
        }
        (Some("response_item"), Some("web_search_call")) => vec![Event::ToolCall {
            id: payload["id"].as_str().unwrap_or_default().to_owned(),
            name: "web_search".into(),
            input: payload["action"].clone(),
        }],
        (Some("event_msg"), Some("task_started")) => vec![Event::TurnStarted],
        (Some("event_msg"), Some("task_complete")) => vec![Event::TurnEnded {
            status: "completed".into(),
        }],
        (Some("event_msg"), Some("turn_aborted")) => vec![Event::TurnEnded {
            status: "interrupted".into(),
        }],
        (Some("event_msg"), Some("error")) => vec![Event::Error {
            message: payload["message"].as_str().unwrap_or_default().to_owned(),
        }],
        (Some("compacted"), _) => vec![Event::Compacted {
            summary: payload["message"]
                .as_str()
                .filter(|text| !text.is_empty())
                .map(str::to_owned),
        }],
        _ => Vec::new(),
    }
}

/// Only the turns a message of `chat` opened. `opened` is the chat of the turn already in
/// progress before the first event, when known.
pub fn of_chat(items: Vec<Item>, chat: &str, mut opened: Option<String>) -> Vec<Item> {
    items
        .into_iter()
        .filter(|item| {
            if let Event::Input { chat, .. } = &item.event {
                opened = chat.clone();
            }
            opened.as_deref() == Some(chat)
        })
        .collect()
}

/// The events of native records, in order.
pub fn project(harness: &str, records: &[Record]) -> Vec<Item> {
    let project = match harness {
        "pi" => pi,
        "claude-code" => claude,
        "codex" => codex,
        _ => return Vec::new(),
    };
    records
        .iter()
        .flat_map(|record| {
            let time = record.record["timestamp"].as_str().map(str::to_owned);
            project(&record.record).into_iter().map(move |event| Item {
                at: record.at,
                time: time.clone(),
                event,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn events(harness: &str, records: Vec<Value>) -> Vec<Event> {
        let records: Vec<Record> = records
            .into_iter()
            .enumerate()
            .map(|(at, record)| Record {
                at: at as u64,
                record,
            })
            .collect();
        project(harness, &records)
            .into_iter()
            .map(|item| item.event)
            .collect()
    }

    const ENVELOPE: &str =
        "[ZeroLux] \"Kernel\"\nChat: chat-1; delivery: d-1\n\"Owner\" [message m]:\n> go";

    #[test]
    fn every_envelope_format_names_its_chat_and_delivery() {
        for text in [
            ENVELOPE,
            "call send with chat \"chat-1\" and reply_to \"d-1\"; otherwise",
            "Reply, text on stdin: zerolux chat-send --link x.json --to chat-1 --reply d-1",
        ] {
            assert_eq!(
                envelope(text),
                (Some("chat-1".into()), Some("d-1".into())),
                "{text}"
            );
        }
        assert_eq!(envelope("typed in the terminal"), (None, None));
    }

    #[test]
    fn pi_records_project_to_the_common_model() {
        assert_eq!(
            events(
                "pi",
                vec![
                    json!({"type":"message","timestamp":"t","message":{"role":"user","content":[{"type":"text","text":ENVELOPE}]}}),
                    json!({"type":"message","message":{"role":"assistant","content":[
                    {"type":"thinking","thinking":"plan"},{"type":"text","text":"Reading"},
                    {"type":"toolCall","id":"c1","name":"read","arguments":{"path":"a"}}],"stopReason":"toolUse"}}),
                    json!({"type":"message","message":{"role":"toolResult","toolCallId":"c1","toolName":"read","content":[{"type":"text","text":"x"}],"isError":false}}),
                    json!({"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Done"}],"stopReason":"stop"}}),
                    json!({"type":"model_change","modelId":"m"}),
                    json!({"type":"custom","customType":"zerolux-compaction-requested","data":{"instructions":" keep the plan "}}),
                    json!({"type":"custom","customType":"zerolux-compaction-failed","data":{"error":"Compaction failed: 429"}}),
                    json!({"type":"custom","customType":"zerolux-compaction-requested","data":{}}),
                    json!({"type":"custom","customType":"other-extension","data":{"error":"not ours"}}),
                ]
            ),
            vec![
                Event::Input {
                    text: ENVELOPE.into(),
                    chat: Some("chat-1".into()),
                    delivery: Some("d-1".into())
                },
                Event::Thinking {
                    text: "plan".into()
                },
                Event::Text {
                    text: "Reading".into()
                },
                Event::ToolCall {
                    id: "c1".into(),
                    name: "read".into(),
                    input: json!({"path":"a"})
                },
                Event::ToolResult {
                    id: "c1".into(),
                    output: json!([{"type":"text","text":"x"}]),
                    error: false
                },
                Event::Text {
                    text: "Done".into()
                },
                Event::TurnEnded {
                    status: "completed".into()
                },
                Event::Command {
                    text: "/compact keep the plan".into()
                },
                Event::Error {
                    message: "Compaction failed: 429".into()
                },
                Event::Command {
                    text: "/compact".into()
                },
            ]
        );
    }

    #[test]
    fn a_background_tasks_notice_is_the_harness_telling_not_anyones_input() {
        let notice = "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command \"cargo test\" completed (exit code 0)</summary>\n</task-notification>";
        assert_eq!(
            events(
                "claude-code",
                vec![
                    // Absorbed into a running turn.
                    json!({"type":"attachment","attachment":{"type":"queued_command","prompt":notice,
                    "commandMode":"task-notification","origin":{"kind":"task-notification","producer":"session-task"}}}),
                    // Opening a turn of its own.
                    json!({"type":"user","message":{"content":notice}}),
                    // Without a summary: its text, without tags.
                    json!({"type":"attachment","attachment":{"type":"queued_command","prompt":"<task-notification><status>killed</status></task-notification>","commandMode":"task-notification"}}),
                    json!({"type":"attachment","attachment":{"type":"queued_command","prompt":"Task ended","commandMode":"task-notification"}}),
                ]
            ),
            vec![
                Event::Notice {
                    text: "Background command \"cargo test\" completed (exit code 0)".into()
                },
                Event::Notice {
                    text: "Background command \"cargo test\" completed (exit code 0)".into()
                },
                Event::Notice {
                    text: "killed".into()
                },
                Event::Notice {
                    text: "Task ended".into()
                },
            ]
        );
    }

    #[test]
    fn claude_records_project_to_the_common_model() {
        assert_eq!(
            events("claude-code", vec![
                json!({"type":"attachment","attachment":{"type":"queued_command","prompt":"[ZeroLux] 1 new message in \"Kernel\". Replying is your choice: to answer, call send with chat \"chat-2\" and reply_to \"d-2\""}}),
                json!({"type":"assistant","message":{"content":[{"type":"thinking","thinking":""},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}),
                json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"out","is_error":true}]}}),
                json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"i1","content":[{"type":"text","text":"[ZeroLux] \"Side\"\nChat: side; delivery: d-3\n\"birch\" (peer) [message m]:\n> hi"}]}]}}),
                json!({"type":"assistant","message":{"content":[{"type":"text","text":"Fine"}]}}),
                json!({"type":"system","subtype":"turn_duration"}),
                json!({"type":"permission-mode"}),
                json!({"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}),
                json!({"type":"system","subtype":"compact_boundary"}),
                json!({"type":"user","isCompactSummary":true,"message":{"content":"Summary"}}),
                json!({"type":"user","isMeta":true,"message":{"content":"<local-command-caveat>Caveat</local-command-caveat>"}}),
                json!({"type":"user","message":{"content":"<command-name>/compact</command-name>\n  <command-message>compact</command-message>\n  <command-args>keep the plan</command-args>"}}),
                json!({"type":"user","message":{"content":"<local-command-stdout>Compacted</local-command-stdout>"}}),
                json!({"type":"user","message":{"content":"<command-name>/model</command-name>\n<command-args></command-args>"}}),
            ]),
            vec![
                Event::Input {
                    text: "[ZeroLux] 1 new message in \"Kernel\". Replying is your choice: to answer, call send with chat \"chat-2\" and reply_to \"d-2\"".into(),
                    chat: Some("chat-2".into()),
                    delivery: Some("d-2".into()),
                },
                Event::ToolCall { id: "t1".into(), name: "Bash".into(), input: json!({"command":"ls"}) },
                Event::ToolResult { id: "t1".into(), output: json!("out"), error: true },
                Event::ToolResult {
                    id: "i1".into(),
                    output: json!([{"type":"text","text":"[ZeroLux] \"Side\"\nChat: side; delivery: d-3\n\"birch\" (peer) [message m]:\n> hi"}]),
                    error: false,
                },
                Event::Input {
                    text: "[ZeroLux] \"Side\"\nChat: side; delivery: d-3\n\"birch\" (peer) [message m]:\n> hi".into(),
                    chat: Some("side".into()),
                    delivery: Some("d-3".into()),
                },
                Event::Text { text: "Fine".into() },
                Event::TurnEnded { status: "completed".into() },
                Event::TurnEnded { status: "interrupted".into() },
                Event::Compacted { summary: None },
                Event::Compacted { summary: Some("Summary".into()) },
                Event::Command { text: "/compact keep the plan".into() },
                Event::Command { text: "/model".into() },
            ]
        );
    }

    #[test]
    fn a_tail_says_how_the_last_turn_ended_and_the_latest_line() {
        let at = |events: Vec<Event>| -> Vec<Item> {
            events
                .into_iter()
                .enumerate()
                .map(|(at, event)| Item {
                    at: at as u64,
                    time: None,
                    event,
                })
                .collect()
        };
        let text = |text: &str| Event::Text { text: text.into() };
        let call = |name: &str, input: Value| Event::ToolCall {
            id: "c".into(),
            name: name.into(),
            input,
        };
        let ended = |status: &str| Event::TurnEnded {
            status: status.into(),
        };
        assert_eq!(tail(&[], None), Tail::default());
        let done = tail(
            &at(vec![
                text("First"),
                text("Fixed the build.\n\nAll   tests pass."),
                ended("completed"),
                Event::Command {
                    text: "/compact".into(),
                },
                Event::Compacted { summary: None },
            ]),
            Some(7),
        );
        assert_eq!(
            done,
            Tail {
                output_at: Some(7),
                last_turn: Some("completed".into()),
                summary: Some("Fixed the build. All tests pass.".into()),
            }
        );
        // Working: no ending yet; without text, its latest step.
        let working = tail(
            &at(vec![
                ended("completed"),
                call("Bash", json!({"command": "bun test"})),
            ]),
            None,
        );
        assert_eq!(working.last_turn, None);
        assert_eq!(working.summary.as_deref(), Some("Bash: bun test"));
        assert_eq!(
            tail(
                &at(vec![Event::Error {
                    message: "x".into()
                }]),
                None
            )
            .last_turn,
            Some("error".into())
        );
        let long = tail(&at(vec![text(&"word ".repeat(100))]), None)
            .summary
            .unwrap();
        assert_eq!(long.chars().count(), SUMMARY_CHARS);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn a_codex_subagents_notice_is_a_notice_and_codex_context_is_nobodys_input() {
        let notice = |status: &str| json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":format!("<subagent_notification>\n{{\"agent_path\":\"/root/a\",\"status\":{status}}}\n</subagent_notification>")}]}});
        assert_eq!(
            events(
                "codex",
                vec![
                    notice(r#"{"completed":"done"}"#),
                    notice(r#"{"errored":"boom\nmore"}"#),
                    notice(r#""shutdown""#),
                    notice(r#""running""#),
                    json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<turn_aborted>\nstopped\n</turn_aborted>"}]}}),
                    json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<skill>\nname\n</skill>"},{"type":"input_text","text":"run it"}]}}),
                ]
            ),
            [
                "Agent /root/a completed",
                "Agent /root/a failed: boom",
                "Agent /root/a shut down"
            ]
            .map(|text| Event::Notice { text: text.into() })
            .to_vec()
        );
    }

    #[test]
    fn codex_records_project_to_the_common_model() {
        assert_eq!(
            events(
                "codex",
                vec![
                    json!({"type":"event_msg","payload":{"type":"task_started"}}),
                    json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":ENVELOPE}]}}),
                    json!({"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"rules"}]}}),
                    json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\n  <cwd>/w</cwd>\n</environment_context>"}]}}),
                    json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /w\n\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>"}]}}),
                    json!({"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"think"}]}}),
                    json!({"type":"response_item","payload":{"type":"function_call","call_id":"f1","name":"shell","arguments":"{\"cmd\":\"ls\"}"}}),
                    json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"f1","output":"ok"}}),
                    json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done"}]}}),
                    json!({"type":"event_msg","payload":{"type":"turn_aborted"}}),
                    json!({"type":"event_msg","payload":{"type":"token_count"}}),
                ]
            ),
            vec![
                Event::TurnStarted,
                Event::Input {
                    text: ENVELOPE.into(),
                    chat: Some("chat-1".into()),
                    delivery: Some("d-1".into())
                },
                Event::Thinking {
                    text: "think".into()
                },
                Event::ToolCall {
                    id: "f1".into(),
                    name: "shell".into(),
                    input: json!({"cmd":"ls"})
                },
                Event::ToolResult {
                    id: "f1".into(),
                    output: json!("ok"),
                    error: false
                },
                Event::Text {
                    text: "Done".into()
                },
                Event::TurnEnded {
                    status: "interrupted".into()
                },
            ]
        );
    }
}
