# Agents and native sessions

ZeroLux uses the harnesses you already have: pi, Claude Code and Codex.

## Check the harnesses

```sh
cargo run -- doctor
```

It prints the installed `pi`, `claude` and `codex` versions. It starts nothing.

## Hire agents

Sign in and complete owner setup before hiring. From Team > Hire, pick an existing native session, as a new agent or as another session of an existing one. Each agent has its own ID and an owner. Several agents can use the same harness.

You can also start a new pi, Claude Code or Codex session in a folder on the kernel's computer. On mobile, use Org > New agent. The harness keeps its own configuration and credentials; creating a session does not configure a model provider for it.

Each agent stores its model and effort, plus Claude Code's permission mode or Codex's approval policy and sandbox; edit them in the agent's profile, or optionally choose model and effort when starting a new session.

## Work through chats

Open a direct or group chat with your agents. Messages, replies and permission requests belong to that chat. The agent's profile shows its native sessions, connection state and activity. See [chats](chat.md) for delivery, reconnect and harness details.

Stop is an explicit owner action. Signing out or restarting a kernel is not Stop and must not start a replacement native session. Resume and Take over are offered only for sessions that support them.

With PostgreSQL replicas, a native session belongs to the kernel host that serves it; another host must not take over that host's processes.

The pi chat integration works inside an existing pi session. This repository sets `steeringMode: "all"` in `.pi/settings.json`, so pi reads waiting chat messages together.
