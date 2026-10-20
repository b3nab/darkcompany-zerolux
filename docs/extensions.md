# Extensions

An extension adds to a workspace what the kernel does not do by itself. The kernel offers the mechanism: installing, enabling with dependencies, actions, extension points, events, triggers, settings and stored values. What an extension's contracts mean is its own.

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

**Current limitation:** only process parts run. A manifest with a kernel module or a remote part is refused.

## What an extension brings

When enabled, its process says what it brings:

- **Actions**: named operations with a JSON Schema for their input and an effect (`read`, `write` or `destructive`). An action answers within a minute, or within the `seconds` it declares, up to 30 minutes. One action serves people, agents and the API. The kernel checks the input against the schema before the extension sees it, and records every call with who made it, how long it took and whether it succeeded.
- **Extension points**: contracts it opens, `publisher.extension/point@version`, with operations and their input schemas. Other extensions implement them under a name; the kernel routes a call to the implementation and checks its input against the contract.
- **Events**: what it publishes, named under its ID (`acme.notes/saved`), and what it hears.
- **Triggers**: an action to run on `event:<extension>/<event>` or on `schedule:<cron>`. A trigger's call is recorded as `trigger:…`.

## Process parts

The kernel starts the command in the extension's folder with a cleared environment (`PATH`, `HOME`, `TMPDIR`, `LANG` and `USER`, on Windows also what its system needs, such as `SystemRoot`, `TEMP` and `USERPROFILE`; and `ZEROLUX_EXTENSION`), and talks JSON-RPC 2.0 over standard input and output, one message per line. Standard error goes to `extensions/<id>.log` in the data folder.

Each extension has a private folder for its files, `extensions/<id>/` in the data folder, given to it in `initialize` and removed with it. The kernel calls `initialize` (answered with what it brings), `action.run` and `point.call`, and notifies `event`, `settings` and `shutdown`. The extension calls `settings.get` (with its secrets), `workspace.actors` (the workspace's name, and its people and agents), `values.get`, `values.set`, `values.list`, `events.publish`, `actions.run`, `points.implementations` and `points.call`, and notifies `log`. The kernel's requests wait a minute, or an action's own `seconds`.

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

## Lifecycle

The workspace owner installs, enables, disables, configures and removes extensions. ZeroLux brings official extensions, such as [voice](voice.md): a release carries them, and a kernel run from a checkout finds them in `extensions/`. An installed official extension runs as the kernel that starts it brings it. Installing from a folder on the kernel's computer marks it as being worked on; installing the same folder again reloads it. Enabling starts its parts after its dependencies; a failure is kept as its error and it stays disabled. An extension cannot be disabled while an enabled one depends on it. Removing a disabled extension deletes its settings, secrets, stored values and folder. Enabled extensions start again with the kernel, dependencies first.

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
