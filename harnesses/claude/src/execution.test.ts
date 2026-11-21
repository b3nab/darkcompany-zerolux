import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeExecution } from "./execution.ts";

// A disposable child stands in for Claude Code: no SDK query and no model.
async function folder() {
  return realpath(await mkdtemp(join(tmpdir(), "zerolux-claude-execution-")));
}

function child(root: string, source: string, signal = new AbortController()) {
  return {
    command: process.execPath,
    args: ["-e", source],
    cwd: root,
    env: { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin" },
    signal: signal.signal,
  };
}

test("the process the SDK asks for is started as asked, and its end is known", async () => {
  const root = await folder();
  try {
    const execution = new ClaudeExecution();
    expect(execution.describe()).toEqual({
      native_pid: null,
      native_phase: "waiting",
    });
    const spawned = execution.spawn(
      child(
        root,
        "process.stdin.once('data', (said) => { process.stdout.write(said); process.exit(0); })",
      ),
    );
    const running = execution.describe();
    expect(running.native_phase).toBe("running");
    expect(running.native_pid).toBeGreaterThan(0);
    // Its input and output are the SDK's own.
    let heard = "";
    spawned.stdout.on("data", (bytes: Buffer) => (heard += bytes.toString()));
    spawned.stdin.write("FAKE_INPUT");
    await execution.waitForExit();
    expect(heard).toBe("FAKE_INPUT");
    expect(execution.describe().native_phase).toBe("exited");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Stop ends the child this host started even when it stays alive after EOF", async () => {
  const root = await folder();
  const execution = new ClaudeExecution();
  const native = execution.spawn(
    child(
      root,
      "process.stdin.resume(); setInterval(() => {}, 1000); console.log(process.pid)",
    ),
  );
  try {
    await new Promise<void>((resolve) =>
      native.stdout.once("data", () => resolve()),
    );
    native.stdin.end();
    execution.requestStop();
    await execution.waitForExit();
    expect(execution.describe().native_phase).toBe("exited");
  } finally {
    native.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("nothing is started after a Stop", async () => {
  const root = await folder();
  try {
    const execution = new ClaudeExecution();
    execution.requestStop();
    expect(() => execution.spawn(child(root, ""))).toThrow();
    expect(execution.describe().native_pid).toBeNull();
    // With nothing started there is nothing to wait for.
    await execution.waitForExit();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
