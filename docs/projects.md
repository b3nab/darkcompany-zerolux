# Projects

Projects (`zerolux.projects`, in `marketplace/projects`) is the extension of the workspace's work: projects and their tasks, for people and agents. It is a kernel module, installed like any other extension.

## Sources

Projects come from **sources**. `ZeroLux` is Projects' own, there from the start: its projects and tasks are kept in the workspace. Every other source is a tracker's workspace: a Plane workspace, a Linear workspace, what a ClickUp account reaches… as many as wanted, several of one tracker too. A tracker's projects show as the tracker holds them, live: nothing is copied into ZeroLux or kept in step, and what changes in the tracker shows the next time it is read. A project is ZeroLux's or a tracker's; the two are never linked.

Only a person adds, changes and removes sources; removing one forgets it in ZeroLux, and nothing changes in its tracker.

Projects keeps only what trackers do not: its sources, and the **agent** given a tracker's task, with the sessions that were told of it. A tracker's people are given tasks there; ZeroLux shows them as `people`. A task deleted in its tracker leaves the agent's work, and what ZeroLux kept of it stays, marked deleted.

## Actions

People, agents and other extensions use the same actions, through `/ext/zerolux.projects/<action>`. A project's ID is `<source>:<project>` and a task's `<source>:<project>:<task>`; a source is named by its ID, or by its name when only one has it.

| Action                                                                        |                                                                                                                                                                                               |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trackers`                                                                    | The trackers there are, with the fields a source of each asks for and their capabilities                                                                                                      |
| `sources`                                                                     | The sources, each with its tracker, configuration (never its secrets), account, capabilities and state                                                                                        |
| `add_source {name, tracker, config}`                                          | Adds one; `sign_in.url` when the person signs in to the tracker                                                                                                                               |
| `change_source {id, name?, config?}`                                          | Renames it, or changes its configuration; a secret left out stays                                                                                                                             |
| `sign_in {id}`, `remove_source {id}`                                          | Signs in again; forgets it in ZeroLux                                                                                                                                                         |
| `projects {source?}`                                                          | The projects of one source or of all, each `{id, source, key?, name, description?, archived, url?}`; a source that cannot be read is in `errors`                                              |
| `create_project {source?, name, key, description?}`, `update_project {id, …}` | In a source that can: ZeroLux's own, by default                                                                                                                                               |
| `tasks {project_id}`                                                          | A project's tasks, live from its source                                                                                                                                                       |
| `tasks {assignee}`                                                            | A person's or an agent's tasks in every source: ZeroLux's own, and each tracker's task given to the agent here                                                                                |
| `task {id}`                                                                   | A task, with its comments and the sessions told of it                                                                                                                                         |
| `create_task {project_id, title, …}`, `update_task {id, …}`                   | In its source: `status`, `priority`, `labels`, `due`, `description`; `assignee` is a person or an agent here, an agent in a tracker. An agent given a task hears of it in its running session |
| `comment {id, text}`, `delete_task {id}`                                      | In its source                                                                                                                                                                                 |

A task is `{id, source, project_id, key, title, description, status, priority, labels, due, assignee, people, url, updated_at}`. `status` is one of `backlog`, `todo`, `in_progress`, `in_review`, `done`, `cancelled`; `priority` one of `none`, `low`, `medium`, `high`, `urgent`. Projects publishes `task.created`, `task.updated`, `task.assigned` and `changed`.

## Trackers

A tracker implements Projects' `zerolux.projects/trackers@2`. Every operation is given the `source` ID and its `config`:

- `describe`: its `title`, `description`, the `fields` a source asks for, whether the person signs in (`sign_in`), and its `capabilities` (`create_project`, `edit_project`, `comments`, `labels`, `due`, `priority`, `delete`).
- `connect {source, config, previous, origin}`: takes a new or changed configuration, keeps its secrets among the tracker's own, and answers with what is shown of it, `config`, its `account`, and `sign_in.url` when the person signs in. When a sign-in ends, the tracker runs Projects' `signed_in {source, ok, error?, account?}`.
- `check`, `forget`, `projects`, `create_project`, `tasks {project}`, `task {project, task}` (with `comments`, each `{id, by, author, text, at}`), `create_task {project, task}`, `update_task {project, task, changes}`, `comment {project, task, text}`, `delete_task {project, task}`. A task it cannot find is refused with `not found` in its reason.

- **Plane** (`zerolux.plane`): a Plane workspace, cloud or self-hosted, with its API key; its projects and work items, labels made where they are missing.
- **Linear** (`zerolux.linear`): a Linear workspace, with its API key; its teams and their issues. A deleted issue goes to Linear's trash.
- **ClickUp** (`zerolux.clickup`): what a ClickUp account reaches, with its API token; the lists of its spaces and folders, and their tasks; labels are its tags.
