//! ZeroLux's Storage, a kernel module: the workspace's files, uploaded by people and written by
//! agents, in folders, some shared in a chat. Where their bytes are kept is a provider's:
//! Storage opens `zerolux.storage/providers@1` and implements it itself as `local`, in its own
//! folder; other extensions implement it for S3, Google Drive and others. What is known of each
//! file is kept in the workspace, as one of Storage's values.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

use zerolux_extension::{Caller, Context, Extension, Value, json, serde_json};

/// The point providers implement.
pub const PROVIDERS: &str = "zerolux.storage/providers@1";
/// The largest file `write` and `read` take as text.
const TEXT: usize = 1024 * 1024;

#[derive(Default)]
pub struct Storage {
    /// Changes to what is known of the files go one at a time.
    files: Mutex<()>,
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type": "object", "properties": properties, "required": required})
}

impl Storage {
    fn read_files(context: &Context) -> Result<BTreeMap<String, Value>, String> {
        let stored = context.get_value("files")?;
        if stored.is_null() {
            return Ok(BTreeMap::new());
        }
        serde_json::from_value(stored).map_err(|error| error.to_string())
    }

    fn change<T>(
        &self,
        context: &Context,
        change: impl FnOnce(&mut BTreeMap<String, Value>) -> Result<T, String>,
    ) -> Result<T, String> {
        let _held = self.files.lock().map_err(|_| "Storage is unavailable")?;
        let mut files = Self::read_files(context)?;
        let result = change(&mut files)?;
        context.set_value("files", json!(files))?;
        context.publish("changed", json!({}))?;
        Ok(result)
    }

    /// The folders made on their own, empty or not.
    fn read_folders(context: &Context) -> Result<std::collections::BTreeSet<String>, String> {
        let stored = context.get_value("folders")?;
        if stored.is_null() {
            return Ok(Default::default());
        }
        serde_json::from_value(stored).map_err(|error| error.to_string())
    }

    /// Changes the files and the folders together, one change at a time.
    fn change_all<T>(
        &self,
        context: &Context,
        change: impl FnOnce(
            &mut BTreeMap<String, Value>,
            &mut std::collections::BTreeSet<String>,
        ) -> Result<T, String>,
    ) -> Result<T, String> {
        let _held = self.files.lock().map_err(|_| "Storage is unavailable")?;
        let mut files = Self::read_files(context)?;
        let mut folders = Self::read_folders(context)?;
        let result = change(&mut files, &mut folders)?;
        context.set_value("files", json!(files))?;
        context.set_value("folders", json!(folders))?;
        context.publish("changed", json!({}))?;
        Ok(result)
    }

    fn provider(context: &Context) -> String {
        context.settings()["provider"]
            .as_str()
            .filter(|name| !name.is_empty())
            .unwrap_or("local")
            .to_owned()
    }

    /// Where the local provider keeps a key's bytes.
    fn local(context: &Context, key: &str) -> Result<PathBuf, String> {
        if key.is_empty() || key.contains(['/', '\\']) || key.starts_with('.') {
            return Err("Invalid key".into());
        }
        let folder = Path::new(&context.folder()).join("files");
        std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
        Ok(folder.join(key))
    }

    /// Asks the chosen provider; `local` is Storage's own.
    fn provide(
        &self,
        context: &Context,
        provider: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, String> {
        if provider == "local" {
            return self.local_operation(context, operation, input);
        }
        context.call(PROVIDERS, provider, operation, input)
    }

    fn local_operation(
        &self,
        context: &Context,
        operation: &str,
        input: Value,
    ) -> Result<Value, String> {
        let key = input["key"].as_str().unwrap_or_default();
        match operation {
            "put" => {
                let from = input["path"].as_str().ok_or("Give the file's path")?;
                let to = Self::local(context, key)?;
                // A file given to an action is the kernel's to remove: moved when it can be.
                if std::fs::rename(from, &to).is_err() {
                    std::fs::copy(from, &to).map_err(|error| error.to_string())?;
                }
                Ok(json!({}))
            }
            "get" => {
                let path = Self::local(context, key)?;
                if !path.is_file() {
                    return Err("The file's bytes are not there".into());
                }
                Ok(json!({"path": path, "temporary": false}))
            }
            "delete" => {
                let _ = std::fs::remove_file(Self::local(context, key)?);
                Ok(json!({}))
            }
            other => Err(format!("No operation `{other}`")),
        }
    }

    fn stored(&self, context: &Context, caller: &Caller, new: New) -> Result<Value, String> {
        let New {
            name,
            folder,
            content_type,
            conversation,
            path,
        } = new;
        let name = clean_name(name)?;
        let folder = clean_folder(folder)?;
        let size = std::fs::metadata(path)
            .map_err(|error| error.to_string())?
            .len();
        let id = uuid::Uuid::new_v4().to_string();
        let provider = Self::provider(context);
        self.provide(
            context,
            &provider,
            "put",
            json!({"key": id, "path": path, "name": name, "content_type": content_type}),
        )?;
        let now = now_ms();
        let file = json!({"id": id, "name": name, "folder": folder, "size": size,
            "content_type": content_type,
            "created_by": caller["actor_id"].as_str().or(caller["by"].as_str()).unwrap_or_default(),
            "created_at": now, "updated_at": now, "conversation_id": conversation,
            "provider": provider});
        self.change(context, |files| {
            files.insert(id.clone(), file.clone());
            Ok(())
        })?;
        Ok(file)
    }

    fn one(context: &Context, id: &str) -> Result<Value, String> {
        Self::read_files(context)?
            .remove(id)
            .ok_or_else(|| "No such file".into())
    }
}

/// A file to keep: its name, folder, type, the chat it is shared in, and where it is now.
struct New<'a> {
    name: &'a str,
    folder: &'a str,
    content_type: &'a str,
    conversation: Option<&'a str>,
    path: &'a str,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}

fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 255
        || name.contains(['/', '\\'])
        || name == "."
        || name == ".."
    {
        return Err("A file's name is 1 to 255 bytes, without slashes".into());
    }
    Ok(name.to_owned())
}

