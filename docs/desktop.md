# Desktop app

The ZeroLux desktop app keeps a list of workspace connections on this device. Each workspace has its own kernel and database; the desktop uses the same interface and HTTP API as the browser client.

The desktop is part of the bootstrap release. Authentication, automatic updates and signed distribution packages are not included. macOS **14 or later** is required for persistent workspace browser isolation. macOS packaging has been exercised; Linux and Windows packaging and isolation remain unverified.

## Run from source

Install Rust, Bun and the native build tools listed in the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), then run from the repository root:

```sh
bun install --frozen-lockfile
bun run desktop:dev
```

The launcher builds the web assets and starts the native app. Restart it after changing the interface to rebuild those assets.

## Workspaces and connections

Open **Manage Workspaces…** from the app menu (`Cmd/Ctrl+Shift+O`), or **Manage connections** from **Workspace settings** in an up-to-date kernel interface.

- **Connect to an existing workspace:** enter a kernel's HTTP or HTTPS origin, such as `http://127.0.0.1:4310` or a server address on your private network. The desktop verifies the service and records its workspace identity. It does not copy or open that kernel's database.
- **Create a local workspace:** choose a name. The desktop starts an independent kernel with its own data directory and stable local address. A new workspace begins with onboarding; it does not inherit another workspace's people or messages.
- **Open a saved workspace:** the desktop checks the saved identity and shows its retained view, or starts that saved local kernel when needed. Failed connections show an error; there is no automatic local fallback or silent reassignment to a different workspace.

A server on the same computer can still be **external to the desktop**. For example, a separately started kernel on port 4310 is not owned or stopped by the app. A local address is not the same as an app-managed kernel, and a network address does not imply the server is currently online.

The workspace's **name is shared** with everyone using it. Renaming does not change its identity or history. The saved **address belongs to this client**. Change an existing connection's address only when the new address serves the same workspace; add a different workspace separately. Identity continuity is not authentication.

The desktop loads its packaged interface and calls the selected kernel's HTTP API. Each workspace window keeps its own verified kernel address. Browser clients still load the interface served by their kernel. The desktop requires a matching `api_version` in `/api/health`; older or incompatible kernels must be updated before opening them. macOS uses an overlay title bar with native traffic lights; Windows and Linux use controls in the interface (not yet verified on those systems).

## Switching, drafts and closing

Switching hides the previous workspace view rather than destroying it. Opened local kernels keep running, and each workspace retains its in-memory drafts and pending sends. Saved workspaces are not all started at app launch.

Changing the address of an open connection or forgetting it checks for pending sends. Pending messages block that change. An address change preserves drafts only after verifying the same workspace; it does not transfer kernel cookies or arbitrary browser storage.

**Forgetting a connection is not deleting its data.** Local databases and browser stores are retained. A running app-managed kernel cannot be forgotten while the app still owns it.

On Quit:

- Existing kernels and their services stay running.
- The app waits for its own kernels and managed LiveKit services to shut down.
- Kernel shutdown is not the same as pressing Stop on a native agent; native work may continue independently.

Finish sending before quitting. Retaining an open view during a switch is not a persistent-outbox guarantee across app exit or a crash.

## Data and migration

Connections are stored in `workspaces.json` in the operating system's application-data directory. New local workspaces have separate directories under `workspaces/<profile-id>`. A connection profile ID, the kernel's workspace ID and its address are distinct values.

On first launch after upgrading from the single-connection desktop, the app imports the previous connection and retains any previous local workspace as a separate entry. Importing the connection list does not open, copy, migrate or reset a database. When upgrading from kernel-served desktop pages, first opening a saved connection imports only its validated drafts into its isolated packaged-page store. The old stores remain untouched, and import completion is recorded only after the new store confirms persistence. The previous address must be available for this one-time import; open the connection before changing its address. Invalid settings are reported rather than reset.

Only one kernel runtime may serve a database. Connect to its address rather than starting another kernel against the same data.

## Services and security

Starting an app-managed kernel requires `livekit-server` on PATH or a complete external LiveKit configuration. Sessions ZeroLux starts or restores also require Bun and the harness itself (Claude Code, pi), are currently Unix-only, and owned Claude sessions remain tied to a single workspace. The app looks for them on PATH and in the usual install locations (`~/.bun/bin`, `~/.local/bin`, `~/.cargo/bin`, `~/.pi/agent/bin`, Homebrew, `/usr/local/bin`). Connecting to an existing kernel does not require those services on the client. See [chat setup](chat.md#livekit) and [agents and tasks](byoh.md).

Use the matching, updated ZeroLux harness integrations. An older loaded pi extension may support only one workspace and may not recognize the desktop subscriber executable; updating source files does not reload an already running extension. Connecting to a remote kernel does not automatically make this computer's native sessions available to that kernel.

The current kernel is unauthenticated and single-owner. Use a trusted local/private network; do not treat HTTPS or a saved workspace ID as permission to expose it to the public internet. Remote connections need the kernel's network and LiveKit addresses configured for those clients.

## Build an application package

```sh
bun run desktop:build
```

Tauri reports the generated application or package location. Open or install that output using your operating system's normal procedure. Building does not install or deploy the app, or sign it for distribution.

The package includes web assets, the ZeroLux Claude runner, the ZeroLux pi host and the pi chat extension it loads into stock pi, but neither the Claude Code nor the pi executable: the app-managed kernel starts and restores Claude Code and pi sessions through the ones installed on this computer. Local-runtime requirements still apply after packaging.

## For contributors

The host and client-owned catalog live in [`apps/desktop`](../apps/desktop). The kernel's shared lifecycle is in [`server.rs`](../crates/zerolux/src/server.rs), independently of Tauri. See [architecture](architecture.md) for component boundaries.

Only the packaged manager can call the connection-registry command. Both its capability and actual window URL are checked. Workspace pages have no registry, file or process privileges; a narrowly intercepted `zerolux://workspaces` navigation can open the manager but returns no registry data. Other HTTP/HTTPS links open in the system browser.

`ZEROLUX_DESKTOP_DATA_DIR` selects an absolute, isolated desktop data directory for development and tests. It is not a database-attachment shortcut. Tests use temporary data and fake harnesses, never personal sessions.

Run `bun run check` from the repository root before submitting changes. To keep a running kernel's web assets unchanged during checks, set `ZEROLUX_WEB_OUTDIR` to an isolated output directory.
