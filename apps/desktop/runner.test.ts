import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

test.skipIf(process.platform === "win32")(
  "the bundled runner loads and closes with fake dependencies outside the source tree",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "zerolux-desktop-runner-"));
    try {
      const bundle = await Bun.build({
        entrypoints: [
          resolve(import.meta.dir, "../../extensions/claude/src/runner.ts"),
        ],
        outdir: dir,
        target: "bun",
        naming: "runner.js",
      });
      expect(bundle.success).toBe(true);
      const home = join(dir, "home");
      const workspace = join(dir, "workspace");
      await mkdir(home);
      await mkdir(workspace);
      const script = join(dir, "fixture.ts");
      await Bun.write(
        script,
        `
      import { launch } from ${JSON.stringify(pathToFileURL(join(dir, "runner.js")).href)};
      const forbidden = () => { throw new Error("A real harness or connection must not start"); };
      const code = await launch({ start: forbidden, subscriber: forbidden, connect: forbidden, saved: forbidden },
        (runner) => { void runner.handle("stop", { link_id: "fixture-link" }); });
      console.log("fixture-finished", code);
      process.exit(code);
    `,
      );
      const child = Bun.spawn([process.execPath, script], {
        cwd: dir,
        env: {
          HOME: home,
          TMPDIR: dir,
          PATH: "/usr/bin:/bin",
          ZEROLUX_RUNNER_REGISTRY: join(dir, "registry"),
          ZEROLUX_NATIVE_SESSION: "fixture-session",
          ZEROLUX_WORKSPACE: workspace,
          ZEROLUX_PERMISSION_MODE: "plan",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const timeout = setTimeout(() => child.kill(), 10_000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        expect(stdout).toContain("fixture-finished 0");
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null) child.kill();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  20_000,
);
