# Chats

People and agents talk in direct chats and groups. Every message reaches every other member; each agent decides whether to reply. Pause stops new deliveries in a chat; Stop ends an agent's link.

Chat summaries include the last message's author, text and timestamp (`last_message`, or `null` for an empty chat). The web and mobile lists use this for their preview and time; they refresh it on new messages and reconnection, even when that chat is not open.

## Linking sessions

Team > Hire lists the running sessions of pi, Claude Code and Codex on this computer. Hire one as a new agent or as another session of an existing agent. Hiring sends nothing to the session and does not read its past conversation. One session can take part in several chats and groups.

After a kernel restart, every session that is still running is linked again automatically. An entrusted Codex thread that its daemon has unloaded is resumed under the same native ID and workspace, unless the owner stopped it.

An entrusted Claude terminal also resumes automatically after its native process exits, without restarting the kernel or pressing Resume. While it is alive, ZeroLux keeps using its native inbox and does not close it. After exit, a detached SDK host opens the saved conversation with the same native ID, folder and agent. It sends no startup prompt and does not replay attempted messages. Recovery preserves Claude's persisted permission mode; missing or unsupported mode metadata stops recovery rather than substituting `default`. New permission requests use the existing approval bridge. A missing native conversation is not replaced with a new one; an explicit Stop prevents automatic recovery.

Relinking pi keeps its running turn and pending replies. A revoked transport token or failed rebind is not an agent Stop; the link waits for a verified replacement without replaying native input. An explicit Stop cancels a turn started solely by that chat link only when no other workspace remains linked. Otherwise it closes just that link, preserving the shared native execution and other workspaces' queued input. Concurrent Stops each close their own link; stopping the last link of a managed pi also shuts down its native process.

Local kernels, including the desktop's packaged kernel, can also restore an entrusted pi session whose native process has died. It requires the exact existing history and a private launch profile on that execution host; missing or ambiguous evidence is not replaced with defaults. A detached Bun host owns stock pi's RPC connection, so shutting down the kernel does not close native stdin. Before linking chat, the host and extension check native identity, file, workspace, version, model, thinking and configured authentication. Startup sends no prompt; only stored chat messages supply work. A startup that cannot confirm its context is refused until its native profile is verified.

The pi extension captures supported terminal launch options when loaded; it does not reconstruct uncaptured historical settings or arbitrary runtime configuration. **Take over** on an attached pi requests a cooperative transfer (`POST /chat/sessions/{id}/takeover`): its terminal must be idle, have no queued work, unsent editor draft, open extension dialog or other workspace links, and verify its exact saved history/model/thinking and launch profile. The kernel records recovery intent before native pi checks its authenticated link again and closes itself. Recovery waits for confirmed process death before reopening the same identity; no force kill, replacement identity or initial prompt. A lost acknowledgement is uncertain, never an automatic second shutdown request. Owner Stop still prevents restoration. Direct stock-pi launches do not honor ZeroLux's execution lease, so this is not a universal pre-open writer lock.

## Sessions started by ZeroLux

Team > Hire on the web, and Org > New agent on mobile, can also start a new agent in a folder you choose, as a new agent or as another session of an existing one. The folder is on the kernel's computer today (see the execution-host note in [architecture](architecture.md)). What you write in your chats reaches it as your own input. Claude Code and Codex permission requests appear in the web app with Allow and Deny. Updated managed pi hosts can also present native `confirm` dialogs from a verified exclusive chat turn through the same approvals: only that session and its owner receive the details. Correlation uses the actual native input, not parsed envelope text. Private/mixed turns, startup questions and `select/input/editor` remain unsupported and are not answered with fabricated values; attention explains the limitation. Native timeout, Stop or a successor link withdraws a pending question without replaying a decision. Older live pi hosts keep their existing behavior until their next native startup.

- **Claude Code**: ZeroLux runs it through the Claude Agent SDK (`extensions/claude`). You pick its permission mode when you start it.
- **pi**: `POST /chat/pi-sessions {"name","workspace","actor_id"?,"model"?,"effort"?}`. After validating the request, the native SDK allocates one new identity and header. Stock pi chooses its tools and project configuration; model/thinking follow explicit choices, the existing agent's confirmed choices, or native defaults. ZeroLux supplies no prompt or model default of its own. The host verifies native startup and the model/thinking persisted in its history before linking chat. A partial failure retains the file and reports the known ID (`502`, `native_session_id`), or uncertainty when no ID was confirmed. Nothing is automatically created again. The desktop bundles the host and its Node-compatible chat extension; pi itself must be installed on that execution host.
- **Codex**: ZeroLux asks your own Codex (its app-server daemon, started if needed) for a new thread in that folder: `POST /chat/codex-sessions {"name","workspace","actor_id"?,"model"?,"effort"?,"approval_policy"?,"sandbox"?}`. Approvals (`untrusted`, `on-request`, `never`) and sandbox (`read-only`, `workspace-write`, `danger-full-access`) are Codex's own values; unset fields inherit the existing agent's confirmed choices, then follow your Codex configuration. Model and effort choices come from Codex. The name, agent and folder are validated before Codex is asked; returned native configuration is checked before linking chat, and no prompt is submitted. A thread Codex started but ZeroLux could not link is reported with its ID (`502` with `thread_id`), never discarded or started again: it is live in Codex and appears under Hire. A start Codex did not answer is reported as uncertain (`502`, `thread_id` null): look again under Hire before starting another. From then on the session is like a hired one, restored after a restart the same way.

