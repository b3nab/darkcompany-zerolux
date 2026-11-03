import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alive, app, quit, stop, trees, until } from "./run-app";

test.skipIf(process.platform !== "darwin" || !app)(
  "a quit from macOS, as the Dock or AppleScript sends it, stops the app's kernel and what it runs before the app ends",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "zerolux-quit-"));
    let running: { pid: number }[] = [];
    try {
      const child = Bun.spawn([app!, "--local"], {
        env: {
          ...process.env,
          ZEROLUX_DESKTOP_DATA_DIR: join(temp, "data"),
          TMPDIR: temp,
        },
        stdout: "ignore",
        stderr: "ignore",
      });
      // This computer's ZeroLux started, with the processes it runs.
      running = await until(async () => {
        const list = await trees(temp, child.pid);
        return list.length ? list : undefined;
      }, 60);
      await quit(child.pid);
      await until(async () => (alive(child.pid) ? undefined : true), 60);
      // None outlives the app: one left behind would run on, its parent gone.
      await Bun.sleep(1000);
      expect(running.filter((tree) => alive(tree.pid))).toEqual([]);
    } finally {
      stop(running);
      await rm(temp, { recursive: true, force: true });
    }
  },
  150_000,
);