/// A folder as `a/b`, without empty or dot parts; the top is empty.
fn clean_folder(folder: &str) -> Result<String, String> {
    let parts: Vec<&str> = folder
        .split('/')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    if parts
        .iter()
        .any(|part| *part == "." || *part == ".." || part.contains('\\'))
        || folder.len() > 1024
    {
        return Err("Invalid folder".into());
    }
    Ok(parts.join("/"))
}

impl Extension for Storage {
    fn initialize(&self, _context: &Context) -> Result<Value, String> {
        let id = json!({"id": {"type": "string"}});
        Ok(json!({
            "actions": [
                {"name": "files", "title": "Files", "description": "The workspace's files, in a folder or a chat, or all",
                    "input": object(json!({"folder": {"type": "string"}, "conversation_id": {"type": "string"}}), &[])},
                {"name": "folders", "title": "Folders", "description": "Every folder, empty or not"},
                {"name": "create_folder", "title": "New folder", "description": "Makes a folder, which stays while empty",
                    "effects": "write", "input": object(json!({"folder": {"type": "string"}}), &["folder"])},
                {"name": "rename_folder", "title": "Rename folder", "description": "Gives a folder another name, with what it holds",
                    "effects": "write",
                    "input": object(json!({"folder": {"type": "string"}, "name": {"type": "string"}}), &["folder", "name"])},
                {"name": "move_folder", "title": "Move folder", "description": "Puts a folder, with what it holds, in another",
                    "effects": "write",
                    "input": object(json!({"folder": {"type": "string"}, "into": {"type": "string"}}), &["folder", "into"])},
                {"name": "delete_folder", "title": "Delete folder", "description": "Deletes a folder and everything in it",
                    "effects": "destructive", "input": object(json!({"folder": {"type": "string"}}), &["folder"])},
                {"name": "upload", "title": "Upload", "description": "Keeps the file sent with it, in a folder or shared in a chat",
                    "effects": "write", "seconds": 600,
                    "input": object(json!({"file": {"type": "object"}, "folder": {"type": "string"},
                        "conversation_id": {"type": "string"}, "name": {"type": "string"}}), &["file"])},
                {"name": "write", "title": "Write a file", "description": "Keeps a text file, up to 1 MiB",
                    "effects": "write",
                    "input": object(json!({"name": {"type": "string"}, "text": {"type": "string"},
                        "folder": {"type": "string"}, "conversation_id": {"type": "string"},
                        "content_type": {"type": "string"}}), &["name", "text"])},
                {"name": "read", "title": "Read a file", "description": "A text file's text, up to 1 MiB",
                    "input": object(id.clone(), &["id"])},
                {"name": "download", "title": "Download", "description": "A file's bytes",
                    "input": object(id.clone(), &["id"])},
                {"name": "rename", "title": "Rename", "description": "Gives a file another name", "effects": "write",
                    "input": object(json!({"id": {"type": "string"}, "name": {"type": "string"}}), &["id", "name"])},
                {"name": "move", "title": "Move", "description": "Puts a file in another folder", "effects": "write",
                    "input": object(json!({"id": {"type": "string"}, "folder": {"type": "string"}}), &["id", "folder"])},
                {"name": "share", "title": "Share in a chat", "description": "Shares a file in a chat, or no longer",
                    "effects": "write",
                    "input": object(json!({"id": {"type": "string"},
                        "conversation_id": {"type": ["string", "null"]}}), &["id", "conversation_id"])},
                {"name": "delete", "title": "Delete", "description": "Deletes a file", "effects": "destructive",
                    "input": object(id, &["id"])},
            ],
            "points": [{"name": "providers", "version": 1,
                "description": "Where Storage keeps files' bytes",
                "operations": [
                    {"name": "put", "description": "Keeps the file at a local path under a key",
                        "input": object(json!({"key": {"type": "string"}, "path": {"type": "string"},
                            "name": {"type": "string"}, "content_type": {"type": "string"}}), &["key", "path"])},
                    {"name": "get", "description": "A local path to read a key's bytes from, and whether it is a temporary copy",
                        "input": object(json!({"key": {"type": "string"}}), &["key"])},
                    {"name": "delete", "description": "Lets a key's bytes go",
                        "input": object(json!({"key": {"type": "string"}}), &["key"])},
                ]}],
            "implements": [{"point": PROVIDERS, "name": "local", "title": "This computer"}],
            "events": [{"name": "changed", "description": "Files were added, changed or deleted"}],
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
        match name {
            "files" => {
                let folder = input["folder"].as_str().map(clean_folder).transpose()?;
                let mut files: Vec<Value> = Self::read_files(context)?
                    .into_values()
                    .filter(|file| {
                        folder
                            .as_deref()
                            .is_none_or(|folder| file["folder"] == folder)
                            && conversation.is_none_or(|id| file["conversation_id"] == id)
                    })
                    .collect();
                files.sort_by(|a, b| b["updated_at"].as_i64().cmp(&a["updated_at"].as_i64()));
                Ok(json!({"files": files}))
            }
            "folders" => {
                // Those made on their own, those that hold files, and every folder above them.
                let mut folders = Self::read_folders(context)?;
                folders.extend(
                    Self::read_files(context)?
                        .values()
                        .filter_map(|file| file["folder"].as_str().map(str::to_owned)),
                );
                let mut all = std::collections::BTreeSet::new();
                for folder in folders.into_iter().filter(|folder| !folder.is_empty()) {
                    let mut parts = Vec::new();
                    for part in folder.split('/') {
                        parts.push(part);
                        all.insert(parts.join("/"));
                    }
                }
                Ok(json!({"folders": all}))
            }
            "create_folder" => {
                let folder = clean_folder(&text("folder"))?;
                if folder.is_empty() {
                    return Err("Name the folder".into());
                }
                self.change_all(context, |_, folders| {
                    folders.insert(folder.clone());
                    Ok(json!({"folder": folder}))
                })
            }
            "rename_folder" | "move_folder" => {
                let from = clean_folder(&text("folder"))?;
                if from.is_empty() {
                    return Err("Name the folder".into());
                }
                let leaf = from.rsplit('/').next().unwrap_or_default().to_owned();
                let to = if name == "rename_folder" {
                    let renamed = clean_name(&text("name"))?;
                    match from.rsplit_once('/') {
                        Some((parent, _)) => format!("{parent}/{renamed}"),
                        None => renamed,
                    }
                } else {
                    let into = clean_folder(&text("into"))?;
                    if into == from || into.starts_with(&format!("{from}/")) {
                        return Err("A folder cannot go inside itself".into());
                    }
                    if into.is_empty() {
                        leaf
                    } else {
                        format!("{into}/{leaf}")
                    }
                };
                let moved = |folder: &str| -> Option<String> {
                    if folder == from {
                        Some(to.clone())
                    } else {
                        folder
                            .strip_prefix(&format!("{from}/"))
                            .map(|rest| format!("{to}/{rest}"))
                    }
                };
                self.change_all(context, |files, folders| {
                    let now = now_ms();
                    for file in files.values_mut() {
                        if let Some(folder) = file["folder"].as_str().and_then(moved) {
                            file["folder"] = json!(folder);
                            file["updated_at"] = json!(now);
                        }
                    }
                    *folders = folders
                        .iter()
                        .map(|folder| moved(folder).unwrap_or_else(|| folder.clone()))
                        .collect();
                    if !folders.contains(&to) {
                        folders.insert(to.clone());
                    }
                    Ok(json!({"folder": to}))
                })
            }
            "delete_folder" => {
                let folder = clean_folder(&text("folder"))?;
                if folder.is_empty() {
                    return Err("Name the folder".into());
                }
                let inside = |path: &str| path == folder || path.starts_with(&format!("{folder}/"));
                let gone = self.change_all(context, |files, folders| {
                    let gone: Vec<Value> = files
                        .values()
                        .filter(|file| file["folder"].as_str().is_some_and(inside))
                        .cloned()
                        .collect();
                    files.retain(|_, file| !file["folder"].as_str().is_some_and(inside));
                    folders.retain(|path| !inside(path));
                    Ok(gone)
                })?;
                for file in &gone {
                    let provider = file["provider"].as_str().unwrap_or("local").to_owned();
                    let _ = self.provide(context, &provider, "delete", json!({"key": file["id"]}));
                }
                Ok(json!({"deleted": gone.len()}))
            }
            "upload" => {
                let file = &input["file"];
                let path = file["path"]
                    .as_str()
                    .ok_or("Send the file with the action")?;
                let name = input["name"]
                    .as_str()
                    .filter(|name| !name.trim().is_empty())
                    .or(file["name"].as_str())
                    .unwrap_or_default();
                let content_type = file["content_type"]
                    .as_str()
                    .unwrap_or("application/octet-stream");
                self.stored(
                    context,
                    &caller,
                    New {
                        name,
                        folder: &text("folder"),
                        content_type,
                        conversation,
                        path,
                    },
                )
            }
            "write" => {
                let body = text("text");
                if body.len() > TEXT {
                    return Err("A text file is up to 1 MiB".into());
                }
                let staged = Path::new(&context.folder())
                    .join(format!(".writing-{}", uuid::Uuid::new_v4().simple()));
                std::fs::write(&staged, body.as_bytes()).map_err(|error| error.to_string())?;
                let content_type = input["content_type"]
                    .as_str()
                    .unwrap_or("text/plain; charset=utf-8")
                    .to_owned();
                let stored = self.stored(
                    context,
                    &caller,
                    New {
                        name: &text("name"),
                        folder: &text("folder"),
                        content_type: &content_type,
                        conversation,
                        path: &staged.to_string_lossy(),
                    },
                );
                let _ = std::fs::remove_file(&staged);
                stored
            }
            "read" | "download" => {
                let file = Self::one(context, &text("id"))?;
                let provider = file["provider"].as_str().unwrap_or("local").to_owned();
                let got = self.provide(context, &provider, "get", json!({"key": file["id"]}))?;
                let path = got["path"].as_str().ok_or("The provider gave no file")?;
                if name == "download" {
                    return Ok(json!({"$file": {"path": path, "name": file["name"],
                        "content_type": file["content_type"], "temporary": got["temporary"]}}));
                }
                let bytes = std::fs::read(path).map_err(|error| error.to_string());
                if got["temporary"] == true {
                    let _ = std::fs::remove_file(path);
                }
                let bytes = bytes?;
                if bytes.len() > TEXT {
                    return Err("The file is larger than 1 MiB; download it".into());
                }
                let text = String::from_utf8(bytes)
                    .map_err(|_| "The file is not text; download it".to_owned())?;
                Ok(json!({"file": file, "text": text}))
            }
            "rename" | "move" | "share" => {
                let id = text("id");
                let renamed = if name == "rename" {
                    Some(clean_name(&text("name"))?)
                } else {
                    None
                };
                let moved = if name == "move" {
                    Some(clean_folder(&text("folder"))?)
                } else {
                    None
                };
                self.change(context, |files| {
                    let file = files.get_mut(&id).ok_or("No such file")?;
                    if let Some(renamed) = renamed {
                        file["name"] = json!(renamed);
                    }
                    if let Some(moved) = moved {
                        file["folder"] = json!(moved);
                    }
                    if name == "share" {
                        file["conversation_id"] = json!(conversation);
                    }
                    file["updated_at"] = json!(now_ms());
                    Ok(file.clone())
                })
            }
            "delete" => {
                let id = text("id");
                let file = self.change(context, |files| {
                    files.remove(&id).ok_or_else(|| "No such file".to_owned())
                })?;
                let provider = file["provider"].as_str().unwrap_or("local").to_owned();
                self.provide(context, &provider, "delete", json!({"key": id}))?;
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
        if point != PROVIDERS || implementation != "local" {
            return Err(format!("No implementation of {point} `{implementation}`"));
        }
        self.local_operation(context, operation, input)
    }
}

zerolux_extension::export!(Storage::default);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_folders_stay_within_storage() {
        assert_eq!(clean_folder(" a / b /").unwrap(), "a/b");
        assert_eq!(clean_folder("").unwrap(), "");
        assert!(clean_folder("a/../b").is_err());
        assert!(clean_name("a/b").is_err());
        assert!(clean_name("..").is_err());
        assert_eq!(clean_name(" report.pdf ").unwrap(), "report.pdf");
    }
}
