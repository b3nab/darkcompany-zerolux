# Desktop app

The ZeroLux desktop app keeps a list of the ZeroLux it reaches on this device: this computer's own, run by the app, and other computers' kernels. A ZeroLux has one database and one sign-in for all its workspaces; each workspace has its people, roles and data, at `/w/<id>`. The desktop uses the same interface and HTTP API as the browser client.

The app runs on macOS **14 or later** (for each connection's own browser storage), Linux and Windows. Signed builds check for updates automatically; choose their release channel in **Account settings › Updates**.

## Run from source

Install Rust, Bun and the native build tools listed in the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), then run from the repository root:

```sh
bun install --frozen-lockfile
bun run desktop:dev
```

The launcher builds the web assets and starts the native app. Restart it after changing the interface to rebuild those assets.

## Workspaces and connections

The workspaces window opens when no window is open, and from **File › Manage Workspaces…** (`Cmd/Ctrl+Shift+O`). On the left it makes a workspace or connects another computer; on the right it lists this computer's ZeroLux and the other computers', each opened with a click.

- **New Workspace…** (`Cmd/Ctrl+Shift+N`): opens this computer's ZeroLux at its list of workspaces, to name a new one; it starts this computer's ZeroLux the first time. On this computer a workspace can keep its files in a folder chosen there, such as a project's `.zerolux`, which is left out of the folder's git repository. A workspace begins with the account that made it as its owner; it does not inherit another workspace's people or messages.
- **Connect to Another Computer…**: enter a kernel's HTTP or HTTPS origin, such as `http://192.0.2.10:4310`. The desktop verifies the service and records its identity. It does not copy or open that kernel's database.
- **Open a saved ZeroLux:** the desktop checks the saved identity and shows its retained view, starting this computer's first when needed. Failed connections show an error; there is no automatic local fallback or silent reassignment to a different identity.

A window signs in once to its ZeroLux, then shows the account's workspaces there: one opens at once, several are chosen from a list, and the one chosen last opens next time. The workspace's name at the top left lists the account's workspaces there and, below, the other computers', with the requests waiting in each. A click opens one in that window, and with Cmd or Ctrl in a new one; `Ctrl+1…9` on macOS, `Alt+1…9` elsewhere, opens the workspaces by place. At launch the app opens again the windows open when it quit, each on its page.

A server on the same computer can still be **external to the desktop**. For example, a separately started kernel on port 4310 is not owned or stopped by the app. A local address is not the same as an app-managed kernel, and a network address does not imply the server is currently online.

To run that workspace with the app, choose **Run with this app…** in its row's menu, then select its existing workspace folder. The preview verifies the running kernel and workspace before taking over. The app retains the complete data directory, database path, connection profile, sign-in and drafts.

On macOS, **Browse…** shows hidden folders such as `.zerolux` and selects folders only.

Taking over requires an updated local CLI kernel running interactively in a terminal, with SQLite and account authentication. Update and restart an older CLI kernel once before using this action. Services, background or piped CLI processes, PostgreSQL kernels and remote kernels remain external connections. A failed validation leaves the running kernel unchanged.

An interrupted transfer is reconciled when the app opens again: a confirmed transfer remains app-managed; otherwise the saved connection returns to the CLI. Recovery preserves the workspace's data and never restores a database backup over later writes.

**This computer**, at the bottom left of the workspaces window, shows the address of this computer's ZeroLux. **Network…** changes its port, private network IP and optional public web and call addresses; **Apply and restart** restarts it there, each window where it was. Other devices need the private network address or a configured public address. Keep the app open for those devices to reach its workspaces. A CLI's kernel can be taken over while this computer has no ZeroLux of its own: its database, address and services become the app's.

The workspace's **name is shared** with everyone using it. Renaming does not change its identity or history. The saved **address belongs to this client**. Change an existing connection's address only when the new address serves the same workspace; add a different workspace separately. Identity continuity is not authentication.

The desktop loads its packaged interface and calls the selected kernel's HTTP API. Each window keeps its own verified kernel address. Browser clients still load the interface served by their kernel. The desktop uses what the kernel declares in `/api/health` (`capabilities`); sign-in is offered when the kernel declares `instance-auth-v1` or `auth-v1`, and an older kernel is used as it is. The sign-in of each saved ZeroLux, one for all its workspaces, is kept in the system's credential store (Keychain, Credential Manager or Secret Service) and deleted on sign-out or when the connection is forgotten. Without a credential store, it lasts until the app closes. On macOS, an unsigned build asks once to allow access to it. macOS uses an overlay title bar with native traffic lights; Windows and Linux use window controls drawn in the interface.

## Windows, drafts and closing

Windows sit beside each other as in VS Code. **New Window** (⌘N, Ctrl+N) opens another window of the ZeroLux in front. Closing a window closes only it; this computer's ZeroLux keeps running. With its last window closed the app stays in the tray until you quit it, and on macOS in the Dock, whose icon brings back the window last in front.

