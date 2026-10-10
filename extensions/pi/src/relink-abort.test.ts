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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import chatExtension from "./chat-extension.ts";

const unixTest = process.platform === "win32" ? test.skip : test;
async function until(ready: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (ready()) return;
    await Bun.sleep(10);
  }
  throw new Error("Fixture did not settle");
}
function rpc(endpoint: string, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => socket.destroy(new Error("Fixture timeout")));
    socket.on("connect", () => socket.write(JSON.stringify(body) + "\n"));
    socket.on("data", (chunk) => (response += chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        resolve(JSON.parse(response));
      } catch (error) {
        reject(error);
      }
    });
  });
}

unixTest.each([
  "revoked-receipt",
  "late-receipt",
  "failed-identity",
  "failed-ready",
] as const)(
  "pi preserves its turn and pending reply through %s; only explicit Stop aborts",
  async (phase) => {
    const root = await mkdtemp(join(tmpdir(), "z-abort-"));
    const workspace = await realpath(root);
    const executable = join(root, "zerolux");
    await writeFile(
      executable,
      '#!/bin/sh\nIFS= read -r init\nprintf \'{"type":"invalidate"}\\n\'\nwhile IFS= read -r line; do :; done\n',
      { mode: 0o700 },
    );
    const nativeId = "11111111-1111-4111-8111-111111111111";
    const delivery = {
      id: "d1",
      session_id: "link-ONE",
      status: "stored",
      message: {
        id: "m1",
        conversation_id: "room",
        author_id: "owner",
        text: "fixture work",
        seq: 1,
      },
    };
    let revoked = false,
      rejections = 0,
      aborts = 0,
      idle = true;
    let releaseReceipt!: () => void;
    const receiptReleased = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    const sent: unknown[] = [];
    const posts: unknown[] = [];
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const tools = new Map<string, any>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const token = request.headers
          .get("authorization")
          ?.replace("Bearer ", "");
        const path = new URL(request.url).pathname;
        if (token === "ONE" && revoked) {
          rejections++;
          if (phase === "late-receipt") await receiptReleased;
          return new Response(null, { status: 401 });
        }
        if (
          token === "TWO" &&
          phase === "failed-identity" &&
          path === "/api/chat/inbox"
        )
          return new Response(null, { status: 503 });
        if (path === "/api/chat/inbox")
          return Response.json({
            session: {
              id: `link-${token}`,
              actor_id: "pi",
              harness: "pi",
              native_session_id: nativeId,
              workspace,
              status: "connected",
            },
            conversations: [
              {
                id: "room",
                kind: "group",
                title: "Fixture",
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
                    session_id: `link-${token}`,
                  },
                ],
              },
            ],
            deliveries: [delivery],
          });
        const body = (await request.json()) as any;
        if (
          token === "TWO" &&
          phase === "failed-ready" &&
          path.endsWith("/status") &&
          body.status === "connected"
        )
          return new Response(null, { status: 503 });
        if (path.endsWith("/dispatch")) {
          if (delivery.status !== "stored")
            return new Response(null, { status: 409 });
          delivery.status = "uncertain";
          return Response.json({ delivery, message: delivery.message });
        }
        if (path.endsWith("/receipt")) delivery.status = body.status;
        if (path.endsWith("/messages")) posts.push(body);
        return Response.json({});
      },
    });
    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => nativeId,
        getSessionName: () => "fixture",
      },
      isIdle: () => idle,
      hasPendingMessages: () => false,
      abort: () => {
        aborts++;
      },
      ui: { setStatus() {}, notify() {} },
    };
    const oldDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    chatExtension({
      on: (name: string, handler: (event: any, ctx: any) => unknown) =>
        handlers.set(name, handler),
      registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
      registerCommand() {},
      sendUserMessage: (message: unknown) => sent.push(message),
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
          native_session_id: nativeId,
          workspace,
          workspace_id: "fixture-workspace",
          base_url: server.url.origin,
          token,
          executable,
        });
      expect((await pair("ONE")).ok).toBe(true);
      await until(() => sent.length === 1 && delivery.status === "notified");
      idle = false;
      await handlers.get("agent_start")!({}, ctx);
      revoked = true; // Restart: the old link is revoked before the new controller binds.
      if (phase === "revoked-receipt" || phase === "late-receipt") {
        await handlers.get("message_start")!(
          {
            message: {
              role: "user",
              content: sent[0],
            },
          },
          ctx,
        );
        await until(() => rejections > 0);
        await Bun.sleep(30);
      } else {
        expect((await pair("TWO")).ok).toBe(false);
      }
      expect(aborts).toBe(0);
      const reply = () =>
        tools.get("zerolux_send").execute("tool", {
          chat: "room",
          text: "pending fixture reply",
          reply_to: "d1",
        });
      if (phase !== "late-receipt")
        expect((await reply()).content[0].text).toContain("kept");
      const resumed = await pair("THREE");
      expect(resumed.ok).toBe(true);
      releaseReceipt(); // In the reverse race, the stale 401 arrives after handoff.
      if (phase === "late-receipt") await reply();
      await until(() => posts.length === 1);
      await Bun.sleep(30);
      expect(posts[0]).toMatchObject({
        text: "pending fixture reply",
        reply_to_delivery_id: "d1",
      });
      expect(sent).toHaveLength(1); // No native input replay.
      expect(aborts).toBe(0);
      expect(
        (await call({ method: "stop", link_id: resumed.link_id })).ok,
      ).toBe(true);
      expect(aborts).toBe(1); // A genuine owner Stop still cancels the owned turn.
    } finally {
      releaseReceipt();
      await handlers.get("session_shutdown")?.({}, ctx);
      if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldDir;
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
