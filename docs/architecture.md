# Architecture

## Parts

- **Kernel** (`crates/zerolux`): a Rust library and CLI executable with a shared server lifecycle. It serves the JSON API and the web app, stores data, runs the chat runtime and the harness drivers. Built on Axum and SQLx.
- **Database**: SQLite, built in and used by default.
- **Clients**: web (`apps/web`), desktop (`apps/desktop`) and mobile (`apps/mobile`) share chat logic (`packages/chat`) and [themes](themes.md) (`packages/theme`). Tauri uses the packaged interface to connect to a kernel, or explicitly hosts the kernel library for a local workspace. Connection identity, lifecycle, assets and desktop-private preferences are described in [desktop](desktop.md).
- **Harnesses**: pi, Claude Code and Codex sessions join as agents. The kernel drives Codex through its app-server and Claude Code through its session inbox; pi runs the ZeroLux extension (`extensions/pi`). The Claude Code runner (`extensions/claude`) runs sessions that ZeroLux starts itself.
- **Real time**: LiveKit carries small change events; clients then read messages and state over HTTP.

## Component boundaries

The kernel owns workspace rules and persistent state, independently of its CLI or desktop host. Clients consume the same HTTP API; the desktop does not introduce a second domain API through Tauri commands. Authentication, update mechanisms, storage adapters and future client modules must respect these boundaries. Modularity includes clients and themes, not only server components; this is a design requirement, not a claim that a community plugin loader is already implemented.

## Control plane and execution hosts

A workspace has one authoritative kernel: its control plane. Harnesses may run on that machine or on an owner's PC or VPS, through a desktop or CLI/server host. An execution host is not another authoritative kernel for the same workspace.

The harness host owns its native processes, session files, configuration and execution leases. The kernel owns company state and coordinates actions on the appropriate host. An unreachable host is not proof that its native execution died, and does not authorize starting a replacement elsewhere.

Web, desktop and mobile command the same control plane. Hiring or starting an agent is not inherently restricted to the computer UI; a folder names a location on the selected execution host, not necessarily on the client or kernel machine. A remote workspace page does not gain direct local file/process privileges merely because the desktop can host execution.

**Current limitation:** chat discovery and creation are implemented locally to the kernel. Remote execution-host enrollment and routing are not implemented yet. Missing client controls are also implementation gaps, not restrictions of this architecture.

## Workspace and actors

The workspace has a generated ID, an editable name and a creation date, preserved across restarts. `GET /workspace` includes its metadata in `workspace`; the owner renames it with `POST /workspace {"name":"…"}`. Renaming changes neither its ID nor its date. The clients show these details in workspace settings.

Humans and agents are actors with generated UUIDs and creation dates shown in their profiles. Each agent has a human owner. The owner is found among the workspace actors, never by a fixed ID.

`created_at` stores a Unix timestamp in milliseconds. Displayed calendar dates use UTC; the company day counter starts at 1.

## Tasks

```text
draft --queue--> queued --claim--> running --exit 0--> review --approve--> done
                                           --error---> failed --retry----> queued
                                   review --request changes--> queued
```

A successful run goes to review, never straight to done: a person approves it. A failed or expired run is never retried on its own.

## API

All routes are under `/api`. Main groups:

| Routes                                               | Purpose                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| `/health`, `/workspace`, `/onboarding/owner`         | Kernel status, workspace metadata and snapshot, owner name |
| `/actors`, `/projects`, `/tasks`                     | Agents, projects, tasks and their actions                  |
| `/connections`, `/worker`                            | Task workers: connect, claim, heartbeat, finish            |
| `/sessions`, `/chat/hire`, `/chat/sessions`          | Discover and link harness sessions                         |
| `/conversations`                                     | Chats, threads, members and messages                       |
| `/chat/inbox`, `/chat/deliveries`, `/chat/approvals` | Delivery, receipts and permission requests for agents      |
| `/livekit/token`                                     | Real-time token for clients                                |

Timestamps are Unix milliseconds. Request bodies are limited to 1 MiB.
