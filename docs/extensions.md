# Extensions

An extension adds to a workspace what the kernel does not do by itself. The kernel offers the mechanism: installing, enabling with dependencies, actions, extension points, events, triggers, settings and stored values. What an extension's contracts mean is its own.

## Making one

`zerolux ext new acme.notes` makes a new extension in a new folder, `notes`, with its manifest, a `main.ts` with one action and the TypeScript SDK beside it as `zerolux.ts`. With `--language python` it has a `main.py`, run by `uv`, and the Python SDK as `zerolux.py`. The SDK is one file with no dependencies, so an extension needs nothing from a registry. `--name` sets the name people read; a last argument sets the folder.

`zerolux ext dev` in its folder installs it in the kernel running on this computer and follows it, printing its state as it starts again and its log, until interrupted; `--data-dir` names the kernel's data folder (`.zerolux` by default). It reaches the kernel through its local channel, a Unix socket or a Windows named pipe that only the system user running the kernel can open, and acts as the workspace's owner. It can also be installed from Develop, in the Extensions page's menu, or with `POST /extensions/folder`. An extension installed from a folder is being worked on: when its files change, the kernel starts it again from them once they hold still for a second. If it fails to start, its error is kept and the next change tries again. Its dependencies, `node_modules`, `.venv`, `__pycache__`, `target` and `.git` are not watched. One the owner disables is left alone.

## Manifest

An extension is a folder with `zerolux-extension.toml`:

```toml
[extension]
id = "acme.notes"          # publisher.name: lowercase letters, digits and dashes
name = "Notes"
version = "1.2.0"          # semver
publisher = "acme"
description = "Notes kept where you choose"
kernel = ">=0.0.1"         # optional: the kernel versions it works with
icon = "icon.png"          # optional: a square PNG, 512 pixels best; icon_dark for dark themes
categories = ["knowledge"] # one or two
keywords = ["notes"]       # up to four
license = "MIT"            # SPDX

[links]                    # optional, each on HTTPS
homepage = "https://acme.example/notes"
repository = "https://github.com/acme/notes"
issues = "https://github.com/acme/notes/issues"
privacy = "https://acme.example/privacy"

[dependencies]
"acme.storage" = ">=1.0"   # enabled before it, at a matching version

[process]
command = ["bun", "run", "main.ts"]   # run in the extension's folder
start_seconds = 600                   # optional: a first start that prepares what it runs

[settings]
store = { type = "text", label = "Store", default = "memory" }
token = { type = "secret", label = "Token" }
```

Settings are `text`, `number`, `boolean`, `secret` or `choice`, with its `options` (`[{ value, label }]`). A secret is never shown to clients; only the extension's own parts read it.

Categories say what an extension is for in a workspace: `files-storage`, `projects-tasks`, `communication`, `meetings-voice`, `agents-ai`, `development`, `knowledge`, `data-analytics`, `automation`, `calendar-time`, `customers-business`, `security-admin` and `other`.

## Card

