import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The built app, `ZeroLux.app/Contents/MacOS/zerolux`: this test runs it, so it is opted into
 * on a Mac's own session, as a release is checked.
 */
const app = process.env.ZEROLUX_DESKTOP_APP;

const until = async <T>(
  read: () => Promise<T | undefined>,
  seconds: number,
) => {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error("Timed out");
    await Bun.sleep(250);
  }
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The process trees the app's kernel keeps a note of, while they run. */
async function trees(temp: string, pid: number) {
  const folder = join(temp, `zerolux-trees-${process.getuid!()}`);
  const note = (await readdir(folder)).find((name) =>
    name.startsWith(`${pid}-`),
  );
  if (!note) return [];
  return JSON.parse(await readFile(join(folder, note), "utf8")) as {
    pid: number;
  }[];
}

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
      // The core quit event, sent to this app alone.
      const quit = Bun.spawn(
        [
          "osascript",
          "-l",
          "JavaScript",
          "-e",
          `ObjC.import("Foundation");
           const target = $.NSAppleEventDescriptor.descriptorWithProcessIdentifier(${child.pid});
           $.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(
             0x61657674, 0x71756974, target, -1, 0,
           ).sendEventWithOptionsTimeoutError(1, 10, null);`,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      await quit.exited;
      await until(async () => (alive(child.pid) ? undefined : true), 60);
      // None outlives the app: one left behind would run on, its parent gone.
      await Bun.sleep(1000);
      expect(running.filter((tree) => alive(tree.pid))).toEqual([]);
    } finally {
      // Whatever a failed quit left running goes too, with all it started.
      for (const tree of running)
        if (alive(tree.pid)) process.kill(-tree.pid, "SIGKILL");
      await rm(temp, { recursive: true, force: true });
    }
  },
  150_000,
);
