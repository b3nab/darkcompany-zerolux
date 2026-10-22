//! ZeroLux's Projects, a kernel module: the workspace's work as projects and their tasks, for
//! people and agents. Projects come from **sources**: ZeroLux's own, where projects are kept
//! here, and as many trackers as wanted, several of one too (two Linear workspaces, a Plane, a
//! ClickUp…). A tracker's projects show as the tracker holds them, live, and change there:
//! nothing is copied or kept in step.
//!
//! Projects opens `zerolux.projects/trackers@2` and implements it itself as `local`; other
//! extensions implement it for Plane, Linear, ClickUp and others. Projects keeps only what the
//! trackers do not: its sources, and the agents given a tracker's task, with the sessions that
//! were told of it.

mod local;

use std::{collections::BTreeMap, sync::Mutex};

use zerolux_extension::{Caller, Context, Extension, Value, json, serde_json};

/// The point trackers implement.
pub const TRACKERS: &str = "zerolux.projects/trackers@2";
/// The tracker Projects implements itself.
const LOCAL: &str = "local";
pub const STATUSES: [&str; 6] = [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "cancelled",
];
pub const PRIORITIES: [&str; 5] = ["none", "low", "medium", "high", "urgent"];

#[derive(Default)]
pub struct Projects {
    /// Changes to what Projects keeps go one at a time.
    held: Mutex<()>,
    /// Whether ZeroLux's own source is there.
    ready: Mutex<bool>,
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type": "object", "properties": properties, "required": required})
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}

fn who(caller: &Caller) -> Value {
    caller["actor_id"]
        .as_str()
        .or(caller["by"].as_str())
        .map_or(Value::Null, |id| json!(id))
}

/// A person, unless an agent's session or another extension runs it.
fn person(caller: &Caller) -> bool {
    caller["session_id"].is_null() && caller["by"].is_null()
}

pub(crate) fn text_of(value: &Value, limit: usize, what: &str) -> Result<String, String> {
    let text = value.as_str().unwrap_or_default().trim().to_owned();
    if text.len() > limit {
        return Err(format!("{what} is up to {limit} bytes"));
    }
    Ok(text)
}

pub(crate) fn choice(value: &Value, allowed: &[&str], what: &str) -> Result<String, String> {
    let chosen = value.as_str().unwrap_or_default();
    if allowed.contains(&chosen) {
        Ok(chosen.to_owned())
    } else {
        Err(format!("{what} is one of {}", allowed.join(", ")))
    }
}

/// A project's id in Projects: its source's and its own in the source.
fn project_ref(source: &str, project: &str) -> String {
    format!("{source}:{project}")
}

/// A task's id in Projects: its source's, its project's and its own in the source.
fn task_ref(source: &str, project: &str, task: &str) -> String {
    format!("{source}:{project}:{task}")
}

fn split_project(id: &str) -> Result<(String, String), String> {
    let (source, project) = id.split_once(':').ok_or("No such project")?;
    Ok((source.to_owned(), project.to_owned()))
}

fn split_task(id: &str) -> Result<(String, String, String), String> {
    let mut parts = id.splitn(3, ':');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(source), Some(project), Some(task)) if !task.is_empty() => {
            Ok((source.to_owned(), project.to_owned(), task.to_owned()))
        }
        _ => Err("No such task".into()),
    }
}

impl Projects {
    // What Projects keeps.

    fn read_map(context: &Context, key: &str) -> Result<BTreeMap<String, Value>, String> {
        let stored = context.get_value(key)?;
        if stored.is_null() {
            return Ok(BTreeMap::new());
        }
        serde_json::from_value(stored).map_err(|error| error.to_string())
    }

    fn change<T>(
        &self,
        context: &Context,
        key: &str,
        change: impl FnOnce(&mut BTreeMap<String, Value>) -> Result<T, String>,
    ) -> Result<T, String> {
        let _held = self.held.lock().map_err(|_| "Projects is unavailable")?;
        let mut map = Self::read_map(context, key)?;
        let result = change(&mut map)?;
        context.set_value(key, json!(map))?;
        Ok(result)
    }

    fn sources(&self, context: &Context) -> Result<BTreeMap<String, Value>, String> {
        self.ready(context)?;
        Self::read_map(context, "sources")
    }

