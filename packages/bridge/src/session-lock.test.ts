import { expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSessionLock } from "./session-lock.ts";

test("acquisition preserves previous liveness evidence until the caller validates it", async () => {
  const root = await mkdtemp(join(tmpdir(), "zerolux-session-lease-"));
  const path = join(root, "session.lock");
  try {
    const old = JSON.stringify({ native_pid: process.pid });
    const first = acquireSessionLock(path)!;
    expect(first.previous).toBe("");
    first.write(old);
    const inode = (await stat(path)).ino;
    expect(acquireSessionLock(path)).toBeUndefined();
    first.release();
    first.release();
    const next = acquireSessionLock(path)!;
    expect(next.previous).toBe(old);
    expect(await readFile(path, "utf8")).toBe(old);
    expect((await stat(path)).ino).toBe(inode);
    // A free flock alone does not authorize replacing an execution whose PID is alive.
    next.release();
    expect(await readFile(path, "utf8")).toBe(old);
    expect(() => next.write("must not write")).toThrow("released");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("untrusted permissions, hardlinks and oversized metadata fail without truncating evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "zerolux-session-lease-"));
  const path = join(root, "session.lock");
  try {
    await writeFile(path, "evidence", { mode: 0o600 });
    await chmod(path, 0o644);
    expect(() => acquireSessionLock(path)).toThrow("private");
    expect(await readFile(path, "utf8")).toBe("evidence");
    await chmod(path, 0o600);
    const alias = join(root, "other.lock");
    await link(path, alias);
    expect(() => acquireSessionLock(alias)).toThrow("unaliased");
    expect(await readFile(path, "utf8")).toBe("evidence");
    await rm(alias);
    await writeFile(path, "x".repeat(64 * 1024 + 1));
    expect(() => acquireSessionLock(path)).toThrow("too large");
    expect((await stat(path)).size).toBe(64 * 1024 + 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
