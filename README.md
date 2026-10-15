# ZeroLux

ZeroLux is an open-source (MIT) operating system for a dark company: people and agents work together in one workspace. The vision is in [ZEROLUX.md](ZEROLUX.md).

## What works today

- A Rust kernel with a JSON API. SQLite is the built-in default database.
- Web (React), desktop (Tauri) and mobile (Expo) apps. The desktop includes the Rust kernel and shares the web interface.
- Owner sign-in, agents hired from pi, Claude Code and Codex (bring your own harness).
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

Open http://127.0.0.1:4310. The first time, create your account: it becomes the owner, and no other account can be created after it. Data lives in `.zerolux/zerolux.db`.

`serve` options: `--port`, `--database` (a SQLite file, or a `postgresql://` URL for a server; `ZEROLUX_DATABASE`), `--data-dir` (links, sockets, the host identity and LiveKit assets; by default the SQLite file's directory, or `.zerolux` with PostgreSQL), `--auth-entry` (the authentication service, run with `bun`; the checkout's by default) and `--expose <ip>` to also serve one more address of this computer, for your other devices. A SQLite workspace is served by one kernel at a time (a lock file next to the database). A PostgreSQL workspace can be served by several kernels at once, each with its own data directory: they share sign-in and chats, and each links only the agent sessions it started; give them one external LiveKit (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`) so clients of all of them get the same notices.

For web development, run the kernel and `bun run dev` side by side, then open http://127.0.0.1:5173.

## Desktop

```sh
bun run desktop:dev
bun run desktop:build
```

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) first. Choose an existing kernel to use the same workspace, or explicitly start a local desktop workspace. The choice is remembered; an unavailable kernel never creates a new workspace. See [desktop setup and lifecycle](docs/desktop.md) for modes and prerequisites.

## Agents

```sh
cargo run -- doctor   # installed pi, claude and codex versions
```

Hire agents from Team > Hire: pick a running session of pi, Claude Code or Codex, or start a new session in a folder. Mobile offers creation from Org > New agent. See [agents](docs/byoh.md), [chats](docs/chat.md) and [web search](docs/web-search.md).

## Checks

The full check needs `livekit-server` on the PATH and a **disposable** PostgreSQL instance. For example, start the test database in a separate terminal (no persistent volume):

```sh
docker run --rm -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=zerolux_test -e POSTGRES_PASSWORD=fixture-only-password \
  -e POSTGRES_DB=zerolux_test \
  postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
```

Once PostgreSQL is ready:

```sh
ZEROLUX_TEST_POSTGRES_URL=postgresql://zerolux_test:fixture-only-password@127.0.0.1:55432/zerolux_test bun run check
```

It prepares desktop assets, then runs formatting, Clippy, the Rust workspace tests on SQLite, the kernel tests on PostgreSQL, typechecks, JavaScript tests and the web build. The auth tests also cover both databases. Tests create and clean their own databases/schemas; the PostgreSQL test role needs permission to create databases. `DATABASE_URL` is never a fallback. Tests never call a real model. Stop the disposable container with Ctrl-C when done. Targeted SQLite tests can still run without PostgreSQL.

## Database schema changes

Edit the SeaORM entities in `crates/zerolux/src/entity`, then run
`bun run db:generate describe_the_change`. The development tool exports the
schema and uses pinned Atlas Community Edition to generate versioned SQLite and
PostgreSQL migrations. It needs local Docker for a disposable PostgreSQL database;
no workspace database or cloud account is used. Review the generated artifacts
before committing. The kernel applies them with SeaORM, never with runtime schema
sync. See [migration workflow](crates/zerolux/migrations/README.md).

## Layout

```text
crates/zerolux/      Rust kernel: API, store, chat runtime, harness drivers, sign-in
apps/web/            Web app: React, Tailwind v4, shadcn/ui on Base UI
apps/desktop/        Desktop app: Tauri, shared web UI and embedded Rust kernel
apps/mobile/         Mobile app: Expo, Uniwind, React Native Reusables
packages/chat/       Chat logic shared by web and mobile
packages/theme/      Themes shared by web and mobile
packages/bridge/     Chat bridge shared by the pi extension and the Claude Code runner
extensions/pi/       pi extension
extensions/claude/   Runner for Claude Code sessions started by ZeroLux
services/auth/       Private Better Auth service, owned by the kernel
docs/                Architecture, agents and chats
```

## License

[MIT](LICENSE)
