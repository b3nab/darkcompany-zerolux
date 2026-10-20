//! ZeroLux's Projects, a kernel module: the workspace's work as projects and their tasks, with
//! states, priorities, labels, due dates, comments, and people or agents assigned. A project is
//! kept here, or in a tracker: Projects opens `zerolux.projects/trackers@1`, which other
//! extensions implement for Plane, Linear, ClickUp and others; a tracked project's tasks are
//! created, changed and commented there, and read back from it.

use std::{collections::BTreeMap, sync::Mutex};

use zerolux_extension::{Caller, Context, Extension, Value, json, serde_json};

/// The point trackers implement.
pub const TRACKERS: &str = "zerolux.projects/trackers@1";
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
    /// Changes go one at a time.
    work: Mutex<()>,
}

/// What Projects keeps: its projects and tasks, by id.
#[derive(Default)]
struct Work {
    projects: BTreeMap<String, Value>,
    tasks: BTreeMap<String, Value>,
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type": "object", "properties": properties, "required": required})
}

fn now_ms() -> i64 {
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

/// A project's key, such as `ZL`: 2 to 10 capital letters and digits, starting with a letter.
fn clean_key(key: &str) -> Result<String, String> {
    let key = key.trim().to_ascii_uppercase();
    if !(2..=10).contains(&key.len())
        || !key.starts_with(|c: char| c.is_ascii_uppercase())
        || !key
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
    {
        return Err("A project's key is 2 to 10 letters and digits, starting with a letter".into());
    }
    Ok(key)
}

fn text_of(value: &Value, limit: usize, what: &str) -> Result<String, String> {
    let text = value.as_str().unwrap_or_default().trim().to_owned();
    if text.len() > limit {
        return Err(format!("{what} is up to {limit} bytes"));
    }
    Ok(text)
}

fn choice(value: &Value, allowed: &[&str], what: &str) -> Result<String, String> {
    let chosen = value.as_str().unwrap_or_default();
    if allowed.contains(&chosen) {
        Ok(chosen.to_owned())
    } else {
        Err(format!("{what} is one of {}", allowed.join(", ")))
    }
}

impl Projects {
    fn read(context: &Context) -> Result<Work, String> {
        let parse = |value: Value| -> Result<BTreeMap<String, Value>, String> {
            if value.is_null() {
                return Ok(BTreeMap::new());
            }
            serde_json::from_value(value).map_err(|error| error.to_string())
        };
        Ok(Work {
            projects: parse(context.get_value("projects")?)?,
            tasks: parse(context.get_value("tasks")?)?,
        })
    }

    /// Changes the work, keeps it, and publishes what happened.
    fn change<T>(
        &self,
        context: &Context,
        change: impl FnOnce(&mut Work) -> Result<(T, Vec<(&'static str, Value)>), String>,
    ) -> Result<T, String> {
        let _held = self.work.lock().map_err(|_| "Projects is unavailable")?;
        let mut work = Self::read(context)?;
        let (result, events) = change(&mut work)?;
        context.set_value("projects", json!(work.projects))?;
        context.set_value("tasks", json!(work.tasks))?;
        for (event, payload) in events {
            context.publish(event, payload)?;
        }
        Ok(result)
    }

    /// Tells an agent a task is now its own, in its running session; a person is told by the
    /// apps. Whether an agent heard it: the session it went to, or why not.
    fn tell(context: &Context, task: &Value) -> Value {
        let Some(assignee) = task["assignee"].as_str() else {
            return Value::Null;
        };
        let agent = context.workspace().ok().is_some_and(|workspace| {
            workspace["actors"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|actor| actor["id"] == assignee && actor["kind"] == "agent")
        });
        if !agent {
            return Value::Null;
        }
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
        match context.tell_agent(assignee, &text) {
            Ok(session) => json!({"session_id": session}),
            Err(error) => json!({"error": error}),
        }
    }

    /// The tracker a project's tasks are kept in, and its id there; none for a local one.
    fn tracker(project: &Value) -> Option<(String, String)> {
        Some((
            project["tracker"].as_str()?.to_owned(),
            project["remote_id"].as_str()?.to_owned(),
        ))
    }
}

impl Extension for Projects {
    fn initialize(&self, _context: &Context) -> Result<Value, String> {
        let id = json!({"id": {"type": "string"}});
        let task_fields = json!({
            "title": {"type": "string"}, "description": {"type": "string"},
            "status": {"enum": STATUSES}, "priority": {"enum": PRIORITIES},
            "assignee": {"type": ["string", "null"]},
            "labels": {"type": "array", "items": {"type": "string"}},
            "due": {"type": ["string", "null"]},
        });
        let mut create_task = task_fields.clone();
        create_task["project_id"] = json!({"type": "string"});
        let mut update_task = task_fields;
        update_task["id"] = json!({"type": "string"});
        Ok(json!({
            "actions": [
                {"name": "projects", "title": "Projects", "description": "The workspace's projects"},
                {"name": "create_project", "title": "New project", "description": "Starts a project, here or in a tracker",
                    "effects": "write",
                    "input": object(json!({"name": {"type": "string"}, "key": {"type": "string"},
                        "description": {"type": "string"}, "tracker": {"type": "string"},
                        "remote_id": {"type": "string"}}), &["name", "key"])},
                {"name": "update_project", "title": "Edit project", "description": "Renames, describes or archives a project",
                    "effects": "write",
                    "input": object(json!({"id": {"type": "string"}, "name": {"type": "string"},
                        "description": {"type": "string"}, "archived": {"type": "boolean"}}), &["id"])},
                {"name": "tasks", "title": "Tasks", "description": "Tasks, by project, state or assignee",
                    "input": object(json!({"project_id": {"type": "string"}, "status": {"enum": STATUSES},
                        "assignee": {"type": "string"}}), &[])},
                {"name": "task", "title": "Task", "description": "A task, with its comments",
                    "input": object(id.clone(), &["id"])},
                {"name": "create_task", "title": "New task", "description": "Adds a task to a project", "effects": "write",
                    "input": object(create_task, &["project_id", "title"])},
                {"name": "update_task", "title": "Edit task", "description": "Changes a task: its state, priority, assignee and the rest",
                    "effects": "write", "input": object(update_task, &["id"])},
                {"name": "comment", "title": "Comment", "description": "Comments on a task", "effects": "write",
                    "input": object(json!({"id": {"type": "string"}, "text": {"type": "string"}}), &["id", "text"])},
                {"name": "delete_task", "title": "Delete task", "description": "Deletes a task", "effects": "destructive",
                    "input": object(id, &["id"])},
                {"name": "refresh", "title": "Refresh", "description": "Reads a tracked project's tasks again from its tracker",
                    "effects": "write", "seconds": 300,
                    "input": object(json!({"project_id": {"type": "string"}}), &["project_id"])},
            ],
            "points": [{"name": "trackers", "version": 1,
                "description": "Where a project's tasks are kept, outside ZeroLux",
                "operations": [
                    {"name": "projects", "description": "The tracker's projects, each {remote_id, name}"},
                    {"name": "tasks", "description": "A project's tasks, each {remote_id, title, description, status, priority, labels, due, url}",
                        "input": object(json!({"remote_id": {"type": "string"}}), &["remote_id"])},
                    {"name": "create", "description": "Creates a task; its {remote_id, url}",
                        "input": object(json!({"remote_id": {"type": "string"}, "task": {"type": "object"}}), &["remote_id", "task"])},
                    {"name": "update", "description": "Changes a task",
                        "input": object(json!({"remote_id": {"type": "string"}, "task_id": {"type": "string"},
                            "changes": {"type": "object"}}), &["remote_id", "task_id", "changes"])},
                    {"name": "comment", "description": "Comments on a task",
                        "input": object(json!({"remote_id": {"type": "string"}, "task_id": {"type": "string"},
                            "text": {"type": "string"}}), &["remote_id", "task_id", "text"])},
                ]}],
            "events": [
                {"name": "task.created", "description": "A task was added"},
                {"name": "task.updated", "description": "A task changed"},
                {"name": "task.assigned", "description": "A task was given to a person or an agent"},
                {"name": "changed", "description": "Projects or tasks changed"},
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
        let id = input["id"].as_str().unwrap_or_default().to_owned();
        match name {
            "projects" => {
                let projects: Vec<Value> = Self::read(context)?.projects.into_values().collect();
                Ok(json!({"projects": projects}))
            }
            "create_project" => {
                let name = text_of(&input["name"], 200, "A project's name")?;
                if name.is_empty() {
                    return Err("Name the project".into());
                }
                let key = clean_key(input["key"].as_str().unwrap_or_default())?;
                let tracker = input["tracker"].as_str().filter(|name| !name.is_empty());
                let remote = input["remote_id"].as_str().filter(|id| !id.is_empty());
                if tracker.is_some() != remote.is_some() {
                    return Err("A tracked project names its tracker and its id there".into());
                }
                let project = json!({"id": uuid::Uuid::new_v4().to_string(), "key": key,
                    "name": name, "description": text_of(&input["description"], 10_000, "A description")?,
                    "tracker": tracker, "remote_id": remote, "archived": false,
                    "next": 1, "created_by": who(&caller), "created_at": now_ms()});
                let project = self.change(context, |work| {
                    if work.projects.values().any(|known| known["key"] == key) {
                        return Err(format!("A project already has the key {key}"));
                    }
                    work.projects.insert(
                        project["id"].as_str().unwrap_or_default().to_owned(),
                        project.clone(),
                    );
                    Ok((project, vec![("changed", json!({}))]))
                })?;
                if project["tracker"].is_string() {
                    self.action(
                        context,
                        "refresh",
                        json!({"project_id": project["id"]}),
                        caller,
                    )?;
                }
                Ok(project)
            }
            "update_project" => self.change(context, |work| {
                let project = work.projects.get_mut(&id).ok_or("No such project")?;
                if input.get("name").is_some() {
                    let name = text_of(&input["name"], 200, "A project's name")?;
                    if name.is_empty() {
                        return Err("Name the project".into());
                    }
                    project["name"] = json!(name);
                }
                if input.get("description").is_some() {
                    project["description"] =
                        json!(text_of(&input["description"], 10_000, "A description")?);
                }
                if let Some(archived) = input["archived"].as_bool() {
                    project["archived"] = json!(archived);
                }
                Ok((project.clone(), vec![("changed", json!({}))]))
            }),
            "tasks" => {
                let work = Self::read(context)?;
                let mut tasks: Vec<Value> = work
                    .tasks
                    .into_values()
                    .filter(|task| {
                        ["project_id", "status", "assignee"].iter().all(|key| {
                            input[*key]
                                .as_str()
                                .is_none_or(|wanted| task[*key] == wanted)
                        })
                    })
                    .map(|mut task| {
                        // Comments are read with the task.
                        task.as_object_mut().map(|task| task.remove("comments"));
                        task
                    })
                    .collect();
                tasks.sort_by(|a, b| b["updated_at"].as_i64().cmp(&a["updated_at"].as_i64()));
                Ok(json!({"tasks": tasks}))
            }
            "task" => Self::read(context)?
                .tasks
                .remove(&id)
                .ok_or_else(|| "No such task".into()),
            "create_task" => {
                let project_id = input["project_id"].as_str().unwrap_or_default().to_owned();
                let title = text_of(&input["title"], 500, "A task's title")?;
                if title.is_empty() {
                    return Err("Give the task a title".into());
                }
                let fields = task_fields(&input, None)?;
                let project = Self::read(context)?
                    .projects
                    .remove(&project_id)
                    .ok_or("No such project")?;
                // A tracked project's task is created in its tracker first.
                let remote = match Self::tracker(&project) {
                    Some((tracker, remote_id)) => Some(context.call(
                        TRACKERS,
                        &tracker,
                        "create",
                        json!({"remote_id": remote_id, "task": {"title": title, "description": fields["description"],
                            "status": fields["status"], "priority": fields["priority"],
                            "labels": fields["labels"], "due": fields["due"]}}),
                    )?),
                    None => None,
                };
                let mut task = self.change(context, |work| {
                    let project = work
                        .projects
                        .get_mut(&project_id)
                        .ok_or("No such project")?;
                    let number = project["next"].as_i64().unwrap_or(1);
                    project["next"] = json!(number + 1);
                    let now = now_ms();
                    let mut task = json!({"id": uuid::Uuid::new_v4().to_string(),
                        "key": format!("{}-{number}", project["key"].as_str().unwrap_or_default()),
                        "number": number, "project_id": project_id, "title": title,
                        "created_by": who(&caller), "created_at": now, "updated_at": now,
                        "remote_id": remote.as_ref().map(|remote| remote["remote_id"].clone()),
                        "url": remote.as_ref().map(|remote| remote["url"].clone()),
                        "comments": []});
                    for (key, value) in fields.as_object().into_iter().flatten() {
                        task[key] = value.clone();
                    }
                    work.tasks.insert(
                        task["id"].as_str().unwrap_or_default().to_owned(),
                        task.clone(),
                    );
                    let mut events = vec![
                        ("task.created", json!({"task": task})),
                        ("changed", json!({})),
                    ];
                    if task["assignee"].is_string() {
                        events.push(("task.assigned", json!({"task": task})));
                    }
                    Ok((task, events))
                })?;
                task["told"] = Self::tell(context, &task);
                Ok(task)
            }
            "update_task" => {
                let work = Self::read(context)?;
                let task = work.tasks.get(&id).ok_or("No such task")?;
                let changes = task_fields(&input, Some(task))?;
                if input.get("title").is_some() {
                    let title = text_of(&input["title"], 500, "A task's title")?;
                    if title.is_empty() {
                        return Err("Give the task a title".into());
                    }
                }
                let project = work
                    .projects
                    .get(task["project_id"].as_str().unwrap_or_default());
                if let (Some((tracker, remote_id)), Some(task_id)) =
                    (project.and_then(Self::tracker), task["remote_id"].as_str())
                {
                    let mut sent = changes.clone();
                    if let Some(title) = input["title"].as_str() {
                        sent["title"] = json!(title.trim());
                    }
                    context.call(
                        TRACKERS,
                        &tracker,
                        "update",
                        json!({"remote_id": remote_id, "task_id": task_id, "changes": sent}),
                    )?;
                }
                let (mut task, assigned) = self.change(context, |work| {
                    let task = work.tasks.get_mut(&id).ok_or("No such task")?;
                    let assigned = changes.get("assignee").is_some_and(|assignee| {
                        assignee.is_string() && *assignee != task["assignee"]
                    });
                    for (key, value) in changes.as_object().into_iter().flatten() {
                        task[key] = value.clone();
                    }
                    if let Some(title) = input["title"].as_str() {
                        task["title"] = json!(title.trim());
                    }
                    task["updated_at"] = json!(now_ms());
                    let task = task.clone();
                    let mut events = vec![
                        ("task.updated", json!({"task": task})),
                        ("changed", json!({})),
                    ];
                    if assigned {
                        events.push(("task.assigned", json!({"task": task})));
                    }
                    Ok(((task, assigned), events))
                })?;
                if assigned {
                    task["told"] = Self::tell(context, &task);
                }
                Ok(task)
            }
            "comment" => {
                let text = text_of(&input["text"], 20_000, "A comment")?;
                if text.is_empty() {
                    return Err("Write the comment".into());
                }
                let work = Self::read(context)?;
                let task = work.tasks.get(&id).ok_or("No such task")?;
                let project = work
                    .projects
                    .get(task["project_id"].as_str().unwrap_or_default());
                if let (Some((tracker, remote_id)), Some(task_id)) =
                    (project.and_then(Self::tracker), task["remote_id"].as_str())
                {
                    context.call(
                        TRACKERS,
                        &tracker,
                        "comment",
                        json!({"remote_id": remote_id, "task_id": task_id, "text": text}),
                    )?;
                }
                self.change(context, |work| {
                    let task = work.tasks.get_mut(&id).ok_or("No such task")?;
                    let comment = json!({"id": uuid::Uuid::new_v4().to_string(), "by": who(&caller),
                        "text": text, "at": now_ms()});
                    match task["comments"].as_array_mut() {
                        Some(comments) => comments.push(comment.clone()),
                        None => task["comments"] = json!([comment.clone()]),
                    }
                    task["updated_at"] = json!(now_ms());
                    Ok((
                        comment,
                        vec![
                            ("task.updated", json!({"task": task.clone()})),
                            ("changed", json!({})),
                        ],
                    ))
                })
            }
            "delete_task" => self.change(context, |work| {
                work.tasks.remove(&id).ok_or("No such task")?;
                Ok((json!({"deleted": id}), vec![("changed", json!({}))]))
            }),
            "refresh" => {
                let project_id = input["project_id"].as_str().unwrap_or_default().to_owned();
                let project = Self::read(context)?
                    .projects
                    .remove(&project_id)
                    .ok_or("No such project")?;
                let (tracker, remote_id) =
                    Self::tracker(&project).ok_or("The project is kept here, not in a tracker")?;
                let listed =
                    context.call(TRACKERS, &tracker, "tasks", json!({"remote_id": remote_id}))?;
                let remote: Vec<Value> = listed["tasks"].as_array().cloned().unwrap_or_default();
                self.change(context, |work| {
                    let project = work.projects.get_mut(&project_id).ok_or("No such project")?;
                    let key = project["key"].as_str().unwrap_or_default().to_owned();
                    let mut next = project["next"].as_i64().unwrap_or(1);
                    let now = now_ms();
                    let mut read = 0;
                    for found in &remote {
                        let Some(remote_task) = found["remote_id"].as_str() else { continue };
                        let known = work.tasks.values_mut().find(|task| {
                            task["project_id"] == project_id.as_str() && task["remote_id"] == remote_task
                        });
                        let task = match known {
                            Some(task) => task,
                            None => {
                                let id = uuid::Uuid::new_v4().to_string();
                                work.tasks.insert(id.clone(), json!({"id": id, "key": format!("{key}-{next}"),
                                    "number": next, "project_id": project_id, "remote_id": remote_task,
                                    "created_at": now, "comments": [], "assignee": null, "created_by": null}));
                                next += 1;
                                work.tasks.get_mut(&id).expect("just kept")
                            }
                        };
                        for field in ["title", "description", "status", "priority", "labels", "due", "url"] {
                            if let Some(value) = found.get(field) {
                                task[field] = value.clone();
                            }
                        }
                        task["updated_at"] = json!(now);
                        read += 1;
                    }
                    project["next"] = json!(next);
                    Ok((json!({"read": read}), vec![("changed", json!({}))]))
                })
            }
            other => Err(format!("No action `{other}`")),
        }
    }
}

/// The task's fields an input sets, checked; with `current`, only those it names.
fn task_fields(input: &Value, current: Option<&Value>) -> Result<Value, String> {
    let mut fields = serde_json::Map::new();
    let given = |key: &str| current.is_none() || input.get(key).is_some();
    if given("description") {
        fields.insert(
            "description".into(),
            json!(text_of(&input["description"], 50_000, "A description")?),
        );
    }
    if given("status") {
        let status = if input["status"].is_null() {
            json!("backlog")
        } else {
            input["status"].clone()
        };
        fields.insert(
            "status".into(),
            json!(choice(&status, &STATUSES, "A task's state")?),
        );
    }
    if given("priority") {
        let priority = if input["priority"].is_null() {
            json!("none")
        } else {
            input["priority"].clone()
        };
        fields.insert(
            "priority".into(),
            json!(choice(&priority, &PRIORITIES, "A task's priority")?),
        );
    }
    if given("assignee") {
        fields.insert(
            "assignee".into(),
            input["assignee"]
                .as_str()
                .filter(|id| !id.is_empty())
                .map_or(Value::Null, |id| json!(id)),
        );
    }
    if given("labels") {
        let labels: Vec<String> = input["labels"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|label| label.as_str().map(|label| label.trim().to_owned()))
            .filter(|label| !label.is_empty() && label.len() <= 50)
            .take(20)
            .collect();
        fields.insert("labels".into(), json!(labels));
    }
    if given("due") {
        let due = input["due"].as_str().filter(|due| !due.is_empty());
        if let Some(due) = due
            && !(due.len() == 10 && due.as_bytes()[4] == b'-' && due.as_bytes()[7] == b'-')
        {
            return Err("A due date is YYYY-MM-DD".into());
        }
        fields.insert("due".into(), due.map_or(Value::Null, |due| json!(due)));
    }
    Ok(Value::Object(fields))
}

zerolux_extension::export!(Projects::default);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_states_and_dates_are_checked() {
        assert_eq!(clean_key("zl").unwrap(), "ZL");
        assert!(clean_key("1A").is_err());
        assert!(clean_key("A").is_err());
        let fields = task_fields(&json!({"status": "todo", "labels": [" ui ", ""]}), None).unwrap();
        assert_eq!(fields["status"], "todo");
        assert_eq!(fields["priority"], "none");
        assert_eq!(fields["labels"], json!(["ui"]));
        assert!(task_fields(&json!({"status": "lost"}), None).is_err());
        assert!(task_fields(&json!({"due": "tomorrow"}), None).is_err());
        let only = task_fields(&json!({"priority": "high"}), Some(&json!({}))).unwrap();
        assert_eq!(only, json!({"priority": "high"}));
    }
}
