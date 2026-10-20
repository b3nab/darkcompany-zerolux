import {
  chmod,
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const dist = join(here, "dist");
const MANIFEST = "zerolux-extension.toml";

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

// The page's own policy is for browsers; in the app, the app's (tauri.conf.json) applies alone.
const page = await readFile(join(dist, "web/index.html"), "utf8");
const policy = /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/;
if (!policy.test(page))
  throw new Error("The web build has no Content-Security-Policy to replace");
await Bun.write(join(dist, "web/index.html"), page.replace(policy, ""));

// The small startup/error page uses the very same generated styles and design tokens.
const html = await readFile(join(dist, "web/index.html"), "utf8");
const styles = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)]
  .map(([tag]) => tag)
  .join("\n");
if (!styles) throw new Error("The web build did not include its stylesheets");
await Bun.write(
  join(dist, "web/desktop.html"),
  `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">${styles}<title>ZeroLux — Workspaces</title><script type="module" src="/desktop.js"></script></head><body><div id="root"></div></body></html>`,
);
const startup = await Bun.build({
  entrypoints: [join(here, "startup.tsx")],
  target: "browser",
  outdir: join(dist, "web"),
  naming: "desktop.js",
  minify: true,
});
if (!startup.success)
  throw new AggregateError(startup.logs, "Build desktop startup page");

// The same Better Auth service as the CLI kernel; no second auth implementation in Tauri.
const auth = await Bun.build({
  entrypoints: [join(root, "services/auth/src/server.ts")],
  target: "bun",
  outdir: join(dist, "auth"),
  naming: "server.js",
});
if (!auth.success)
  throw new AggregateError(auth.logs, "Bundle the authentication service");

// Bundle existing ZeroLux runner code, not a second implementation. The desktop supplies
// the installed Claude executable explicitly; no SDK binary is downloaded or started here.
const runner = await Bun.build({
  entrypoints: [join(root, "harnesses/claude/src/runner.ts")],
  target: "bun",
  outdir: join(dist, "claude"),
  naming: "runner.js",
});
if (!runner.success)
  throw new AggregateError(runner.logs, "Bundle the Claude runner");
const sdk = dirname(
  Bun.resolveSync(
    "@anthropic-ai/claude-agent-sdk",
    join(root, "harnesses/claude"),
  ),
);
await cp(join(sdk, "LICENSE.md"), join(dist, "claude/CLAUDE-SDK-LICENSE.md"));
await cp(join(sdk, "README.md"), join(dist, "claude/CLAUDE-SDK-README.md"));

// The pi host is the same runner the checkout uses: it opens the installed `pi` on the
// agent's own session file. Nothing of pi itself is bundled or downloaded.
const piHost = await Bun.build({
  entrypoints: [join(root, "harnesses/pi/src/runner.ts")],
  target: "bun",
  outdir: join(dist, "pi"),
  naming: "runner.js",
});
if (!piHost.success)
  throw new AggregateError(piHost.logs, "Bundle the pi host");
// The chat extension stock pi loads (`--extension`) beside the host. pi runs on Node and
// supplies its own packages: those stay imports for pi's loader, nothing of pi is copied.
const piExtension = await Bun.build({
  entrypoints: [join(root, "harnesses/pi/src/chat-extension.ts")],
  target: "node",
  outdir: join(dist, "pi"),
  naming: "chat-extension.js",
  external: ["@earendil-works/*"],
});
if (!piExtension.success)
  throw new AggregateError(piExtension.logs, "Bundle the pi chat extension");

// What a release's kernel carries inside itself (`ZEROLUX_CARRY` = this folder): beside the
// web app, sign-in and runners above, the programs it starts: Bun, the LiveKit server, and uv
// for the Python parts of extensions.
for (const [name, path] of [
  ["bun", process.execPath],
  ["livekit-server", Bun.which("livekit-server")],
  ["uv", Bun.which("uv")],
] as const) {
  if (!path)
    throw new Error(`${name} is not on the PATH: the kernel carries it`);
  const target = join(
    dist,
    process.platform === "win32" ? `${name}.exe` : name,
  );
  await rm(target, { force: true });
  await cp(await realpath(path), target);
  await chmod(target, 0o755);
}

// The official extensions a release brings, as the kernel finds them: each folder of
// `extensions/` with its manifest, without what Python leaves behind.
await rm(join(dist, "extensions"), { recursive: true, force: true });
for (const entry of await readdir(join(root, "extensions"), {
  withFileTypes: true,
})) {
  const from = join(root, "extensions", entry.name);
  if (!entry.isDirectory() || !(await Bun.file(join(from, MANIFEST)).exists()))
    continue;
  await cp(from, join(dist, "extensions", entry.name), {
    recursive: true,
    filter: (path) => !path.split(sep).includes("__pycache__"),
  });
}

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
