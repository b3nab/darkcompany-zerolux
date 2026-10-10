import { expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import chatExtension from "./chat-extension.ts";

function rpc(endpoint: string, body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let text = "";
    socket.setTimeout(5000, () => socket.destroy(new Error("fixture timeout")));
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(body) + "\n"));
    socket.on("data", (chunk) => {
      text += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        if (!text)
          throw new Error(
            `Empty fixture response to ${(body as { method: string }).method}`,
          );
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
  });
}
const unixTest = process.platform === "win32" ? test.skip : test;
unixTest.each(["identity", "ready"] as const)(
  "off during %s rejects a late pairing ACK and closes owned resources",
  async (phase) => {
    const root = await mkdtemp(join(tmpdir(), "zpr-"));
    const workspace = await realpath(root),
      ui = join(root, "ui.log"),
      executable = join(root, "zerolux");
    await writeFile(ui, "");
    await writeFile(
      executable,
      `#!/bin/sh
IFS= read -r init
printf '{"type":"invalidate"}\\n'
while IFS= read -r line; do :; done
printf 'closed' > "$HOME/subscriber-closed"
`,
      { mode: 0o700 },
    );
    let enterReady!: () => void, releaseReady!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterReady = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const statuses: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe(
          "Bearer FIXTURE_TOKEN",
        );
        if (new URL(request.url).pathname === "/api/chat/inbox") {
          if (phase === "identity") {
            enterReady();
            await released;
          }
          return Response.json({
            session: {
              id: "link",
              actor_id: "pi",
              harness: "pi",
              native_session_id: "11111111-1111-4111-8111-111111111111",
              workspace,
              status: "connecting",
            },
            conversations: [],
            deliveries: [],
          });
        }
        const body = (await request.json()) as { status: string };
        if (body.status === "connected") {
          enterReady();
          await released;
        }
        statuses.push(body.status);
        return Response.json({});
      },
    });
    const native = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("./fixtures/chat-harness.ts", import.meta.url)),
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: root,
          PI_CODING_AGENT_DIR: root,
          TMPDIR: root,
          ZEROLUX_FIXTURE_UI_LOG: ui,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const reader = native.stdout.getReader();
      const first = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(first.value)).toContain("READY");
      const registry = join(root, "zerolux-links");
      const record = JSON.parse(
        await readFile(join(registry, (await readdir(registry))[0]!), "utf8"),
      );
      const call = (body: object) =>
        rpc(record.endpoint, { nonce: record.nonce, ...body });
      const paired = call({
        method: "pair",
        native_session_id: record.native_session_id,
        workspace,
        base_url: server.url.origin,
        token: "FIXTURE_TOKEN",
        executable,
      }).catch((error) => ({ ok: false, error }));
      await entered;
      expect((await call({ method: "describe" })).paired).toBe(true);
      process.kill(native.pid, "SIGUSR1"); // Invoke the actual registered off command.
      let stopped = false;
      for (let i = 0; i < 100; i++) {
        if ((await readFile(ui, "utf8")).includes("OFF_REQUESTED")) {
          stopped = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(stopped).toBe(true);
      expect(statuses).toEqual([]); // attention must not overtake the in-flight connected update.
      releaseReady();
      expect((await paired).ok).toBe(false);
      expect(statuses).toEqual(
        phase === "ready" ? ["connected", "attention"] : [],
      );
      expect(await readFile(ui, "utf8")).not.toContain("chat: connected");
      expect(
        await readFile(join(root, "subscriber-closed"), "utf8").catch(
          () => null,
        ),
      ).toBe(phase === "ready" ? "closed" : null);
      expect((await call({ method: "describe" })).paired).toBe(false);
    } catch (error) {
      if (native.exitCode !== null)
        console.error(await new Response(native.stderr).text());
      throw error;
    } finally {
      releaseReady();
      native.kill("SIGTERM");
      const exited = await Promise.race([
        native.exited.then(() => true),
        Bun.sleep(3000).then(() => false),
      ]);
      if (!exited) {
        native.kill("SIGKILL");
        await native.exited;
      }
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);

unixTest.each([false, true])(
  "a kernel relink with a new token replaces the live link and closes the old subscriber (pi busy: %p)",
  async (busy) => {
    const root = await mkdtemp(join(tmpdir(), "zpr-"));
    const workspace = await realpath(root),
      executable = join(root, "zerolux");
    // Each subscriber records its token on join and its exit on stdin EOF.
    await writeFile(
      executable,
      `#!/bin/sh
IFS= read -r init
case "$init" in *TOKEN_2*) name=second ;; *) name=first ;; esac
printf '{"type":"invalidate"}\\n'
while IFS= read -r line; do :; done
printf 'closed' > "$HOME/$name-closed"
`,
      { mode: 0o700 },
    );
    const statuses: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const auth = request.headers.get("authorization");
        expect([
          "Bearer TOKEN_1",
          "Bearer TOKEN_2",
          "Bearer TOKEN_X",
        ]).toContain(auth!);
        if (new URL(request.url).pathname === "/api/chat/inbox")
          return Response.json({
            session: {
              id:
                auth === "Bearer TOKEN_1"
                  ? "link-1"
                  : auth === "Bearer TOKEN_X"
                    ? "link-x"
                    : "link-2",
              actor_id: "pi",
              harness: "pi",
              native_session_id: "11111111-1111-4111-8111-111111111111",
              workspace,
              status: "connecting",
            },
            conversations: [],
            deliveries: [],
          });
        if (new URL(request.url).pathname.endsWith("/status"))
          statuses.push(
            `${auth}:${((await request.json()) as { status: string }).status}`,
          );
        return Response.json({});
      },
    });
    const native = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("./fixtures/chat-harness.ts", import.meta.url)),
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: root,
          PI_CODING_AGENT_DIR: root,
          TMPDIR: root,
          // Busy: the relink after a reload must not wait for pi to be idle.
          ...(busy ? { ZEROLUX_FIXTURE_BUSY: "1" } : {}),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const reader = native.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        "READY",
      );
      reader.releaseLock();
      const registry = join(root, "zerolux-links");
      const record = JSON.parse(
        await readFile(join(registry, (await readdir(registry))[0]!), "utf8"),
      );
      // `null`: a kernel that does not say which workspace it serves.
      const pair = (
        token: string,
        workspace_id: string | null = "workspace-fixture",
      ) =>
        rpc(record.endpoint, {
          nonce: record.nonce,
          method: "pair",
          native_session_id: record.native_session_id,
          workspace,
          ...(workspace_id === null ? {} : { workspace_id }),
          base_url: server.url.origin,
          token,
          executable,
        });
      const first = await pair("TOKEN_1");
      expect(first.ok).toBe(true);
      // A kernel that names no workspace cannot join a session linked by one that does.
      // The control channel answers with a generic failure: the reason stays in pi's log.
      expect((await pair("TOKEN_X", null)).ok).toBe(false);
      // Another workspace adds its own link, next to the first one: no takeover.
      const other = await pair("TOKEN_X", "workspace-other");
      expect(other.ok).toBe(true);
      expect(other.link_id).not.toBe(first.link_id);
      expect(
        await readFile(join(root, "first-closed"), "utf8").catch(() => null),
      ).toBe(null);
      const second = await pair("TOKEN_2");
      expect(second.ok).toBe(true);
      expect(second.link_id).not.toBe(first.link_id);
      expect(await readFile(join(root, "first-closed"), "utf8")).toBe("closed");
      expect(
        await readFile(join(root, "second-closed"), "utf8").catch(() => null),
      ).toBe(null);
      expect(
        (
          await rpc(record.endpoint, {
            nonce: record.nonce,
            method: "describe",
          })
        ).paired,
      ).toBe(true);
      // The live pi also lists the machine's pi sessions through its SDK, in-process.
      const listed = await rpc(record.endpoint, {
        nonce: record.nonce,
        method: "sessions",
      });
      expect(listed.ok).toBe(true);
      expect(Array.isArray(listed.sessions)).toBe(true);
      // The revoked link is not told anything; the other workspace's link and the new one
      // each reported ready to their own kernel.
      expect(statuses).toEqual([
        "Bearer TOKEN_1:connected",
        "Bearer TOKEN_X:connected",
        "Bearer TOKEN_2:connected",
      ]);
    } catch (error) {
      if (native.exitCode !== null)
        console.error(await new Response(native.stderr).text());
      throw error;
    } finally {
      native.kill("SIGTERM");
      const exited = await Promise.race([
        native.exited.then(() => true),
        Bun.sleep(3000).then(() => false),
      ]);
      if (!exited) {
        native.kill("SIGKILL");
        await native.exited;
      }
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);

