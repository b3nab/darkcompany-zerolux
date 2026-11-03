import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The built app, `ZeroLux.app/Contents/MacOS/zerolux`: tests run it, so they are opted into on a
 * Mac's own session, as a release is checked.
 */
export const app = process.env.ZEROLUX_DESKTOP_APP;

export const until = async <T>(
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

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The process trees the app's kernel keeps a note of, while they run. */
export async function trees(temp: string, pid: number) {
  const folder = join(temp, `zerolux-trees-${process.getuid!()}`);
  const note = (await readdir(folder)).find((name) =>
    name.startsWith(`${pid}-`),
  );
  if (!note) return [];
  return JSON.parse(await readFile(join(folder, note), "utf8")) as {
    pid: number;
  }[];
}

/** Whatever a test left running goes, with all it started. */
export const stop = (running: { pid: number }[]) => {
  for (const tree of running)
    if (alive(tree.pid)) process.kill(-tree.pid, "SIGKILL");
};

/** The core quit event, sent to this app alone, as the Dock or AppleScript sends it. */
export async function quit(pid: number) {
  const sent = Bun.spawn(
    [
      "osascript",
      "-l",
      "JavaScript",
      "-e",
      `ObjC.import("Foundation");
       const target = $.NSAppleEventDescriptor.descriptorWithProcessIdentifier(${pid});
       $.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(
         0x61657674, 0x71756974, target, -1, 0,
       ).sendEventWithOptionsTimeoutError(1, 10, null);`,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  await sent.exited;
}

/** How many of the app's windows are on screen, at the normal level: no menu, tray or panel. */
export async function windowsOnScreen(pid: number) {
  const listed = Bun.spawn(
    [
      "osascript",
      "-l",
      "JavaScript",
      "-e",
      `ObjC.import("CoreGraphics");
       const all = ObjC.deepUnwrap(ObjC.castRefToObject(
         $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0),
       ));
       all.filter((w) => w.kCGWindowOwnerPID === ${pid} && w.kCGWindowLayer === 0).length;`,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  return Number((await new Response(listed.stdout).text()).trim());
}
