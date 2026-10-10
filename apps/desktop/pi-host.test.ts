import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  controlRequest,
  readControlDescriptor,
} from "../../packages/bridge/src/control-client";

const extension = resolve(import.meta.dir, "../../extensions/pi");

/** A saved pi session and launch profile, written by pi's own SDK as a terminal would. */
async function fixture(
  root: string,
  agent: string,
  options: { thinking?: string; args?: string[] } = {},
) {
  const thinking = options.thinking ?? "high";
  const args = options.args ?? [];
  const script = `
    import { SessionManager } from "@earendil-works/pi-coding-agent";
    import { writeFile } from "node:fs/promises";
    import { savePiProfile } from "./src/execution-profile.ts";
    // A native process that ran and ended: the host must see it as gone.
    const old = Bun.spawn([process.execPath, "-e", ""]);
    await old.exited;
    const manager = SessionManager.create(${JSON.stringify(root)}, ${JSON.stringify(join(agent, "sessions"))});
    manager.appendModelChange("fixture", "native-model");
    manager.appendThinkingLevelChange(${JSON.stringify(thinking)});
    const file = manager.getSessionFile();
    const bytes = [manager.getHeader(), ...manager.getEntries()].map((e) => JSON.stringify(e)).join("\\n") + "\\n";
    await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    const profile = await savePiProfile({ version: 1, nativeSessionId: manager.getSessionId(), file,
      workspace: ${JSON.stringify(root)}, agentDir: ${JSON.stringify(agent)}, cliVersion: "0.87.1", lastPid: old.pid, args: ${JSON.stringify(args)} });
    console.log(JSON.stringify({ id: manager.getSessionId(), file, profile }));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: extension,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  return JSON.parse(stdout) as { id: string; file: string; profile: string };
}

test.skipIf(process.platform === "win32")(
  "the bundled pi host verifies a saved session outside the source tree and starts nothing",
  async () => {
    // Canonical, as the host records paths (`/var` is a link on macOS).
    const dir = await realpath(
      await mkdtemp(join(tmpdir(), "zerolux-desktop-pi-")),
    );
    try {
      const bundle = await Bun.build({
        entrypoints: [join(extension, "src/runner.ts")],
        outdir: dir,
        target: "bun",
        naming: "runner.js",
      });
      expect(bundle.success).toBe(true);
      const home = join(dir, "home");
      const workspace = join(dir, "workspace");
      const agent = join(home, ".pi/agent");
      const registry = join(dir, "registry");
      await mkdir(workspace, { recursive: true });
      await mkdir(join(agent, "sessions"), { recursive: true });
      const saved = await fixture(workspace, agent);
      // No pi on this PATH, no checkout: the host must stand on the bundle alone.
      const child = Bun.spawn([process.execPath, join(dir, "runner.js")], {
        cwd: dir,
        env: {
          HOME: home,
          TMPDIR: dir,
          PATH: "/usr/bin:/bin",
          ZEROLUX_PI_REGISTRY: registry,
          ZEROLUX_PI_CONFIG: JSON.stringify({
            nativeSessionId: saved.id,
            workspace,
            file: saved.file,
            profile: saved.profile,
            pi: "pi",
            entry: "unused",
          }),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const timeout = setTimeout(() => child.kill(), 15_000);
      try {
        // Ready: the host verified file and profile and published its private control.
        let descriptor: string | undefined;
        for (let i = 0; i < 100 && !descriptor; i++) {
          await Bun.sleep(100);
          descriptor = (await readdir(registry).catch(() => []))
            .filter((name) => name.endsWith(".json"))
            .map((name) => join(registry, name))[0];
          if (child.exitCode !== null) break;
        }
        if (!descriptor)
          throw new Error(
            `host exited ${child.exitCode}: ${await new Response(child.stderr).text()}`,
          );
        const record = JSON.parse(await readFile(descriptor!, "utf8"));
        expect(record.kind).toBe("pi-runner");
        expect(child.exitCode).toBeNull();
        // Nothing native was started: no bind arrived, and no pi exists on this PATH.
        expect(record.native_pid ?? null).toBeNull();
        child.kill("SIGTERM");
        const [code, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
        ]);
        expect(stderr).toBe("");
        expect(
          code === 0 || code === 143 || child.signalCode === "SIGTERM",
        ).toBe(true);
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null) child.kill();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

test("the bundled pi chat extension leaves pi's packages to pi's own loader and needs no Bun", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerolux-desktop-pi-ext-"));
  try {
    const bundle = await Bun.build({
      entrypoints: [join(extension, "src/chat-extension.ts")],
      outdir: dir,
      target: "node",
      naming: "chat-extension.js",
      external: ["@earendil-works/*"],
    });
    expect(bundle.success).toBe(true);
    const code = await readFile(join(dir, "chat-extension.js"), "utf8");
    // Stock pi runs on Node: nothing of Bun, and pi's SDK stays an import it resolves.
    expect(code).not.toContain("bun:");
    expect(code).toContain('from "@earendil-works/pi-coding-agent"');
    // Everything of ZeroLux is inside: no import reaches back into the checkout.
    expect(code).not.toMatch(/from "\.{1,2}\//);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const stockPi = Bun.which("pi");
const node = Bun.which("node");

test.skipIf(process.platform === "win32" || !stockPi || !node)(
  "the bundled host starts stock pi with the bundled extension, verifies it and stops it",
  async () => {
    // A short path: Unix sockets under it are limited to about 100 bytes on macOS.
    const dir = await realpath(await mkdtemp("/tmp/zl-pi-"));
    const kernel = Bun.serve({
      port: 0,
      fetch: () => new Response("", { status: 404 }),
    });
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      for (const [entry, target, naming, external] of [
        ["src/runner.ts", "bun", "runner.js", []],
        [
          "src/chat-extension.ts",
          "node",
          "chat-extension.js",
          ["@earendil-works/*"],
        ],
      ] as const) {
        const bundle = await Bun.build({
          entrypoints: [join(extension, entry)],
          outdir: dir,
          target,
          naming,
          external: [...external],
        });
        expect(bundle.success).toBe(true);
      }
      // An isolated pi: its own home, a provider that reaches nothing, the folder trusted.
      const home = join(dir, "home");
      const workspace = join(dir, "workspace");
      const agent = join(home, ".pi/agent");
      await mkdir(workspace, { recursive: true });
      await mkdir(join(agent, "sessions"), { recursive: true });
      await Bun.write(
        join(agent, "models.json"),
        JSON.stringify({
          providers: {
            fixture: {
              baseUrl: "http://127.0.0.1:9/v1",
              api: "openai-completions",
              apiKey: "fixture",
              models: [{ id: "native-model" }],
            },
          },
        }),
      );
      await Bun.write(
        join(agent, "trust.json"),
        JSON.stringify({ [workspace]: true }),
      );
      const saved = await fixture(workspace, agent, {
        thinking: "off",
        args: ["--extension", join(dir, "chat-extension.js")],
      });
      // The owner's intent, as the host reads it before starting anything native.
      kernel.reload({
        fetch(request) {
          // Other calls (status, activity) are acknowledged; only the inbox matters here.
          if (new URL(request.url).pathname !== "/api/chat/inbox")
            return Response.json({});
          return Response.json({
            session: {
              id: "link",
              actor_id: "actor",
              harness: "pi",
              native_session_id: saved.id,
              workspace,
              status: "connecting",
            },
            workspace: { id: "company", name: "Fixture" },
            conversations: [],
            deliveries: [],
          });
        },
      });
      const registry = join(dir, "registry");
      child = Bun.spawn([process.execPath, join(dir, "runner.js")], {
        cwd: dir,
        env: {
          HOME: home,
          TMPDIR: dir,
          PATH: `${dirname(node!)}:/usr/bin:/bin`,
          ZEROLUX_PI_REGISTRY: registry,
          ZEROLUX_PI_CONFIG: JSON.stringify({
            nativeSessionId: saved.id,
            workspace,
            file: saved.file,
            profile: saved.profile,
            pi: stockPi,
            entry: "unused",
          }),
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      const stderr = new Response(child.stderr as ReadableStream).text();
      let path: string | undefined;
      for (let i = 0; i < 100 && !path; i++) {
        await Bun.sleep(100);
        path = (await readdir(registry).catch(() => []))
          .filter((name) => name.endsWith(".json"))
          .map((name) => join(registry, name))[0];
      }
      if (!path)
        throw new Error(`host exited ${child.exitCode}: ${await stderr}`);
      const descriptor = await readControlDescriptor(path);
      const bound = await controlRequest(descriptor, "bind", {
        base_url: `http://127.0.0.1:${kernel.port}`,
        token: "fixture",
      }).catch(async (error) => {
        child!.kill();
        throw new Error(`${error}\nhost stderr: ${await stderr}`);
      });
      // Running: stock pi loaded the bundled extension (its guard verified the host) and
      // answered get_state with the saved model and thinking, which it persisted again.
      expect(bound.ok).toBe(true);
      const state = await controlRequest(descriptor, "describe");
      expect(state.phase).toBe("running");
      expect(state.model).toEqual({ provider: "fixture", id: "native-model" });
      expect(state.thinking).toBe("off");
      const history = (await readFile(saved.file, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).type);
      expect(history).toEqual([
        "session",
        "model_change",
        "thinking_level_change",
        "model_change",
        "thinking_level_change",
      ]);
      expect(
        await controlRequest(descriptor, "stop", { link_id: "link" }),
      ).toEqual({ ok: true });
      expect(
        await Promise.race([
          child.exited,
          Bun.sleep(10_000).then(() => "late"),
        ]),
      ).toBe(0);
    } finally {
      if (child && child.exitCode === null) child.kill();
      kernel.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