unixTest(
  "during a relink, pi's events reach the new link: the owner's input keeps Stop from cancelling",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zpr-"));
    const workspace = await realpath(root),
      executable = join(root, "zerolux");
    // The first subscriber takes a second to stop: pi's events arrive meanwhile.
    await writeFile(
      executable,
      `#!/bin/sh
IFS= read -r init
printf '{"type":"invalidate"}\\n'
while IFS= read -r line; do :; done
case "$init" in *TOKEN_1*) sleep 1 ;; esac
`,
      { mode: 0o700 },
    );
    const delivery = {
      id: "d1",
      session_id: "link-1",
      status: "stored",
      message: {
        id: "m1",
        conversation_id: "room",
        author_id: "owner",
        text: "hello",
        seq: 1,
      },
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const link =
          request.headers.get("authorization") === "Bearer TOKEN_1"
            ? "link-1"
            : "link-2";
        const path = new URL(request.url).pathname;
        if (path === "/api/chat/inbox")
          return Response.json({
            session: {
              id: link,
              actor_id: "pi",
              harness: "pi",
              native_session_id: "11111111-1111-4111-8111-111111111111",
              workspace,
              status: "connected",
            },
            conversations: [
              {
                id: "room",
                kind: "group",
                title: "General",
                paused: false,
                members: [
                  {
                    actor_id: "owner",
                    name: "Owner",
                    kind: "human",
                    session_id: null,
                  },
                  {
                    actor_id: "pi",
                    name: "pi",
                    kind: "agent",
                    session_id: link,
                  },
                ],
              },
            ],
            deliveries: [delivery],
          });
        if (path.endsWith("/dispatch")) {
          delivery.status = "uncertain";
          return Response.json({ delivery, message: delivery.message });
        }
        return Response.json({});
      },
    });
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    let command!: { handler(args: string, ctx: unknown): Promise<void> };
    let idle = true,
      aborts = 0;
    const sent: unknown[] = [];
    const ctx = {
      cwd: root,
      sessionManager: {
        getSessionId: () => "11111111-1111-4111-8111-111111111111",
        getSessionName: () => "fixture",
      },
      isIdle: () => idle,
      hasPendingMessages: () => false,
      abort: () => {
        aborts++;
      },
      ui: { setStatus() {}, notify() {} },
    };
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    chatExtension({
      on: (name: string, handler: (event: any, ctx: any) => unknown) => {
        handlers.set(name, handler);
      },
      registerTool() {},
      registerCommand: (_: string, value: typeof command) => {
        command = value;
      },
      sendUserMessage: (message: unknown) => {
        sent.push(message);
      },
      events: { on: () => () => {}, emit() {} },
    } as unknown as ExtensionAPI);
    try {
      await handlers.get("session_start")!({}, ctx);
      const registry = join(root, "zerolux-links");
      const record = JSON.parse(
        await readFile(join(registry, (await readdir(registry))[0]!), "utf8"),
      );
      // `null`: a kernel that does not say which workspace it serves.
      const pair = (
        token: string,
        workspace_id: string | null = "workspace-fixture",
      ) =>
        rpc(record.endpoint, {
          nonce: record.nonce,
          method: "pair",
          native_session_id: record.native_session_id,
          workspace,
          ...(workspace_id === null ? {} : { workspace_id }),
          base_url: server.url.origin,
          token,
          executable,
        });
      expect((await pair("TOKEN_1")).ok).toBe(true);
      for (let i = 0; i < 100 && !sent.length; i++) await Bun.sleep(20);
      expect(sent).toHaveLength(1); // The chat message started pi's turn.
      idle = false;
      await handlers.get("agent_start")!({}, ctx);
      await handlers.get("message_start")!(
        {
          message: {
            role: "user",
            content: sent[0],
          },
        },
        ctx,
      );
      const relinked = pair("TOKEN_2"); // The kernel restarted.
      await Bun.sleep(300); // The old subscriber is still stopping.
      await handlers.get("input")!({ source: "interactive" }, ctx);
      expect((await relinked).ok).toBe(true);
      await command.handler("off", ctx);
      expect(aborts).toBe(0); // The owner's own turn is not cancelled.
    } finally {
      await command?.handler("off", ctx);
      await handlers.get("session_shutdown")?.({}, ctx);
      if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = agentDir;
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);

