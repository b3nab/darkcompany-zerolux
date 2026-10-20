//! An extension's manifest, `zerolux-extension.toml`, and what it brings once running.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::store::{Error, Result};

/// The manifest's file name, at the root of an extension.
pub const FILE: &str = "zerolux-extension.toml";
/// The version of the protocol between the kernel and an extension's parts.
pub const API: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub extension: Identity,
    #[serde(default)]
    pub dependencies: BTreeMap<String, String>,
    pub kernel: Option<KernelPart>,
    pub process: Option<ProcessPart>,
    pub remote: Option<RemotePart>,
    #[serde(default)]
    pub settings: BTreeMap<String, Setting>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    /// `publisher.name`, in lowercase letters, digits and dashes.
    pub id: String,
    pub name: String,
    pub version: String,
    pub publisher: String,
    #[serde(default)]
    pub description: String,
    /// The kernel versions it works with, as a semver range.
    pub kernel: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct KernelPart {
    pub library: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ProcessPart {
    /// The program and its arguments, run in the extension's folder.
    pub command: Vec<String>,
    /// How long it may take to start, in seconds, when longer than a minute: the first start
    /// may prepare what it runs, such as its packages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RemotePart {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Setting {
    /// `text`, `number`, `boolean`, `secret` or `choice`.
    #[serde(rename = "type")]
    pub kind: String,
    pub label: String,
    #[serde(default)]
    pub description: String,
    pub default: Option<Value>,
    /// A choice's values, each with its label.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<SettingOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SettingOption {
    pub value: String,
    pub label: String,
}

/// The longest an action may take, when it says so; otherwise a minute.
pub const LONGEST: u64 = 30 * 60;

fn invalid(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}

fn name_part(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

impl Manifest {
    /// Whether `id` is an extension's id, `publisher.name`.
    pub fn valid_id(id: &str) -> bool {
        id.split_once('.')
            .is_some_and(|(publisher, name)| name_part(publisher) && name_part(name))
    }

    /// Reads and checks a manifest.
    pub fn parse(text: &str) -> Result<Self> {
        let manifest: Self =
            toml::from_str(text).map_err(|error| invalid(format!("Invalid manifest: {error}")))?;
        manifest.check()?;
        Ok(manifest)
    }

    fn check(&self) -> Result<()> {
        let identity = &self.extension;
        let Some((publisher, name)) = identity.id.split_once('.') else {
            return Err(invalid("An extension's id is `publisher.name`"));
        };
        if !name_part(publisher) || !name_part(name) || publisher != identity.publisher {
            return Err(invalid(
                "An extension's id is `publisher.name`, in lowercase letters, digits and dashes, with its publisher",
            ));
        }
        semver::Version::parse(&identity.version)
            .map_err(|_| invalid("An extension's version is semver, such as 1.0.0"))?;
        if let Some(range) = &identity.kernel {
            let range = semver::VersionReq::parse(range)
                .map_err(|_| invalid("The kernel versions are a semver range, such as >=0.1"))?;
            let kernel = semver::Version::parse(env!("CARGO_PKG_VERSION"))
                .map_err(|_| invalid("This kernel's version is not semver"))?;
            if !range.matches(&kernel) {
                return Err(invalid(format!(
                    "This extension works with kernel {range}; this one is {kernel}"
                )));
            }
        }
        for (dependency, range) in &self.dependencies {
            if dependency.split_once('.').is_none() {
                return Err(invalid(format!("Unknown dependency `{dependency}`")));
            }
            semver::VersionReq::parse(range)
                .map_err(|_| invalid(format!("`{dependency}` needs a semver range")))?;
        }
        if let Some(process) = &self.process
            && process
                .command
                .first()
                .is_none_or(|program| program.is_empty())
        {
            return Err(invalid("A process part names its command"));
        }
        if let Some(process) = &self.process
            && process
                .start_seconds
                .is_some_and(|seconds| seconds == 0 || seconds > LONGEST)
        {
            return Err(invalid(format!(
                "A process part starts within {LONGEST} seconds"
            )));
        }
        if let Some(remote) = &self.remote
            && !remote.url.starts_with("https://")
            && !remote.url.starts_with("http://127.0.0.1")
            && !remote.url.starts_with("http://localhost")
        {
            return Err(invalid("A remote part is reached over HTTPS"));
        }
        for (key, setting) in &self.settings {
            if !name_part(&key.replace('_', "-")) {
                return Err(invalid(format!("Invalid setting name `{key}`")));
            }
            if !matches!(
                setting.kind.as_str(),
                "text" | "number" | "boolean" | "secret" | "choice"
            ) {
                return Err(invalid(format!(
                    "Setting `{key}` is text, number, boolean, secret or choice"
                )));
            }
            if (setting.kind == "choice") == setting.options.is_empty() {
                return Err(invalid(format!(
                    "Setting `{key}` has options only if it is a choice"
                )));
            }
            if setting.kind == "choice"
                && let Some(default) = &setting.default
                && !setting
                    .options
                    .iter()
                    .any(|option| Some(option.value.as_str()) == default.as_str())
            {
                return Err(invalid(format!(
                    "Setting `{key}` defaults to one of its options"
                )));
            }
        }
        if self.remote.is_some() {
            return Err(invalid(
                "Remote parts are not called yet by this kernel; use a kernel or process part",
            ));
        }
        if let Some(kernel) = &self.kernel
            && !name_part(&kernel.library.replace('_', "-"))
        {
            return Err(invalid(
                "A kernel part names its library in lowercase letters, digits, dashes and underscores",
            ));
        }
        if self.kernel.is_some() == self.process.is_some() {
            return Err(invalid("An extension has a kernel part or a process part"));
        }
        Ok(())
    }
}

/// What an extension brings, as its running parts declare it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Contributes {
    #[serde(default)]
    pub actions: Vec<Action>,
    /// Extension points it opens, with their contracts.
    #[serde(default)]
    pub points: Vec<Point>,
    /// Extension points of others it implements.
    #[serde(default)]
    pub implements: Vec<Implementation>,
    /// Events it publishes.
    #[serde(default)]
    pub events: Vec<EventSpec>,
    /// Events, its own or others', it hears.
    #[serde(default)]
    pub subscribes: Vec<String>,
    #[serde(default)]
    pub triggers: Vec<Trigger>,
    /// What it shows in the clients, and where.
    #[serde(default)]
    pub ui: Vec<UiPiece>,
}

/// A piece of an extension's interface, in one of the clients' spaces.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UiPiece {
    /// `page`, `session`, `chat`, `message` or `settings`.
    pub space: String,
    pub name: String,
    pub title: String,
    /// The name of one of the clients' icons.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub view: UiView,
}