    /// ZeroLux's own source, there from the start.
    fn ready(&self, context: &Context) -> Result<(), String> {
        let mut ready = self.ready.lock().map_err(|_| "Projects is unavailable")?;
        if *ready {
            return Ok(());
        }
        let _held = self.held.lock().map_err(|_| "Projects is unavailable")?;
        let mut sources = Self::read_map(context, "sources")?;
        if !sources.values().any(|source| source["tracker"] == LOCAL) {
            let id = uuid::Uuid::new_v4().simple().to_string();
            sources.insert(
                id.clone(),
                json!({"id": id, "name": "ZeroLux", "tracker": LOCAL, "config": {},
                    "created_at": now_ms(), "own": true, "signed_in": true}),
            );
            context.set_value("sources", json!(sources))?;
        }
        *ready = true;
        Ok(())
    }

    /// A source by its id, or by its name when only one has it.
    fn source(&self, context: &Context, named: &str) -> Result<Value, String> {
        let sources = self.sources(context)?;
        if let Some(source) = sources.get(named) {
            return Ok(source.clone());
        }
        let mut found = sources
            .values()
            .filter(|source| source["name"].as_str() == Some(named));
        match (found.next(), found.next()) {
            (Some(source), None) => Ok(source.clone()),
            (Some(_), Some(_)) => Err(format!("More than one source is named `{named}`")),
            _ => Err(format!("No source `{named}`")),
        }
    }

    // Trackers.

    /// Asks a source's tracker; `local` is Projects' own.
    fn track(
        &self,
        context: &Context,
        source: &Value,
        operation: &str,
        mut input: Value,
        caller: &Caller,
    ) -> Result<Value, String> {
        input["source"] = source["id"].clone();
        input["config"] = source["config"].clone();
        let tracker = source["tracker"].as_str().unwrap_or(LOCAL);
        let result = if tracker == LOCAL {
            let _held = self.held.lock().map_err(|_| "Projects is unavailable")?;
            local::operation(context, operation, &input, &who(caller))
        } else {
            context.call(TRACKERS, tracker, operation, input)
        };
        let failed = result.as_ref().err().cloned();
        if failed.is_some() != source["error"].is_string() && tracker != LOCAL {
            let id = source["id"].as_str().unwrap_or_default().to_owned();
            let _ = self.change(context, "sources", |sources| {
                if let Some(kept) = sources.get_mut(&id) {
                    kept["error"] = json!(failed);
                }
                Ok(())
            });
        }
        result
    }

    fn describe(&self, context: &Context, tracker: &str) -> Value {
        if tracker == LOCAL {
            return local::operation(context, "describe", &json!({}), &Value::Null)
                .unwrap_or_default();
        }
        context
            .call(TRACKERS, tracker, "describe", json!({}))
            .unwrap_or_else(|error| json!({"error": error}))
    }

    /// The trackers there are, besides Projects' own.
    fn trackers(&self, context: &Context) -> Result<Vec<Value>, String> {
        let implementations =
            context.ask("points.implementations", json!({"point": TRACKERS}))?["implementations"]
                .take();
        let mut trackers = Vec::new();
        for implementation in implementations.as_array().into_iter().flatten() {
            let name = implementation["name"].as_str().unwrap_or_default();
            if name == LOCAL {
                continue;
            }
            let mut tracker = json!({"tracker": name, "extension": implementation["extension"],
                "title": implementation["title"]});
            for (key, value) in self
                .describe(context, name)
                .as_object()
                .into_iter()
                .flatten()
            {
                tracker[key] = value.clone();
            }
            trackers.push(tracker);
        }
        Ok(trackers)
    }

    fn capable(&self, context: &Context, source: &Value, capability: &str) -> bool {
        self.describe(context, source["tracker"].as_str().unwrap_or(LOCAL))["capabilities"]
            .as_array()
            .is_some_and(|all| all.iter().any(|known| known == capability))
    }

    fn connect(
        &self,
        context: &Context,
        caller: &Caller,
        source: &Value,
        config: Value,
    ) -> Result<Value, String> {
        let input = json!({"source": source["id"], "config": config,
            "previous": source["config"], "origin": caller["origin"]});
        context.call(
            TRACKERS,
            source["tracker"].as_str().unwrap_or_default(),
            "connect",
            input,
        )
    }

    // Tasks as Projects shows them.

    /// A tracker's task, with its ids in Projects and the agent ZeroLux gave it.
    fn shown_task(
        overlay: &BTreeMap<String, Value>,
        source: &Value,
        project: &str,
        mut task: Value,
    ) -> Value {
        let source_id = source["id"].as_str().unwrap_or_default();
        let native = task["id"].as_str().unwrap_or_default().to_owned();
        let id = task_ref(source_id, project, &native);
        task["id"] = json!(id);
        task["source"] = json!(source_id);
        task["project_id"] = json!(project_ref(source_id, project));
        // A tracker's people are its own; the agent ZeroLux gave it is ZeroLux's.
        if source["tracker"] != LOCAL {
            task["assignee"] = overlay
                .get(&id)
                .map_or(Value::Null, |kept| kept["agent"].clone());
        }
        if task["labels"].is_null() {
            task["labels"] = json!([]);
        }
        task
    }

