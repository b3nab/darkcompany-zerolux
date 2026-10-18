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

## Native observability and control

ZeroLux provides full observability and control over agents and all their output, uniformly for pi, Claude Code and Codex. Native history, output, tool calls and results, errors and intervention requests are available through the kernel, alongside input, approval and interruption controls. This data and these controls are reusable throughout ZeroLux.

## Native settings

Each session has its own model and effort, plus Claude Code's permission mode (`plan` among them) or Codex's approval policy, sandbox and collaboration mode (`plan` or `default`). Its selectors read them from the harness and change them through native controls; no prompt, new turn or replacement session is submitted. An agent's settings are the defaults its new sessions start with; its running sessions keep theirs.

Model catalogs come from the harness: pi's available model registry and supported thinking levels, Claude's SDK `supportedModels`, and Codex's paginated `model/list`. Effort choices belong to the selected model. The kernel does not maintain a model/effort catalog. Without a connected, controllable local harness, creation can still use native defaults; the client does not invent choices.

- **pi** changes its session model and thinking level without changing global preferences.
- **Managed Claude** changes session-local SDK flags and permission mode. Native tool approval decisions are still respected, including requests for chat tools.
- **Codex** updates the thread and targets its active turn for model/effort changes. Approval and sandbox changes require an idle session. A turn that ended is never restarted to apply a setting. Already-running inference cannot be rewritten; native controls govern subsequent inference steps.

A disconnected session, another host's session, an older integration, or a Claude terminal with only an inbox does not expose these controls, and says so. Reading settings never takes over or restarts a terminal. A change is checked by the harness before it is applied; an uncertain change is not retried.

`GET /sessions/{id}/settings` returns the session's native `values`, `models` and `editable` fields; `PATCH /sessions/{id}/settings` applies only supplied fields and returns the confirmed values. `GET /actors/{id}/settings` returns the agent's defaults with its harness's `models` and `editable` fields; `POST /actors/{id}/settings` sets them. Values must be native choices, not empty-string resets. Plan mode is a session setting in each harness's terms, Codex's `collaboration_mode` (`plan` or `default`) and Claude Code's `permission_mode` `plan`; the apps show it as a Plan switch beside the others. `GET /sessions/catalog?harness=…` supplies creation choices. These routes are owner-only. Confirmed snapshots contain only public settings, never raw native configuration or provider credentials. Background observation refreshes each session's values every ten seconds without enforcing them.

New sessions accept optional model and effort overrides. Explicit choices win over the agent's defaults; otherwise the harness chooses. Changing model without an explicit effort leaves effort to the harness instead of carrying over an incompatible setting. Configuration is applied and checked before any input can be dispatched.

## Work through chats

Open a direct or group chat with your agents. Chat messages and replies belong to their conversation. Native output and intervention requests are available throughout ZeroLux, which provides full observability and control over agents and all their output. The agent's profile shows its native sessions, connection state and activity. See [chats](chat.md) for delivery, reconnect and harness details.

Stop is an explicit owner action. Signing out or restarting a kernel is not Stop and must not start a replacement native session. Resume and Take over are offered only for sessions that support them.

With PostgreSQL replicas, a native session belongs to the kernel host that serves it; another host must not take over that host's processes.

The pi chat integration works inside an existing pi session. This repository sets `steeringMode: "all"` in `.pi/settings.json`, so pi reads waiting chat messages together.
