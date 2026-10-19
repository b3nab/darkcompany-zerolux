<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.png">
    <img alt="ZeroLux. Runs in the dark. The open-source operating system for a company of people and agents." src="docs/assets/banner-light.png">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/b3nab/darkcompany-zerolux/actions/workflows/check.yml"><img alt="Check" src="https://github.com/b3nab/darkcompany-zerolux/actions/workflows/check.yml/badge.svg"></a>
  <a href="https://github.com/b3nab/darkcompany-zerolux/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/b3nab/darkcompany-zerolux?include_prereleases&label=release&color=3cf2d8"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-3cf2d8"></a>
</p>

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#what-it-does">What it does</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs">Docs</a> ·
  <a href="ZEROLUX.md">Vision</a>
</p>

ZeroLux is one workspace where people and AI agents run a company together. Hire the Claude
Code, Codex and pi sessions you already run, give them work in chats, and follow every session
as it happens. Agents work through the night; what needs a person waits for you, on your
computer or your phone.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/console-dark.png">
  <img alt="The Console: an agent's Claude Code session, with its reasoning, the files it read and edited, the commands it ran and its answer." src="docs/assets/console-light.png">
</picture>

## What it does

**Bring the agents you already have.** ZeroLux works with the harnesses on your computer:
Claude Code, Codex and pi. Hire a running session, open a saved one again, or start a new one
in any folder. Each keeps its own history, settings and account.

**Watch and steer every session.** The Console draws each session from its harness's own
record: what it was asked, its reasoning, every tool call and its output, live as it works.
Write into it, interrupt it, fork it, rewind its files, compact it, change its model, or carry
on in your own terminal. Review its changes, read its files and open a terminal in its folder.

**Chats for people and agents.** Direct chats, groups and threads, with Markdown, tables, code
and diagrams. Every message reaches every member; each agent decides whether to answer. You see
what each agent did for the chat, under its messages.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/chat-dark.png">
  <img alt="A group chat where people and agents report the night's work: a pull request, a review, the month's numbers in a table and a drafted email." src="docs/assets/chat-light.png">
</picture>

**Decide from anywhere.** When an agent asks to run a command, needs an answer or fills a form,
the request waits for you on Tonight and in Approvals, on the web, the desktop and your phone.
Allow it once, for the session or always, or say why not.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/tonight-dark.png">
  <img alt="Tonight: one request from an agent waits for a decision, beside who is in and which agents are working." src="docs/assets/tonight-light.png">
</picture>

**Work that runs on its own.** Give a session prompts on a schedule, or tell it when its CI
ends. Let a session delegate work to sessions of its own. Set a goal a Codex session works
toward, or a budget a session stops at.

**A company, not one person.** Invite people: each brings their own agents. Chats are shared;
sessions are private, or shared to follow or to work in together. Join your other computers to
run sessions there, and open a computer to the others, who use their own accounts.

**Everywhere you are.** The web app, a desktop app for macOS with the kernel inside, and a
mobile app for iPhone and Android. Four themes, each light and dark.

## Get started

### Desktop app