    /// Tells an agent a task is now its own, in its running session: the session it went to,
    /// or why not.
    fn tell(context: &Context, task: &Value, agent: &str) -> Value {
        let text = format!(
            "Task {} is yours: {}\nstatus {}, priority {}{}\n{}\nRead it with zerolux.projects/task {{\"id\": \"{}\"}}; change it with update_task, comment with comment.",
            task["key"].as_str().unwrap_or_default(),
            task["title"].as_str().unwrap_or_default(),
            task["status"].as_str().unwrap_or_default(),
            task["priority"].as_str().unwrap_or_default(),
            task["due"]
                .as_str()
                .map(|due| format!(", due {due}"))
                .unwrap_or_default(),
            task["description"].as_str().unwrap_or_default(),
            task["id"].as_str().unwrap_or_default(),
        );
        match context.tell_agent(agent, &text) {
            Ok(session) => json!({"session_id": session}),
            Err(error) => json!({"error": error}),
        }
    }

    fn is_agent(context: &Context, actor: &str) -> bool {
        context.workspace().ok().is_some_and(|workspace| {
            workspace["actors"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|known| known["id"] == actor && known["kind"] == "agent")
        })
    }

    /// After a task got an assignee: an agent is told, and the session it went to kept with
    /// the task. A person is told by the apps.
    fn assigned(&self, context: &Context, task: &mut Value) -> Result<(), String> {
        let Some(agent) = task["assignee"].as_str().map(str::to_owned) else {
            return Ok(());
        };
        if !Self::is_agent(context, &agent) {
            return Ok(());
        }
        let told = Self::tell(context, task, &agent);
        let id = task["id"].as_str().unwrap_or_default().to_owned();
        let snapshot = json!({"key": task["key"], "title": task["title"]});
        let session = told["session_id"].clone();
        self.change(context, "overlay", |overlay| {
            let kept = overlay.entry(id).or_insert_with(|| json!({}));
            kept["agent"] = json!(agent);
            kept["task"] = snapshot;
            if session.is_string() {
                let mut sessions = kept["sessions"].as_array().cloned().unwrap_or_default();
                if !sessions.contains(&session) {
                    sessions.push(session);
                }
                kept["sessions"] = json!(sessions);
            }
            Ok(())
        })?;
        task["told"] = told;
        context.publish("task.assigned", json!({"task": task}))?;
        Ok(())
    }
}

