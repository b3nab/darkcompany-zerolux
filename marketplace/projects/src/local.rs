//! The `local` tracker, Projects' own: projects and tasks kept in ZeroLux, as Projects' values.

use std::collections::BTreeMap;

use zerolux_extension::{Context, Value, json, serde_json};

use crate::{PRIORITIES, STATUSES, choice, now_ms, text_of};

/// What the local tracker keeps: its projects and tasks, by id.
#[derive(Default)]
pub struct Work {
    pub projects: BTreeMap<String, Value>,
    pub tasks: BTreeMap<String, Value>,
}

/// A project's key, such as `ZL`: 2 to 10 capital letters and digits, starting with a letter.
pub fn clean_key(key: &str) -> Result<String, String> {
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

pub fn read(context: &Context) -> Result<Work, String> {
    let parse = |value: Value| -> Result<BTreeMap<String, Value>, String> {
        if value.is_null() {
            return Ok(BTreeMap::new());
        }
        serde_json::from_value(value).map_err(|error| error.to_string())
    };
    let mut work = Work {
        projects: parse(context.get_value("projects")?)?,
        tasks: parse(context.get_value("tasks")?)?,
    };
    // What Projects 0.1 copied from trackers is not kept here: those projects are their own.
    let copied: Vec<String> = work
        .projects
        .iter()
        .filter(|(_, project)| project["tracker"].is_string())
        .map(|(id, _)| id.clone())
        .collect();
    work.projects.retain(|id, _| !copied.contains(id));
    work.tasks
        .retain(|_, task| !copied.iter().any(|id| task["project_id"] == id.as_str()));
    Ok(work)
}

pub fn write(context: &Context, work: &Work) -> Result<(), String> {
    context.set_value("projects", json!(work.projects))?;
    context.set_value("tasks", json!(work.tasks))
}

/// A local project as trackers give projects.
fn project_of(project: &Value) -> Value {
    json!({"id": project["id"], "key": project["key"], "name": project["name"],
        "description": project["description"], "archived": project["archived"]})
}

/// A local task as trackers give tasks.
pub fn task_of(task: &Value, comments: bool) -> Value {
    let mut shown = json!({"id": task["id"], "key": task["key"], "title": task["title"],
        "description": task["description"], "status": task["status"],
        "priority": task["priority"], "labels": task["labels"], "due": task["due"],
        "assignee": task["assignee"], "url": null, "people": [],
        "created_at": task["created_at"], "updated_at": task["updated_at"]});
    if comments {
        shown["comments"] = task["comments"].clone();
        if shown["comments"].is_null() {
            shown["comments"] = json!([]);
        }
    }
    shown
}

/// The task's fields an input sets, checked; with `current`, only those it names.
pub fn task_fields(input: &Value, current: Option<&Value>) -> Result<Value, String> {
    let mut fields = serde_json::Map::new();
    let given = |key: &str| current.is_none() || input.get(key).is_some();
    if input.get("title").is_some() || current.is_none() {
        let title = text_of(&input["title"], 500, "A task's title")?;
        if title.is_empty() {
            return Err("Give the task a title".into());
        }
        fields.insert("title".into(), json!(title));
    }
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

/// The local tracker's operations. `by` is who acts.
pub fn operation(
    context: &Context,
    operation: &str,
    input: &Value,
    by: &Value,
) -> Result<Value, String> {
    let project_id = input["project"].as_str().unwrap_or_default().to_owned();
    let task_id = input["task"].as_str().unwrap_or_default().to_owned();
    let reading = matches!(
        operation,
        "describe" | "check" | "projects" | "tasks" | "task"
    );
    let mut work = read(context)?;
    let result = match operation {
        "describe" => Ok(json!({"title": "ZeroLux", "fields": [], "sign_in": false,
            "capabilities": ["create_project", "edit_project", "comments", "labels", "due",
                "priority", "delete", "assign"]})),
        "check" => Ok(json!({})),
        "projects" => {
            Ok(json!({"projects": work.projects.values().map(project_of).collect::<Vec<_>>()}))
        }
        "create_project" => {
            let name = text_of(&input["name"], 200, "A project's name")?;
            if name.is_empty() {
                return Err("Name the project".into());
            }
            let key = clean_key(input["key"].as_str().unwrap_or_default())?;
            if work.projects.values().any(|known| known["key"] == key) {
                return Err(format!("A project already has the key {key}"));
            }
            let id = uuid::Uuid::new_v4().to_string();
            let project = json!({"id": id, "key": key, "name": name,
                "description": text_of(&input["description"], 10_000, "A description")?,
                "archived": false, "next": 1, "created_by": by, "created_at": now_ms()});
            work.projects.insert(id, project.clone());
            Ok(project_of(&project))
        }
        "update_project" => {
            let project = work
                .projects
                .get_mut(&project_id)
                .ok_or("No such project")?;
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
            Ok(project_of(project))
        }
        "tasks" => {
            let tasks: Vec<Value> = work
                .tasks
                .values()
                .filter(|task| task["project_id"] == project_id.as_str())
                .map(|task| task_of(task, false))
                .collect();
            Ok(json!({"tasks": tasks}))
        }
        "task" => work
            .tasks
            .get(&task_id)
            .filter(|task| task["project_id"] == project_id.as_str())
            .map(|task| task_of(task, true))
            .ok_or_else(|| "No such task".into()),
        "create_task" => {
            let fields = task_fields(&input["task"], None)?;
            let project = work
                .projects
                .get_mut(&project_id)
                .ok_or("No such project")?;
            let number = project["next"].as_i64().unwrap_or(1);
            project["next"] = json!(number + 1);
            let now = now_ms();
            let id = uuid::Uuid::new_v4().to_string();
            let mut task = json!({"id": id, "number": number, "project_id": project_id,
                "key": format!("{}-{number}", project["key"].as_str().unwrap_or_default()),
                "created_by": by, "created_at": now, "updated_at": now, "comments": []});
            for (key, value) in fields.as_object().into_iter().flatten() {
                task[key] = value.clone();
            }
            work.tasks.insert(id, task.clone());
            Ok(task_of(&task, false))
        }
        "update_task" => {
            let task = work
                .tasks
                .get_mut(&task_id)
                .filter(|task| task["project_id"] == project_id.as_str())
                .ok_or("No such task")?;
            let changes = task_fields(&input["changes"], Some(task))?;
            for (key, value) in changes.as_object().into_iter().flatten() {
                task[key] = value.clone();
            }
            task["updated_at"] = json!(now_ms());
            Ok(task_of(task, false))
        }
        "comment" => {
            let text = text_of(&input["text"], 20_000, "A comment")?;
            if text.is_empty() {
                return Err("Write the comment".into());
            }
            let task = work
                .tasks
                .get_mut(&task_id)
                .filter(|task| task["project_id"] == project_id.as_str())
                .ok_or("No such task")?;
            let comment = json!({"id": uuid::Uuid::new_v4().to_string(), "by": by,
                "author": null, "text": text, "at": now_ms()});
            match task["comments"].as_array_mut() {
                Some(comments) => comments.push(comment.clone()),
                None => task["comments"] = json!([comment.clone()]),
            }
            task["updated_at"] = json!(now_ms());
            Ok(comment)
        }
        "delete_task" => {
            work.tasks
                .remove(&task_id)
                .filter(|task| task["project_id"] == project_id.as_str())
                .ok_or("No such task")?;
            Ok(json!({}))
        }
        other => Err(format!("No operation `{other}`")),
    }?;
    if !reading {
        write(context, &work)?;
    }
    Ok(result)
}
