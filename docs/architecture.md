# Architecture

## Parts

- **Kernel** (`crates/zerolux`): a Rust library and CLI executable with a shared server lifecycle. It serves the JSON API and the web app, stores data, runs the chat runtime and the harness drivers. Built on Axum and SeaORM.
- **Database**: SQLite, built in and supported permanently, or shared PostgreSQL for replicas. See [foundations](foundations.md).
- **Clients**: web (`apps/web`), desktop (`apps/desktop`) and mobile (`apps/mobile`) share chat logic (`packages/chat`) and [themes](themes.md) (`packages/theme`). Tauri uses the packaged interface to connect to a kernel, or explicitly hosts the kernel library for a local workspace. Connection identity, lifecycle, assets and desktop-private preferences are described in [desktop](desktop.md).
- **Sessions**: native sessions of pi, Claude Code and Codex, each one a session in ZeroLux, with or without an agent. Agents, chats and the organization are a layer on top of them.
- **Harnesses**: pi, Claude Code and Codex sessions join ZeroLux, and may work as agents. The kernel drives Codex through its app-server and Claude Code through its session inbox; pi loads ZeroLux's integration, a pi extension (`harnesses/pi`). Detached hosts in `harnesses/claude` and `harnesses/pi` keep managed execution independent of the kernel's lifetime. New sessions use native configuration. Claude and Codex recover through their native resume APIs with the saved session identity; managed pi also keeps the launch profile needed by its RPC host.
- **Real time**: LiveKit carries small change events, and what sessions are producing as it streams; clients read messages and state over HTTP.

## Component boundaries

The kernel owns workspace rules and persistent state, independently of its CLI or desktop host. Clients consume the same HTTP API; the desktop does not introduce a second domain API through Tauri commands. Authentication, update mechanisms, storage adapters and future client modules must respect these boundaries. Modularity includes clients and themes, not only server components. [Extensions](extensions.md) add actions, extension points, events and triggers to a workspace through the same API.

## Native agent observability and control

ZeroLux provides full observability and control over agents and all their output, uniformly for pi, Claude Code and Codex. Agent Console integrates native history, output, tool activity, errors and intervention requests into the kernel. Native input, approvals and interruption are kernel capabilities.

Chats, agents, automations and clients reuse this data and these controls through the kernel API. See [native observability and control](chat.md#native-observability-and-control).

## Control plane and execution hosts

A workspace has one authoritative control plane, served by a local SQLite kernel or replicas sharing PostgreSQL and authentication. Native process ownership remains host-local. Harnesses may run on that machine or on an owner's PC or VPS, through a desktop or CLI/server host. An execution host is not an independent authority for the same workspace.

The harness host owns its native processes, session files, configuration and execution leases. The kernel owns company state and coordinates actions on the appropriate host. An unreachable host is not proof that its native execution died, and does not authorize starting a replacement elsewhere.

Web, desktop and mobile command the same control plane. Hiring or starting an agent is not inherently restricted to the computer UI; a folder names a location on the selected execution host, not necessarily on the client or kernel machine. A remote workspace page does not gain direct local file/process privileges merely because the desktop can host execution.

**Current limitation:** chat discovery and creation are implemented locally to the kernel. Remote execution-host enrollment and routing are not implemented yet. Missing client controls are also implementation gaps, not restrictions of this architecture.

## Workspace and actors

The workspace has a generated ID, an editable name and a creation date, preserved across restarts. `GET /workspace` includes its metadata in `workspace`; the owner renames it with `POST /workspace {"name":"…"}`. Renaming changes neither its ID nor its date. The clients show these details in workspace settings.

Humans and agents are actors with generated UUIDs and creation dates shown in their profiles. Each agent has a human owner. The owner is found among the workspace actors, never by a fixed ID.

Native settings belong to each session and are observed, not enforced. Harness adapters project public values and native model/effort catalogs; the kernel changes a session's settings through its harness and persists confirmed snapshots in its locator, for its relaunch. An agent's settings are the defaults its new sessions start with. Owner controls are serialized per session, without holding database transactions across native requests. Unavailable or foreign-host controls fail closed. See [native settings](byoh.md#native-settings).

`created_at` stores a Unix timestamp in milliseconds. Displayed calendar dates use UTC; the company day counter starts at 1.

## API

All routes are under `/api`. Main groups:

| Routes                                                                                                                                                  | Purpose                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/health`, `/workspace`, `/onboarding/owner`                                                                                                            | Kernel status, workspace metadata and snapshot, owner name                                                                                                  |
| `/actors`                                                                                                                                               | Agents hired by name, renamed                                                                                                                               |
| `/actors/{id}/settings`                                                                                                                                 | An agent's defaults for its new sessions                                                                                                                    |
| `/auth/identity`, `/auth/claim`, `/auth/invites/{token}`, `/auth/*`                                                                                     | Sign-in: who the account is, binding it to the owner or a new person, invitations, Better Auth                                                              |
| `/invites`, `/invites/{id}`, `/hosts`, `/hosts/link`, `/hosts/join`, `/hosts/channel`, `/hosts/{id}`, `/hosts/{id}/accounts/*`                          | The owner's invitations; the computers that run sessions, whose they are, whom they are open to and a guest's harness accounts there                        |
| `/sessions`, `/sessions/{id}`, `/sessions/discover`, `/sessions/attach`, `/sessions/catalog`, `/sessions/search`                                        | Sessions with or without an agent: create, list, organize, search, discover and open native ones                                                            |
| `/sessions/{id}/output`, `/events`, `/subagents`, `/live`, `/input`, `/interrupt`, `/compact`, `/settings`, `/stop`, `/resume`                          | The session's native record, its common events and its subagents', what it is producing now, input, turn control, compaction, native settings and lifecycle |
| `/sessions/{id}/commands`, `/files`, `/queue/{item}`, `/goal`, `/fork`, `/rewind-files`, `/schedules`, `/schedules/{id}`, `/triggers`, `/triggers/{id}` | The harness's commands, files to mention, the waiting queue, the goal, forks, file checkpoints, schedules and CI triggers                                   |
| `/sessions/{id}/tasks`, `/tasks/{id}`, `/tasks/{id}/stop`                                                                                               | Commands a session runs in the background; the session is told how each ends                                                                                |
| `/sessions/{id}/git`, `/git/*`, `/file`, `/sessions/{id}/terminals`, `/terminals/{id}`                                                                  | The code in a session's folder: git status, diffs, the owner's git actions and pull requests, files, terminals                                              |
| `/conversations`                                                                                                                                        | Chats, threads, members and messages                                                                                                                        |
| `/chat/inbox`, `/chat/deliveries`, `/chat/approvals`, `/chat/sessions/{id}/status`, `/activity`, `/live`                                                | What a session's integration reads and reports: deliveries, receipts, requests, state and streamed output                                                   |
| `/extensions`, `/extensions/folder`, `/extensions/{id}`, `/extensions/{id}/enable`, `/disable`, `/settings`, `/actions`, `/ext/{extension}/{action}`    | The workspace's [extensions](extensions.md), their settings, and their actions for people and agents                                                        |
| `/livekit/token`                                                                                                                                        | Real-time token for clients                                                                                                                                 |

Timestamps are Unix milliseconds. Request bodies are limited to 1 MiB.