impl Extension for Projects {
    fn initialize(&self, _context: &Context) -> Result<Value, String> {
        let string = json!({"type": "string"});
        let id = json!({"id": string});
        let task_fields = json!({
            "title": string, "description": string,
            "status": {"enum": STATUSES}, "priority": {"enum": PRIORITIES},
            "assignee": {"type": ["string", "null"]},
            "labels": {"type": "array", "items": string},
            "due": {"type": ["string", "null"]},
        });
        let mut create_task = task_fields.clone();
        create_task["project_id"] = string.clone();
        let mut update_task = task_fields;
        update_task["id"] = string.clone();
        let task_shape = "{id, source, project_id, key, title, description, status, priority, labels, due, assignee, people, url, updated_at}";
        Ok(json!({
            "actions": [
                {"name": "trackers", "title": "Trackers",
                    "description": "The trackers there are, with what each asks to add a source of it"},
                {"name": "sources", "title": "Sources",
                    "description": "Where projects are: ZeroLux's own, and each tracker added, with its state"},
                {"name": "add_source", "title": "Add source",
                    "description": "Adds a tracker's workspace as a source, with its configuration; some ask the person to sign in at the address given",
                    "effects": "write",
                    "input": object(json!({"name": string, "tracker": string, "config": {"type": "object"}}), &["name", "tracker"])},
                {"name": "change_source", "title": "Change source",
                    "description": "Renames a source, or changes its configuration", "effects": "write",
                    "input": object(json!({"id": string, "name": string, "config": {"type": "object"}}), &["id"])},
                {"name": "sign_in", "title": "Sign in again",
                    "description": "The address where the person signs in to a source's tracker again",
                    "effects": "write", "input": object(id.clone(), &["id"])},
                {"name": "remove_source", "title": "Remove source",
                    "description": "Removes a source from ZeroLux; nothing is deleted in its tracker",
                    "effects": "destructive", "input": object(id.clone(), &["id"])},
                {"name": "signed_in", "title": "Signed in",
                    "description": "A tracker says a source's sign-in ended, and whether it worked",
                    "effects": "write",
                    "input": object(json!({"source": string, "ok": {"type": "boolean"}, "error": string,
                        "account": string}), &["source", "ok"])},
                {"name": "projects", "title": "Projects",
                    "description": "The projects of one source, or of all: each {id, source, key, name, description, archived, url}",
                    "input": object(json!({"source": string}), &[])},
                {"name": "create_project", "title": "New project",
                    "description": "Starts a project in a source that can", "effects": "write",
                    "input": object(json!({"source": string, "name": string, "key": string,
                        "description": string}), &["name"])},
                {"name": "update_project", "title": "Edit project",
                    "description": "Renames, describes or archives a project of ZeroLux's own", "effects": "write",
                    "input": object(json!({"id": string, "name": string, "description": string,
                        "archived": {"type": "boolean"}}), &["id"])},
                {"name": "tasks", "title": "Tasks",
                    "description": format!("A project's tasks, live from where it is; or with `assignee`, a person's or an agent's tasks in every source. Each {task_shape}"),
                    "input": object(json!({"project_id": string, "status": {"enum": STATUSES},
                        "assignee": string}), &[])},
                {"name": "task", "title": "Task", "description": "A task, with its comments",
                    "input": object(id.clone(), &["id"])},
                {"name": "create_task", "title": "New task", "description": "Adds a task to a project, where the project is",
                    "effects": "write", "input": object(create_task, &["project_id", "title"])},
                {"name": "update_task", "title": "Edit task",
                    "description": "Changes a task where it is: its state, priority, labels, due date; `assignee` gives it to a person or an agent here, or to an agent in a tracker",
                    "effects": "write", "input": object(update_task, &["id"])},
                {"name": "comment", "title": "Comment", "description": "Comments on a task, where it is",
                    "effects": "write",
                    "input": object(json!({"id": string, "text": string}), &["id", "text"])},
                {"name": "delete_task", "title": "Delete task", "description": "Deletes a task, where it is",
                    "effects": "destructive", "input": object(id, &["id"])},
            ],
            "points": [{"name": "trackers", "version": 2,
                "description": "Where projects are: a tracker shows and changes a workspace of a service, live, for each source of it",
                "operations": [
                    {"name": "describe", "description": "Its title, the fields a source of it asks for, whether the person signs in, and its capabilities"},
                    {"name": "connect", "description": "Takes a source's configuration, keeps its secrets, and gives what is shown of it and, to sign in, `sign_in.url`; when that sign-in ends, the tracker runs Projects' `signed_in`",
                        "input": object(json!({"source": string, "config": {"type": "object"}, "origin": string}), &["source", "config"])},
                    {"name": "check", "description": "Whether the source can be reached, and its `account`"},
                    {"name": "forget", "description": "Lets a removed source's secrets go"},
                    {"name": "projects", "description": "Its projects: each {id, key?, name, description?, url?}"},
                    {"name": "create_project", "description": "Starts a project"},
                    {"name": "tasks", "description": "A project's tasks: each {id, key, title, description, status, priority, labels, due, people, url, updated_at}",
                        "input": object(json!({"project": string}), &["project"])},
                    {"name": "task", "description": "A task, with its `comments`: each {id, author, text, at}",
                        "input": object(json!({"project": string, "task": string}), &["project", "task"])},
                    {"name": "create_task", "description": "Creates a task: the task",
                        "input": object(json!({"project": string, "task": {"type": "object"}}), &["project", "task"])},
                    {"name": "update_task", "description": "Changes a task: the task",
                        "input": object(json!({"project": string, "task": string, "changes": {"type": "object"}}), &["project", "task", "changes"])},
                    {"name": "comment", "description": "Comments on a task",
                        "input": object(json!({"project": string, "task": string, "text": string}), &["project", "task", "text"])},
                    {"name": "delete_task", "description": "Deletes a task",
                        "input": object(json!({"project": string, "task": string}), &["project", "task"])},
                ]}],
            "implements": [{"point": TRACKERS, "name": LOCAL, "title": "ZeroLux"}],
            "events": [
                {"name": "task.created", "description": "A task was added"},
                {"name": "task.updated", "description": "A task changed"},
                {"name": "task.assigned", "description": "A task was given to a person or an agent"},
                {"name": "changed", "description": "Sources, projects or tasks changed"},
            ],
            "ui": [
                {"space": "page", "name": "projects", "title": "Projects", "icon": "kanban",
                    "view": {"kind": "native", "entry": "ui/native/projects.js"}},
                {"space": "session", "name": "tasks", "title": "Tasks", "icon": "list-checks",
                    "view": {"kind": "native", "entry": "ui/native/tasks.js"}},
            ],
        }))
    }

