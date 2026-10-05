import { expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChatControl } from "./chat-control.ts";

async function rpc(endpoint: string, body: unknown) {
  return new Promise<any>((resolve, reject) => {
    const socket = connect(endpoint);
    let text = "";
    socket.setTimeout(2000, () => socket.destroy(new Error("fixture timeout")));
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(body) + "\n"));
    socket.on("data", (chunk) => {
      text += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
  });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zl-control-test-"));
  const registry = join(root, "registry");
  const pairs: unknown[] = [],
    stops: string[] = [];
  const description = {
    native_session_id: "native",
    workspace: root,
    title: "pi fixture",
    busy: false,
    paired: false,
  };
  const control = new ChatControl(registry, {
    describe: () => description,
    sessions: async () => [
      {
        native_session_id: "native",
        title: "pi fixture",
        workspace: root,
        last_activity_at: 1,
        path: join(root, "session.jsonl"),
      },
    ],
    pair: async (request) => {
      pairs.push(request);
      return "link";
    },
    stop: async (id) => {
      stops.push(id);
    },
  });
  await control.start();
  const path = join(registry, (await readdir(registry))[0]!);
  const descriptor = JSON.parse(await readFile(path, "utf8"));
  return {
    root,
    path,
    registry,
    descriptor,
    control,
    pairs,
    stops,
    description,
    call: (body: unknown) =>
      rpc(descriptor.endpoint, {
        nonce: descriptor.nonce,
        ...(body as object),
      }),
    close: async () => {
      await control.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("private IPC advertises metadata but does not connect or start model work", async () => {
  const f = await fixture();
  try {
    if (process.platform !== "win32")
      expect((await stat(f.path)).mode & 0o077).toBe(0);
    const response = await f.call({ method: "describe" });
    expect(response.native_session_id).toBe("native");
    expect(response.nonce).toBeUndefined();
    expect(f.pairs).toHaveLength(0);
    expect(f.stops).toHaveLength(0);
    expect(
      (await rpc(f.descriptor.endpoint, { method: "describe", nonce: "wrong" }))
        .ok,
    ).toBe(false);
    expect(
      (await f.call({ method: "prompt", message: "not supported" })).ok,
    ).toBe(false);
  } finally {
    await f.close();
  }
});
test("pairing uses a private frame, verifies native identity, and never stores the chat Bearer", async () => {
  const f = await fixture();
  try {
    const request = {
      method: "pair",
      base_url: "http://127.0.0.1:4310",
      token: "SECRET_BEARER",
      executable: "/installed/zerolux",
      native_session_id: "native",
      workspace: f.root,
    };
    expect((await f.call({ ...request, native_session_id: "other" })).ok).toBe(
      false,
    );
    expect(f.pairs).toHaveLength(0);
    const paired = await f.call(request);
    expect(paired.link_id).toBe("link");
    expect(JSON.stringify(paired)).not.toContain("SECRET_BEARER");
    expect(await readFile(f.path, "utf8")).not.toContain("SECRET_BEARER");
    await f.call({ method: "stop", link_id: "link" });
    expect(f.stops).toEqual(["link"]);
  } finally {
    await f.close();
  }
});
test("shutdown closes IPC and removes only the descriptor it owns", async () => {
  const f = await fixture();
  const directory = dirname(f.descriptor.endpoint);
  try {
    await f.control.close();
    await f.control.close();
    expect(await readdir(f.registry)).toEqual([]);
    if (process.platform !== "win32")
      expect(await stat(directory).catch(() => null)).toBeNull();
  } finally {
    await f.close();
  }
  const g = await fixture();
  try {
    await writeFile(
      g.path,
      JSON.stringify({ instance_id: "someone-else", nonce: "replacement" }),
    );
    await g.control.close();
    expect(JSON.parse(await readFile(g.path, "utf8")).instance_id).toBe(
      "someone-else",
    );
  } finally {
    await g.close();
  }
});
test("shutdown racing registration leaves no live control or stale descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "zl-control-race-"));
  const control = new ChatControl(root, {
    describe: () => ({
      native_session_id: "n",
      title: "test",
      workspace: root,
      busy: false,
      paired: false,
    }),
    sessions: async () => [],
    pair: async () => "never",
    stop: async () => {},
  });
  try {
    await Promise.all([control.start(), control.close()]);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await control.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a live pi lists the machine's pi sessions for the kernel, only with its credential", async () => {
  const f = await fixture();
  try {
    const response = await f.call({ method: "sessions" });
    expect(response.ok).toBe(true);
    expect(response.sessions).toEqual([
      {
        native_session_id: "native",
        title: "pi fixture",
        workspace: f.root,
        last_activity_at: 1,
        path: join(f.root, "session.jsonl"),
      },
    ]);
    expect(
      (await rpc(f.descriptor.endpoint, { method: "sessions", nonce: "wrong" }))
        .ok,
    ).toBe(false);
    // Listing never pairs, stops or starts anything.
    expect(f.pairs).toHaveLength(0);
    expect(f.stops).toHaveLength(0);
  } finally {
    await f.close();
  }
});
