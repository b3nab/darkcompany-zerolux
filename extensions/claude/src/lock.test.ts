import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockSession } from "./lock.ts";

test("one holder per session lock; the lock goes with the holder, the file stays", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerolux-lock-"));
  try {
    const path = join(dir, "native.lock");
    const first = lockSession(path, "first");
    expect(first).toBeFunction();
    // A second open of the same file cannot take it while the first holds it.
    expect(lockSession(path, "second")).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe("first");
    first!();
    const second = lockSession(path, "second");
    expect(second).toBeFunction();
    expect(await readFile(path, "utf8")).toBe("second");
    second!();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lock held by another process blocks; once that process dies, it is free", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerolux-lock-"));
  const path = join(dir, "native.lock");
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { lockSession } from ${JSON.stringify(join(import.meta.dir, "lock.ts"))};
       if (!lockSession(${JSON.stringify(path)}, "holder")) process.exit(1);
       console.log("held");
       setInterval(() => {}, 1000);`,
    ],
    { stdout: "pipe" },
  );
  try {
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "held",
    );
    expect(lockSession(path, "mine")).toBeUndefined();
    holder.kill("SIGKILL");
    await holder.exited;
    // The system released it with the dead process: no stale file to take over.
    const release = lockSession(path, "mine");
    expect(release).toBeFunction();
    release!();
  } finally {
    holder.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lock path that is a symlink or not a regular file is refused, and nothing is written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerolux-lock-"));
  try {
    const target = join(dir, "elsewhere");
    await Bun.write(target, "keep me");
    const link = join(dir, "link.lock");
    await symlink(target, link);
    expect(() => lockSession(link, "mine")).toThrow();
    expect(await readFile(target, "utf8")).toBe("keep me");
    const folder = join(dir, "folder.lock");
    await mkdir(folder);
    expect(() => lockSession(folder, "mine")).toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
