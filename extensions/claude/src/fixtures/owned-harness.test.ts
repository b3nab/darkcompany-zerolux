import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rpc = (endpoint: string, body: unknown) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = connect(endpoint);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => resolve(JSON.parse(data)));
    socket.on("error", reject);
    socket.write(`${JSON.stringify(body)}\n`);
  });

test("the fixture runner registers, answers describe, and leaves cleanly on SIGTERM", async () => {
  const root = await mkdtemp(join(tmpdir(), "zerolux-harness-"));
  const registry = join(root, "registry");
  const native = crypto.randomUUID();
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "owned-harness.ts")],
    {
      env: {
        ...process.env,
        ZEROLUX_RUNNER_REGISTRY: registry,
        ZEROLUX_NATIVE_SESSION: native,
        ZEROLUX_WORKSPACE: root,
        ZEROLUX_PERMISSION_MODE: "default",
      },
      stderr: "pipe",
    },
  );
  try {
    let descriptor: string | undefined;
    for (let i = 0; i < 100 && !descriptor; i++) {
      await Bun.sleep(50);
      descriptor = (await readdir(registry).catch(() => [])).find((f) =>
        f.endsWith(".json"),
      );
    }
    const info = JSON.parse(
      await readFile(join(registry, descriptor!), "utf8"),
    );
    expect(info).toMatchObject({
      kind: "claude-runner",
      native_session_id: native,
      permission_mode: "default",
      bound: false,
    });
    const described = await rpc(info.endpoint, {
      nonce: info.nonce,
      method: "describe",
    });
    expect(described).toMatchObject({ ok: true, native_session_id: native });
    // A wrong nonce gets nothing.
    expect(
      (await rpc(info.endpoint, { nonce: "wrong", method: "describe" })).ok,
    ).toBe(false);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    // The descriptor goes with it; the lock file stays (released by the system).
    expect((await readdir(registry)).sort()).toEqual([`${native}.lock`]);
  } finally {
    child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("a fixture runner stopped before any bind answers and exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "zerolux-harness-"));
  const registry = join(root, "registry");
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "owned-harness.ts")],
    {
      env: {
        ...process.env,
        ZEROLUX_RUNNER_REGISTRY: registry,
        ZEROLUX_NATIVE_SESSION: crypto.randomUUID(),
        ZEROLUX_WORKSPACE: root,
        ZEROLUX_PERMISSION_MODE: "default",
      },
      stderr: "pipe",
    },
  );
  try {
    let descriptor: string | undefined;
    for (let i = 0; i < 100 && !descriptor; i++) {
      await Bun.sleep(50);
      descriptor = (await readdir(registry).catch(() => [])).find((f) =>
        f.endsWith(".json"),
      );
    }
    const info = JSON.parse(
      await readFile(join(registry, descriptor!), "utf8"),
    );
    expect(
      await rpc(info.endpoint, {
        nonce: info.nonce,
        method: "stop",
        link_id: "session",
      }),
    ).toEqual({ ok: true });
    expect(await child.exited).toBe(0);
  } finally {
    child.kill();
    await rm(root, { recursive: true, force: true });
  }
});
