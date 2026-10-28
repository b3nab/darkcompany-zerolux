import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  acquireSessionLock,
  type SessionLock,
} from "@zerolux/bridge/session-lock";
import { processExists } from "@zerolux/bridge/process-state";
import { ClaudeExecution } from "./execution.ts";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

const gate = resolve(
  import.meta.dir,
  "../../../packages/bridge/src/exec-gate.ts",
);
async function fixture(previous?: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "zerolux-claude-exec-"));
  const path = join(root, "session.lock");
  const identity = {
    nativeSessionId: "native",
    workspace: root,
    instanceId: "instance",
  };
  const old = {
    ...identity,
    version: 1,
    kind: "claude-execution",
    holderPid: 100,
    nativePid: null,
    phase: "waiting",
    started: false,
    released: false,
  };
  if (previous)
    await writeFile(path, JSON.stringify({ ...old, ...previous }), {
      mode: 0o600,
    });
  const locks: SessionLock[] = [];
  const lock = () => {
    const result = acquireSessionLock(path)!;
    expect(result).toBeDefined();
    locks.push(result);
    return result;
  };
  return {
    root,
    path,
    identity,
    lock,
    record: async () => JSON.parse(await readFile(path, "utf8")),
    options: (script: string) => ({
      command: process.execPath,
      args: ["-e", script],
      cwd: root,
      env: { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin" },
      signal: new AbortController().signal,
    }),
    close: async () => {
      for (const l of locks) l.release();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function output(child: SpawnedProcess) {
  let text = "";
  for await (const chunk of child.stdout) text += chunk.toString();
  return text;
}

// The actual fake child PID is durably recorded before exec; stdin remains the SDK's.
test("a gated Claude child keeps its recorded PID and original SDK input", async () => {
  const f = await fixture();
  const owner = new ClaudeExecution(f.lock(), f.identity, gate);
  try {
    const child = owner.spawn(
      f.options(`
let text = "";
process.stdin.on("data", b => text += b);
process.stdin.on("end", () => console.log(JSON.stringify({pid:process.pid, text})));
`),
    );
    const running = await f.record();
    expect(running.phase).toBe("running");
    expect(running.started).toBe(true);
    expect(processExists(running.nativePid)).toBe(true);
    expect(() => owner.release(true)).toThrow();
    child.stdin.end('{"type":"initialize"}\n');
    // On Windows, which cannot exec in place, the gate serves the native as its child.
    expect(JSON.parse(await output(child))).toEqual({
      pid:
        process.platform === "win32" ? expect.any(Number) : running.nativePid,
      text: '{"type":"initialize"}\n',
    });
    await owner.waitForExit();
    expect((await f.record()).phase).toBe("exited");
    expect((await f.record()).released).toBe(false);
    owner.release(true);
    expect((await f.record()).released).toBe(true);
    // A positive release is stronger than a subsequently reused PID.
    const next = new ClaudeExecution(
      f.lock(),
      { ...f.identity, instanceId: "next" },
      gate,
      () => true,
    );
    expect(next.describe().native_phase).toBe("waiting");
    next.release(true);
  } finally {
    owner.release();
    await f.close();
  }
});

test("a free helper lease does not permit replacing its live native child", async () => {
  const f = await fixture();
  const owner = new ClaudeExecution(f.lock(), f.identity, gate);
  const child = owner.spawn(f.options("process.stdin.resume();"));
  try {
    const before = await f.record();
    owner.release(); // Simulated helper loss, not native Stop. Its child still owns stdin.
    const free = f.lock();
    expect(
      () =>
        new ClaudeExecution(
          free,
          f.identity,
          gate,
          (p) => p === before.nativePid && processExists(p),
        ),
    ).toThrow();
    expect(await f.record()).toEqual(before);
    expect(processExists(before.nativePid)).toBe(true);
    free.release();
    child.stdin.end();
    await owner.waitForExit();
    expect(processExists(before.nativePid)).toBe(false);
    const next = new ClaudeExecution(f.lock(), f.identity, gate, () => false);
    expect(next.describe().native_phase).toBe("waiting");
    next.release(true);
  } finally {
    child.stdin.end();
    await owner.waitForExit();
    owner.release();
    await f.close();
  }
});

// The native's own PID is the recorded one only where the gate execs in place.
test.skipIf(process.platform === "win32")(
  "a real helper crash cannot recreate its still-live fake native child",
  async () => {
    const f = await fixture();
    const host = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/execution-host.ts"),
        f.root,
      ],
      {
        env: { HOME: f.root, TMPDIR: f.root, PATH: "/usr/bin:/bin" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let nativePid: number | undefined;
    const reader = host.stdout.getReader();
    try {
      let text = "";
      while (!text.includes("\n")) {
        const part = await reader.read();
        if (part.done)
          throw new Error("Fake host exited before its child was ready");
        text += new TextDecoder().decode(part.value);
      }
      nativePid = Number(text.trim());
      const before = await f.record();
      expect(before.holderPid).toBe(host.pid);
      expect(before.nativePid).toBe(nativePid);
      expect(processExists(nativePid)).toBe(true);
      host.kill("SIGKILL"); // This fixture alone: a crash, not an owner Stop.
      await host.exited;
      expect(processExists(host.pid)).toBe(false);
      const free = f.lock();
      expect(() => new ClaudeExecution(free, f.identity, gate)).toThrow();
      expect(await f.record()).toEqual(before);
      expect(processExists(nativePid)).toBe(true);
      free.release();
      process.kill(nativePid, "SIGTERM"); // Only the child created by this isolated fixture.
      for (let n = 0; n < 100 && processExists(nativePid); n++)
        await Bun.sleep(20);
      expect(processExists(nativePid)).toBe(false);
      const next = new ClaudeExecution(f.lock(), f.identity, gate);
      expect(next.describe().native_phase).toBe("waiting");
      next.release(true);
    } finally {
      host.kill("SIGKILL");
      await host.exited;
      if (nativePid && processExists(nativePid))
        process.kill(nativePid, "SIGKILL");
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      await f.close();
    }
  },
  10_000,
);

test("unknown spawn, invalid evidence and ambiguous process checks refuse without erasing evidence", async () => {
  for (const fields of [
    { phase: "starting", started: true },
    { nativePid: 123, phase: "running", started: true },
    { holderPid: 0 },
    { version: 2 },
    { workspace: "/another" },
    { nativePid: 123, released: true },
  ]) {
    const f = await fixture(fields);
    try {
      const before = await f.record();
      expect(
        () => new ClaudeExecution(f.lock(), f.identity, gate, () => true),
      ).toThrow();
      expect(await f.record()).toEqual(before);
    } finally {
      await f.close();
    }
  }
});

test("failure to record startup cannot authorize native exec", async () => {
  const f = await fixture({
    phase: "exited",
    started: true,
    released: true,
  });
  const lock = f.lock();
  const owner = new ClaudeExecution(
    {
      ...lock,
      write: (text) => {
        if (JSON.parse(text).phase === "starting")
          throw new Error("fixture disk unavailable");
        lock.write(text);
      },
    },
    f.identity,
    gate,
  );
  try {
    const before = await f.record();
    const marker = join(f.root, "native-started");
    expect(() =>
      owner.spawn(f.options(`Bun.write(${JSON.stringify(marker)}, "bad")`)),
    ).toThrow("fixture disk unavailable");
    await owner.waitForExit();
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await f.record()).toEqual(before); // Old proof survives only with NO new native effects.
  } finally {
    owner.release();
    await f.close();
  }
});

test("Stop prevents a waiting host from spawning", async () => {
  const f = await fixture();
  const owner = new ClaudeExecution(f.lock(), f.identity, gate);
  try {
    const options = f.options("throw new Error('must not execute')");
    owner.requestStop();
    expect(() => owner.spawn(options)).toThrow();
    expect((await f.record()).phase).toBe("waiting");
    owner.release(true);
  } finally {
    owner.release();
    await f.close();
  }
});

test.each(["metadata write failure", "stopped before native execution"])(
  "%s cannot execute the gated native program",
  async (reason) => {
    const f = await fixture();
    const lock = f.lock();
    let writes = 0;
    const owner = new ClaudeExecution(
      {
        ...lock,
        write: (value) => {
          if (++writes === 3) {
            if (reason === "metadata write failure") throw new Error(reason);
            owner.requestStop();
          }
          lock.write(value);
        },
      },
      f.identity,
      gate,
    );
    try {
      const marker = join(f.root, "native-started");
      expect(() =>
        owner.spawn(f.options(`Bun.write(${JSON.stringify(marker)}, "bad")`)),
      ).toThrow();
      await owner.waitForExit();
      expect(await Bun.file(marker).exists()).toBe(false);
      expect((await f.record()).phase).toBe("exited");
      owner.release(true);
    } finally {
      owner.release();
      await f.close();
    }
  },
);