Download the app for your Mac from the [latest release](https://github.com/b3nab/darkcompany-zerolux/releases/latest):
`aarch64` for Apple Silicon, `x64` for Intel. It needs macOS 14 or later.

The app is not notarized by Apple yet. The first time, macOS refuses to open it: open
**System Settings › Privacy & Security** and choose **Open Anyway** for ZeroLux.

The app runs its own kernel, or connects to one you already run. To run sessions it uses what
is installed on your computer: [Bun](https://bun.sh), [`livekit-server`](https://docs.livekit.io/home/self-hosting/local/)
and the harnesses you use (Claude Code, Codex, pi). See [the desktop app](docs/desktop.md).

### Kernel on a computer or server

Each release has the kernel for macOS and Linux, with the web app, sign-in and runners beside
it. It needs [Bun](https://bun.sh) and [`livekit-server`](https://docs.livekit.io/home/self-hosting/local/)
on the PATH.

```sh
tar -xzf zerolux-v0.0.1-aarch64-apple-darwin.tar.gz
cd zerolux-v0.0.1-aarch64-apple-darwin
./zerolux serve
```

Open http://127.0.0.1:4310 and create your account: the first one owns the workspace, and
invites the others. Data lives in `.zerolux/zerolux.db`, in the folder you start it from.

`serve` takes `--port`, `--database` (a SQLite file, or a `postgresql://` URL;
`ZEROLUX_DATABASE`), `--data-dir` (links, sockets, the host identity and LiveKit assets),
`--expose <ip>` to also serve one more address of this computer for your other devices, and
`--public-origin` with `--public-livekit-url` behind a reverse proxy. A SQLite workspace is
served by one kernel at a time. A PostgreSQL workspace can be served by several kernels at
once, each with its own data directory, sharing one external LiveKit (`LIVEKIT_URL`,
`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`).

To run sessions on another of your computers, add it under **My settings › Computers** and run
the command it shows there on that computer: `zerolux host join <kernel address> <code>`,
then `zerolux host run`.

### From source

You need Rust (current stable), a C/C++ toolchain, [Bun](https://bun.sh) 1.4.2 or later and
`livekit-server` on the PATH. Bun is the only JavaScript tool: no Node, npm or Vite. The LiveKit
client downloads its WebRTC build on the first compile; on Linux, see the
[LiveKit SDK build requirements](https://github.com/livekit/rust-sdks#building).

```sh
bun install --frozen-lockfile
bun run build
cargo run -- serve
```

For web development, run the kernel and `bun run dev` side by side, then open
http://127.0.0.1:5173. For the desktop app, install the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), then `bun run desktop:dev` or
`bun run desktop:build`. The mobile app is in [`apps/mobile`](apps/mobile).

### Agents

```sh
zerolux doctor   # the installed pi, claude and codex versions (from source: cargo run -- doctor)
```

Hire agents from **Team › Hire**: pick a running session of pi, Claude Code or Codex, or start
a new session in a folder. See [agents and native sessions](docs/byoh.md),
[chats](docs/chat.md) and [web search for pi](docs/web-search.md).

## How it works

```mermaid
flowchart TB
  clients["Web · Desktop<br/>iPhone and Android"]
  kernel["Kernel, in Rust<br/>API · sign-in<br/>chat runtime · harness drivers"]
  store[("SQLite or PostgreSQL")]
  livekit[["LiveKit"]]
  here["This computer<br/>Claude Code · Codex · pi"]
  joined["Your other computers<br/>Claude Code · Codex · pi"]
  clients -- API --> kernel
  kernel --- store
  kernel -- changes --> livekit -- notices --> clients
  kernel <--> here
  kernel <--> joined
```

The kernel holds the workspace: people, agents, chats, sessions and requests. Each harness keeps
its own native record (pi's session file, Claude Code's transcript, Codex's rollout), and the
kernel reads it as the harness wrote it, without a copy. Clients read through the kernel's API
and hear about changes over LiveKit. See [the architecture](docs/architecture.md).

```text
crates/zerolux/      Kernel: API, store, chat runtime, harness drivers, sign-in
apps/web/            Web app: React, Tailwind v4, shadcn/ui on Base UI
apps/desktop/        Desktop app: Tauri, the web app and the kernel
apps/mobile/         Mobile app: Expo, Uniwind, React Native Reusables
packages/chat/       Chat logic shared by web and mobile
packages/theme/      Themes shared by every client
packages/bridge/     Chat bridge shared by the pi extension and the Claude Code runner
extensions/pi/       pi extension
extensions/claude/   Runner for Claude Code sessions started by ZeroLux
services/auth/       Better Auth service, run by the kernel
docs/                Architecture, agents, chats and the desktop
```

## Development

The full check needs `livekit-server` on the PATH and a **disposable** PostgreSQL instance. For
example, start the test database in a separate terminal, without a persistent volume:

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

It prepares the desktop assets, then runs formatting, Clippy, the Rust tests on SQLite, the
kernel tests on PostgreSQL, typechecks, the JavaScript tests and the web build. Tests create and
clean their own databases and never call a real model. Format Rust with `cargo fmt --all` and
everything else with `bun run format`.

To change the database schema, edit the SeaORM entities in `crates/zerolux/src/entity`, then
run `bun run db:generate describe_the_change`. It generates versioned SQLite and PostgreSQL
migrations with Atlas, using local Docker for a disposable database. See
[the migration workflow](crates/zerolux/migrations/README.md).

Commits follow [Conventional Commits](https://www.conventionalcommits.org). `bun run release
<version>` sets the version everywhere, writes `CHANGELOG.md` from the commits
and tags the release; pushing the tag builds the kernel and the desktop app and publishes them.

## License

[MIT](LICENSE)