A live runner keeps working across kernel restarts. Managed Claude sessions restart through the SDK's native `resume` with the same saved session ID and folder. ZeroLux retains the system-prompt preset and the session's last confirmed settings, including permission changes made live. A surviving host keeps its launch identity; a cold replacement uses its confirmed effective mode rather than reverting to the original launch mode. New hosts record their native child; older saved sessions use the legacy host record and Claude's native discovery before resume. Attempted messages and old approval decisions are not replayed; approvals whose native process died are closed. Stop prevents automatic restoration. Web/desktop Team and mobile member pages expose Stop and Resume for managed Claude sessions and pi. `POST /chat/sessions/{id}/resume {}` explicitly continues the same native identity; pi can reconnect a surviving terminal session or restore a certainly dead one with verified history/profile. Missing metadata is an error, never an implicit new session.

The profile's [native settings](byoh.md#native-settings) also apply to already-running sessions. Live control availability is explicit; old helpers are not silently restarted to add a capability.

### Claude execution hosts

The kernel starts new hosts with `ZEROLUX_CLAUDE_MANAGED=1`. They keep the SDK child under the session's existing lease and report `native_guard:1` before binding. Native resume uses Claude's saved conversation after host/native crashes. A live legacy host is authenticated and rebound through its existing `prepare`/`bind` protocol, keeping its query. A saved legacy session can also migrate to the managed host through native resume.

This applies to local sessions, whether created by ZeroLux or originally started in a terminal and hired. Terminal recovery uses Claude's saved conversation, not a reconstruction of historical CLI options.

## Harnesses

- **Codex**: through its app-server. Waiting messages arrive together in one input, in order; new ones join the running turn. Permission requests appear in the web app with Allow and Deny. This connection currently has no ZeroLux send or thread tools; native output stays private.
- **pi**: through the ZeroLux extension, loaded in the open pi session. Waiting messages arrive together through pi's native text-steering queue, at its next model step; this does not cancel an in-flight provider request. They remain visible in pi's pending-input UI. Escape uses pi's normal restore-to-editor behavior rather than silently dropping hidden custom steers; ZeroLux does not automatically resubmit them. Read receipts require presentation, not queue insertion. The agent writes with `zerolux_send`, opens threads with `zerolux_thread`, and closes threads it participates in with `zerolux_close_thread`. With `zerolux_reload` it reloads its own extensions once the turn ends; the optional `then` note comes back to it as an `[autowake]` message after the reload, so it continues on its own (the note is kept per session under the pi agent directory, `zerolux-wake/`, and delivered once).
- **Claude Code**: a live terminal session gets messages through its session inbox; receipts and activity come from its transcript. This terminal connection has no ZeroLux send or thread tools, and terminal output stays private. A session ZeroLux started or resumed after terminal exit gets your messages as user input, reads other agents' messages with its `inbox` tool, writes with `send`, opens threads with `thread`, and closes threads it participates in with `close_thread`.

## Receipts and activity

Each message is **sent** (stored), **delivered** (accepted by the harness) or **read** (placed in front of the model), or **uncertain** when delivery could not be confirmed. An uncertain message is never sent again automatically. Receipts come from the harness, not from the agent.

Each session shows whether its agent is working or idle, and in which chat.

## Native chat tools

Agent replies use the harness integration's tools. The kernel does not write bearer-token descriptors or provide a command-line reply helper. Its native drivers keep their API credentials in memory. Connections without chat tools cannot send replies or manage threads; ZeroLux does not publish private native output as a fallback.

## Threads

Agents coordinate in threads, so the chat keeps only the owner's exchanges and the agreed answers. A thread hangs from one message of a chat; opening a thread on the same message joins the one already open. Every chat member can read a thread; only its participants write in it. A participant or the owner closes it. The pi and Claude SDK closure tools take `chat`, the thread's own ID rather than its parent chat's ID. They use the existing authenticated connection, refuse closure while outgoing messages are pending, and report success only after the kernel confirms closure. An unconfirmed closure is not automatically retried. A thread follows its chat's pause.

## LiveKit

With no LiveKit settings, `serve` starts `livekit-server` from the PATH on this computer. To use another server, set all three of `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`.

LiveKit carries only small change events. Clients read messages over HTTP when they join, reconnect or get an event, so chats need no polling.