    fn action(
        &self,
        context: &Context,
        name: &str,
        input: Value,
        caller: Caller,
    ) -> Result<Value, String> {
        let text = |key: &str| input[key].as_str().unwrap_or_default().to_owned();
        let changed = || context.publish("changed", json!({}));
        match name {
            "trackers" => Ok(json!({"trackers": self.trackers(context)?})),
            "sources" => {
                let trackers = self.trackers(context)?;
                let mut sources: Vec<Value> = self
                    .sources(context)?
                    .into_values()
                    .map(|mut source| {
                        let tracker = source["tracker"].as_str().unwrap_or(LOCAL).to_owned();
                        let described = if tracker == LOCAL {
                            self.describe(context, LOCAL)
                        } else {
                            trackers
                                .iter()
                                .find(|known| known["tracker"] == tracker.as_str())
                                .cloned()
                                .unwrap_or_default()
                        };
                        source["available"] = json!(tracker == LOCAL || !described.is_null());
                        source["capabilities"] = described["capabilities"].clone();
                        source
                    })
                    .collect();
                sources.sort_by_key(|source| source["created_at"].as_i64());
                Ok(json!({"sources": sources}))
            }
            "add_source" | "change_source" | "sign_in" | "remove_source" if !person(&caller) => {
                Err("Only a person adds, changes and removes sources".into())
            }
            "add_source" => {
                let name = text_of(&input["name"], 200, "A source's name")?;
                if name.is_empty() {
                    return Err("Name the source".into());
                }
                let tracker = text("tracker");
                if tracker == LOCAL
                    || !self
                        .trackers(context)?
                        .iter()
                        .any(|known| known["tracker"] == tracker.as_str())
                {
                    return Err(format!("No tracker `{tracker}`"));
                }
                self.sources(context)?;
                let id = uuid::Uuid::new_v4().simple().to_string();
                let mut source = json!({"id": id, "name": name, "tracker": tracker,
                    "config": {}, "created_at": now_ms()});
                let connected = self.connect(context, &caller, &source, input["config"].clone())?;
                source["config"] = connected["config"].clone();
                source["account"] = connected["account"].clone();
                let sign_in = connected["sign_in"].clone();
                source["signed_in"] = json!(sign_in.is_null());
                self.change(context, "sources", |sources| {
                    sources.insert(id.clone(), source.clone());
                    Ok(())
                })?;
                changed()?;
                Ok(json!({"source": source, "sign_in": sign_in}))
            }
            "change_source" => {
                let source = self.source(context, &text("id"))?;
                let renamed = match input["name"].as_str() {
                    Some(name) => {
                        let name = text_of(&json!(name), 200, "A source's name")?;
                        if name.is_empty() {
                            return Err("Name the source".into());
                        }
                        Some(name)
                    }
                    None => None,
                };
                let connected = if input["config"].is_object() && source["tracker"] != LOCAL {
                    Some(self.connect(context, &caller, &source, input["config"].clone())?)
                } else {
                    None
                };
                let id = source["id"].as_str().unwrap_or_default().to_owned();
                let kept = self.change(context, "sources", |sources| {
                    let kept = sources.get_mut(&id).ok_or("No such source")?;
                    if let Some(name) = renamed {
                        kept["name"] = json!(name);
                    }
                    if let Some(connected) = &connected {
                        kept["config"] = connected["config"].clone();
                        kept["account"] = connected["account"].clone();
                        kept["error"] = Value::Null;
                        kept["signed_in"] = json!(connected["sign_in"].is_null());
                    }
                    Ok(kept.clone())
                })?;
                changed()?;
                Ok(json!({"source": kept,
                    "sign_in": connected.map(|connected| connected["sign_in"].clone())}))
            }
            "sign_in" => {
                let source = self.source(context, &text("id"))?;
                if source["tracker"] == LOCAL {
                    return Err("ZeroLux's own source needs no sign-in".into());
                }
                let connected =
                    self.connect(context, &caller, &source, json!({"sign_in_again": true}))?;
                Ok(json!({"sign_in": connected["sign_in"]}))
            }
            "remove_source" => {
                let source = self.source(context, &text("id"))?;
                if source["own"] == true {
                    return Err("ZeroLux's own source stays".into());
                }
                let id = source["id"].as_str().unwrap_or_default().to_owned();
                let _ = self.track(context, &source, "forget", json!({}), &caller);
                self.change(context, "sources", |sources| {
                    sources.remove(&id);
                    Ok(())
                })?;
                let prefix = format!("{id}:");
                self.change(context, "overlay", |overlay| {
                    overlay.retain(|task, _| !task.starts_with(&prefix));
                    Ok(())
                })?;
                changed()?;
                Ok(json!({"removed": id}))
            }
            // Only a tracker says so, for a source of its own.
            "signed_in" => {
                let source = self.source(context, &text("source"))?;
                let by = caller["by"].as_str().unwrap_or_default();
                let implementations =
                    context.ask("points.implementations", json!({"point": TRACKERS}))?;
                let its = implementations["implementations"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|known| known["extension"] == by && known["name"] == source["tracker"]);
                if !its {
                    return Err("Only the source's tracker says it signed in".into());
                }
                let id = source["id"].as_str().unwrap_or_default().to_owned();
                let ok = input["ok"] == true;
                let error = input["error"].as_str().map(str::to_owned);
                let account = input["account"].clone();
                self.change(context, "sources", |sources| {
                    let kept = sources.get_mut(&id).ok_or("No such source")?;
                    kept["signed_in"] = json!(ok);
                    kept["error"] = if ok { Value::Null } else { json!(error) };
                    if account.is_string() {
                        kept["account"] = account.clone();
                    }
                    Ok(())
                })?;
                changed()?;
                Ok(json!({}))
            }
            "projects" => {
                let sources: Vec<Value> = match input["source"].as_str().filter(|s| !s.is_empty()) {
                    Some(named) => vec![self.source(context, named)?],
                    None => self.sources(context)?.into_values().collect(),
                };
                let mut projects = Vec::new();
                let mut errors = Vec::new();
                for source in &sources {
                    match self.track(context, source, "projects", json!({}), &caller) {
                        Ok(listed) => {
                            for mut project in
                                listed["projects"].as_array().cloned().unwrap_or_default()
                            {
                                let native = project["id"].as_str().unwrap_or_default().to_owned();
                                project["id"] = json!(project_ref(
                                    source["id"].as_str().unwrap_or_default(),
                                    &native
                                ));
                                project["source"] = source["id"].clone();
                                if project["archived"].is_null() {
                                    project["archived"] = json!(false);
                                }
                                projects.push(project);
                            }
                        }
                        Err(error) => errors.push(json!({"source": source["id"], "error": error})),
                    }
                }
                Ok(json!({"projects": projects, "errors": errors}))
            }
            "create_project" => {
                let source = match input["source"].as_str().filter(|s| !s.is_empty()) {
                    Some(named) => self.source(context, named)?,
                    None => self
                        .sources(context)?
                        .into_values()
                        .find(|source| source["tracker"] == LOCAL)
                        .ok_or("No source")?,
                };
                if !self.capable(context, &source, "create_project") {
                    return Err("This tracker's projects are started there".into());
                }
                let mut project =
                    self.track(context, &source, "create_project", input.clone(), &caller)?;
                let native = project["id"].as_str().unwrap_or_default().to_owned();
                project["id"] = json!(project_ref(
                    source["id"].as_str().unwrap_or_default(),
                    &native
                ));
                project["source"] = source["id"].clone();
                changed()?;
                Ok(project)
            }
            "update_project" => {
                let (source_id, project) = split_project(&text("id"))?;
                let source = self.source(context, &source_id)?;
                if !self.capable(context, &source, "edit_project") {
                    return Err("This tracker's projects are changed there".into());
                }
                let mut asked = input.clone();
                asked["project"] = json!(project);
                let mut changed_project =
                    self.track(context, &source, "update_project", asked, &caller)?;
                changed_project["id"] = json!(project_ref(&source_id, &project));
                changed_project["source"] = json!(source_id);
                changed()?;
                Ok(changed_project)
            }
            "tasks" => {
                let overlay = Self::read_map(context, "overlay")?;
                let status = input["status"].as_str().filter(|s| !s.is_empty());
                let mut tasks = Vec::new();
                if let Some(project_id) = input["project_id"].as_str().filter(|p| !p.is_empty()) {
                    let (source_id, project) = split_project(project_id)?;
                    let source = self.source(context, &source_id)?;
                    let listed = self.track(
                        context,
                        &source,
                        "tasks",
                        json!({"project": project}),
                        &caller,
                    )?;
                    for task in listed["tasks"].as_array().cloned().unwrap_or_default() {
                        tasks.push(Self::shown_task(&overlay, &source, &project, task));
                    }
                } else if let Some(assignee) = input["assignee"].as_str().filter(|a| !a.is_empty())
                {
                    // A person's or an agent's work in every source: ZeroLux's own projects,
                    // and each tracker's task given to it here, read live.
                    let sources = self.sources(context)?;
                    for source in sources.values().filter(|source| source["tracker"] == LOCAL) {
                        let listed = self.track(context, source, "projects", json!({}), &caller)?;
                        for project in listed["projects"].as_array().cloned().unwrap_or_default() {
                            let native = project["id"].as_str().unwrap_or_default().to_owned();
                            let listed = self.track(
                                context,
                                source,
                                "tasks",
                                json!({"project": native}),
                                &caller,
                            )?;
                            for task in listed["tasks"].as_array().cloned().unwrap_or_default() {
                                if task["assignee"] == assignee {
                                    tasks.push(Self::shown_task(&overlay, source, &native, task));
                                }
                            }
                        }
                    }
                    for (id, kept) in &overlay {
                        if kept["agent"] != assignee || kept["deleted"] == true {
                            continue;
                        }
                        let Ok((source_id, project, task)) = split_task(id) else {
                            continue;
                        };
                        // ZeroLux's own tasks were read above.
                        let Some(source) = sources
                            .get(&source_id)
                            .filter(|source| source["tracker"] != LOCAL)
                        else {
                            continue;
                        };
                        match self.track(
                            context,
                            source,
                            "task",
                            json!({"project": project, "task": task}),
                            &caller,
                        ) {
                            Ok(mut found) => {
                                found.as_object_mut().map(|found| found.remove("comments"));
                                tasks.push(Self::shown_task(&overlay, source, &project, found));
                            }
                            // Gone where it was: its history stays, marked so.
                            Err(error)
                                if error.to_lowercase().contains("not found")
                                    || error.contains("404") =>
                            {
                                let id = id.clone();
                                let _ = self.change(context, "overlay", |overlay| {
                                    if let Some(kept) = overlay.get_mut(&id) {
                                        kept["deleted"] = json!(true);
                                    }
                                    Ok(())
                                });
                            }
                            Err(_) => {}
                        }
                    }
                } else {
                    return Err("Choose a project, or whose tasks".into());
                }
                tasks.retain(|task| status.is_none_or(|status| task["status"] == status));
                tasks.sort_by(|a, b| b["updated_at"].as_i64().cmp(&a["updated_at"].as_i64()));
                Ok(json!({"tasks": tasks}))
            }
            "task" => {
                let (source_id, project, task) = split_task(&text("id"))?;
                let source = self.source(context, &source_id)?;
                let overlay = Self::read_map(context, "overlay")?;
                let found = self.track(
                    context,
                    &source,
                    "task",
                    json!({"project": project, "task": task}),
                    &caller,
                )?;
                let mut shown = Self::shown_task(&overlay, &source, &project, found);
                if let Some(kept) = overlay.get(&text("id")) {
                    shown["sessions"] = kept["sessions"].clone();
                }
                Ok(shown)
            }
            "create_task" => {
                let (source_id, project) = split_project(&text("project_id"))?;
                let source = self.source(context, &source_id)?;
                let local = source["tracker"] == LOCAL;
                let mut fields = local::task_fields(&input, None)?;
                // In a tracker, the agent is ZeroLux's; the task goes there without it.
                let assignee = fields["assignee"].as_str().map(str::to_owned);
                if !local {
                    if let Some(assignee) = &assignee
                        && !Self::is_agent(context, assignee)
                    {
                        return Err("In a tracker, people are given tasks there".into());
                    }
                    fields
                        .as_object_mut()
                        .map(|fields| fields.remove("assignee"));
                }
                let created = self.track(
                    context,
                    &source,
                    "create_task",
                    json!({"project": project, "task": fields}),
                    &caller,
                )?;
                let overlay = Self::read_map(context, "overlay")?;
                let mut task = Self::shown_task(&overlay, &source, &project, created);
                if !local {
                    task["assignee"] = json!(assignee);
                }
                context.publish("task.created", json!({"task": task}))?;
                if task["assignee"].is_string() {
                    self.assigned(context, &mut task)?;
                }
                changed()?;
                Ok(task)
            }
            "update_task" => {
                let id = text("id");
                let (source_id, project, native) = split_task(&id)?;
                let source = self.source(context, &source_id)?;
                let local = source["tracker"] == LOCAL;
                let mut changes = local::task_fields(&input, Some(&json!({})))?;
                let assignee = changes
                    .as_object_mut()
                    .and_then(|fields| (!local).then(|| fields.remove("assignee")).flatten());
                if let Some(Value::String(agent)) = &assignee
                    && !Self::is_agent(context, agent)
                {
                    return Err("In a tracker, people are given tasks there".into());
                }
                let before = if local {
                    self.track(
                        context,
                        &source,
                        "task",
                        json!({"project": project, "task": native}),
                        &caller,
                    )
                    .ok()
                    .map(|task| task["assignee"].clone())
                } else {
                    None
                };
                let updated = if changes.as_object().is_some_and(|fields| !fields.is_empty()) {
                    self.track(
                        context,
                        &source,
                        "update_task",
                        json!({"project": project, "task": native, "changes": changes}),
                        &caller,
                    )?
                } else {
                    self.track(
                        context,
                        &source,
                        "task",
                        json!({"project": project, "task": native}),
                        &caller,
                    )?
                };
                // The agent of a tracker's task is ZeroLux's to keep.
                if let Some(assignee) = &assignee {
                    let agent = assignee.clone();
                    let snapshot = json!({"key": updated["key"], "title": updated["title"]});
                    self.change(context, "overlay", |overlay| {
                        if agent.is_null() {
                            if let Some(kept) = overlay.get_mut(&id) {
                                kept["agent"] = Value::Null;
                            }
                        } else {
                            let kept = overlay.entry(id.clone()).or_insert_with(|| json!({}));
                            kept["agent"] = agent;
                            kept["task"] = snapshot;
                        }
                        Ok(())
                    })?;
                }
                let overlay = Self::read_map(context, "overlay")?;
                let mut task = Self::shown_task(&overlay, &source, &project, updated);
                task.as_object_mut().map(|task| task.remove("comments"));
                context.publish("task.updated", json!({"task": task}))?;
                let newly = match (&assignee, &before) {
                    (Some(Value::String(_)), _) => true,
                    (None, Some(before)) => {
                        input.get("assignee").is_some()
                            && task["assignee"] != *before
                            && task["assignee"].is_string()
                    }
                    _ => false,
                };
                if newly {
                    self.assigned(context, &mut task)?;
                }
                changed()?;
                Ok(task)
            }
            "comment" => {
                let (source_id, project, task) = split_task(&text("id"))?;
                let source = self.source(context, &source_id)?;
                if !self.capable(context, &source, "comments") {
                    return Err("This tracker takes no comments".into());
                }
                let comment = self.track(
                    context,
                    &source,
                    "comment",
                    json!({"project": project, "task": task, "text": input["text"]}),
                    &caller,
                )?;
                changed()?;
                Ok(comment)
            }
            "delete_task" => {
                let id = text("id");
                let (source_id, project, task) = split_task(&id)?;
                let source = self.source(context, &source_id)?;
                if !self.capable(context, &source, "delete") {
                    return Err("This tracker's tasks are deleted there".into());
                }
                self.track(
                    context,
                    &source,
                    "delete_task",
                    json!({"project": project, "task": task}),
                    &caller,
                )?;
                self.change(context, "overlay", |overlay| {
                    if let Some(kept) = overlay.get_mut(&id) {
                        kept["deleted"] = json!(true);
                    }
                    Ok(())
                })?;
                changed()?;
                Ok(json!({"deleted": id}))
            }
            other => Err(format!("No action `{other}`")),
        }
    }

