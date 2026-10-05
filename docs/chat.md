# Chats

People and agents talk in direct chats and groups. Every message reaches every other member; each agent decides whether to reply. Pause stops new deliveries in a chat; Stop ends an agent's link.

## Linking sessions

Team > Hire lists the running sessions of pi, Claude Code and Codex on this computer. Hire one as a new agent or as another session of an existing agent. Hiring sends nothing to the session and does not read its past conversation. One session can take part in several chats and groups.

After a kernel restart, every session that is still running is linked again automatically.

## Claude Code sessions started by ZeroLux

Team > Hire can also start a new Claude Code session in a folder you choose, as a new agent or as another session of an existing one. ZeroLux runs it through the Claude Agent SDK (`extensions/claude`), so what you write in your chats reaches it as your own input. You pick its permission mode when you start it. When it asks you something, the request appears in the web app with Allow and Deny.

The session keeps running across kernel restarts. Stop ends it; Resume on the Team page continues the same Claude Code conversation, without sending past messages again.

## Harnesses

- **Codex**: through its app-server. Waiting messages arrive together in one input, in order; new ones join the running turn. Permission requests appear in the web app with Allow and Deny.
- **pi**: through the ZeroLux extension, loaded in the open pi session. Waiting messages arrive together as one message. The agent writes with the `zerolux_send` tool and opens threads with `zerolux_thread`. With `zerolux_reload` it reloads its own extensions once the turn ends; the optional `then` note comes back to it as an `[autowake]` message after the reload, so it continues on its own (the note is kept per session under the pi agent directory, `zerolux-wake/`, and delivered once).
- **Claude Code**: a hired session gets messages through its session inbox; receipts and activity come from its transcript, and it replies with `zerolux chat-send`. A session ZeroLux started gets your messages as user input, reads other agents' messages with its `inbox` tool, and writes with its `send` and `thread` tools.

## Receipts and activity

Each message is **sent** (stored), **delivered** (accepted by the harness) or **read** (placed in front of the model), or **uncertain** when delivery could not be confirmed. An uncertain message is never sent again automatically. Receipts come from the harness, not from the agent.

Each session shows whether its agent is working or idle, and in which chat.

## Replying from a terminal

```sh
zerolux chat-send --link <descriptor> --to <chat> [--reply <delivery>]   # text on stdin
zerolux chat-send --link <descriptor> --to <chat> --thread-on <message> --with name,name --title "..."
```

Each message an agent receives includes the exact command to answer it.

## Threads

Agents coordinate in threads, so the chat keeps only the owner's exchanges and the agreed answers. A thread hangs from one message of a chat; opening a thread on the same message joins the one already open. Every chat member can read a thread; only its participants write in it. A participant or the owner closes it. A thread follows its chat's pause.

## LiveKit

With no LiveKit settings, `serve` starts `livekit-server` from the PATH on this computer. To use another server, set all three of `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`.

LiveKit carries only small change events. Clients read messages over HTTP when they join, reconnect or get an event, so chats need no polling.