What a marketplace shows of an extension is its **card**: its summary (the manifest's `description`), categories, keywords, licence and links, its icon, the images and video in `media/`, and its `README.md` and `CHANGELOG.md`. `zerolux ext pack` checks it before packing:

- an icon is a square PNG of 128 to 1024 pixels, up to 256 KB;
- `media/` holds up to 6 PNG, JPEG or WebP images, 2 MB each (16:10 at 2000×1250 shows best), and one MP4 video, up to 50 MB;
- `README.md` and `CHANGELOG.md` are Markdown up to 256 KB, without HTML outside code; the README's images are files in `media/`.

Beside the package it writes `<id>-<version>.card/`: `card.json` and the files it names, each with its path in the package (`name`), SHA-256, size and kind (`icon`, `image`, `video` or `text`). An index lists the card with each version, each file at its `url`. Clients never reach an index or another host for them: the kernel gives each file at `/api/extensions/assets/<sha256>`, downloaded from its index once, kept, and only as its digest says; an installed extension's from its folder. Both `GET /extensions` and `GET /extensions/marketplace` give cards with each file's `url` there.

## Secrets and signing in

Besides its settings' secrets, an extension keeps as many secrets as it needs, by name (one for each account it connects, say): `secrets.get {name}`, `secrets.set {name, value}` (`null` removes it) and `secrets.list {prefix}`. Every secret, these and the settings', is stored encrypted with a key of the kernel's own, `extensions/vault.key` in the data folder, readable only by the kernel's user: a copy of the database alone reveals none. Clients never see them.

To sign in to another service with OAuth, an extension calls `oauth.start {secret, authorize_url, token_url, client_id, client_secret?, scopes?, params?, origin?}` and gets `{url, redirect_uri}`: the person opens `url`, signs in there, and the service sends them back to `redirect_uri`, `/api/extensions/oauth/callback` on the kernel at `origin` (the caller's `origin`, the kernel's address as the person's device reached it; the kernel's own on this computer by default). The kernel exchanges the code with PKCE, keeps the tokens in the secret named, and sends the extension its `zerolux/signed_in` event, `{secret, ok, error?}`, which it hears like any other with `on`. A sign-in expires after 15 minutes and comes back once. `oauth.token {secret}` gives a valid access token, `{access_token, token_type, expires_at, scope}`, renewed with the refresh token when it is due. The service decides which addresses it sends people back to: many take any port on this computer (`127.0.0.1`), and only HTTPS elsewhere.

An extension has a kernel module or a process part. **Current limitation:** a manifest with a remote part is refused.

## What an extension brings

When enabled, its process says what it brings:

- **Actions**: named operations with a JSON Schema for their input and an effect (`read`, `write` or `destructive`). An action answers within a minute, or within the `seconds` it declares, up to 30 minutes. One action serves the clients and the API, where an agent's session runs it with its own token. The kernel checks the input against the schema before the extension sees it, and records every call with who made it, how long it took and whether it succeeded.
- **Extension points**: contracts it opens, `publisher.extension/point@version`, with operations and their input schemas. Other extensions implement them under a name; the kernel routes a call to the implementation and checks its input against the contract.
- **Events**: what it publishes, named under its ID (`acme.notes/saved`), and what it hears.
- **Triggers**: an action to run on `event:<extension>/<event>` or on `schedule:<cron>`. A trigger's call is recorded as `trigger:…`.

## Interface

An extension shows pieces of its interface in the clients' spaces, each `{space, name, title, icon?, view}`:

| Space      | Where                                                                      | Context the view's action gets  |
| ---------- | -------------------------------------------------------------------------- | ------------------------------- |
| `page`     | A page with its item in the sidebar; on the phone, under More              | `{}`                            |
| `session`  | A panel beside a session; on the phone, a screen from its header           | `{session_id}`                  |
| `chat`     | A section in a chat's About                                                | `{conversation_id}`             |
| `message`  | An item in a message's menu, which runs `view.action` and shows its result | `{conversation_id, message_id}` |
| `settings` | A section in the workspace's settings                                      | `{}`                            |

A piece's `view` says how it is drawn:

- `{kind: "native", entry}`: by its own interface, `ui/native/<piece>.js` in its package, which the apps run inside themselves. It is written once with `@zerolux/ui` (React and ZeroLux's components and hooks, never HTML elements or React Native views), and each app draws it with its own components: the web and desktop apps with theirs, the phone apps with theirs. `zerolux ext build` makes it from `ui/src/<piece>.tsx`: one script, `globalThis.__zeroluxModule(entry, function (module, exports, require) {…})`, needing only `react`, `react/jsx-runtime` and `@zerolux/ui`, which the app gives it; `module.exports.default` is its component. The app loads it from the address `POST /extensions/{id}/ui {entry}` gives. Such an interface runs with the rights of the person using the app, so an extension that brings one counts `interface` among its parts, and people see it before installing. A page drawn as a `Page`, or as a `Split` beside one, is a screen of the app's own: it takes the whole window, with its header, search and inspector; its rows and cards open their `menu` with a right click or a long press as with their "…", and a folder is chosen with `FolderInput`, never typed.
- `{kind: "described", action, refresh_on?}`: from the tree its action returns, drawn with the clients' components. Buttons and forms in it run its actions, then it is drawn again, and again on each event named in `refresh_on`.
- `{kind: "remote", action}`: from its action's tree first, then from the trees the extension sends with `views.update {name, context, tree}` (`context.updateView` in the SDK). Clients hear `extension.view {extension, name, context, tree}`.
- `{kind: "web", entry}`: its own page, `ui/…` in its folder. `POST /extensions/{id}/ui {entry}` gives the address to open it: under a key good for an hour, which serves the files of its `ui/` folder only, sandboxed (`Content-Security-Policy: sandbox allow-scripts allow-forms`). The page talks to the client as MCP Apps do, JSON-RPC over `postMessage`: `tools/call {name, arguments}` runs one of the extension's actions.
- `{kind: "action", action}`: only in `message`.

Clients open a `web` piece only at the address `POST /extensions/{id}/ui` gives, in a frame sandboxed with `allow-scripts allow-forms`: it reaches neither the client's origin, cookies and storage nor its navigation.
Clients answer only the messages that come from that frame.

A tree is made of `stack {direction?, children}`, `heading {text}`, `text {text, tone?}`, `markdown {text}`, `badge {text}`, `divider`, `empty {text}`, `image {src, alt}` (a `data:image/` address: nothing is loaded from elsewhere), `list {items: [{title, subtitle?, badge?, action?: {name, input}}]}`, `table {columns: [{key, title}], rows}`, `button {title, action: {name, input}, tone?, confirm?}` and `form {action, submit, values?}`, whose fields come from the action's input schema. Clients hear `extension.event {event}` for every event an extension publishes.

## Process parts

The kernel starts the command in the extension's folder with a cleared environment (`PATH`, `HOME`, `TMPDIR`, `LANG` and `USER`, on Windows also what its system needs, such as `SystemRoot`, `TEMP` and `USERPROFILE`; and `ZEROLUX_EXTENSION`), and talks JSON-RPC 2.0 over standard input and output, one message per line. Standard error goes to `extensions/<id>.log` in the data folder.

Each extension has a private folder for its files, `extensions/<id>/` in the data folder, given to it in `initialize` and removed with it. `initialize` also gives the workspace's storage area, `storage/` in the data folder: the files its people and agents keep, which Storage shows as its location `ZeroLux`. The kernel calls `initialize` (answered with what it brings), `action.run` and `point.call`, and notifies `event`, `settings` and `shutdown`. The extension calls `settings.get` (with its secrets), `workspace.actors` (the workspace's name, and its people and agents), `values.get`, `values.set`, `values.list`, `events.publish`, `actions.run`, `points.implementations`, `points.call`, `views.update`, `agents.tell` (an agent hears a text in its newest running session, as input that waits for its turn; refused when it has none running), `secrets.get`, `secrets.set`, `secrets.list`, `oauth.start` and `oauth.token`, and notifies `log`. An action's `caller` is `{actor_id, session_id, by, origin}`. The kernel's requests wait a minute, or an action's own `seconds`.

`@zerolux/extension-sdk` (`packages/extension-sdk`) writes this in TypeScript:

```ts
import { defineExtension, serve } from "@zerolux/extension-sdk";

await serve(
  defineExtension({
    events: { saved: { description: "A note was saved" } },
    actions: {
      save: {
        title: "Save a note",
        description: "Keeps a note",
        effects: "write",
        input: { type: "object", required: ["key", "text"] },
        async run(input, context) {
          await context.values.set(`note:${input.key}`, input.text);
          await context.publish("saved", { key: input.key });
          return { saved: true };
        },
      },
    },
  }),
);
```

The Python SDK (`packages/extension-sdk/python/zerolux.py`) brings the same:

```python
from zerolux import Extension

extension = Extension()
extension.event("saved", "A note was saved")


@extension.action("save", "Save a note", "Keeps a note", effects="write",
                  input={"type": "object", "required": ["key", "text"]})
def save(input, caller):
    extension.set_value(f"note:{input['key']}", input["text"])
    extension.publish("saved", {"key": input["key"]})
    return {"saved": True}


if __name__ == "__main__":
    extension.serve()
```

It also has `point` and `implement` for extension points, `on` for the events it hears, `trigger`, `ui` for its interface pieces, `update_view`, `secrets`, `secret`, `set_secret`, `secret_names`, `oauth_start`, `oauth_token`, `get_value`, `set_value`, `delete_value`, `list_values`, `workspace`, `run` for another extension's action, `implementations_of`, `call` and `log`; `started` and `changed` run once it starts and after its settings change. Actions run in threads.

## Kernel modules

A kernel module is a library the kernel loads into itself while it runs, named in the manifest:

```toml
[kernel]
library = "tally"   # libtally.dylib, libtally.so or tally.dll
```

It speaks the process part's JSON-RPC, carried by four C functions instead of standard input and output: `zerolux_extension_abi` (the interface's version, 1), `zerolux_extension_start` (an instance, given the kernel's `send` function), `zerolux_extension_receive` (one message) and `zerolux_extension_stop`. Each message is one JSON object, without a line end; the module answers later, from any thread. The Rust SDK, `crates/zerolux-extension`, writes them: an extension implements `Extension` and `export!`s it, and its `Context` asks the kernel as the other SDKs do. `examples/tally.rs` is one.

The kernel looks for the library in `kernel/<platform>/` in the extension's folder (`macos-aarch64`, `linux-x86_64`, `windows-x86_64`…), then, in a folder being worked on, in `target/release` and `target/debug`. It loads a copy named by its content, so a rebuilt library is loaded anew; one being worked on starts again when it is rebuilt. A loaded library stays in memory until the kernel stops: once disabled or replaced, it is not called again. A kernel module runs inside the kernel with its rights; enable only those you trust.

## Files

An action can take a file and give one, without either passing through its messages. `POST /ext/{extension}/{action}/file?input=<json>&name=<name>` keeps the request's body in the extension's own folder while the action runs, and adds to its input `file {path, size, name, content_type}`; the action may move the file, and what it leaves is removed when it ends. An action run with `GET /ext/{extension}/{action}?input=<json>` that returns `{"$file": {path, name?, content_type?, temporary?}}` gives that file as the response, if it is in an extension's folder; a `temporary` one is removed once sent.

## Packages and indexes

`zerolux ext build` builds what an extension brings: its kernel module, a Cargo package, for this computer into `kernel/<platform>/`, and its interface from `ui/src/*.tsx` into `ui/native/`. `zerolux ext key <publisher>` makes a publisher's Ed25519 key, kept in `~/.zerolux/keys/<publisher>.json` and readable only by its user; it prints the public key. `zerolux ext pack --key <file>` checks its card, packs the extension into a signed `<id>-<version>.zlx`, prints its SHA-256, and writes its card beside it. A package is a gzipped tar of the extension's files, without what tools make and download (`target`, `dist`, `node_modules`, `.venv`, `__pycache__`, `.git`), with `files.json` (each file's path, size and SHA-256) and `SIGNATURE` (the publisher's signature of `files.json`).

An index is a JSON file on HTTPS that anyone may host:

```json
{
  "name": "Acme",
  "publishers": { "acme": { "key": "<public key, base64>" } },
  "extensions": [
    {
      "id": "acme.notes",
      "name": "Notes",
      "description": "Notes kept where you choose",
      "publisher": "acme",
      "versions": [
        {
          "version": "1.0.0",
          "kernel": ">=0.0.1",
          "parts": ["process"],
          "card": {
            "summary": "…",
            "categories": ["knowledge"],
            "icon": {
              "name": "icon.png",
              "sha256": "…",
              "size": 1234,
              "kind": "icon",
              "url": "acme.notes/1.0.0/icon.png"
            }
          },
          "packages": {
            "macos-aarch64": {
              "url": "acme.notes-1.0.0-macos-aarch64.zlx",
              "sha256": "…"
            },
            "any": {
              "url": "https://example.com/acme.notes-1.0.0.zlx",
              "sha256": "…"
            }
          }
        }
      ]
    }
  ]
}
```

`parts` says what the package runs, `kernel`, `process` and `interface` (an interface run inside the apps), so that people see it before installing; a package that runs otherwise is refused. A package is listed for each computer (`macos-aarch64`, `linux-x86_64`, `windows-x86_64`…) or for `any`; its URL is absolute or relative to the index. A kernel reads the indexes `ZEROLUX_EXTENSION_INDEXES` names, separated by commas, and none otherwise. Every package is treated alike: signed by its publisher, and checked with that publisher's key in the index. It offers each extension's newest version that works with it and has a package for its computer. Installing downloads the package, checks it against the index's SHA-256 and its publisher's key in that index, unpacks it in `extensions/packages/<id>/` in the data folder and enables it; an older version's files go.

## Lifecycle

The workspace owner installs, enables, disables, configures and removes extensions. There is one channel: every extension, ZeroLux's own too, such as [voice](voice.md), [Storage](storage.md) and [Projects](projects.md), whose sources are in `marketplace/`, is a package installed from an index, or a folder being worked on; the kernel carries none. Installing from a folder on the kernel's computer marks it as being worked on: it starts again as its files change, and installing the same folder again reloads it. Disabling one clears its last error. Enabling starts its parts after its dependencies; a failure is kept as its error and it stays disabled. An extension cannot be disabled while an enabled one depends on it. Removing a disabled extension deletes its settings, secrets, stored values and folder. Enabled extensions start again with the kernel, dependencies first.

People and agents' sessions run actions. Clients hear `extensions.changed` and read the list again.

## API

| Route                                      | Purpose                                                                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /extensions`                          | Installed extensions, their state, settings and what they bring                                                                                                                                                           |
| `POST /extensions/folder {folder}`         | Install, or install again, from a folder, and enable                                                                                                                                                                      |
| `GET /extensions/marketplace`              | What the indexes offer, with the version installed and `current`, whether it came from the package offered (a new build of the same version is not); each index read, `marketplaces: [{index, name}]`; unreadable indexes |
| `POST /extensions/marketplace/install`     | `{index, id, version?}`: install from an index, and enable                                                                                                                                                                |
| `POST /extensions/marketplace/update`      | `{ids?}`: update each installed extension an index offers anew, a newer version or another build, or only those of `ids`: `{updated: [{id, version}], failed: [{id, error}]}`                                             |
| `POST /extensions/{id}/enable`, `/disable` | Enable or disable                                                                                                                                                                                                         |
| `PATCH /extensions/{id}/settings`          | Change settings and secrets; `null` removes one                                                                                                                                                                           |
| `DELETE /extensions/{id}`                  | Remove a disabled extension and its data                                                                                                                                                                                  |
| `GET /actions`                             | The enabled extensions' actions                                                                                                                                                                                           |
| `POST /ext/{extension}/{action}`           | Run an action; the body is its input, the answer `{result}`                                                                                                                                                               |
| `POST /ext/{extension}/{action}/file`      | Run an action with a file: the body, up to 2 GiB; `?input=<json>&name=`                                                                                                                                                   |
| `GET /ext/{extension}/{action}?input=`     | Run an action that reads: its `{result}`, or the file it gives                                                                                                                                                            |
| `POST /extensions/{id}/ui {entry}`         | The address of one of its pages, under a key good for an hour                                                                                                                                                             |