unixTest(
  "a Stop while the old subscriber is stopping ends the relink: no new subscriber starts",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zpr-"));
    const workspace = await realpath(root),
      executable = join(root, "zerolux"),
      started = join(root, "second-started");
    await writeFile(
      executable,
      `#!/bin/sh
IFS= read -r init
case "$init" in *TOKEN_2*) printf started > '${started}' ;; esac
printf '{"type":"invalidate"}\\n'
while IFS= read -r line; do :; done
case "$init" in *TOKEN_1*) sleep 1 ;; esac
`,
      { mode: 0o700 },
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const link =
          request.headers.get("authorization") === "Bearer TOKEN_1"
            ? "link-1"
            : "link-2";
        if (new URL(request.url).pathname === "/api/chat/inbox")
          return Response.json({
            session: {
              id: link,
              actor_id: "pi",
              harness: "pi",
              native_session_id: "11111111-1111-4111-8111-111111111111",
              workspace,
              status: "connected",
            },
            conversations: [],
            deliveries: [],
          });
        return Response.json({});
      },
    });
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    let command!: { handler(args: string, ctx: unknown): Promise<void> };
    const ctx = {
      cwd: root,
      sessionManager: {
        getSessionId: () => "11111111-1111-4111-8111-111111111111",
        getSessionName: () => "fixture",
      },
      isIdle: () => true,
      hasPendingMessages: () => false,
      abort() {},
      ui: { setStatus() {}, notify() {} },
    };
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    chatExtension({
      on: (name: string, handler: (event: any, ctx: any) => unknown) => {
        handlers.set(name, handler);
      },
      registerTool() {},
      registerCommand: (_: string, value: typeof command) => {
        command = value;
      },
      sendUserMessage() {},
      events: { on: () => () => {}, emit() {} },
    } as unknown as ExtensionAPI);
    try {
      await handlers.get("session_start")!({}, ctx);
      const registry = join(root, "zerolux-links");
      const record = JSON.parse(
        await readFile(join(registry, (await readdir(registry))[0]!), "utf8"),
      );
      const call = (body: object) =>
        rpc(record.endpoint, { nonce: record.nonce, ...body });
      const pair = (token: string) =>
        call({
          method: "pair",
          native_session_id: record.native_session_id,
          workspace,
          base_url: server.url.origin,
          token,
          executable,
        });
      expect((await pair("TOKEN_1")).ok).toBe(true);
      const relinked = pair("TOKEN_2");
      await Bun.sleep(300); // The old subscriber is still stopping.
      await command.handler("off", ctx); // The owner stops the agent.
      expect((await relinked).ok).toBe(false);
      await Bun.sleep(200);
      expect(await readFile(started, "utf8").catch(() => null)).toBe(null);
      expect((await call({ method: "describe" })).paired).toBe(false);
    } finally {
      await handlers.get("session_shutdown")?.({}, ctx);
      if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = agentDir;
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);

