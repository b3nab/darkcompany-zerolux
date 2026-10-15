//! What a session asks the owner besides a permission: a question or an MCP form.
//!
//! One shape for every harness. Each integration converts its native request into it and
//! the owner's answer back into the native response; the kernel only checks that the
//! answer fits what was asked.

use serde_json::{Map, Value};

use crate::store::{Error, Result};

pub const KINDS: [&str; 3] = ["permission", "question", "form"];
const MAX_TEXT: usize = 64 * 1024;

fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}

fn string<'a>(value: &'a Value, key: &str, required: bool) -> Result<Option<&'a str>> {
    match value.get(key) {
        None | Some(Value::Null) if !required => Ok(None),
        Some(Value::String(text)) if text.len() <= MAX_TEXT => Ok(Some(text)),
        _ => Err(invalid(&format!("Invalid request field {key}"))),
    }
}

fn flag(value: &Value, key: &str) -> Result<bool> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(flag)) => Ok(*flag),
        _ => Err(invalid(&format!("Invalid request field {key}"))),
    }
}

/// `{"questions":[{id, header?, question, options:[{label, description?, preview?}],
/// multiple, other, secret, multiline, placeholder?, default?}]}`
fn check_question(details: &Value) -> Result<()> {
    let questions = details["questions"]
        .as_array()
        .filter(|items| (1..=16).contains(&items.len()))
        .ok_or_else(|| invalid("A question request has 1 to 16 questions"))?;
    let mut ids = std::collections::HashSet::new();
    for question in questions {
        let id = string(question, "id", true)?.unwrap_or_default();
        if id.is_empty() || id.len() > 1000 || !ids.insert(id) {
            return Err(invalid("Each question needs its own ID"));
        }
        string(question, "question", true)?;
        for key in ["header", "placeholder", "default"] {
            string(question, key, false)?;
        }
        for key in ["multiple", "other", "secret", "multiline"] {
            flag(question, key)?;
        }
        let options = question["options"]
            .as_array()
            .filter(|items| items.len() <= 64)
            .ok_or_else(|| invalid("Invalid question options"))?;
        for option in options {
            string(option, "label", true)?;
            string(option, "description", false)?;
            string(option, "preview", false)?;
        }
        if options.is_empty() && !flag(question, "other")? {
            return Err(invalid("A question without options takes free text"));
        }
    }
    Ok(())
}

/// `{"server", "message", "mode": "form" | "url", "schema"?, "url"?}`: MCP elicitation.
fn check_form(details: &Value) -> Result<()> {
    string(details, "server", true)?;
    string(details, "message", true)?;
    match string(details, "mode", true)? {
        Some("form") => {
            let schema = &details["schema"];
            if schema["type"] != "object" || !schema["properties"].is_object() {
                return Err(invalid("A form needs an object schema"));
            }
            Ok(())
        }
        Some("url") => string(details, "url", true).map(|_| ()),
        _ => Err(invalid("A form is a form or a URL")),
    }
}

/// The request a session records, checked for its kind.
pub fn check_request(kind: &str, details: &Value) -> Result<()> {
    if !details.is_object() || details.to_string().len() > 256 * 1024 {
        return Err(invalid(
            "Request details must be a JSON object of at most 256 KiB",
        ));
    }
    match kind {
        "permission" => Ok(()),
        "question" => check_question(details),
        "form" => check_form(details),
        _ => Err(invalid("Unknown request kind")),
    }
}

/// `{"declined": true}`, or `{"answers": {<id>: [text, ...]}}` with every question answered.
fn check_answers(details: &Value, answer: &Value) -> Result<()> {
    if answer == &serde_json::json!({"declined": true}) {
        return Ok(());
    }
    let answers = answer
        .as_object()
        .filter(|object| object.len() == 1)
        .and_then(|object| object.get("answers"))
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("Answer with {\"answers\": {...}} or {\"declined\": true}"))?;
    let questions = details["questions"].as_array().cloned().unwrap_or_default();
    if answers.len() != questions.len() {
        return Err(invalid("Answer every question"));
    }
    for question in &questions {
        let id = question["id"].as_str().unwrap_or_default();
        let values = answers
            .get(id)
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("Answer every question"))?;
        let multiple = question["multiple"] == true;
        if values.is_empty() || (!multiple && values.len() > 1) {
            return Err(invalid(if multiple {
                "Choose at least one answer"
            } else {
                "Choose one answer"
            }));
        }
        let labels: Vec<&str> = question["options"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|option| option["label"].as_str())
            .collect();
        for value in values {
            let text = value
                .as_str()
                .filter(|text| !text.is_empty() && text.len() <= MAX_TEXT)
                .ok_or_else(|| invalid("Answers are non-empty text"))?;
            if question["other"] != true && !labels.contains(&text) {
                return Err(invalid("Choose one of the offered answers"));
            }
        }
    }
    Ok(())
}

fn fits(field: &Value, value: &Value) -> bool {
    let options = |items: &Value| -> Vec<String> {
        items
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| {
                item.as_str()
                    .map(str::to_owned)
                    .or_else(|| item["const"].as_str().map(str::to_owned))
            })
            .collect()
    };
    let choices = if field["enum"].is_array() {
        options(&field["enum"])
    } else {
        options(&field["oneOf"])
    };
    let in_range = |number: f64| {
        field["minimum"].as_f64().is_none_or(|min| number >= min)
            && field["maximum"].as_f64().is_none_or(|max| number <= max)
    };
    match field["type"].as_str() {
        Some("string") => value
            .as_str()
            .is_some_and(|text| choices.is_empty() || choices.iter().any(|c| c == text)),
        Some("number") => value.as_f64().is_some_and(in_range),
        Some("integer") => value.as_i64().is_some_and(|n| in_range(n as f64)),
        Some("boolean") => value.is_boolean(),
        Some("array") => {
            let allowed = {
                let items = &field["items"];
                if items["enum"].is_array() {
                    options(&items["enum"])
                } else {
                    options(&items["anyOf"])
                }
            };
            value.as_array().is_some_and(|items| {
                items.iter().all(|item| {
                    item.as_str()
                        .is_some_and(|text| allowed.is_empty() || allowed.iter().any(|a| a == text))
                })
            })
        }
        _ => false,
    }
}

