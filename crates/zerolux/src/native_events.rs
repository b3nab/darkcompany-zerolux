//! Agent Console events: the native record of pi, Claude Code and Codex in one model.
//!
//! A projection of the native record, never a copy: every event names the byte offset of
//! the record it comes from, and `/output` still serves the records themselves. Records
//! that say nothing about the agent's work (bookkeeping, settings, token counts) project
//! to no event.

use serde::Serialize;
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
        _ => Vec::new(),
    }
}

fn claude(record: &Value) -> Vec<Event> {
    match record["type"].as_str() {
        Some("user") if record["isCompactSummary"] == true => vec![Event::Compacted {
            summary: Some(text_of(&record["message"]["content"], &["text"])),
        }],
        Some("user") => {
            let content = &record["message"]["content"];
            let mut events = Vec::new();
            let text = text_of(content, &["text"]);
            if !text.trim().is_empty() {
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
            match record["attachment"]["prompt"].as_str() {
                Some(prompt) => vec![input(prompt.to_owned())],
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

fn codex(record: &Value) -> Vec<Event> {
    let payload = &record["payload"];
    match (record["type"].as_str(), payload["type"].as_str()) {
        (Some("response_item"), Some("message")) => match payload["role"].as_str() {
            Some("user") => vec![input(text_of(&payload["content"], &["input_text"]))],
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
        "[ZeroLux] \"Kernel\"\nChat: chat-1; delivery: d-1\n\"Ben\" [message m]:\n> go";

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
            ]
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
