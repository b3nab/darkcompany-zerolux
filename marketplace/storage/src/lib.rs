//! ZeroLux's Storage, a kernel module: the workspace's files where they are, live. Each
//! **location** is a provider with its configuration and account: a folder on this computer,
//! a Google Drive, an S3 bucket… as many as wanted, of any provider. A location shows what
//! its service holds, as the service holds it; nothing is copied or kept in step.
//!
//! Storage opens `zerolux.storage/providers@2` and implements it itself as `folder`, a folder
//! on the kernel's computer; other extensions implement it for other services. Storage keeps
//! only what the services do not: its locations, and the files shared in chats.

mod paths;

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

use paths::{clean_name, clean_path, join, leaf, parent};
use zerolux_extension::{Caller, Context, Extension, Value, json, serde_json};

/// The point providers implement.
pub const PROVIDERS: &str = "zerolux.storage/providers@2";
/// The provider Storage implements itself.
const FOLDER: &str = "folder";
/// The largest file `write` and `read` take as text.
const TEXT: usize = 1024 * 1024;
/// The folder chat attachments go to, in the chosen location.
const ATTACHMENTS: &str = "Chats";

#[derive(Default)]
pub struct Storage {
    /// Changes to its locations and shares go one at a time.
    held: Mutex<()>,
    /// Whether what an earlier Storage kept has been brought over.
    ready: Mutex<bool>,
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

/// What a caller is: a person, unless an agent's session or another extension runs it.
fn person(caller: &Caller) -> bool {
    caller["session_id"].is_null() && caller["by"].is_null()
}

fn who(caller: &Caller) -> String {
    caller["actor_id"]
        .as_str()
        .or(caller["by"].as_str())
        .unwrap_or_default()
        .to_owned()
}

/// A file's type, from its name.
fn content_type(name: &str) -> &'static str {
    let extension = name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "txt" | "log" => "text/plain; charset=utf-8",
        "md" | "markdown" => "text/markdown; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" | "opus" => "audio/ogg",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        "tar" => "application/x-tar",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "ts" | "tsx" => "text/typescript; charset=utf-8",
        "rs" => "text/x-rust; charset=utf-8",
        "py" => "text/x-python; charset=utf-8",
        "sh" => "application/x-sh",
        "toml" => "application/toml",
        "yaml" | "yml" => "application/yaml",
        "xml" => "application/xml",
        _ => "application/octet-stream",
    }
}

impl Storage {
    // What Storage keeps.

    fn read_map(context: &Context, key: &str) -> Result<BTreeMap<String, Value>, String> {
        let stored = context.get_value(key)?;
        if stored.is_null() {
            return Ok(BTreeMap::new());
        }
        serde_json::from_value(stored).map_err(|error| error.to_string())
    }

    fn locations(&self, context: &Context) -> Result<BTreeMap<String, Value>, String> {
        self.ready(context)?;
        Self::read_map(context, "locations")
    }

    /// Changes what Storage keeps, one change at a time, and says so.
    fn change<T>(
        &self,
        context: &Context,
        key: &str,
        change: impl FnOnce(&mut BTreeMap<String, Value>) -> Result<T, String>,
    ) -> Result<T, String> {
        let result = {
            let _held = self.held.lock().map_err(|_| "Storage is unavailable")?;
            let mut map = Self::read_map(context, key)?;
            let result = change(&mut map)?;
            context.set_value(key, json!(map))?;
            result
        };
        context.publish("changed", json!({}))?;
        Ok(result)
    }

    /// A location by its id, or by its name when only one has it.
    fn location(&self, context: &Context, named: &str) -> Result<Value, String> {
        let locations = self.locations(context)?;
        if let Some(location) = locations.get(named) {
            return Ok(location.clone());
        }
        let mut found = locations
            .values()
            .filter(|location| location["name"].as_str() == Some(named));
        match (found.next(), found.next()) {
            (Some(location), None) => Ok(location.clone()),
            (Some(_), Some(_)) => Err(format!("More than one location is named `{named}`")),
            _ => Err(format!("No location `{named}`")),
        }
    }

    /// The location chat attachments go to: the one chosen, or the first.
    fn default_location(&self, context: &Context) -> Result<Value, String> {
        let locations = self.locations(context)?;
        let chosen = context.get_value("default")?;
        chosen
            .as_str()
            .and_then(|id| locations.get(id))
            .or_else(|| locations.values().next())
            .cloned()
            .ok_or_else(|| "Add a location first".to_owned())
    }

    /// The ZeroLux location, a folder of Storage's own, for whoever has no other; and what an
    /// earlier Storage kept, brought over once.
    fn ready(&self, context: &Context) -> Result<(), String> {
        let mut ready = self.ready.lock().map_err(|_| "Storage is unavailable")?;
        if *ready {
            return Ok(());
        }
        let _held = self.held.lock().map_err(|_| "Storage is unavailable")?;
        let mut locations = Self::read_map(context, "locations")?;
        if locations.is_empty() {
            let space = Path::new(&context.folder()).join("space");
            std::fs::create_dir_all(&space).map_err(|error| error.to_string())?;
            let id = uuid::Uuid::new_v4().to_string();
            locations.insert(
                id.clone(),
                json!({"id": id, "name": "ZeroLux", "provider": FOLDER,
                    "config": {"path": space}, "created_at": now_ms(), "own": true}),
            );
            context.set_value("locations", json!(locations))?;
            context.set_value("default", json!(id))?;
            bring_over(context, &locations[&id])?;
        }
        *ready = true;
        Ok(())
    }

