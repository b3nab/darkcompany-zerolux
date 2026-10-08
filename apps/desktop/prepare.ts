import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const dist = join(here, "dist");

async function run(
  args: string[],
  cwd = here,
  env: Record<string, string> = {},
) {
  const child = Bun.spawn(args, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) throw new Error(`Failed: ${args.join(" ")}`);
}

// A desktop build never replaces the assets served by the running web kernel.
await mkdir(dist, { recursive: true });
await rm(join(dist, "web"), { recursive: true, force: true });
await run(["bun", "run", "build"], join(root, "apps/web"), {
  ZEROLUX_WEB_OUTDIR: join(dist, "web"),
});

// The small startup/error page uses the very same generated styles and design tokens.
const html = await readFile(join(dist, "web/index.html"), "utf8");
const styles = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)]
  .map(([tag]) => tag)
  .join("\n");
if (!styles) throw new Error("The web build did not include its stylesheets");
await Bun.write(
  join(dist, "web/desktop.html"),
  `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">${styles}<title>ZeroLux</title><script type="module" src="/desktop.js"></script></head><body><main style="padding:3rem;max-width:56rem;font-family:system-ui"><h1>ZeroLux</h1><p id="status">Opening ZeroLux…</p><pre id="error" role="alert" style="white-space:pre-wrap;overflow-wrap:anywhere;margin-block:1rem"></pre><fieldset id="choices" hidden disabled style="border:0;padding:0"><form id="connection"><label for="address">Existing workspace — kernel address</label><div style="display:flex;gap:0.5rem;margin-block:0.75rem"><input id="address" type="url" required value="http://127.0.0.1:4310/" style="flex:1;min-width:0;padding:0.5rem;border:1px solid var(--border);border-radius:var(--radius)"><button type="submit" style="padding:0.5rem 1rem;background:var(--primary);color:var(--primary-foreground);border-radius:var(--radius)">Use workspace</button></div><p>This opens the same organization, chats and agents. Closing this window will not stop its kernel.</p></form><hr style="margin-block:1.5rem"><button id="local" type="button" style="padding:0.5rem 1rem;border:1px solid var(--border);border-radius:var(--radius)">Use a local workspace</button><p style="margin-top:0.75rem">Starts the desktop's separate local kernel. A new local workspace begins with onboarding; no existing workspace is copied or replaced.</p></fieldset></main></body></html>`,
);
const startup = await Bun.build({
  entrypoints: [join(here, "startup.ts")],
  target: "browser",
  outdir: join(dist, "web"),
  naming: "desktop.js",
  minify: true,
});
if (!startup.success)
  throw new AggregateError(startup.logs, "Build desktop startup page");

// Bundle existing ZeroLux runner code, not a second implementation. The desktop supplies
// the installed Claude executable explicitly; no SDK binary is downloaded or started here.
const runner = await Bun.build({
  entrypoints: [join(root, "extensions/claude/src/runner.ts")],
  target: "bun",
  outdir: join(dist, "claude"),
  naming: "runner.js",
});
if (!runner.success)
  throw new AggregateError(runner.logs, "Bundle the Claude runner");
const sdk = dirname(
  Bun.resolveSync(
    "@anthropic-ai/claude-agent-sdk",
    join(root, "extensions/claude"),
  ),
);
await cp(join(sdk, "LICENSE.md"), join(dist, "claude/CLAUDE-SDK-LICENSE.md"));
await cp(join(sdk, "README.md"), join(dist, "claude/CLAUDE-SDK-README.md"));

// Generate platform icons from the existing web favicon; no independent desktop branding.
const source = await readFile(join(root, "apps/web/index.html"), "utf8");
const favicon = source.match(/href="data:image\/svg\+xml,([^"]+)"/);
if (!favicon) throw new Error("Web favicon was not found");
await Bun.write(join(dist, "icon.svg"), decodeURIComponent(favicon[1]!));
await run([
  "bun",
  "x",
  "--bun",
  "tauri",
  "icon",
  join(dist, "icon.svg"),
  "--output",
  join(dist, "icons"),
]);