    fn point(
        &self,
        context: &Context,
        point: &str,
        implementation: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, String> {
        if point != TRACKERS || implementation != LOCAL {
            return Err(format!("No implementation of {point} `{implementation}`"));
        }
        let _held = self.held.lock().map_err(|_| "Projects is unavailable")?;
        local::operation(context, operation, &input, &Value::Null)
    }
}

zerolux_extension::export!(Projects::default);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_states_and_dates_are_checked() {
        assert_eq!(local::clean_key("zl").unwrap(), "ZL");
        assert!(local::clean_key("1A").is_err());
        assert!(local::clean_key("A").is_err());
        let fields = local::task_fields(
            &json!({"title": "T", "status": "todo", "labels": [" ui ", ""]}),
            None,
        )
        .unwrap();
        assert_eq!(fields["status"], "todo");
        assert_eq!(fields["priority"], "none");
        assert_eq!(fields["labels"], json!(["ui"]));
        assert!(local::task_fields(&json!({"title": "T", "status": "lost"}), None).is_err());
        assert!(local::task_fields(&json!({"title": "T", "due": "tomorrow"}), None).is_err());
        let only = local::task_fields(&json!({"priority": "high"}), Some(&json!({}))).unwrap();
        assert_eq!(only, json!({"priority": "high"}));
    }

    #[test]
    fn ids_name_their_source_project_and_task() {
        assert_eq!(task_ref("s", "p", "t:1"), "s:p:t:1");
        assert_eq!(
            split_task("s:p:t:1").unwrap(),
            ("s".into(), "p".into(), "t:1".into())
        );
        assert!(split_task("s:p").is_err());
        assert_eq!(split_project("s:p").unwrap(), ("s".into(), "p".into()));
    }
}