    // Providers.

    /// Asks a location's provider; `folder` is Storage's own.
    fn provide(
        &self,
        context: &Context,
        location: &Value,
        operation: &str,
        mut input: Value,
    ) -> Result<Value, String> {
        input["location"] = location["id"].clone();
        input["config"] = location["config"].clone();
        let provider = location["provider"].as_str().unwrap_or(FOLDER);
        let result = if provider == FOLDER {
            folder_operation(operation, &input)
        } else {
            context.call(PROVIDERS, provider, operation, input)
        };
        if let Err(error) = &result {
            self.noted(context, location, Some(error));
        } else if location["error"].is_string() {
            self.noted(context, location, None);
        }
        result
    }

    /// Keeps what went wrong with a location last, or that it works again.
    fn noted(&self, context: &Context, location: &Value, error: Option<&String>) {
        let id = location["id"].as_str().unwrap_or_default().to_owned();
        let error = error.cloned();
        let _ = self.change(context, "locations", |locations| {
            if let Some(kept) = locations.get_mut(&id) {
                kept["error"] = json!(error);
            }
            Ok(())
        });
    }

    /// The providers there are: Storage's own and those other extensions implement.
    fn providers(&self, context: &Context) -> Result<Vec<Value>, String> {
        let mut providers = vec![describe_folder()];
        let implementations =
            context.ask("points.implementations", json!({"point": PROVIDERS}))?["implementations"]
                .take();
        for implementation in implementations.as_array().into_iter().flatten() {
            let name = implementation["name"].as_str().unwrap_or_default();
            if name == FOLDER {
                continue;
            }
            let described = context
                .call(PROVIDERS, name, "describe", json!({}))
                .unwrap_or_else(|error| json!({"error": error}));
            let mut provider = json!({"provider": name,
                "extension": implementation["extension"],
                "title": implementation["title"]});
            if let Some(described) = described.as_object() {
                for (key, value) in described {
                    provider[key] = value.clone();
                }
            }
            providers.push(provider);
        }
        Ok(providers)
    }

    fn capabilities(&self, context: &Context, provider: &str) -> Vec<String> {
        let described = if provider == FOLDER {
            describe_folder()
        } else {
            context
                .call(PROVIDERS, provider, "describe", json!({}))
                .unwrap_or_default()
        };
        serde_json::from_value(described["capabilities"].clone()).unwrap_or_default()
    }

    /// Hands a location's configuration to its provider, which keeps its secrets and says
    /// what is shown of it, and whether the person signs in.
    fn connect(
        &self,
        context: &Context,
        caller: &Caller,
        location: &Value,
        config: Value,
    ) -> Result<Value, String> {
        let input = json!({"location": location["id"], "config": config,
            "previous": location["config"], "origin": caller["origin"]});
        match location["provider"].as_str().unwrap_or(FOLDER) {
            FOLDER => folder_operation("connect", &input),
            provider => context.call(PROVIDERS, provider, "connect", input),
        }
    }

    // Shares.

    fn shares(context: &Context) -> Result<BTreeMap<String, Value>, String> {
        Self::read_map(context, "shares")
    }

