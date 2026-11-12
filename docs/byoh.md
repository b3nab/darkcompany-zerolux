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

### On Windows

- **Codex** needs version 0.154 or later, the first with its background server on Windows. The kernel reaches it through `codex app-server proxy`.
- **pi and Claude Code** started by ZeroLux run under a gate that keeps them as its child, since Windows cannot replace a process in place; the gate lives exactly as long as the session.
- **Claude Code in a terminal** cannot be hired yet: on Windows its inbox takes a message only with a token Claude Code gives its own processes. Start Claude Code sessions from ZeroLux there.

## Native observability and control

ZeroLux provides full observability and control over agents and all their output, uniformly for pi, Claude Code and Codex. Native history, output, tool calls and results, errors and intervention requests are available through the kernel, alongside input, approval and interruption controls. This data and these controls are reusable throughout ZeroLux.

## Native settings

Each session has its own model and effort, plus Claude Code's permission mode (`plan` among them) or Codex's approval policy, sandbox and collaboration mode (`plan` or `default`). Its selectors read them from the harness and change them through native controls, preserving the session and its history. Selecting a value is the only user action; no Stop or Resume is required. An agent's settings are the defaults its new sessions start with; its running sessions keep theirs.

Model catalogs come from the harness installed on the selected host, using that person's account and the selected project folder: pi's available model registry and supported thinking levels, Claude's SDK `supportedModels`, and Codex's paginated `model/list`. Discovery works before any session exists. Claude initializes the installed executable without a prompt or saved session; pi loads a catalog extension through its installed CLI without creating an agent session. Effort choices belong to the selected model. The kernel does not maintain a model/effort catalog; the client does not invent choices.

- **pi** changes its session model and thinking level without changing global preferences.
- **Managed Claude** changes its model through the native SDK control, and its effort and permission mode through session-local controls. The model selector also accepts a full native model ID: Claude's catalog is a list of suggestions, not an exhaustive allowlist. A change succeeds only when Claude confirms the effective value. Native tool approval decisions are still respected, including requests for chat tools.
- **Codex** updates the thread and targets its active turn for model/effort changes. Approval and sandbox changes require an idle session. A turn that ended is never restarted to apply a setting. Already-running inference cannot be rewritten; native controls govern subsequent inference steps.

A disconnected session, an unavailable execution host, an unsupported integration, or a Claude terminal with only an inbox cannot expose these controls, and says so. Joined hosts serve the controls for their own sessions. Reading settings never takes over or restarts a terminal. A change is checked by the harness before it is applied; an uncertain change is not retried.

An installed Claude Code update refreshes the catalog for existing sessions as well as new ones. Changing settings uses the running session's native controls without requiring a helper or executable upgrade. When an alias resolves differently in the installed harness, the kernel requests that concrete model ID and confirms it against the running session's own settings; reset and hybrid selections keep their native meaning. When an older adapter refuses a model or effort absent from its startup catalog, the kernel uses Claude's advertised `/model` or `/effort` built-in command and confirms the applied settings. These commands affect only that session in non-interactive mode; they do not start model inference or change saved defaults. All requested fields and commands are checked before any mutation. A command is sent once, including when its acknowledgement is lost; the kernel then only observes its outcome. If Claude has not confirmed it before the request deadline, HTTP 504 carries `code: "session_settings_unconfirmed"`. Clients refresh the actual settings without resending the change. A multi-field change may already be partly applied, and the reported values always come from the harness.

Helper updates run separately in the background. Automatic handoff requires the `integration-target-v1` protocol and a confirmed idle boundary after pending input, approvals and receipts have settled. The host supplies its activated entry path and revision; the runner verifies that target before closing. The checkpoint preserves the native session ID, history and settings; recovery waits for the old native process to exit. Release directories stay unchanged. Older runners keep serving native settings without an automatic Stop or input replay.

`GET /sessions/{id}/settings` returns the session's native `values`, `models` and `editable` fields; `PATCH /sessions/{id}/settings` applies only supplied fields and returns the confirmed values. `GET /actors/{id}/settings` returns the agent's defaults with its harness's `models` and `editable` fields; `POST /actors/{id}/settings` sets them. Values must be concrete native choices, not empty-string resets. Plan mode is a session setting in each harness's terms, Codex's `collaboration_mode` (`plan` or `default`) and Claude Code's `permission_mode` `plan`; the apps show it as a Plan switch beside the others. `GET /sessions/catalog?harness=…&host=…&workspace=…` supplies creation choices for the selected host and folder; host and workspace are optional. These routes are owner-only. Confirmed snapshots contain only public settings, never raw native configuration or provider credentials. Background observation refreshes each session's values every ten seconds without enforcing them.

New sessions accept optional model and effort overrides. Explicit choices win over the agent's defaults; otherwise the harness chooses. Changing model without an explicit effort leaves effort to the harness instead of carrying over an incompatible setting. Configuration is applied and checked before any input can be dispatched.

## Work through chats

Open a direct or group chat with your agents. Chat messages and replies belong to their conversation. Native output and intervention requests are available throughout ZeroLux, which provides full observability and control over agents and all their output. The agent's profile shows its native sessions, connection state and activity. See [chats](chat.md) for delivery, reconnect and harness details.

Stop is an explicit owner action. Signing out or restarting a kernel is not Stop and must not start a replacement native session. Resume and Take over are offered only for sessions that support them.

The kernel gives local harness integrations a loopback origin dedicated to their workspace,
with the same authentication as its `/w/<id>` API. This keeps already-running integrations
that accept only an origin connected across kernel updates. The port belongs to that
workspace's running lifetime; a verified rebind supplies its new address after a restart.
Clients continue to use `/w/<id>` on the kernel's public address.

With PostgreSQL replicas, a native session belongs to the kernel host that serves it; another host must not take over that host's processes.

The pi chat integration works inside an existing pi session. This repository sets `steeringMode: "all"` in `.pi/settings.json`, so pi reads waiting chat messages together.
