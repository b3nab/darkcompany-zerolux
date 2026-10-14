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

## Native settings

The agent's profile reads its effective model and effort, plus Claude Code's permission mode or Codex's approval policy and sandbox. Choose from the selectors and press **Apply**: connected sessions receive native control requests, not just database defaults. No prompt, new turn or replacement session is submitted.

Model catalogs come from the harness: pi's available model registry and supported thinking levels, Claude's SDK `supportedModels`, and Codex's paginated `model/list`. Effort choices belong to the selected model. The kernel does not maintain a model/effort catalog. Without a connected, controllable local harness, creation can still use native defaults; the client does not invent choices.

- **pi** changes its session model and thinking level without changing global preferences.
- **Managed Claude** changes session-local SDK flags and permission mode. Native tool approval decisions are still respected, including requests for chat tools.
- **Codex** updates the thread and targets its active turn for model/effort changes. Approval and sandbox changes require an idle session. A turn that ended is never restarted to apply a setting. Already-running inference cannot be rewritten; native controls govern subsequent inference steps.

A disconnected session, another host's session, an older integration, or a Claude terminal with only an inbox does not expose these controls. The profile explains the limitation rather than claiming a saved choice was applied. Reading settings never takes over or restarts a terminal. Several sessions are preflighted before any mutation; their shared values and choices are intersected, with differing or unknown values left unset. Application across sessions is not a distributed transaction: a later failure can leave partial changes. Refresh reads the resulting native state; uncertain changes are not automatically retried.

`GET /actors/{id}/settings` returns the actor, native `models`, `editable` fields and per-session values/errors. `POST /actors/{id}/settings` applies only supplied fields and returns the confirmed actor. Values must be native choices, not empty-string resets. `GET /chat/settings-catalog?harness=…` supplies creation choices. These routes are owner-only. Confirmed snapshots contain only public settings, never raw native configuration or provider credentials. Background observation refreshes them every ten seconds without enforcing stored preferences.

New sessions accept optional model and effort overrides. Explicit choices win over an existing agent's last confirmed settings; otherwise the harness chooses. Changing model without an explicit effort leaves effort to the harness instead of carrying over an incompatible setting. Configuration is applied and checked before chat inputs can be dispatched. An agent with no active sessions can store validated choices for its next new session.

## Work through chats

Open a direct or group chat with your agents. Messages, replies and permission requests belong to that chat. The agent's profile shows its native sessions, connection state and activity. See [chats](chat.md) for delivery, reconnect and harness details.

Stop is an explicit owner action. Signing out or restarting a kernel is not Stop and must not start a replacement native session. Resume and Take over are offered only for sessions that support them.

With PostgreSQL replicas, a native session belongs to the kernel host that serves it; another host must not take over that host's processes.

The pi chat integration works inside an existing pi session. This repository sets `steeringMode: "all"` in `.pi/settings.json`, so pi reads waiting chat messages together.