    /// A shared file as chats show it.
    fn shared(
        &self,
        context: &Context,
        caller: &Caller,
        location: &Value,
        entry: &Value,
        conversation: &str,
    ) -> Result<Value, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let name = entry["name"].as_str().unwrap_or_default();
        let share = json!({"id": id, "location": location["id"], "path": entry["path"],
            "file_id": entry["id"], "name": name, "folder": "",
            "size": entry["size"].as_u64().unwrap_or(0),
            "content_type": entry["content_type"].as_str().unwrap_or(content_type(name)),
            "conversation_id": conversation, "created_by": who(caller),
            "created_at": now, "updated_at": now});
        self.change(context, "shares", |shares| {
            shares.insert(id.clone(), share.clone());
            Ok(())
        })?;
        Ok(share)
    }

    /// Shares follow what Storage itself renamed or moved.
    fn moved(&self, context: &Context, location: &str, from: &str, to: (&str, &str)) {
        let (to_location, to) = to;
        let _ = self.change(context, "shares", |shares| {
            for share in shares.values_mut() {
                if share["location"] != location {
                    continue;
                }
                let path = share["path"].as_str().unwrap_or_default();
                let moved = if path == from {
                    Some(to.to_owned())
                } else {
                    path.strip_prefix(&format!("{from}/"))
                        .map(|rest| join(to, rest))
                };
                if let Some(moved) = moved {
                    share["name"] = json!(leaf(&moved));
                    share["path"] = json!(moved);
                    share["location"] = json!(to_location);
                }
            }
            Ok(())
        });
    }

    // Moving between locations.

    /// Copies a file or a folder with what it holds into a folder of another location, or of
    /// the same one when its provider cannot: the new entry.
    fn copy_across(
        &self,
        context: &Context,
        from: (&Value, &str),
        to: (&Value, &str),
    ) -> Result<Value, String> {
        let (_, path) = from;
        self.copy_as(context, from, to, leaf(path))
    }

    /// The same, under another name.
    fn copy_as(
        &self,
        context: &Context,
        from: (&Value, &str),
        to: (&Value, &str),
        name: &str,
    ) -> Result<Value, String> {
        let (source, path) = from;
        let (target, folder) = to;
        let entry = self.provide(context, source, "stat", json!({"path": path}))?;
        let destination = join(folder, name);
        if entry["kind"] == "folder" {
            let made = self.provide(context, target, "mkdir", json!({"path": destination}))?;
            let listed = self.provide(context, source, "list", json!({"path": path}))?;
            for inner in listed["entries"].as_array().into_iter().flatten() {
                let inner = inner["path"].as_str().unwrap_or_default();
                self.copy_across(context, (source, inner), (target, &destination))?;
            }
            return Ok(made);
        }
        let got = self.provide(context, source, "read", json!({"path": path}))?;
        let local = got["path"].as_str().ok_or("The provider gave no file")?;
        // A service's own document comes in another format, under that format's name.
        let destination = match got["name"].as_str() {
            Some(given) if name == leaf(path) => join(folder, given),
            _ => destination,
        };
        let written = self.provide(
            context,
            target,
            "write",
            json!({"path": destination, "from": local,
                "content_type": got["content_type"].as_str()
                    .unwrap_or(content_type(leaf(path))),
                "owned": got["temporary"] == true}),
        );
        if got["temporary"] == true {
            let _ = std::fs::remove_file(local);
        }
        written
    }

    /// A file kept from a local path into a location's folder: the new entry.
    fn keep(
        &self,
        context: &Context,
        location: &Value,
        folder: &str,
        name: &str,
        from: &str,
        content_type: &str,
    ) -> Result<Value, String> {
        let name = clean_name(name)?;
        let folder = clean_path(folder)?;
        // A name already there is not overwritten: the new file gets a number.
        let taken: Vec<String> = self
            .provide(context, location, "list", json!({"path": folder}))
            .map(|listed| {
                listed["entries"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|entry| entry["name"].as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        let name = paths::free_name(&name, &taken);
        self.provide(
            context,
            location,
            "write",
            json!({"path": join(&folder, &name), "from": from, "content_type": content_type,
                "owned": true}),
        )
    }
}

/// What a person sees of a location: never its secrets, which its provider keeps.
fn shown(location: &Value, capabilities: &[String]) -> Value {
    let mut shown = location.clone();
    shown["capabilities"] = json!(capabilities);
    shown
}

/// What Storage 0.1 kept, in the ZeroLux location: its files with their names and folders,
/// and those shared in a chat shared from there under the same id, so links keep working.
fn bring_over(context: &Context, location: &Value) -> Result<(), String> {
    let files = Storage::read_map(context, "files")?;
    if files.is_empty() {
        return Ok(());
    }
    let root = PathBuf::from(location["config"]["path"].as_str().unwrap_or_default());
    let old = Path::new(&context.folder()).join("files");
    let mut shares = Storage::read_map(context, "shares")?;
    for (id, file) in &files {
        let Some(name) = file["name"].as_str() else {
            continue;
        };
        let bytes = old.join(id);
        if file["provider"].as_str().unwrap_or("local") != "local" || !bytes.is_file() {
            context.log(&format!(
                "{name} was kept by another provider; not brought over"
            ));
            continue;
        }
        let folder = file["folder"].as_str().unwrap_or_default();
        let into = root.join(folder);
        std::fs::create_dir_all(&into).map_err(|error| error.to_string())?;
        let taken: Vec<String> = std::fs::read_dir(&into)
            .map_err(|error| error.to_string())?
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .collect();
        let name = paths::free_name(name, &taken);
        std::fs::rename(&bytes, into.join(&name)).map_err(|error| error.to_string())?;
        if let Some(conversation) = file["conversation_id"].as_str() {
            let mut share = file.clone();
            share["location"] = location["id"].clone();
            share["path"] = json!(join(folder, &name));
            share["name"] = json!(name);
            share["conversation_id"] = json!(conversation);
            shares.insert(id.clone(), share);
        }
    }
    context.set_value("shares", json!(shares))?;
    context.set_value("files", Value::Null)?;
    context.set_value("folders", Value::Null)?;
    let _ = std::fs::remove_dir(&old);
    Ok(())
}

// The `folder` provider: a folder on the kernel's computer.

fn describe_folder() -> Value {
    json!({"provider": FOLDER, "extension": "zerolux.storage", "title": "Folder",
        "description": "A folder on the kernel's computer",
        "fields": [{"key": "path", "label": "Folder", "type": "text", "required": true,
            "description": "Its full path on the kernel's computer"}],
        "capabilities": ["write", "move", "copy", "delete", "search"]})
}

/// A path within a folder location, never outside it.
fn within(input: &Value, key: &str) -> Result<(PathBuf, String), String> {
    let root = input["config"]["path"]
        .as_str()
        .filter(|root| Path::new(root).is_absolute())
        .ok_or("The location has no folder")?;
    let root =
        std::fs::canonicalize(root).map_err(|_| format!("The folder {root} is not there"))?;
    let path = clean_path(input[key].as_str().unwrap_or_default())?;
    let full = root.join(&path);
    // Through links too: what exists resolves inside the folder.
    if let Ok(real) = std::fs::canonicalize(&full)
        && !real.starts_with(&root)
    {
        return Err("The path leaves the location".into());
    }
    Ok((full, path))
}

fn entry_of(full: &Path, path: &str) -> Result<Value, String> {
    let meta = std::fs::metadata(full).map_err(|_| format!("`{path}` is not there"))?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as i64);
    let name = leaf(path);
    Ok(if meta.is_dir() {
        json!({"name": name, "path": path, "kind": "folder", "modified": modified})
    } else {
        json!({"name": name, "path": path, "kind": "file", "size": meta.len(),
            "modified": modified, "content_type": content_type(name)})
    })
}

fn listed(full: &Path, path: &str) -> Result<Vec<Value>, String> {
    let mut entries: Vec<Value> = std::fs::read_dir(full)
        .map_err(|_| format!("`{path}` is not a folder there"))?
        .filter_map(|entry| {
            let name = entry.ok()?.file_name().into_string().ok()?;
            // What the system keeps for itself is not the person's.
            if name == ".DS_Store" || name.starts_with("._") {
                return None;
            }
            let inner = join(path, &name);
            entry_of(&full.join(&name), &inner).ok()
        })
        .collect();
    entries.sort_by(|a, b| {
        (
            a["kind"] != "folder",
            a["name"].as_str().map(str::to_lowercase),
        )
            .cmp(&(
                b["kind"] != "folder",
                b["name"].as_str().map(str::to_lowercase),
            ))
    });
    Ok(entries)
}

fn folder_operation(operation: &str, input: &Value) -> Result<Value, String> {
    let error = |error: std::io::Error| error.to_string();
    match operation {
        "describe" => Ok(describe_folder()),
        "connect" => {
            let path = input["config"]["path"].as_str().unwrap_or_default().trim();
            if !Path::new(path).is_absolute() {
                return Err("Give the folder's full path".into());
            }
            let real = std::fs::canonicalize(path)
                .map_err(|_| format!("The folder {path} is not there"))?;
            if !real.is_dir() {
                return Err(format!("{path} is not a folder"));
            }
            Ok(json!({"config": {"path": real}}))
        }
        "check" => {
            within(input, "path")?;
            Ok(json!({}))
        }
        "forget" => Ok(json!({})),
        "list" => {
            let (full, path) = within(input, "path")?;
            Ok(json!({"entries": listed(&full, &path)?}))
        }
        "stat" => {
            let (full, path) = within(input, "path")?;
            entry_of(&full, &path)
        }
        "read" => {
            let (full, path) = within(input, "path")?;
            if !full.is_file() {
                return Err(format!("`{path}` is not a file"));
            }
            Ok(json!({"path": full, "temporary": false, "content_type": content_type(&path)}))
        }
        "write" => {
            let (full, path) = within(input, "path")?;
            if path.is_empty() {
                return Err("Name the file".into());
            }
            let from = input["from"].as_str().ok_or("Give the file to write")?;
            if let Some(folder) = full.parent() {
                std::fs::create_dir_all(folder).map_err(error)?;
            }
            // A file that is the writer's to let go is moved when it can be; another is copied.
            if input["owned"] != true || std::fs::rename(from, &full).is_err() {
                std::fs::copy(from, &full).map_err(error)?;
            }
            entry_of(&full, &path)
        }
        "mkdir" => {
            let (full, path) = within(input, "path")?;
            std::fs::create_dir_all(&full).map_err(error)?;
            entry_of(&full, &path)
        }
        "move" | "copy" => {
            let (from, _) = within(input, "from")?;
            let (to, path) = within(input, "to")?;
            if to.exists() {
                return Err(format!("`{path}` is already there"));
            }
            if let Some(folder) = to.parent() {
                std::fs::create_dir_all(folder).map_err(error)?;
            }
            if operation == "move" {
                std::fs::rename(&from, &to).map_err(error)?;
            } else {
                copy_tree(&from, &to).map_err(error)?;
            }
            entry_of(&to, &path)
        }
        "delete" => {
            let (full, path) = within(input, "path")?;
            if path.is_empty() {
                return Err("The location itself is not deleted".into());
            }
            if full.is_dir() {
                std::fs::remove_dir_all(&full).map_err(error)?;
            } else {
                std::fs::remove_file(&full).map_err(error)?;
            }
            Ok(json!({}))
        }
        "search" => {
            let (root, _) = within(input, "path")?;
            let words = input["query"].as_str().unwrap_or_default().to_lowercase();
            if words.trim().is_empty() {
                return Ok(json!({"entries": []}));
            }
            let mut found = Vec::new();
            search(&root, "", &words, &mut found, &mut 0);
            Ok(json!({"entries": found}))
        }
        other => Err(format!("No operation `{other}`")),
    }
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to).map(drop)
    }
}

