import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { CONTROL_HEADER } from "./auth.ts";
import type { AuthConfig } from "./config.ts";

const source = fileURLToPath(new URL("./server.ts", import.meta.url));
let bundleRoot: string;
let bundle: string;
beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), "zerolux-auth-bundle-"));
  bundle = join(bundleRoot, "server.js");
  const result = await Bun.build({
    entrypoints: [source],
    target: "bun",
    outdir: bundleRoot,
    naming: "server.js",
  });
  expect(result.success).toBe(true);
});
afterAll(async () => {
  if (bundleRoot) await rm(bundleRoot, { recursive: true, force: true });
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function within<T>(
  promise: Promise<T>,
  milliseconds = 15_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Authentication fixture timed out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function fixture(entrypoint: string) {
  const root = await mkdtemp(join(tmpdir(), "zerolux-auth-process-"));
  const config: AuthConfig = {
    version: 1,
    workspace_id: randomUUID(),
    database: { kind: "sqlite", path: join(root, "workspace.db") },
    base_url: "http://127.0.0.1:4310",
    trusted_origins: [],
    secret: randomBytes(32).toString("hex"),
    control_token: randomBytes(32).toString("hex"),
  };
  const child = Bun.spawn([process.execPath, "--no-env-file", entrypoint], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      TMPDIR: root,
      NODE_ENV: "test",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanups.push(async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await within(child.exited);
    await rm(root, { recursive: true, force: true });
  });
  const ready = async () => {
    const reader = child.stdout.getReader();
    try {
      let output = "";
      while (!output.includes("\n")) {
        const part = await within(reader.read());
        if (part.done)
          throw new Error("Authentication fixture ended before readiness");
        output += new TextDecoder().decode(part.value);
        if (output.length > 4096)
          throw new Error("Unexpected authentication output");
      }
      expect(output).not.toContain(config.secret);
      expect(output).not.toContain(config.control_token);
      return JSON.parse(output.split("\n")[0]!) as {
        type: string;
        version: number;
        pid: number;
        workspace_id: string;
        address: string;
      };
    } finally {
      reader.releaseLock();
    }
  };
  return { child, config, ready, root };
}

describe.each(["source", "bundle"])("%s", (mode) => {
  const start = () => fixture(mode === "source" ? source : bundle);

  test("announces its loopback listener, serves real auth and exits on parent-pipe EOF", async () => {
    const { child, config, ready } = await start();
    child.stdin.write(JSON.stringify(config) + "\n");
    await child.stdin.flush();
    const state = await ready();
    expect(state.type).toBe("ready");
    expect(state.version).toBe(1);
    expect(state.pid).toBe(child.pid);
    expect(state.workspace_id).toBe(config.workspace_id);
    expect(new URL(state.address).hostname).toBe("127.0.0.1");
    expect((await fetch(state.address + "/internal/health")).status).toBe(401);
    const headers = { [CONTROL_HEADER]: config.control_token };
    const response = await fetch(state.address + "/internal/health", {
      headers,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      workspace_id: config.workspace_id,
    });
    const signup = await fetch(state.address + "/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        ...headers,
        "x-zerolux-auth-enroll": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Fixture owner",
        email: "owner@example.test",
        password: "Fixture-only password!",
      }),
    });
    expect(signup.status).toBe(200);
    const token = signup.headers.get("set-auth-token");
    expect(token).toBeTruthy();
    const session = await fetch(state.address + "/internal/session", {
      headers: { ...headers, authorization: `Bearer ${token}` },
    });
    expect(session.status).toBe(200);
    expect(((await session.json()) as { email: string }).email).toBe(
      "owner@example.test",
    );
    child.stdin.end();
    expect(await within(child.exited)).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    await expect(fetch(state.address + "/internal/health")).rejects.toThrow();
  }, 20_000);

  test("a parent disappearing during startup cannot leave a listener behind", async () => {
    const { child, config } = await start();
    child.stdin.write(JSON.stringify(config) + "\n");
    child.stdin.end();
    expect(await within(child.exited)).toBe(0);
    // Readiness may win the scheduling race with pipe EOF, especially in the bundle.
    // The invariant is no orphan listener, not an ordering between those two events.
    const output = (await new Response(child.stdout).text()).trim();
    if (output) {
      const state = JSON.parse(output) as {
        type: string;
        workspace_id: string;
        address: string;
      };
      expect(state.type).toBe("ready");
      expect(state.workspace_id).toBe(config.workspace_id);
      await expect(fetch(state.address + "/internal/health")).rejects.toThrow();
    }
  }, 20_000);

  test("invalid startup reports its category without echoing credentials", async () => {
    const { child, config } = await start();
    child.stdin.write(
      JSON.stringify({
        ...config,
        base_url: `https://user:${config.secret}@company.example`,
      }) + "\n",
    );
    await child.stdin.flush();
    expect(await within(child.exited)).toBe(1);
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({
      type: "failed",
      version: 1,
      reason: "config",
    });
    expect(await new Response(child.stderr).text()).toBe(
      "ZeroLux authentication service failed to start\n",
    );
  }, 20_000);

  test("parent EOF ends a child even when an established database query never returns", async () => {
    let querying!: () => void;
    const queryStarted = new Promise<void>((resolve) => {
      querying = resolve;
    });
    const peer = Bun.listen<{ greeted: boolean; pending: Buffer }>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.data = { greeted: false, pending: Buffer.alloc(0) };
        },
        data(socket, chunk) {
          const state = socket.data;
          state.pending = Buffer.concat([state.pending, Buffer.from(chunk)]);
          if (!state.greeted) {
            if (state.pending.length < 4) return;
            const length = state.pending.readUInt32BE(0);
            if (state.pending.length < length) return;
            state.pending = state.pending.subarray(length);
            state.greeted = true;
            // AuthenticationOk and ReadyForQuery. Never answer a subsequent query.
            socket.write(
              new Uint8Array([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73]),
            );
          }
          // Wait for an actual SimpleQuery or Parse packet, not a fragment of startup.
          if (state.pending.length >= 5 && [81, 80].includes(state.pending[0]!))
            querying();
        },
      },
    });
    cleanups.push(async () => {
      peer.stop(true);
    });
    const { child, config } = await start();
    child.stdin.write(
      JSON.stringify({
        ...config,
        database: {
          kind: "postgres",
          url: `postgresql://fixture:fixture-only@127.0.0.1:${peer.port}/fixture`,
        },
      }) + "\n",
    );
    await within(queryStarted);
    child.stdin.end();
    expect(await within(child.exited)).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(await new Response(child.stderr).text()).toBe("");
  }, 20_000);

  test("parent EOF cannot turn a pending database failure into a successful exit", async () => {
    // A fixture-owned TCP peer, not a PostgreSQL server or anybody's database.
    const peer = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data() {},
        open(socket) {
          setTimeout(() => socket.end(), 100);
        },
      },
    });
    cleanups.push(async () => {
      peer.stop(true);
    });
    const { child, config } = await start();
    child.stdin.write(
      JSON.stringify({
        ...config,
        database: {
          kind: "postgres",
          url: `postgresql://fixture:fixture-only@127.0.0.1:${peer.port}/fixture`,
        },
      }) + "\n",
    );
    child.stdin.end();
    expect(await within(child.exited)).toBe(1);
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({
      type: "failed",
      version: 1,
      reason: "database",
    });
  }, 20_000);

  test("a database failure has a distinct, nonsecret startup category", async () => {
    const { child, config, root } = await start();
    child.stdin.write(
      JSON.stringify({ ...config, database: { kind: "sqlite", path: root } }) +
        "\n",
    );
    await child.stdin.flush();
    expect(await within(child.exited)).toBe(1);
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({
      type: "failed",
      version: 1,
      reason: "database",
    });
    expect(await new Response(child.stderr).text()).toBe(
      "ZeroLux authentication service failed to start\n",
    );
  }, 20_000);
});
