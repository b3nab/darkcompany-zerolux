import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  alive,
  app,
  quit,
  stop,
  trees,
  until,
  windowsOnScreen,
} from "./run-app";

type Session = Record<string, ({ path: string | null } | null)[]>;

test.skipIf(process.platform !== "darwin" || !app)(
  "the windows open are kept as the app works, and after a crash all of them open again",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "zerolux-session-"));
    const data = join(temp, "data");
    const file = join(data, "windows.json");
    const env = {
      ...process.env,
      ZEROLUX_DESKTOP_DATA_DIR: data,
      TMPDIR: temp,
    };
    const read = async () =>
      JSON.parse(await readFile(file, "utf8")) as Session;
    let running: { pid: number }[] = [];
    try {
      // This computer's ZeroLux in a window: kept on its page while the app runs.
      const first = Bun.spawn([app!, "--local"], {
        env,
        stdout: "ignore",
        stderr: "ignore",
      });
      const kept = await until(async () => {
        const session = await read();
        const [places] = Object.values(session);
        return places?.[0]?.path ? session : undefined;
      }, 90);
      running = await trees(temp, first.pid);
      // A crash: nothing more is kept on the way out.
      first.kill("SIGKILL");
      await first.exited;
      stop(running);
      // Its ZeroLux had a second window open too.
      const [[profile, [window]]] = Object.entries(kept);
      await writeFile(file, JSON.stringify({ [profile]: [window, window] }));
      const next = Bun.spawn([app!], {
        env,
        stdout: "ignore",
        stderr: "ignore",
      });
      await until(
        async () =>
          (await windowsOnScreen(next.pid)) === 2 ? true : undefined,
        90,
      );
      running = await trees(temp, next.pid);
      await quit(next.pid);
      await until(async () => (alive(next.pid) ? undefined : true), 60);
      // Both are kept for the next launch, each on its page.
      const places = (await read())[profile];
      expect(places).toHaveLength(2);
      expect(places!.every((place) => place?.path)).toBe(true);
    } finally {
      stop(running);
      await rm(temp, { recursive: true, force: true });
    }
  },
  300_000,
);
