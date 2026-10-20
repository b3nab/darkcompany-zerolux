# Extensions

An extension adds to a workspace what the kernel does not do by itself. The kernel offers the mechanism: installing, enabling with dependencies, actions, extension points, events, triggers, settings and stored values. What an extension's contracts mean is its own.

## Making one

`zerolux ext new acme.notes` makes a new extension in a new folder, `notes`, with its manifest, a `main.ts` with one action and the TypeScript SDK beside it as `zerolux.ts`. With `--language python` it has a `main.py`, run by `uv`, and the Python SDK as `zerolux.py`. The SDK is one file with no dependencies, so an extension needs nothing from a registry. `--name` sets the name people read; a last argument sets the folder.

`zerolux ext dev` in its folder installs it in the kernel running on this computer and follows it, printing its state as it starts again and its log, until interrupted; `--data-dir` names the kernel's data folder (`.zerolux` by default). It reaches the kernel through its local channel, a Unix socket or a Windows named pipe that only the system user running the kernel can open, and acts as the workspace's owner. It can also be installed from the Extensions page or with `POST /extensions/folder`. An extension installed from a folder is being worked on: when its files change, the kernel starts it again from them once they hold still for a second. If it fails to start, its error is kept and the next change tries again. Its dependencies, `node_modules`, `.venv`, `__pycache__`, `target` and `.git` are not watched. One the owner disables is left alone.

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

- `{kind: "native"}`: by the clients' own component for it, registered as `<extension>/<name>`; a client without one does not show it. ZeroLux's official extensions use it.
- `{kind: "described", action, refresh_on?}`: from the tree its action returns, drawn with the clients' components. Buttons and forms in it run its actions, then it is drawn again, and again on each event named in `refresh_on`.
- `{kind: "remote", action}`: from its action's tree first, then from the trees the extension sends with `views.update {name, context, tree}` (`context.updateView` in the SDK). Clients hear `extension.view {extension, name, context, tree}`.
- `{kind: "web", entry}`: its own page, `ui/…` in its folder. `POST /extensions/{id}/ui {entry}` gives the address to open it: under a key good for an hour, which serves the files of its `ui/` folder only, sandboxed (`Content-Security-Policy: sandbox allow-scripts allow-forms`). The page talks to the client as MCP Apps do, JSON-RPC over `postMessage`: `tools/call {name, arguments}` runs one of the extension's actions.
- `{kind: "action", action}`: only in `message`.

Clients open a `web` piece only at the address `POST /extensions/{id}/ui` gives, in a frame sandboxed with `allow-scripts allow-forms`: it reaches neither the client's origin, cookies and storage nor its navigation.
Clients answer only the messages that come from that frame.

A tree is made of `stack {direction?, children}`, `heading {text}`, `text {text, tone?}`, `markdown {text}`, `badge {text}`, `divider`, `empty {text}`, `image {src, alt}` (`https:` or `data:image/`), `list {items: [{title, subtitle?, badge?, action?: {name, input}}]}`, `table {columns: [{key, title}], rows}`, `button {title, action: {name, input}, tone?, confirm?}` and `form {action, submit, values?}`, whose fields come from the action's input schema. Clients hear `extension.event {event}` for every event an extension publishes.

## Process parts

The kernel starts the command in the extension's folder with a cleared environment (`PATH`, `HOME`, `TMPDIR`, `LANG` and `USER`, on Windows also what its system needs, such as `SystemRoot`, `TEMP` and `USERPROFILE`; and `ZEROLUX_EXTENSION`), and talks JSON-RPC 2.0 over standard input and output, one message per line. Standard error goes to `extensions/<id>.log` in the data folder.

Each extension has a private folder for its files, `extensions/<id>/` in the data folder, given to it in `initialize` and removed with it. The kernel calls `initialize` (answered with what it brings), `action.run` and `point.call`, and notifies `event`, `settings` and `shutdown`. The extension calls `settings.get` (with its secrets), `workspace.actors` (the workspace's name, and its people and agents), `values.get`, `values.set`, `values.list`, `events.publish`, `actions.run`, `points.implementations`, `points.call` and `views.update`, and notifies `log`. The kernel's requests wait a minute, or an action's own `seconds`.

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

It also has `point` and `implement` for extension points, `on` for the events it hears, `trigger`, `ui` for its interface pieces, `update_view`, `secrets`, `get_value`, `set_value`, `delete_value`, `list_values`, `workspace`, `run` for another extension's action, `implementations_of`, `call` and `log`; `started` and `changed` run once it starts and after its settings change. Actions run in threads.

## Kernel modules

A kernel module is a library the kernel loads into itself while it runs, named in the manifest:

```toml
[kernel]
library = "tally"   # libtally.dylib, libtally.so or tally.dll
```

It speaks the process part's JSON-RPC, carried by four C functions instead of standard input and output: `zerolux_extension_abi` (the interface's version, 1), `zerolux_extension_start` (an instance, given the kernel's `send` function), `zerolux_extension_receive` (one message) and `zerolux_extension_stop`. Each message is one JSON object, without a line end; the module answers later, from any thread. The Rust SDK, `crates/zerolux-extension`, writes them: an extension implements `Extension` and `export!`s it, and its `Context` asks the kernel as the other SDKs do. `examples/tally.rs` is one.

The kernel looks for the library in `kernel/<platform>/` in the extension's folder (`macos-aarch64`, `linux-x86_64`, `windows-x86_64`…), then, in a folder being worked on, in `target/release` and `target/debug`. It loads a copy named by its content, so a rebuilt library is loaded anew; one being worked on starts again when it is rebuilt. A loaded library stays in memory until the kernel stops: once disabled or replaced, it is not called again. A kernel module runs inside the kernel with its rights; enable only those you trust.

## Lifecycle

The workspace owner installs, enables, disables, configures and removes extensions. ZeroLux brings official extensions, such as [voice](voice.md): a release carries them, and a kernel run from a checkout finds them in `extensions/`. An installed official extension runs as the kernel that starts it brings it. Installing from a folder on the kernel's computer marks it as being worked on: it starts again as its files change, and installing the same folder again reloads it. Disabling one clears its last error. Enabling starts its parts after its dependencies; a failure is kept as its error and it stays disabled. An extension cannot be disabled while an enabled one depends on it. Removing a disabled extension deletes its settings, secrets, stored values and folder. Enabled extensions start again with the kernel, dependencies first.

People and agents' sessions run actions. Clients hear `extensions.changed` and read the list again.

## API

| Route                                      | Purpose                                                               |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `GET /extensions`                          | Installed extensions, their state, settings and what they bring       |
| `GET /extensions/available`                | The official extensions ZeroLux brings, and whether each is installed |
| `POST /extensions/available/{id}`          | Install an official extension, and enable it                          |
| `POST /extensions/folder {folder}`         | Install, or install again, from a folder, and enable                  |
| `POST /extensions/{id}/enable`, `/disable` | Enable or disable                                                     |
| `PATCH /extensions/{id}/settings`          | Change settings and secrets; `null` removes one                       |
| `DELETE /extensions/{id}`                  | Remove a disabled extension and its data                              |
| `GET /actions`                             | The enabled extensions' actions                                       |
| `POST /ext/{extension}/{action}`           | Run an action; the body is its input, the answer `{result}`           |
| `POST /extensions/{id}/ui {entry}`         | The address of one of its pages, under a key good for an hour         |