The app's menu is the menu bar on macOS, and on Windows and Linux the window's menu button (☰), also opened with Alt or F10. It holds the windows and workspaces (File), editing (Edit), the sidebar, the command menu and zoom (View), back, forward and the bar's sections by their place, ⌘1…9 (Go), and help, the keyboard shortcuts and updates (Help, and on macOS the ZeroLux menu). **Help → Keyboard Shortcuts** lists every shortcut. Reload and the developer tools are in **View → Developer** in builds from source only.

On macOS, the app's kernel remains responsive while the app is in the background: its lifetime prevents App Nap, including service shutdown. The Mac can still sleep when idle. Connections to external kernels do not prevent App Nap.

**Start when ZeroLux opens**, in this computer's row menu, starts this computer's ZeroLux as soon as the app opens; taking over an existing workspace enables it for that connection. **My settings → Desktop → Open at login** starts ZeroLux in the background when you sign in to this computer, then starts only the workspaces enabled for app startup. Login startup is off until you enable it; it does not run before you sign in.

Open at login reads and changes the operating system's startup registration: a LaunchAgent on macOS, the current user's startup entry on Windows, and XDG autostart on Linux. System settings or administrator policy can still block startup. Keep the installed app at the same path; source executables on macOS and isolated test data directories cannot register for login startup.

Changing the address of an open connection or removing it checks for pending sends. Pending messages block that change. An address change preserves drafts only after verifying the same workspace; it does not transfer kernel cookies or arbitrary browser storage.

**Removing a connection is not deleting its data.** Its database, files and browser store are retained.

On Quit:

- Existing kernels and their services stay running.
- The app waits for its kernel and managed LiveKit services to shut down.
- Kernel shutdown is not the same as pressing Stop on a native agent; native work may continue independently.

Finish sending before closing a window or quitting: pending sends live in their window, and are not kept across a close, an app exit or a crash.

## Tray

ZeroLux's mark sits in the menu bar on macOS, the notification area on Windows and the tray on Linux (GNOME shows it with the AppIndicator extension). On macOS the number beside it counts the requests waiting for you; elsewhere a badge says something waits. The mark has no lit point while no workspace's kernel answers.

A click on the mark opens a panel under it, over full-screen apps too, with what every workspace opened since the app started asks of you:

- **Needs you:** each permission as it would act (the whole command, the files with the lines it adds and removes, the address), to allow once, for the session or always as its harness offers, or deny; a question with one answer among its options, answered with a tap; anything else opens its chat or session in the app. Arrows move between requests, Return allows once, Backspace denies, Escape closes the panel.
- **Subscriptions:** each plan of the person on the kernel's computer, with its main limit; a click shows the others, a week's pace (when it runs out at this rate), extra usage, credits and earned resets to use.
- **Extensions' rows** from the workspace in front, such as the next meeting.
- **A newer ZeroLux**, with its download progress and the action to install it and restart.

A request that comes while the panel is closed is also a system notification: a permission is allowed once or denied from it, and a click opens the request in the app. The workspace windows then leave requests to the tray. On macOS the app asks once whether it may notify; a build run from source, with no app bundle, shows none of these. The panel reads each workspace with that workspace's own sign-in, kept by the desktop; a workspace not signed in says so. The right click opens a menu with Open ZeroLux, New Window, the workspaces and Quit. Linux's trays open only a menu, so there the menu also holds the requests, each with its choices, and the plans' main lines.

## Data and migration

Connections are stored in `workspaces.json` in the operating system's application-data directory. New local workspaces have separate directories under `workspaces/<profile-id>`. A connection profile ID, the kernel's workspace ID and its address are distinct values.

A workspace taken over from a local kernel keeps its existing directory and database path. The app retains its host identity, storage, extensions and session links there; it does not copy only the database into a new workspace.

An app that ran a kernel for each local workspace keeps one after the update, this computer's ZeroLux: the database of the workspace taken over from the CLI, else the selected one's, else the first one's, with its address and services. The other local workspaces leave the list; their folders and files stay as they are.

On first launch after upgrading from the single-connection desktop, the app imports the previous connection and retains any previous local workspace as a separate entry. Importing the connection list does not open, copy, migrate or reset a database. When upgrading from kernel-served desktop pages, first opening a saved connection imports only its validated drafts into its isolated packaged-page store. The old stores remain untouched, and import completion is recorded only after the new store confirms persistence. The previous address must be available for this one-time import; open the connection before changing its address. Invalid settings are reported rather than reset.

Only one kernel runtime may serve a database. Connect to its address rather than starting another kernel against the same data.

Before taking over, the app stops the CLI through its handover protocol and backs up the existing database while holding its exclusive lock. The transfer keeps the same profile and workspace identities. The app records enough state to recover an interrupted transfer without replacing workspace data.

## Updates