/// How a piece is drawn.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum UiView {
    /// By the clients' own component for it, when they have one.
    Native,
    /// From the tree an action of its returns, drawn again after its own actions and on the
    /// events it names.
    Described {
        action: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        refresh_on: Vec<String>,
    },
    /// From a tree the extension keeps up to date itself, starting from an action's.
    Remote { action: String },
    /// From its own page, `ui/…` in its folder, isolated in a frame.
    Web { entry: String },
    /// One of its actions, run on a message.
    Action { action: String },
}

/// An operation, defined once for people, agents and the API.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Action {
    pub name: String,
    pub title: String,
    pub description: String,
    /// JSON Schema of its input.
    #[serde(default = "object")]
    pub input: Value,
    /// JSON Schema of its result.
    pub output: Option<Value>,
    /// `read`, `write` or `destructive`.
    #[serde(default = "read")]
    pub effects: String,
    /// How long it may take, in seconds, when longer than a minute.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seconds: Option<u64>,
}

fn object() -> Value {
    serde_json::json!({"type": "object"})
}

fn read() -> String {
    "read".into()
}

/// An extension point, versioned, with the operations its implementations offer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub name: String,
    pub version: u32,
    #[serde(default)]
    pub description: String,
    pub operations: Vec<Operation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "object")]
    pub input: Value,
    pub output: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Implementation {
    /// `publisher.extension/point@version`.
    pub point: String,
    /// What it is called among the point's implementations, such as `s3`.
    pub name: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EventSpec {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

/// When something happens, run one of its actions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Trigger {
    /// `event:<name>` or `schedule:<cron>`.
    pub on: String,
    pub action: String,
}

fn local_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

impl Contributes {
    /// Checks what an extension declared, in its own namespace.
    pub fn check(&self, extension: &str) -> Result<()> {
        let mut names = std::collections::HashSet::new();
        for action in &self.actions {
            if !local_name(&action.name) || !names.insert(&action.name) {
                return Err(invalid(format!(
                    "Invalid or repeated action `{}`",
                    action.name
                )));
            }
            if action
                .seconds
                .is_some_and(|seconds| seconds == 0 || seconds > LONGEST)
            {
                return Err(invalid(format!(
                    "`{}` may take up to {LONGEST} seconds",
                    action.name
                )));
            }
            if !matches!(action.effects.as_str(), "read" | "write" | "destructive") {
                return Err(invalid(format!(
                    "Action `{}` reads, writes or is destructive",
                    action.name
                )));
            }
            jsonschema::validator_for(&action.input).map_err(|error| {
                invalid(format!(
                    "Action `{}` has an invalid input schema: {error}",
                    action.name
                ))
            })?;
        }
        for point in &self.points {
            if !local_name(&point.name) || point.operations.is_empty() {
                return Err(invalid(format!("Invalid extension point `{}`", point.name)));
            }
        }
        for implementation in &self.implements {
            parse_point(&implementation.point)?;
            if !local_name(&implementation.name) {
                return Err(invalid(format!(
                    "Invalid implementation name `{}`",
                    implementation.name
                )));
            }
        }
        for event in &self.events {
            if !local_name(&event.name) {
                return Err(invalid(format!("Invalid event `{}`", event.name)));
            }
        }
        let mut pieces = std::collections::HashSet::new();
        for piece in &self.ui {
            if !local_name(&piece.name) || !pieces.insert((&piece.space, &piece.name)) {
                return Err(invalid(format!(
                    "Invalid or repeated interface piece `{}`",
                    piece.name
                )));
            }
            if !matches!(
                piece.space.as_str(),
                "page" | "session" | "chat" | "message" | "settings"
            ) {
                return Err(invalid(format!(
                    "`{}` goes in a page, session, chat, message or settings",
                    piece.name
                )));
            }
            let action = match &piece.view {
                UiView::Native => None,
                UiView::Described { action, .. } | UiView::Remote { action } => Some(action),
                UiView::Web { entry } => {
                    let path = std::path::Path::new(entry);
                    if !entry.starts_with("ui/")
                        || path
                            .components()
                            .any(|part| !matches!(part, std::path::Component::Normal(_)))
                    {
                        return Err(invalid(format!(
                            "`{}` shows a page in its `ui/` folder",
                            piece.name
                        )));
                    }
                    None
                }
                UiView::Action { action } => Some(action),
            };
            if matches!(piece.view, UiView::Action { .. }) != (piece.space == "message") {
                return Err(invalid(format!(
                    "`{}`: a message's piece runs an action, and only there",
                    piece.name
                )));
            }
            if let Some(action) = action
                && !self.actions.iter().any(|known| &known.name == action)
            {
                return Err(invalid(format!(
                    "`{}` shows `{action}`, which {extension} does not have",
                    piece.name
                )));
            }
        }
        for trigger in &self.triggers {
            if !self
                .actions
                .iter()
                .any(|action| action.name == trigger.action)
            {
                return Err(invalid(format!(
                    "A trigger runs `{}`, which {extension} does not have",
                    trigger.action
                )));
            }
            match trigger.on.split_once(':') {
                Some(("event", name)) if name.contains('/') => {}
                Some(("schedule", cron)) => {
                    crate::schedules::next_run(cron, crate::store::now_ms())?;
                }
                _ => {
                    return Err(invalid(
                        "A trigger is on `event:<extension>/<event>` or `schedule:<cron>`",
                    ));
                }
            }
        }
        Ok(())
    }
}

/// `publisher.extension/point@version` as its parts.
pub fn parse_point(value: &str) -> Result<(String, String, u32)> {
    let (owner, rest) = value
        .split_once('/')
        .ok_or_else(|| invalid("An extension point is `publisher.extension/point@version`"))?;
    let (name, version) = rest
        .split_once('@')
        .ok_or_else(|| invalid("An extension point is `publisher.extension/point@version`"))?;
    let version = version
        .parse()
        .map_err(|_| invalid("An extension point's version is a number"))?;
    Ok((owner.to_owned(), name.to_owned(), version))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_manifest_names_its_extension_and_parts_and_is_checked() {
        let manifest = Manifest::parse(
            r#"
[extension]
id = "zerolux.hello"
name = "Hello"
version = "1.0.0"
publisher = "zerolux"

[process]
command = ["bun", "run", "main.ts"]

[settings]
greeting = { type = "text", label = "Greeting", default = "Hello" }
token = { type = "secret", label = "Token" }
"#,
        )
        .unwrap();
        assert_eq!(manifest.extension.id, "zerolux.hello");
        assert_eq!(manifest.settings["token"].kind, "secret");
        for wrong in [
            "[extension]\nid = \"Hello\"\nname = \"x\"\nversion = \"1.0.0\"\npublisher = \"zerolux\"",
            "[extension]\nid = \"acme.x\"\nname = \"x\"\nversion = \"1.0.0\"\npublisher = \"zerolux\"",
            "[extension]\nid = \"zerolux.x\"\nname = \"x\"\nversion = \"one\"\npublisher = \"zerolux\"",
            "[extension]\nid = \"zerolux.x\"\nname = \"x\"\nversion = \"1.0.0\"\npublisher = \"zerolux\"\nkernel = \">=99\"",
            "[extension]\nid = \"zerolux.x\"\nname = \"x\"\nversion = \"1.0.0\"\npublisher = \"zerolux\"\nunknown = 1",
        ] {
            let wrong = format!("{wrong}\n[process]\ncommand = [\"bun\"]");
            assert!(Manifest::parse(&wrong).is_err(), "{wrong}");
        }
        let identity = "[extension]\nid = \"zerolux.x\"\nname = \"x\"\nversion = \"1.0.0\"\npublisher = \"zerolux\"";
        assert!(Manifest::parse(identity).is_err(), "it has no part");
        assert!(Manifest::parse(&format!("{identity}\n[process]\ncommand = [\"bun\"]")).is_ok());
        assert!(
            Manifest::parse(&format!(
                "{identity}\n[process]\ncommand = [\"bun\"]\n[remote]\nurl = \"https://example.com\""
            ))
            .is_err(),
            "remote parts are not called yet"
        );
    }

    #[test]
    fn what_an_extension_brings_is_checked_in_its_namespace() {
        let mut contributes: Contributes = serde_json::from_value(serde_json::json!({
            "actions": [{"name": "greet", "title": "Greet", "description": "Says hello",
                "input": {"type": "object", "properties": {"name": {"type": "string"}}}}],
            "triggers": [{"on": "schedule:0 9 * * 1", "action": "greet"},
                {"on": "event:zerolux.projects/issue.created", "action": "greet"}],
            "implements": [{"point": "zerolux.storage/providers@1", "name": "s3", "title": "S3"}]
        }))
        .unwrap();
        contributes.check("zerolux.hello").unwrap();
        contributes.triggers.push(Trigger {
            on: "event:nothing".into(),
            action: "greet".into(),
        });
        assert!(contributes.check("zerolux.hello").is_err());
        assert_eq!(
            parse_point("zerolux.storage/providers@1").unwrap(),
            ("zerolux.storage".into(), "providers".into(), 1)
        );
    }

    #[test]
    fn interface_pieces_go_in_known_spaces_and_show_their_own_actions() {
        let with = |ui: serde_json::Value| -> Result<()> {
            let contributes: Contributes = serde_json::from_value(serde_json::json!({
                "actions": [{"name": "board", "title": "Board", "description": "The board"}],
                "ui": ui,
            }))
            .map_err(|error| invalid(error.to_string()))?;
            contributes.check("acme.board")
        };
        with(serde_json::json!([
            {"space": "page", "name": "board", "title": "Board", "icon": "kanban",
                "view": {"kind": "described", "action": "board", "refresh_on": ["acme.board/moved"]}},
            {"space": "session", "name": "board", "title": "Board", "view": {"kind": "remote", "action": "board"}},
            {"space": "settings", "name": "page", "title": "Board", "view": {"kind": "web", "entry": "ui/index.html"}},
            {"space": "chat", "name": "files", "title": "Files", "view": {"kind": "native"}},
            {"space": "message", "name": "save", "title": "Save", "view": {"kind": "action", "action": "board"}},
        ]))
        .unwrap();
        for wrong in [
            serde_json::json!([{"space": "sky", "name": "a", "title": "A", "view": {"kind": "native"}}]),
            serde_json::json!([{"space": "page", "name": "a", "title": "A",
                "view": {"kind": "described", "action": "missing"}}]),
            serde_json::json!([{"space": "page", "name": "a", "title": "A",
                "view": {"kind": "web", "entry": "ui/../secret"}}]),
            serde_json::json!([{"space": "page", "name": "a", "title": "A",
                "view": {"kind": "action", "action": "board"}}]),
            serde_json::json!([{"space": "message", "name": "a", "title": "A", "view": {"kind": "native"}}]),
            serde_json::json!([
                {"space": "page", "name": "a", "title": "A", "view": {"kind": "native"}},
                {"space": "page", "name": "a", "title": "B", "view": {"kind": "native"}}]),
        ] {
            assert!(with(wrong.clone()).is_err(), "{wrong}");
        }
    }
}
