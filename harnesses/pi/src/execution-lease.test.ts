import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiExecutionLease, piLeaseFile } from "./execution-lease.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zerolux-pi-execution-"));
  const file = join(root, "session.jsonl");
  await writeFile(file, "fixture history");
  const identity = { nativeSessionId: "fixture", file, workspace: root };
  return {
    root,
    file,
    identity,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("a helper's death/free flock never substitutes for native process death", async () => {
  const f = await fixture();
  const alive = new Set<number>([123456]);
  const options = { alive: (pid: number) => alive.has(pid) };
  try {
    const first = await PiExecutionLease.acquire(f.identity, options);
    first.setNativeProcess(123456);
    await expect(PiExecutionLease.acquire(f.identity, options)).rejects.toThrow(
      "Another controller",
    );
    expect(() => first.close("exited")).toThrow("not confirmed");
    first.close("lost");
    await expect(PiExecutionLease.acquire(f.identity, options)).rejects.toThrow(
      "still alive",
    );
    alive.delete(123456);
    const restored = await PiExecutionLease.acquire(f.identity, options);
    expect(restored.previousNativeStopped(123456)).toBe(false);
    restored.close("exited");
    expect(await readFile(f.file, "utf8")).toBe("fixture history");
  } finally {
    await f.close();
  }
});

test("a terminal reacquires its lost helper without granting a second native writer", async () => {
  const f = await fixture();
  const options = {
    terminalPid: 123456,
    alive: (pid: number) => pid === 123456,
  };
  try {
    const first = await PiExecutionLease.acquire(f.identity, options);
    first.close("lost");
    const again = await PiExecutionLease.acquire(f.identity, options);
    expect(again.identity.nativeSessionId).toBe("fixture");
    again.close("switched"); // Native SDK has finished switching away from this file.
    const other = await PiExecutionLease.acquire(f.identity, {
      alive: options.alive,
    });
    expect(other.previousNativeStopped(123456)).toBe(true);
    expect(other.previousNativeStopped(654321)).toBe(false);
    other.close("exited");
  } finally {
    await f.close();
  }
});

test("corrupt or mismatched ownership evidence is retained and refused", async () => {
  const f = await fixture();
  try {
    const lease = await PiExecutionLease.acquire(f.identity);
    lease.close("exited");
    const path = await piLeaseFile(f.file);
    const original = await readFile(path, "utf8");
    await expect(
      PiExecutionLease.acquire({
        ...f.identity,
        nativeSessionId: "replacement",
      }),
    ).rejects.toThrow("cannot be identified");
    expect(await readFile(path, "utf8")).toBe(original);
    await writeFile(path, "{corrupt");
    await expect(PiExecutionLease.acquire(f.identity)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("{corrupt");
  } finally {
    await f.close();
  }
});