/// Names that hold the words, up to 200 found and 20,000 looked at.
fn search(folder: &Path, path: &str, words: &str, found: &mut Vec<Value>, seen: &mut usize) {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    for entry in entries.flatten() {
        *seen += 1;
        if found.len() >= 200 || *seen > 20_000 {
            return;
        }
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let inner = join(path, &name);
        let full = entry.path();
        if name.to_lowercase().contains(words)
            && let Ok(found_entry) = entry_of(&full, &inner)
        {
            found.push(found_entry);
        }
        if full.is_dir() && !full.is_symlink() {
            search(&full, &inner, words, found, seen);
        }
    }
}

impl Extension for Storage {
    fn initialize(&self, _context: &Context) -> Result<Value, String> {
        let at = || json!({"location": {"type": "string"}, "path": {"type": "string"}});
        let with = |extra: Value| {
            let mut properties = at();
            for (key, value) in extra.as_object().into_iter().flatten() {
                properties[key] = value.clone();
            }
            properties
        };
        let string = json!({"type": "string"});
        Ok(json!({
            "actions": [
                {"name": "providers", "title": "Providers",
                    "description": "Where files can be: the providers there are, with what each asks to add a location and what it can do"},
                {"name": "locations", "title": "Locations",
                    "description": "The workspace's locations, each a provider with its configuration: a folder on this computer, a Google Drive, a bucket…"},
                {"name": "add_location", "title": "Add location",
                    "description": "Adds a location of a provider, with its configuration; some ask the person to sign in at the address given",
                    "effects": "write",
                    "input": object(json!({"name": string, "provider": string, "config": {"type": "object"}}), &["name", "provider"])},
                {"name": "change_location", "title": "Change location",
                    "description": "Renames a location, or changes its configuration",
                    "effects": "write",
                    "input": object(json!({"id": string, "name": string, "config": {"type": "object"}}), &["id"])},
                {"name": "sign_in", "title": "Sign in again",
                    "description": "The address where the person signs in to a location's service again",
                    "effects": "write", "input": object(json!({"id": string}), &["id"])},
                {"name": "check_location", "title": "Check location",
                    "description": "Whether a location can be reached, and with which account",
                    "input": object(json!({"id": string}), &["id"])},
                {"name": "remove_location", "title": "Remove location",
                    "description": "Removes a location from ZeroLux; nothing is deleted where its files are",
                    "effects": "destructive", "input": object(json!({"id": string}), &["id"])},
                {"name": "list", "title": "Files",
                    "description": "What a folder of a location holds, as its service holds it: the top with no path",
                    "input": object(at(), &["location"])},
                {"name": "search", "title": "Search",
                    "description": "Files and folders whose names hold the words, in one location or in all that can search",
                    "input": object(json!({"query": string, "location": string}), &["query"])},
                {"name": "read", "title": "Read a file", "description": "A text file's text, up to 1 MiB",
                    "input": object(at(), &["location", "path"])},
                {"name": "download", "title": "Download",
                    "description": "A file's bytes: by location and path, or a file shared in a chat by its id",
                    "input": object(with(json!({"id": string})), &[])},
                {"name": "upload", "title": "Upload",
                    "description": "Keeps the file sent with it in a folder of a location, or shares it in a chat",
                    "effects": "write", "seconds": 600,
                    "input": object(with(json!({"file": {"type": "object"}, "name": string,
                        "conversation_id": string})), &["file"])},
                {"name": "write", "title": "Write a file",
                    "description": "Writes a text file, up to 1 MiB, at a path of a location, replacing what is there",
                    "effects": "write",
                    "input": object(with(json!({"text": string, "conversation_id": string})), &["path", "text"])},
                {"name": "create_folder", "title": "New folder", "description": "Makes a folder",
                    "effects": "write", "input": object(at(), &["location", "path"])},
                {"name": "rename", "title": "Rename", "description": "Gives a file or a folder another name",
                    "effects": "write",
                    "input": object(with(json!({"name": string})), &["location", "path", "name"])},
                {"name": "move", "title": "Move",
                    "description": "Puts a file or a folder, with what it holds, in a folder of the same location or another",
                    "effects": "write", "seconds": 1800,
                    "input": object(with(json!({"to_location": string, "to": string})), &["location", "path", "to"])},
                {"name": "copy", "title": "Copy",
                    "description": "Copies a file or a folder, with what it holds, into a folder of the same location or another",
                    "effects": "write", "seconds": 1800,
                    "input": object(with(json!({"to_location": string, "to": string})), &["location", "path", "to"])},
                {"name": "delete", "title": "Delete",
                    "description": "Deletes a file, or a folder with what it holds, where it is",
                    "effects": "destructive", "input": object(at(), &["location", "path"])},
                {"name": "share", "title": "Share in a chat", "description": "Shares a file in a chat",
                    "effects": "write",
                    "input": object(with(json!({"conversation_id": string})), &["location", "path", "conversation_id"])},
                {"name": "unshare", "title": "Stop sharing",
                    "description": "A file shared in a chat is no longer shared there; the file stays",
                    "effects": "write", "input": object(json!({"id": string}), &["id"])},
                {"name": "files", "title": "Shared files", "description": "The files shared in a chat",
                    "input": object(json!({"conversation_id": string}), &["conversation_id"])},
                {"name": "signed_in", "title": "Signed in",
                    "description": "A provider says a location's sign-in ended, and whether it worked",
                    "effects": "write",
                    "input": object(json!({"location": string, "ok": {"type": "boolean"}, "error": string,
                        "account": string}), &["location", "ok"])},
            ],
            "points": [{"name": "providers", "version": 2,
                "description": "Where files are: a provider shows and changes what a service holds, live, for each location of it",
                "operations": [
                    {"name": "describe", "description": "Its title, the fields a location of it asks for, whether the person signs in, and its capabilities"},
                    {"name": "connect", "description": "Takes a location's configuration, keeps its secrets, and gives what is shown of it and, to sign in, `sign_in.url`; when that sign-in ends, the provider runs Storage's `signed_in`",
                        "input": object(json!({"location": string, "config": {"type": "object"}, "origin": string}), &["location", "config"])},
                    {"name": "check", "description": "Whether the location can be reached, and its `account`"},
                    {"name": "forget", "description": "Lets a removed location's secrets go"},
                    {"name": "list", "description": "The entries of a folder: each `{name, path, kind, size?, modified?, content_type?, id?}`"},
                    {"name": "stat", "description": "One entry"},
                    {"name": "read", "description": "A local path to read a file's bytes from, and whether it is a temporary copy"},
                    {"name": "write", "description": "Writes a file at a path from a local path, replacing what is there"},
                    {"name": "mkdir", "description": "Makes a folder, with those above it"},
                    {"name": "move", "description": "Moves or renames, from `from` to `to`"},
                    {"name": "copy", "description": "Copies, from `from` to `to`"},
                    {"name": "delete", "description": "Deletes a file, or a folder with what it holds"},
                    {"name": "search", "description": "Entries whose names hold `query`"},
                ]}],
            "implements": [{"point": PROVIDERS, "name": FOLDER, "title": "Folder"}],
            "events": [{"name": "changed", "description": "Locations, files or shares changed"}],
            "ui": [
                {"space": "page", "name": "files", "title": "Files", "icon": "folder",
                    "view": {"kind": "native", "entry": "ui/native/files.js"}},
                {"space": "chat", "name": "shared", "title": "Files",
                    "view": {"kind": "native", "entry": "ui/native/shared.js"}},
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
        let conversation = input["conversation_id"]
            .as_str()
            .filter(|id| !id.is_empty());
        // The location named, or the one chat attachments go to.
        let place = || -> Result<Value, String> {
            match input["location"].as_str().filter(|named| !named.is_empty()) {
                Some(named) => self.location(context, named),
                None => self.default_location(context),
            }
        };
        let path = || clean_path(&text("path"));
        match name {
            "providers" => Ok(json!({"providers": self.providers(context)?})),
            "locations" => {
                let providers = self.providers(context)?;
                let capabilities = |provider: &str| -> Vec<String> {
                    providers
                        .iter()
                        .find(|known| known["provider"] == provider)
                        .and_then(|known| {
                            serde_json::from_value(known["capabilities"].clone()).ok()
                        })
                        .unwrap_or_default()
                };
                let kept = self.locations(context)?;
                let default = context.get_value("default")?;
                let mut locations: Vec<Value> = kept
                    .values()
                    .map(|location| {
                        let mut shown = shown(
                            location,
                            &capabilities(location["provider"].as_str().unwrap_or(FOLDER)),
                        );
                        shown["default"] = json!(location["id"] == default);
                        shown["available"] = json!(
                            providers
                                .iter()
                                .any(|known| known["provider"] == location["provider"])
                        );
                        shown
                    })
                    .collect();
                locations.sort_by_key(|location| location["created_at"].as_i64());
                Ok(json!({"locations": locations}))
            }
            "add_location" | "change_location" | "sign_in" | "remove_location"
                if !person(&caller) =>
            {
                Err("Only a person adds, changes and removes locations".into())
            }
            "add_location" => {
                let name = clean_name(&text("name"))?;
                let provider = text("provider");
                if !self
                    .providers(context)?
                    .iter()
                    .any(|known| known["provider"] == provider)
                {
                    return Err(format!("No provider `{provider}`"));
                }
                self.locations(context)?;
                let id = uuid::Uuid::new_v4().to_string();
                let mut location = json!({"id": id, "name": name, "provider": provider,
                    "config": {}, "created_at": now_ms()});
                let connected =
                    self.connect(context, &caller, &location, input["config"].clone())?;
                location["config"] = connected["config"].clone();
                location["account"] = connected["account"].clone();
                let sign_in = connected["sign_in"].clone();
                location["signed_in"] = json!(sign_in.is_null());
                self.change(context, "locations", |locations| {
                    locations.insert(id.clone(), location.clone());
                    Ok(())
                })?;
                Ok(json!({"location": location, "sign_in": sign_in}))
            }
            "change_location" => {
                let location = self.location(context, &text("id"))?;
                let renamed = input["name"].as_str().map(clean_name).transpose()?;
                let connected = if input["config"].is_object() {
                    Some(self.connect(context, &caller, &location, input["config"].clone())?)
                } else {
                    None
                };
                let id = location["id"].as_str().unwrap_or_default().to_owned();
                let changed = self.change(context, "locations", |locations| {
                    let kept = locations.get_mut(&id).ok_or("No such location")?;
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
                Ok(json!({"location": changed,
                    "sign_in": connected.map(|connected| connected["sign_in"].clone())}))
            }
            "sign_in" => {
                let location = self.location(context, &text("id"))?;
                let connected =
                    self.connect(context, &caller, &location, json!({"sign_in_again": true}))?;
                Ok(json!({"sign_in": connected["sign_in"]}))
            }
            "check_location" => {
                let location = self.location(context, &text("id"))?;
                let checked = self.provide(context, &location, "check", json!({"path": ""}))?;
                Ok(json!({"ok": true, "account": checked["account"]}))
            }
            "remove_location" => {
                let location = self.location(context, &text("id"))?;
                if location["own"] == true {
                    return Err("ZeroLux's own location stays".into());
                }
                let id = location["id"].as_str().unwrap_or_default().to_owned();
                let _ = self.provide(context, &location, "forget", json!({}));
                self.change(context, "locations", |locations| {
                    locations.remove(&id);
                    Ok(())
                })?;
                self.change(context, "shares", |shares| {
                    shares.retain(|_, share| share["location"] != id);
                    Ok(())
                })?;
                Ok(json!({"removed": id}))
            }
            "list" => {
                let location = place()?;
                let path = path()?;
                let listed = self.provide(context, &location, "list", json!({"path": path}))?;
                Ok(json!({"location": location["id"], "path": path, "entries": listed["entries"]}))
            }
            "search" => {
                let query = text("query");
                let locations: Vec<Value> = match input["location"].as_str() {
                    Some(named) if !named.is_empty() => vec![self.location(context, named)?],
                    _ => self.locations(context)?.into_values().collect(),
                };
                let mut found = Vec::new();
                for location in locations {
                    let provider = location["provider"].as_str().unwrap_or(FOLDER);
                    if !self
                        .capabilities(context, provider)
                        .iter()
                        .any(|c| c == "search")
                    {
                        continue;
                    }
                    if let Ok(result) = self.provide(
                        context,
                        &location,
                        "search",
                        json!({"query": query, "path": ""}),
                    ) {
                        for mut entry in result["entries"].as_array().cloned().unwrap_or_default() {
                            entry["location"] = location["id"].clone();
                            found.push(entry);
                        }
                    }
                }
                Ok(json!({"entries": found}))
            }
            "read" | "download" => {
                let (location, path) = match input["id"].as_str().filter(|id| !id.is_empty()) {
                    Some(id) => {
                        let share = Self::shares(context)?
                            .remove(id)
                            .ok_or("No such shared file")?;
                        (
                            self.location(context, share["location"].as_str().unwrap_or_default())?,
                            share["path"].as_str().unwrap_or_default().to_owned(),
                        )
                    }
                    None => (place()?, path()?),
                };
                let got = self.provide(context, &location, "read", json!({"path": path}))?;
                let local = got["path"].as_str().ok_or("The provider gave no file")?;
                // A service may give it in another format, under another name.
                let named = got["name"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| leaf(&path).to_owned());
                if name == "download" {
                    // The kernel gives files from Storage's own folder only: one elsewhere goes
                    // as a link to it there, or a copy.
                    let own = Path::new(&context.folder()).to_path_buf();
                    let (local, temporary) = if got["temporary"] == true
                        || std::fs::canonicalize(local).is_ok_and(|real| {
                            std::fs::canonicalize(&own).is_ok_and(|own| real.starts_with(own))
                        }) {
                        (PathBuf::from(local), got["temporary"] == true)
                    } else {
                        let staged = own.join(format!(".out-{}", uuid::Uuid::new_v4().simple()));
                        if std::fs::hard_link(local, &staged).is_err() {
                            std::fs::copy(local, &staged).map_err(|error| error.to_string())?;
                        }
                        (staged, true)
                    };
                    return Ok(json!({"$file": {"path": local, "name": named,
                        "content_type": got["content_type"].as_str().unwrap_or(content_type(&named)),
                        "temporary": temporary}}));
                }
                let bytes = std::fs::read(local).map_err(|error| error.to_string());
                if got["temporary"] == true {
                    let _ = std::fs::remove_file(local);
                }
                let bytes = bytes?;
                if bytes.len() > TEXT {
                    return Err("The file is larger than 1 MiB; download it".into());
                }
                let text = String::from_utf8(bytes)
                    .map_err(|_| "The file is not text; download it".to_owned())?;
                Ok(json!({"location": location["id"], "path": path, "text": text}))
            }
            "upload" => {
                let file = &input["file"];
                let from = file["path"]
                    .as_str()
                    .ok_or("Send the file with the action")?;
                let named = input["name"]
                    .as_str()
                    .filter(|name| !name.trim().is_empty())
                    .or(file["name"].as_str())
                    .unwrap_or_default();
                let location = place()?;
                let folder = match (input["path"].as_str(), conversation) {
                    (Some(folder), _) if !folder.is_empty() => clean_path(folder)?,
                    (_, Some(_)) => ATTACHMENTS.to_owned(),
                    _ => String::new(),
                };
                let kind = file["content_type"]
                    .as_str()
                    .filter(|kind| *kind != "application/octet-stream")
                    .unwrap_or(content_type(named))
                    .to_owned();
                let mut entry = self.keep(context, &location, &folder, named, from, &kind)?;
                if entry["content_type"].is_null() {
                    entry["content_type"] = json!(kind);
                }
                context.publish("changed", json!({}))?;
                match conversation {
                    Some(conversation) => {
                        self.shared(context, &caller, &location, &entry, conversation)
                    }
                    None => {
                        entry["location"] = location["id"].clone();
                        Ok(entry)
                    }
                }
            }
            "write" => {
                let body = text("text");
                if body.len() > TEXT {
                    return Err("A text file is up to 1 MiB".into());
                }
                let location = place()?;
                let path = path()?;
                if path.is_empty() {
                    return Err("Name the file".into());
                }
                clean_name(leaf(&path))?;
                let staged = Path::new(&context.folder())
                    .join(format!(".writing-{}", uuid::Uuid::new_v4().simple()));
                std::fs::write(&staged, body.as_bytes()).map_err(|error| error.to_string())?;
                let written = self.provide(
                    context,
                    &location,
                    "write",
                    json!({"path": path, "from": staged, "content_type": content_type(&path),
                        "owned": true}),
                );
                let _ = std::fs::remove_file(&staged);
                let mut entry = written?;
                context.publish("changed", json!({}))?;
                if let Some(conversation) = conversation {
                    return self.shared(context, &caller, &location, &entry, conversation);
                }
                entry["location"] = location["id"].clone();
                Ok(entry)
            }
            "create_folder" => {
                let location = place()?;
                let path = path()?;
                if path.is_empty() {
                    return Err("Name the folder".into());
                }
                let made = self.provide(context, &location, "mkdir", json!({"path": path}))?;
                context.publish("changed", json!({}))?;
                Ok(made)
            }
            "rename" => {
                let location = place()?;
                let path = path()?;
                if path.is_empty() {
                    return Err("The location is renamed in its settings".into());
                }
                let name = clean_name(&text("name"))?;
                let to = join(parent(&path), &name);
                let provider = location["provider"].as_str().unwrap_or(FOLDER);
                let renamed = if self
                    .capabilities(context, provider)
                    .iter()
                    .any(|c| c == "move")
                {
                    self.provide(context, &location, "move", json!({"from": path, "to": to}))?
                } else {
                    // A service without renames: a copy under the new name, then the old goes.
                    let copied = self.copy_as(
                        context,
                        (&location, &path),
                        (&location, parent(&path)),
                        &name,
                    )?;
                    self.provide(context, &location, "delete", json!({"path": path}))?;
                    copied
                };
                context.publish("changed", json!({}))?;
                let id = location["id"].as_str().unwrap_or_default();
                self.moved(context, id, &path, (id, &to));
                Ok(renamed)
            }
            "move" | "copy" => {
                let location = place()?;
                let path = path()?;
                if path.is_empty() {
                    return Err("Choose a file or a folder".into());
                }
                let target = match input["to_location"].as_str().filter(|to| !to.is_empty()) {
                    Some(to) => self.location(context, to)?,
                    None => location.clone(),
                };
                let into = clean_path(&text("to"))?;
                let same = target["id"] == location["id"];
                if same && (into == path || into.starts_with(&format!("{path}/"))) {
                    return Err("A folder cannot go inside itself".into());
                }
                let destination = join(&into, leaf(&path));
                let provider = location["provider"].as_str().unwrap_or(FOLDER);
                let served = same
                    && self
                        .capabilities(context, provider)
                        .iter()
                        .any(|c| c == name);
                let entry = if served {
                    self.provide(
                        context,
                        &location,
                        name,
                        json!({"from": path, "to": destination}),
                    )?
                } else {
                    let copied = self.copy_across(context, (&location, &path), (&target, &into))?;
                    if name == "move" {
                        self.provide(context, &location, "delete", json!({"path": path}))?;
                    }
                    copied
                };
                if name == "move" {
                    self.moved(
                        context,
                        location["id"].as_str().unwrap_or_default(),
                        &path,
                        (target["id"].as_str().unwrap_or_default(), &destination),
                    );
                }
                context.publish("changed", json!({}))?;
                Ok(entry)
            }
            "delete" => {
                let location = place()?;
                let path = path()?;
                if path.is_empty() {
                    return Err("A location is removed, not deleted".into());
                }
                self.provide(context, &location, "delete", json!({"path": path}))?;
                let id = location["id"].clone();
                self.change(context, "shares", |shares| {
                    shares.retain(|_, share| {
                        share["location"] != id
                            || share["path"].as_str().is_some_and(|shared| {
                                shared != path && !shared.starts_with(&format!("{path}/"))
                            })
                    });
                    Ok(())
                })?;
                Ok(json!({"deleted": path}))
            }
            "share" => {
                let location = place()?;
                let path = path()?;
                let entry = self.provide(context, &location, "stat", json!({"path": path}))?;
                if entry["kind"] != "file" {
                    return Err("Only a file is shared in a chat".into());
                }
                let conversation = conversation.ok_or("Choose the chat")?;
                self.shared(context, &caller, &location, &entry, conversation)
            }
            "unshare" => {
                let id = text("id");
                self.change(context, "shares", |shares| {
                    shares
                        .remove(&id)
                        .ok_or_else(|| "No such shared file".to_owned())
                })?;
                Ok(json!({"unshared": id}))
            }
            // Only a provider says so, for a location of its own.
            "signed_in" => {
                let location = self.location(context, &text("location"))?;
                let by = caller["by"].as_str().unwrap_or_default();
                let provider = location["provider"].as_str().unwrap_or_default();
                let implementations =
                    context.ask("points.implementations", json!({"point": PROVIDERS}))?;
                let its = implementations["implementations"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|known| known["extension"] == by && known["name"] == provider);
                if !its {
                    return Err("Only the location's provider says it signed in".into());
                }
                let id = location["id"].as_str().unwrap_or_default().to_owned();
                let ok = input["ok"] == true;
                let error = input["error"].as_str().map(str::to_owned);
                let account = input["account"].clone();
                self.change(context, "locations", |locations| {
                    let kept = locations.get_mut(&id).ok_or("No such location")?;
                    kept["signed_in"] = json!(ok);
                    kept["error"] = if ok { Value::Null } else { json!(error) };
                    if account.is_string() {
                        kept["account"] = account.clone();
                    }
                    Ok(())
                })?;
                Ok(json!({}))
            }
            "files" => {
                self.locations(context)?;
                let conversation = conversation.ok_or("Choose the chat")?;
                let mut files: Vec<Value> = Self::shares(context)?
                    .into_values()
                    .filter(|share| share["conversation_id"] == conversation)
                    .collect();
                files.sort_by(|a, b| b["updated_at"].as_i64().cmp(&a["updated_at"].as_i64()));
                Ok(json!({"files": files}))
            }
            other => Err(format!("No action `{other}`")),
        }
    }

    fn point(
        &self,
        _context: &Context,
        point: &str,
        implementation: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, String> {
        if point != PROVIDERS || implementation != FOLDER {
            return Err(format!("No implementation of {point} `{implementation}`"));
        }
        folder_operation(operation, &input)
    }
}

zerolux_extension::export!(Storage::default);