unixTest(
  "Stop of one workspace's link leaves the other's link and turn alone; the last Stop cancels its own turn",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zpr-"));
    const workspace = await realpath(root),
      executable = join(root, "zerolux");
    // Each subscriber records its exit on stdin EOF, by the token it was started with.
    await writeFile(
      executable,
      `#!/bin/sh
IFS= read -r init
case "$init" in *TOKEN_B2*) name=b2 ;; *TOKEN_B*) name=b ;; *) name=a ;; esac
printf '{"type":"invalidate"}\\n'
while IFS= read -r line; do :; done
printf 'closed' > "${root}/$name-closed"
`,
      { mode: 0o700 },
    );
    // Workspace B has a message for the agent; A has nothing.
    const delivery = {
      id: "d1",
      session_id: "link-b",
      status: "stored",
      message: {
        id: "m1",
        conversation_id: "room-b",
        author_id: "owner",
        text: "hello from B",
        seq: 1,
      },
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const auth = request.headers.get("authorization");
        const b = auth === "Bearer TOKEN_B" || auth === "Bearer TOKEN_B2";
        const link = b ? "link-b" : "link-a";
        const path = new URL(request.url).pathname;
        if (path === "/api/chat/inbox")
          return Response.json({
            session: {
              id: link,
              actor_id: "pi",
              harness: "pi",
              native_session_id: "11111111-1111-4111-8111-111111111111",
              workspace,
              status: "connected",
            },
            workspace: b
              ? { id: "ws-b", name: "B" }
              : { id: "ws-a", name: "A" },
            conversations: b
              ? [
                  {
                    id: "room-b",
                    kind: "group",
                    title: "General",
                    paused: false,
                    members: [
                      {
                        actor_id: "owner",
                        name: "Owner",
                        kind: "human",
                        session_id: null,
                      },
                      {
                        actor_id: "pi",
                        name: "pi",
                        kind: "agent",
                        session_id: link,
                      },
                    ],
                  },
                ]
              : [],
            deliveries: b ? [delivery] : [],
          });
        if (path.endsWith("/dispatch")) {
          delivery.status = "uncertain";
          return Response.json({ delivery, message: delivery.message });
        }
        return Response.json({});
      },
    });
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    let command!: { handler(args: string, ctx: unknown): Promise<void> };
    let idle = true,
      aborts = 0;
    const sent: unknown[] = [];
    const ctx = {
      cwd: root,
      sessionManager: {
        getSessionId: () => "11111111-1111-4111-8111-111111111111",
        getSessionName: () => "fixture",
      },
      isIdle: () => idle,
      hasPendingMessages: () => false,
      abort: () => {
        aborts++;
      },
      ui: { setStatus() {}, notify() {} },
    };
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    chatExtension({
      on: (name: string, handler: (event: any, ctx: any) => unknown) => {
        handlers.set(name, handler);
      },
      registerTool() {},
      registerCommand: (_: string, value: typeof command) => {
        command = value;
      },
      sendUserMessage: (message: unknown) => {
        sent.push(message);
      },
      events: { on: () => () => {}, emit() {} },
    } as unknown as ExtensionAPI);
    const closed = (name: string) =>
      readFile(join(root, `${name}-closed`), "utf8").catch(() => null);
    try {
      await handlers.get("session_start")!({}, ctx);
      const registry = join(root, "zerolux-links");
      const record = JSON.parse(
        await readFile(join(registry, (await readdir(registry))[0]!), "utf8"),
      );
      const control = (body: Record<string, unknown>) =>
        rpc(record.endpoint, { nonce: record.nonce, ...body });
      const pair = (token: string, workspace_id: string) =>
        control({
          method: "pair",
          native_session_id: record.native_session_id,
          workspace,
          workspace_id,
          base_url: server.url.origin,
          token,
          executable,
        });
      const a = await pair("TOKEN_A", "ws-a");
      const b = await pair("TOKEN_B", "ws-b");
      expect(a.ok && b.ok).toBe(true);
      // B's message starts pi's turn: that turn is B's.
      for (let i = 0; i < 100 && !sent.length; i++) await Bun.sleep(20);
      expect(sent).toHaveLength(1);
      idle = false;
      await handlers.get("agent_start")!({}, ctx);
      await handlers.get("message_start")!(
        { message: { role: "user", content: sent[0] } },
        ctx,
      );
      // Stop from workspace A: only A's link ends. B's turn is not cancelled, B's
      // subscriber keeps running, pi is still paired.
      expect((await control({ method: "stop", link_id: a.link_id })).ok).toBe(
        true,
      );
      expect(await closed("a")).toBe("closed");
      expect(await closed("b")).toBe(null);
      expect(aborts).toBe(0);
      expect((await control({ method: "describe" })).paired).toBe(true);
      // The native turn was shared: removing A must not turn B into a private audience.
      expect((await control({ method: "turn" })).delivery).toBe(null);
      // B's kernel relinks (restart): a new token is not a Stop either.
      const relinked = await pair("TOKEN_B2", "ws-b");
      expect(relinked.ok).toBe(true);
      expect(await closed("b")).toBe("closed");
      expect(aborts).toBe(0);
      expect((await control({ method: "describe" })).paired).toBe(true);
      // Stop from B, the last link, cancels the turn B started and ends pairing.
      expect(
        (await control({ method: "stop", link_id: relinked.link_id })).ok,
      ).toBe(true);
      expect(await closed("b2")).toBe("closed");
      expect(aborts).toBe(1);
      expect((await control({ method: "describe" })).paired).toBe(false);
    } finally {
      await command?.handler("off", ctx);
      await handlers.get("session_shutdown")?.({}, ctx);
      if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = agentDir;
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);

