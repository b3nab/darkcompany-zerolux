import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

const projectSettings = new URL("../../../.pi/settings.json", import.meta.url);
const messages = ["General: first peer", "DM: owner", "General: latest peer"];

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Real pi session/queue, isolated settings and an in-process fake model transport. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zerolux-pi-steering-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir);
  const globalPath = join(agentDir, "settings.json");
  const globalText = JSON.stringify({
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  await writeFile(globalPath, globalText);
  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted: true, // Only this temporary fixture workspace.
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const calls: string[][] = [];
  const entered = gate();
  const release = gate();
  modelRuntime.registerProvider("zerolux-steering-fixture", {
    baseUrl: "https://fixture.invalid",
    api: "zerolux-steering-fixture",
    apiKey: "FIXTURE_NOT_A_CREDENTIAL",
    models: [
      {
        id: "fixture",
        name: "Fixture only",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 64,
      },
    ],
    streamSimple(model, context) {
      calls.push(
        context.messages.flatMap((message) =>
          message.role === "user"
            ? [
                typeof message.content === "string"
                  ? message.content
                  : message.content
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join(""),
              ]
            : [],
        ),
      );
      const first = calls.length === 1;
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: "text", text: "Fixture response" }],
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(async () => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        if (first) {
          entered.resolve();
          await release.promise;
        }
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    },
  });
  // No extensions, personal context, credentials, tools, sockets or model transports discovered.
  const runtime = createExtensionRuntime();
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Deterministic queue fixture.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources() {},
    async reload() {},
  };
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: modelRuntime.getModel("zerolux-steering-fixture", "fixture")!,
    modelRuntime,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
    tools: [],
    thinkingLevel: "off",
  });
  const presented: string[] = [];
  session.subscribe((event) => {
    if (
      event.type === "message_start" &&
      event.message.role === "custom" &&
      event.message.customType === "zerolux-chat-delivery"
    )
      presented.push(
        ...(event.message.details as { deliveryIds: string[] }).deliveryIds,
      );
    if (event.type === "message_start" && event.message.role === "user") {
      const content = event.message.content;
      const text =
        typeof content === "string"
          ? content
          : content
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n");
      const index = messages.indexOf(text);
      if (index >= 0) presented.push(`d${index + 1}`);
    }
  });
  return {
    session,
    async installProjectSettings() {
      await writeFile(
        join(cwd, ".pi", "settings.json"),
        await readFile(projectSettings, "utf8"),
      );
    },
    async burst(textSteering = false) {
      const running = session.prompt("Private fixture input");
      try {
        await Promise.race([
          entered.promise,
          running.then(() => {
            throw new Error("Fixture ended before its held model request");
          }),
        ]);
        for (const [index, content] of messages.entries()) {
          if (textSteering) {
            await session.sendUserMessage(content, { deliverAs: "steer" });
            continue;
          }
          await session.sendCustomMessage(
            {
              customType: "zerolux-chat-delivery",
              content,
              display: true,
              details: { deliveryIds: [`d${index + 1}`] },
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
        }
        expect(presented).toEqual([]); // Queued is not Read/presented yet.
        release.resolve();
        await running;
        expect(presented).toEqual(["d1", "d2", "d3"]);
        expect(session.pendingMessageCount).toBe(0);
        return calls;
      } finally {
        release.resolve();
        await running.catch(() => {});
      }
    },
    async escape(useTextSteering: boolean) {
      const running = session.prompt("Private fixture input");
      await entered.promise;
      for (const content of messages) {
        if (useTextSteering)
          await session.sendUserMessage(content, { deliverAs: "steer" });
        else
          await session.sendCustomMessage(
            {
              customType: "zerolux-chat-delivery",
              content,
              display: true,
              details: { deliveryIds: [content] },
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
      }
      // This is the native TUI's clear/restore-to-editor path, not a ZeroLux retry.
      const restored = session.clearQueue();
      const aborted = session.abort();
      release.resolve();
      await aborted;
      await running;
      expect(calls).toHaveLength(1);
      expect(presented).toEqual([]);
      return restored;
    },
    async close() {
      release.resolve();
      session.dispose();
      try {
        await settingsManager.flush();
        expect(await readFile(globalPath, "utf8")).toBe(globalText);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

test("native Escape silently drops custom steers, but returns text steers intact to the editor", async () => {
  for (const text of [false, true]) {
    const f = await fixture();
    try {
      expect(await f.escape(text)).toEqual({
        steering: text ? messages : [],
        followUp: [],
      });
    } finally {
      await f.close();
    }
  }
});

test("pi's one-at-a-time queue adds one model step for every waiting chat envelope", async () => {
  const f = await fixture();
  try {
    expect(f.session.steeringMode).toBe("one-at-a-time");
    const calls = await f.burst();
    expect(calls).toEqual([
      ["Private fixture input"],
      ["Private fixture input", messages[0]!],
      ["Private fixture input", ...messages.slice(0, 2)],
      ["Private fixture input", ...messages],
    ]);
  } finally {
    await f.close();
  }
});

test("reloading this project's settings delivers the entire waiting burst at the next model step", async () => {
  const f = await fixture();
  try {
    const id = f.session.sessionId;
    expect(f.session.steeringMode).toBe("one-at-a-time");
    await f.installProjectSettings();
    await f.session.reload();
    expect(f.session.sessionId).toBe(id);
    expect(f.session.steeringMode).toBe("all");
    expect(f.session.followUpMode).toBe("one-at-a-time");
    expect(await f.burst(true)).toEqual([
      ["Private fixture input"],
      ["Private fixture input", ...messages],
    ]);
  } finally {
    await f.close();
  }
});
