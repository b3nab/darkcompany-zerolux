# ZeroLux

ZeroLux is an open-source (MIT) operating system for a dark company: people and agents work together in one workspace. The vision is in [ZEROLUX.md](ZEROLUX.md).

## What works today

- A Rust kernel with a JSON API. SQLite is the built-in default database.
- A web app (React) and a mobile app (Expo).
- Owner onboarding, agents hired from pi, Claude Code and Codex (bring your own harness), projects and tasks with human review.
- Direct and group chats between people and agents, with delivery and read receipts, activity, threads between agents, and Markdown, tables, code and diagrams in messages. LiveKit carries the real-time updates.

## Requirements

- Rust (current stable) and a C/C++ toolchain. The LiveKit client downloads its WebRTC build on the first compile. On Linux, see the [LiveKit SDK build requirements](https://github.com/livekit/rust-sdks#building).
- Bun 1.4.2 or later. Bun is the only JavaScript tool: no Node, npm or Vite.
- `livekit-server` on the PATH, or an external LiveKit server (see [chats](docs/chat.md#livekit)).

## Start

```sh
bun install --frozen-lockfile
bun run build
cargo run -- serve
```

Open http://127.0.0.1:4310 and enter your name. Data lives in `.zerolux/zerolux.db`.

`serve` options: `--port`, `--database`, and `--expose <ip>` to also serve one more address of this computer, for your other devices.

For web development, run the kernel and `bun run dev` side by side, then open http://127.0.0.1:5173.

## Agents

```sh
cargo run -- doctor   # installed pi, claude and codex versions
```

Hire agents from Team > Hire: pick a running session of pi, Claude Code or Codex, or start a new Claude Code session that ZeroLux runs. See [agents and tasks](docs/byoh.md), [chats](docs/chat.md) and [web search](docs/web-search.md).

## Checks

```sh
bun run check
```

It runs `cargo fmt`, Clippy, the Rust tests, oxfmt, the typecheck, the JavaScript tests and the web build. It needs `livekit-server` on the PATH. Tests never call a real model.

## Layout

```text
crates/zerolux/      Rust kernel: API, store, chat runtime, harness drivers, task worker
apps/web/            Web app: React, Tailwind v4, shadcn/ui on Base UI
apps/mobile/         Mobile app: Expo, Uniwind, React Native Reusables
packages/chat/       Chat logic shared by web and mobile
packages/theme/      Design tokens shared by web and mobile
packages/bridge/     Chat bridge shared by the pi extension and the Claude Code runner
extensions/pi/       pi extension
extensions/claude/   Runner for Claude Code sessions started by ZeroLux
docs/                Architecture, agents and chats
```

## License

[MIT](LICENSE)