/// `{"action": "accept", "content"?}`, `{"action": "decline"}` or `{"action": "cancel"}`.
fn check_form_answer(details: &Value, answer: &Value) -> Result<()> {
    let object = answer
        .as_object()
        .ok_or_else(|| invalid("Answer a form with an action"))?;
    match object.get("action").and_then(Value::as_str) {
        Some("decline" | "cancel") if object.len() == 1 => Ok(()),
        Some("accept") if details["mode"] == "url" && object.len() == 1 => Ok(()),
        Some("accept") if details["mode"] == "form" => {
            let empty = Map::new();
            let content = object
                .get("content")
                .and_then(Value::as_object)
                .filter(|_| object.len() == 2)
                .ok_or_else(|| invalid("An accepted form carries its content"))?;
            let fields = details["schema"]["properties"]
                .as_object()
                .unwrap_or(&empty);
            for (name, value) in content {
                let field = fields
                    .get(name)
                    .ok_or_else(|| invalid("The form has no such field"))?;
                if !fits(field, value) {
                    return Err(invalid(&format!("Invalid value for {name}")));
                }
            }
            for required in details["schema"]["required"]
                .as_array()
                .into_iter()
                .flatten()
            {
                if !required
                    .as_str()
                    .is_some_and(|name| content.contains_key(name))
                {
                    return Err(invalid("Fill in every required field"));
                }
            }
            Ok(())
        }
        _ => Err(invalid("Answer a form with accept, decline or cancel")),
    }
}

/// The owner's answer to a question or a form, checked against what was asked.
pub fn check_answer(kind: &str, details: &Value, answer: &Value) -> Result<()> {
    if answer.to_string().len() > 256 * 1024 {
        return Err(invalid("The answer is too large"));
    }
    match kind {
        "question" => check_answers(details, answer),
        "form" => check_form_answer(details, answer),
        _ => Err(invalid("A permission is decided, not answered")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn question() -> Value {
        json!({"questions":[
            {"id":"lib","header":"Library","question":"Which library?","options":[
                {"label":"date-fns","description":"Small"},{"label":"luxon","description":"Zones"}],
             "multiple":false,"other":false},
            {"id":"features","question":"Which features?","options":[{"label":"A"},{"label":"B"}],
             "multiple":true,"other":true}
        ]})
    }

    #[test]
    fn a_question_is_answered_within_what_was_offered() {
        let details = question();
        check_request("question", &details).unwrap();
        check_answer(
            "question",
            &details,
            &json!({"answers":{"lib":["luxon"],"features":["A","something else"]}}),
        )
        .unwrap();
        check_answer("question", &details, &json!({"declined": true})).unwrap();
        for wrong in [
            json!({"answers":{"lib":["moment"],"features":["A"]}}),
            json!({"answers":{"lib":["luxon","date-fns"],"features":["A"]}}),
            json!({"answers":{"lib":["luxon"]}}),
            json!({"answers":{"lib":["luxon"],"features":[]}}),
            json!({"decision":"allow"}),
        ] {
            assert!(
                check_answer("question", &details, &wrong).is_err(),
                "{wrong}"
            );
        }
        assert!(check_request("question", &json!({"questions":[]})).is_err());
        assert!(
            check_request(
                "question",
                &json!({"questions":[{"id":"x","question":"?","options":[]}]})
            )
            .is_err()
        );
    }

    #[test]
    fn a_form_is_filled_within_its_schema() {
        let details = json!({"server":"github","message":"Which repository?","mode":"form","schema":{
            "type":"object","required":["repo"],"properties":{
                "repo":{"type":"string"},
                "visibility":{"type":"string","enum":["public","private"]},
                "count":{"type":"integer","minimum":1,"maximum":5},
                "draft":{"type":"boolean"},
                "labels":{"type":"array","items":{"type":"string","enum":["bug","docs"]}}}}});
        check_request("form", &details).unwrap();
        check_answer(
            "form",
            &details,
            &json!({"action":"accept","content":{"repo":"zerolux","visibility":"private","count":2,"draft":true,"labels":["bug"]}}),
        )
        .unwrap();
        check_answer("form", &details, &json!({"action":"decline"})).unwrap();
        for wrong in [
            json!({"action":"accept","content":{"visibility":"public"}}),
            json!({"action":"accept","content":{"repo":"z","visibility":"secret"}}),
            json!({"action":"accept","content":{"repo":"z","count":9}}),
            json!({"action":"accept","content":{"repo":"z","labels":["other"]}}),
            json!({"action":"accept","content":{"repo":"z","unknown":1}}),
            json!({"action":"accept"}),
        ] {
            assert!(check_answer("form", &details, &wrong).is_err(), "{wrong}");
        }
        let url = json!({"server":"linear","message":"Sign in","mode":"url","url":"https://example.invalid/auth"});
        check_request("form", &url).unwrap();
        check_answer("form", &url, &json!({"action":"accept"})).unwrap();
        assert!(check_answer("permission", &url, &json!({"action":"accept"})).is_err());
    }
}