unixTest(
  "Stop of the workspace that started the turn, while another workspace's steer is queued in it",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zpr-"));
    const workspace = await realpath(root),
      executable = join(root, "zerolux");
    // B's subscriber tells its link to look again a little later: B's message arrives
    // while A's turn is running.
    await writeFile(
      executable,
      `#!/bin/sh
IFS= read -r init
printf '{"type":"invalidate"}\\n'
case "$init" in *TOKEN_B*) sleep 0.5; printf '{"type":"invalidate"}\\n' ;; esac
while IFS= read -r line; do :; done
`,
      { mode: 0o700 },
    );
    const message = (id: string, room: string, text: string) => ({
      id,
      conversation_id: room,
      author_id: "owner",
      text,
      seq: 1,
    });
    const a = {
      id: "da",
      session_id: "link-a",
      status: "stored",
      message: message("ma", "room-a", "A starts the turn"),
    };
    const b = {
      id: "db",
      session_id: "link-b",
      status: "stored",
      message: message("mb", "room-b", "B joins while A runs"),
    };
    let bVisible = false;
    const room = (id: string, link: string) => ({
      id,
      kind: "group",
      title: "General",
      paused: false,
      members: [
        { actor_id: "owner", name: "Owner", kind: "human", session_id: null },
        { actor_id: "pi", name: "pi", kind: "agent", session_id: link },
      ],
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const isB = request.headers.get("authorization") === "Bearer TOKEN_B";
        const link = isB ? "link-b" : "link-a";
        const path = new URL(request.url).pathname;
        if (path === "/api/chat/inbox")
          return Response.json({
            session: {
              id: link,
              actor_id: "pi",
              harness: "pi",
              native_session_id: "11111111-1111-4111-8111-111111111111",
              workspace,
              status: "connected",
            },
            workspace: isB
              ? { id: "ws-b", name: "B" }
              : { id: "ws-a", name: "A" },
            conversations: [room(isB ? "room-b" : "room-a", link)],
            deliveries: isB ? (bVisible ? [b] : []) : [a],
          });
        if (path.endsWith("/dispatch")) {
          const delivery = path.includes("/db/") ? b : a;
          delivery.status = "uncertain";
          return Response.json({ delivery, message: delivery.message });
        }
        return Response.json({});
      },
    });
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    let command!: { handler(args: string, ctx: unknown): Promise<void> };
    let idle = true,
      aborts = 0;
    const sent: { content: string; options?: unknown }[] = [];
    const ctx = {
      cwd: root,
      sessionManager: {
        getSessionId: () => "11111111-1111-4111-8111-111111111111",
        getSessionName: () => "fixture",
      },
      isIdle: () => idle,
      hasPendingMessages: () => false,
      abort: () => {
        aborts++;
      },
      ui: { setStatus() {}, notify() {} },
    };
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    chatExtension({
      on: (name: string, handler: (event: any, ctx: any) => unknown) => {
        handlers.set(name, handler);
      },
      registerTool() {},
      registerCommand: (_: string, value: typeof command) => {
        command = value;
      },
      sendUserMessage: (content: string, options?: unknown) => {
        sent.push({ content, options });
      },
      events: { on: () => () => {}, emit() {} },
    } as unknown as ExtensionAPI);
    try {
      await handlers.get("session_start")!({}, ctx);
      const registry = join(root, "zerolux-links");
      const record = JSON.parse(
        await readFile(join(registry, (await readdir(registry))[0]!), "utf8"),
      );
      const control = (body: Record<string, unknown>) =>
        rpc(record.endpoint, { nonce: record.nonce, ...body });
      const pair = (token: string, workspace_id: string) =>
        control({
          method: "pair",
          native_session_id: record.native_session_id,
          workspace,
          workspace_id,
          base_url: server.url.origin,
          token,
          executable,
        });
      const linkA = await pair("TOKEN_A", "ws-a");
      expect(linkA.ok).toBe(true);
      // A's message starts the turn.
      for (let i = 0; i < 100 && !sent.length; i++) await Bun.sleep(20);
      expect(sent).toHaveLength(1);
      idle = false;
      await handlers.get("agent_start")!({}, ctx);
      await handlers.get("message_start")!(
        { message: { role: "user", content: sent[0]!.content } },
        ctx,
      );
      const exclusive = await control({ method: "turn" });
      expect(exclusive.delivery).toBe("da");
      expect(exclusive.link_id).toBe("link-a");
      expect(exclusive.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      // B links and, while A's turn runs, its message is queued as a steer that pi has
      // not presented yet (no message_start for it).
      expect((await pair("TOKEN_B", "ws-b")).ok).toBe(true);
      bVisible = true;
      for (let i = 0; i < 100 && sent.length < 2; i++) await Bun.sleep(20);
      expect(sent).toHaveLength(2);
      expect(sent[1]!.content).toContain("B joins while A runs");
      expect((await control({ method: "turn" })).delivery).toBe(null);
      // Stop from A: the turn A started now carries B's pending work, so it is not
      // cancelled from under B.
      expect(
        (await control({ method: "stop", link_id: linkA.link_id })).ok,
      ).toBe(true);
      expect(aborts).toBe(0);
      expect((await control({ method: "describe" })).paired).toBe(true);
    } finally {
      await command?.handler("off", ctx);
      await handlers.get("session_shutdown")?.({}, ctx);
      if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = agentDir;
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);

unixTest(
  "two workspaces stopping at once each end their own link: a Stop is never confirmed unapplied",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zpr-"));
    const workspace = await realpath(root),
      executable = join(root, "zerolux");
    // A's subscriber takes a moment to stop; B's Stop arrives meanwhile.
    await writeFile(
      executable,
      `#!/bin/sh
IFS= read -r init
case "$init" in *TOKEN_B*) name=b ;; *) name=a ;; esac
printf '{"type":"invalidate"}\\n'
while IFS= read -r line; do :; done
case "$name" in a) sleep 1 ;; esac
printf 'closed' > "${root}/$name-closed"
`,
      { mode: 0o700 },
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const isB = request.headers.get("authorization") === "Bearer TOKEN_B";
        if (new URL(request.url).pathname === "/api/chat/inbox")
          return Response.json({
            session: {
              id: isB ? "link-b" : "link-a",
              actor_id: "pi",
              harness: "pi",
              native_session_id: "11111111-1111-4111-8111-111111111111",
              workspace,
              status: "connected",
            },
            workspace: isB
              ? { id: "ws-b", name: "B" }
              : { id: "ws-a", name: "A" },
            conversations: [],
            deliveries: [],
          });
        return Response.json({});
      },
    });
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    let command!: { handler(args: string, ctx: unknown): Promise<void> };
    const ctx = {
      cwd: root,
      sessionManager: {
        getSessionId: () => "11111111-1111-4111-8111-111111111111",
        getSessionName: () => "fixture",
      },
      isIdle: () => true,
      hasPendingMessages: () => false,
      abort: () => {},
      ui: { setStatus() {}, notify() {} },
    };
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    chatExtension({
      on: (name: string, handler: (event: any, ctx: any) => unknown) => {
        handlers.set(name, handler);
      },
      registerTool() {},
      registerCommand: (_: string, value: typeof command) => {
        command = value;
      },
      sendUserMessage() {},
      events: { on: () => () => {}, emit() {} },
    } as unknown as ExtensionAPI);
    const closed = (name: string) =>
      readFile(join(root, `${name}-closed`), "utf8").catch(() => null);
    try {
      await handlers.get("session_start")!({}, ctx);
      const registry = join(root, "zerolux-links");
      const record = JSON.parse(
        await readFile(join(registry, (await readdir(registry))[0]!), "utf8"),
      );
      const control = (body: Record<string, unknown>) =>
        rpc(record.endpoint, { nonce: record.nonce, ...body });
      const pair = (token: string, workspace_id: string) =>
        control({
          method: "pair",
          native_session_id: record.native_session_id,
          workspace,
          workspace_id,
          base_url: server.url.origin,
          token,
          executable,
        });
      const linkA = await pair("TOKEN_A", "ws-a");
      const linkB = await pair("TOKEN_B", "ws-b");
      expect(linkA.ok && linkB.ok).toBe(true);
      const stopA = control({ method: "stop", link_id: linkA.link_id });
      await Bun.sleep(100); // A is still closing its subscriber.
      const stopB = control({ method: "stop", link_id: linkB.link_id });
      expect((await stopB).ok).toBe(true);
      // B's Stop was confirmed: B's link is really over, not left paired behind A's.
      expect(await closed("b")).toBe("closed");
      expect((await stopA).ok).toBe(true);
      expect(await closed("a")).toBe("closed");
      expect((await control({ method: "describe" })).paired).toBe(false);
    } finally {
      await command?.handler("off", ctx);
      await handlers.get("session_shutdown")?.({}, ctx);
      if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = agentDir;
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