Choose **Nightly**, **Beta** (including release candidates) or **Stable** in Account settings. The app checks at startup and every six hours, then downloads and verifies a newer compatible release. **Update** beside the bell, or in the tray, shows its progress; **Restart to update** installs it. Switching channels never installs an older version. See [release versions and signing](releases.md).

Restart checks every open workspace window. Pending or failed sends, recording, transcription and attachments must be resolved first. Text drafts and open views are saved for the restart. An unavailable remote workspace keeps its saved drafts until it can open again.

Before replacing the app, the desktop stops its kernel, holds its workspaces' database locks, and creates verified SQLite snapshots in `backups/update-<id>` under its application-data directory. External kernels and native agents are not stopped. If backup or installation fails, the kernel serves its workspaces again and the windows become usable again. Backups are never restored automatically over subsequent writes.

The current pre-release still has a mutable `0001_bootstrap` schema. Automatic installation requires the release's signed schema fingerprint to match the running build when local databases exist. A different fingerprint stops the update before download and is checked again before installation. Supporting future schema changes requires an immutable migration history and an explicit upgrade path; a backup alone does not make such an upgrade or downgrade safe.

The feed and its signature are published separately. A check that catches them between uploads fails safely; **Check for updates** in settings retries it. Source builds without `ZEROLUX_UPDATE_PUBLIC_KEY` report that updates are unconfigured and make no update request. Updates apply to the desktop and its embedded kernel; they do not replace independently running kernels, mobile apps or separately installed extensions.

## Services

The app carries what its kernel starts: the LiveKit server, unless an external LiveKit is configured, Bun, which runs sign-in and the session runners, and uv, which runs the Python parts of extensions. Sessions use the harnesses installed on this computer (Claude Code, Codex, pi); owned Claude sessions remain tied to a single workspace. The app looks for the harnesses on PATH and in the usual install locations (`~/.bun/bin`, `~/.local/bin`, `~/.cargo/bin`, `~/.pi/agent/bin`, Homebrew, `/usr/local/bin`; on Windows also npm's global folder). Connecting to an existing kernel needs none of this on the client. See [chat setup](chat.md#livekit) and [agents and native sessions](byoh.md).

Use the matching, updated ZeroLux harness integrations. An older loaded pi extension may support only one workspace and may not recognize the desktop subscriber executable; updating source files does not reload an already running extension. Connecting to a remote kernel does not automatically make this computer's native sessions available to that kernel.

Clients on other devices reach the kernel at an address it serves (`--expose`, or a public origin behind a reverse proxy) and at its LiveKit address.

## Build an application package

```sh
bun run desktop:build
```

Tauri writes desktop packages under `target/desktop/release/bundle`; a debug build uses `target/desktop/debug/bundle`. An explicit Rust target adds its target triple before `release` or `debug`. `CARGO_TARGET_DIR` overrides the desktop output directory; use an absolute, separate directory when setting it. CLI builds keep their own `target` directory.

The installed desktop executable is named `zerolux` (`zerolux.exe` on Windows), so existing harness integrations recognize its subscription command. Its Cargo target remains `zerolux-desktop`; it is the actual app executable, with no wrapper or second kernel. Moving build output does not move the installed app or workspace data.

Open or install the generated package using your operating system's normal procedure. Building does not install or deploy the app, or sign it for distribution.

The package includes the web assets, Bun, the LiveKit server, uv, the ZeroLux Claude runner, the ZeroLux pi host and the pi chat extension it loads into stock pi, but no harness: the app-managed kernel starts and restores Claude Code, Codex and pi sessions through the ones installed on this computer. Building it takes `livekit-server` and `uv` on the PATH, which the package copies.

## For contributors

The host and client-owned catalog live in [`apps/desktop`](../apps/desktop). The kernel's shared lifecycle is in [`server.rs`](../crates/zerolux/src/server.rs), independently of Tauri. See [architecture](architecture.md) for component boundaries.

Workspaces are made through the kernel's authenticated API, with the signed-in account as their owner. Later name changes use the authenticated workspace API.

Only the packaged manager can call the connection-registry command. Both its capability and actual window URL are checked. Workspace pages have no registry, file or process privileges; a narrowly intercepted `zerolux://workspaces` navigation can open the manager but returns no registry data. Other HTTP/HTTPS links open in the system browser.

`ZEROLUX_DESKTOP_DATA_DIR` selects an absolute, isolated desktop data directory for development and tests. It is not a database-attachment shortcut. Tests use temporary data and fake harnesses, never personal sessions.

Debug builds can compile `ZEROLUX_UPDATE_TEST_FEEDS=http://127.0.0.1:<port>/feeds` to exercise signed updates from a local fixture server. Use a temporary signing key, an isolated app bundle and desktop data directory; feed and package signatures remain mandatory. Release builds ignore this variable and use the production feeds.

Run `bun run check` from the repository root before submitting changes. To keep a running kernel's web assets unchanged during checks, set `ZEROLUX_WEB_OUTDIR` to an isolated output directory.
