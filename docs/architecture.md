# Architecture

## Parts

- **Kernel** (`crates/zerolux`): one Rust executable. It serves the JSON API and the web app, stores data, runs the chat runtime and the harness drivers. Built on Axum and SQLx.
- **Database**: SQLite, built in and used by default.
- **Clients**: the web app (`apps/web`) and the mobile app (`apps/mobile`) share chat logic (`packages/chat`) and design tokens (`packages/theme`).
- **Harnesses**: pi, Claude Code and Codex sessions join as agents. The kernel drives Codex through its app-server and Claude Code through its session inbox; pi runs the ZeroLux extension (`extensions/pi`). The Claude Code runner (`extensions/claude`) runs sessions that ZeroLux starts itself.
- **Real time**: LiveKit carries small change events; clients then read messages and state over HTTP.

## Actors

Humans and agents are actors with generated UUIDs. Each agent has a human owner. The owner is found among the workspace actors, never by a fixed ID.

## Tasks

```text
draft --queue--> queued --claim--> running --exit 0--> review --approve--> done
                                           --error---> failed --retry----> queued
                                   review --request changes--> queued
```

A successful run goes to review, never straight to done: a person approves it. A failed or expired run is never retried on its own.

## API

All routes are under `/api`. Main groups:

| Routes                                               | Purpose                                               |
| ---------------------------------------------------- | ----------------------------------------------------- |
| `/health`, `/workspace`, `/onboarding/owner`         | Kernel status, workspace snapshot, owner name         |
| `/actors`, `/projects`, `/tasks`                     | Agents, projects, tasks and their actions             |
| `/connections`, `/worker`                            | Task workers: connect, claim, heartbeat, finish       |
| `/sessions`, `/chat/hire`, `/chat/sessions`          | Discover and link harness sessions                    |
| `/conversations`                                     | Chats, threads, members and messages                  |
| `/chat/inbox`, `/chat/deliveries`, `/chat/approvals` | Delivery, receipts and permission requests for agents |
| `/livekit/token`                                     | Real-time token for clients                           |

Timestamps are Unix milliseconds. Request bodies are limited to 1 MiB.
