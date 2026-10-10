import { test, expect } from "bun:test";
import {
  mkdtemp,
  mkdir,
  realpath,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { readdir } from "node:fs/promises";
import { readControlDescriptor, controlRequest } from "@zerolux/bridge";
import chatExtension from "./chat-extension.ts";
import { join } from "node:path";
import {
  SessionManager,
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { savePiProfile } from "./execution-profile.ts";
import { checkTerminalTakeover } from "./terminal-takeover.ts";

const unixTest = process.platform === "win32" ? test.skip : test;

unixTest(
  "terminal takeover preflight requires the current saved native context, never writes history",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-takeover-")));
    const agent = join(root, "agent");
    await mkdir(agent, { mode: 0o700 });
    const oldDir = process.env.PI_CODING_AGENT_DIR;
    const oldArgs = process.argv;
    process.env.PI_CODING_AGENT_DIR = agent;
    process.argv = [process.execPath, "pi"];
    try {
      const manager = SessionManager.create(root, join(agent, "sessions"));
      manager.appendModelChange("fixture", "native-model");
      manager.appendThinkingLevelChange("high");
      const file = manager.getSessionFile()!;
      await writeFile(
        file,
        [manager.getHeader(), ...manager.getEntries()]
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n",
      );
      const profile = {
        version: 1 as const,
        nativeSessionId: manager.getSessionId(),
        file,
        workspace: root,
        agentDir: agent,
        cliVersion: VERSION,
        lastPid: process.pid,
        args: [] as string[],
      };
      const metadata = {
        pid: process.pid,
        session_file: file,
        profile: await savePiProfile(profile),
      };
      const ctx = {
        mode: "tui",
        cwd: root,
        sessionManager: manager,
        isIdle: () => true,
        hasPendingMessages: () => false,
        model: { provider: "fixture", id: "native-model" },
        modelRegistry: { hasConfiguredAuth: () => true },
        ui: { getEditorText: () => "" },
      } as unknown as ExtensionContext;
      const pi = { getThinkingLevel: () => "high" } as unknown as ExtensionAPI;
      const before = await readFile(file, "utf8");
      await checkTerminalTakeover(pi, ctx, metadata);
      for (const changed of [
        { mode: "rpc" },
        { isIdle: () => false },
        { hasPendingMessages: () => true },
        { ui: { getEditorText: () => "unsent private draft" } },
        { ui: { getEditorText: () => undefined as unknown as string } },
        { model: { provider: "fixture", id: "another" } },
        { modelRegistry: { hasConfiguredAuth: () => false } },
      ])
        await expect(
          checkTerminalTakeover(
            pi,
            { ...ctx, ...changed } as ExtensionContext,
            metadata,
          ),
        ).rejects.toThrow();
      await expect(
        checkTerminalTakeover(pi, ctx, {
          ...metadata,
          runner: "/not-a-terminal",
        }),
      ).rejects.toThrow();
      await expect(
        checkTerminalTakeover(pi, ctx, { pid: process.pid }),
      ).rejects.toThrow();
      await savePiProfile({ ...profile, args: ["--no-tools"] });
      await expect(checkTerminalTakeover(pi, ctx, metadata)).rejects.toThrow(
        "launch profile",
      );
      await savePiProfile({
        ...profile,
        unavailable: "Unsupported native options",
      });
      await expect(checkTerminalTakeover(pi, ctx, metadata)).rejects.toThrow(
        "Unsupported native options",
      );
      expect(await readFile(file, "utf8")).toBe(before);
    } finally {
      process.argv = oldArgs;
      if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldDir;
      await rm(root, { recursive: true, force: true });
    }
  },
);

for (const scenario of ["idle", "owner-stop", "dispatch"] as const)
  unixTest(
    `terminal control takeover: ${scenario}`,
    async () => {
      const stopped = scenario === "owner-stop";
      const root = await realpath(await mkdtemp("/tmp/zt-"));
      const agent = join(root, "agent");
      await mkdir(agent, { mode: 0o700 });
      const oldDir = process.env.PI_CODING_AGENT_DIR;
      const oldArgs = process.argv;
      process.env.PI_CODING_AGENT_DIR = agent;
      process.argv = [process.execPath, "pi"];
      const manager = SessionManager.create(root, join(agent, "sessions"));
      manager.appendModelChange("fixture", "native-model");
      manager.appendThinkingLevelChange("high");
      const file = manager.getSessionFile()!;
      const history =
        [manager.getHeader(), ...manager.getEntries()]
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n";
      await writeFile(file, history);
      const executable = join(root, "zerolux");
      await writeFile(
        executable,
        '#!/bin/sh\nprintf \'{"type":"invalidate"}\\n\'\nwhile IFS= read -r line; do :; done\n',
        { mode: 0o700 },
      );
      let status = "connected",
        shutdowns = 0;
      let visible = false;
      let inboxReads = 0;
      const submitted: string[] = [];
      let releaseDispatch!: () => void;
      let claimed!: () => void;
      const dispatchPending = new Promise<void>((resolve) => {
        claimed = resolve;
      });
      const dispatchAck = new Promise<void>((resolve) => {
        releaseDispatch = resolve;
      });
      const delivery = {
        id: "d",
        session_id: "link",
        status: "stored",
        message: {
          id: "m",
          conversation_id: "chat",
          author_id: "owner",
          text: "Fixture work arriving before takeover",
          seq: 1,
        },
      };
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (status === "stopped") return new Response(null, { status: 403 });
          if (new URL(request.url).pathname.endsWith("/dispatch")) {
            delivery.status = "uncertain";
            claimed();
            await dispatchAck;
            return Response.json({ delivery, message: delivery.message });
          }
          if (new URL(request.url).pathname.endsWith("/inbox")) inboxReads++;
          if (new URL(request.url).pathname.endsWith("/status")) {
            status = ((await request.json()) as { status: string }).status;
            return Response.json({});
          }
          return Response.json({
            session: {
              id: "link",
              actor_id: "pi",
              harness: "pi",
              native_session_id: manager.getSessionId(),
              workspace: root,
              status,
            },
            workspace: { id: "ws", name: "Fixture" },
            conversations: [
              {
                id: "chat",
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
                    session_id: "link",
                  },
                ],
              },
            ],
            deliveries: visible ? [delivery] : [],
          });
        },
      });
      const handlers = new Map<
        string,
        ((event: unknown, ctx: ExtensionContext) => unknown)[]
      >();
      const ctx = {
        mode: "tui",
        cwd: root,
        sessionManager: manager,
        isIdle: () => true,
        hasPendingMessages: () => false,
        model: { provider: "fixture", id: "native-model" },
        modelRegistry: { hasConfiguredAuth: () => true },
        shutdown: () => {
          shutdowns++;
        },
        abort() {},
        ui: { notify() {}, setStatus() {}, getEditorText: () => "" },
      } as unknown as ExtensionContext;
      const emit = async (name: string) => {
        for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
      };
      try {
        chatExtension({
          on: (
            name: string,
            handler: (event: unknown, ctx: ExtensionContext) => unknown,
          ) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
          registerTool() {},
          registerCommand() {},
          getThinkingLevel: () => "high",
          sendUserMessage(content: string) {
            if (scenario !== "dispatch")
              throw new Error("Takeover must not submit native input");
            submitted.push(content);
          },
          events: { on: () => () => {}, emit() {} },
        } as unknown as ExtensionAPI);
        await emit("session_start");
        const registry = join(agent, "zerolux-links");
        const record = await readControlDescriptor(
          join(registry, (await readdir(registry))[0]!),
        );
        await controlRequest(record, "pair", {
          native_session_id: manager.getSessionId(),
          workspace: root,
          workspace_id: "ws",
          base_url: server.url.origin,
          token: "TOKEN",
          executable,
        });
        const request = {
          session_id: "link",
          workspace_id: "ws",
          session_file: file,
        };
        await Bun.sleep(50); // Initial subscriber invalidation has drained.
        const readsBeforePreflight = inboxReads;
        expect(
          (
            await controlRequest(record, "takeover", {
              ...request,
              check: true,
            })
          ).accepted,
        ).toBe(true);
        await Bun.sleep(20);
        expect(inboxReads).toBe(readsBeforePreflight); // A read-only check must not start dispatch.
        expect(shutdowns).toBe(0);
        await emit("ui_prompt_start");
        expect(
          (
            await controlRequest(record, "takeover", {
              ...request,
              check: true,
            })
          ).accepted,
        ).toBe(false);
        await emit("ui_prompt_end");
        // No durable recovery intent yet: a terminal must not close.
        expect(
          (await controlRequest(record, "takeover", request)).accepted,
        ).toBe(false);
        expect(shutdowns).toBe(0);
        status = stopped ? "stopped" : "attention";
        if (scenario === "dispatch") {
          visible = true;
          await emit("agent_settled"); // Invalidation starts a real bridge dispatch.
          await dispatchPending;
          // Claimed in the kernel, but not acknowledged to the extension yet. It is no
          // longer `stored`, and no native envelope exists: neither old idle check saw it.
          expect(delivery.status).toBe("uncertain");
          expect(submitted).toHaveLength(0);
          expect(
            (await controlRequest(record, "takeover", request)).accepted,
          ).toBe(false);
          expect(shutdowns).toBe(0);
          releaseDispatch();
          for (let i = 0; i < 100 && submitted.length === 0; i++)
            await Bun.sleep(10);
          expect(submitted).toHaveLength(1);
        } else {
          expect(
            (await controlRequest(record, "takeover", request)).accepted,
          ).toBe(!stopped);
          expect(shutdowns).toBe(stopped ? 0 : 1);
        }
        expect(await readFile(file, "utf8")).toBe(history);
      } finally {
        releaseDispatch();
        await emit("session_shutdown");
        server.stop(true);
        process.argv = oldArgs;
        if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = oldDir;
        await rm(root, { recursive: true, force: true });
      }
    },
    15000,
  );
