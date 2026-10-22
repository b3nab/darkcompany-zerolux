# Storage

Storage (`zerolux.storage`, in `marketplace/storage`) is the extension that shows the workspace's files where they are. It is a kernel module, installed like any other extension.

## Locations

A **location** is a provider with its configuration and account: a folder on the kernel's computer, a Google Drive, an S3 bucket… A workspace has as many as it wants, of any provider, several of one too. Each shows what its service holds, as the service holds it, live: nothing is copied into ZeroLux or kept in step, and what changes on the service shows at once. ZeroLux's own location, `ZeroLux`, is the workspace's storage area (`storage/` in the data folder), where its people and agents keep their files; it is there from the start and cannot be removed.

Only a person adds, changes and removes locations; removing one forgets it in ZeroLux, and its files stay where they are. One location is where chat attachments go (`Chats/` in it): ZeroLux's own, at first.

Storage keeps only what the services do not: its locations, and the files shared in chats, each by location and path. A shared file follows what Storage itself renames or moves.

## Actions

People, agents and other extensions use the same actions, through `/ext/zerolux.storage/<action>`. A location is named by its ID, or by its name when only one has it; a path is `folder/file` within it, the top empty, and never leaves it.

| Action                                                                               |                                                                                                                                   |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `providers`                                                                          | The providers there are, with the fields a location of each asks for and their capabilities                                       |
| `locations`                                                                          | The locations, each with its provider, configuration (never its secrets), capabilities, account and state                         |
| `add_location {name, provider, config}`                                              | Adds one; `sign_in.url` when the person signs in to the service                                                                   |
| `change_location {id, name?, config?}`                                               | Renames it, or changes its configuration; a secret left out stays                                                                 |
| `sign_in {id}`                                                                       | The address to sign in to the service again                                                                                       |
| `check_location {id}`                                                                | Whether it can be reached, and with which account                                                                                 |
| `remove_location {id}`                                                               | Forgets it in ZeroLux                                                                                                             |
| `list {location, path?}`                                                             | What a folder holds: each `{name, path, kind, size?, modified?, content_type?}`                                                   |
| `search {query, location?}`                                                          | Names that hold the words, in one location or all that can search                                                                 |
| `read {location, path}`                                                              | A text file's text, up to 1 MiB                                                                                                   |
| `download {location, path}` or `{id}`                                                | A file's bytes, or a shared file's by its ID                                                                                      |
| `upload {location?, path?, conversation_id?}` with a file                            | Keeps it in a folder; with `conversation_id`, shares it in that chat. A name already there gets a number                          |
| `write {location?, path, text, conversation_id?}`                                    | Writes a text file, replacing what is there                                                                                       |
| `create_folder`, `rename {name}`, `delete`                                           | As they say, where the file is; `delete` takes a folder with what it holds                                                        |
| `move` and `copy {location, path, to_location?, to}`                                 | Into a folder of the same location or another: by the service within one, through ZeroLux across two, folders with what they hold |
| `share {location, path, conversation_id}`, `unshare {id}`, `files {conversation_id}` | Files shared in a chat                                                                                                            |

Without `location`, an action uses the location chat attachments go to. Storage publishes `changed` when locations, files or shares change.

## Providers

A provider implements Storage's `zerolux.storage/providers@2`. Every operation is given the `location` ID and its `config`:

- `describe`: its `title`, `description`, the `fields` a location asks for (`{key, label, type, required?, description?, options?}`, `type` `text`, `secret`, `choice`, `boolean` or `folder`, a folder on the kernel's computer chosen by browsing it), whether the person signs in (`sign_in`), and its `capabilities` (`write`, `move`, `copy`, `delete`, `search`).
- `connect {location, config, previous, origin}`: takes a new or changed configuration, keeps its secrets among the provider's own, and answers with what is shown of it, `config`, its `account`, and `sign_in.url` when the person signs in. When a sign-in ends, the provider runs Storage's `signed_in {location, ok, error?, account?}`.
- `check`, `forget` (its secrets go), `list {path}`, `stat {path}`, `read {path}` (a local path and whether it is a temporary copy, and a `name` when the service gives it in another format), `write {path, from, owned}` (`owned`: the file at `from` is the writer's to move), `mkdir`, `move {from, to}`, `copy {from, to}`, `delete`, `search {query}`.

What a provider cannot do, Storage does with what it can: a rename as a copy and a delete, a move across locations as a copy and a delete.

- **Folder**, Storage's own: a folder on the kernel's computer, by its full path.
- **S3** (`zerolux.s3`): a bucket, or a folder of one, of Amazon S3, Cloudflare R2, MinIO and the like, with its keys. An empty folder is kept as an empty object named with a slash at its end.
- **Google Drive** (`zerolux.drive`): My Drive, one of its folders, or a shared drive, with access to all of Drive. Who adds a location signs in with Google through the kernel's OAuth, with their own OAuth client, or with the publisher's once it registers one. Google's own documents are read in Office formats; deleting puts a file in Drive's trash.
