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
  discoverAndLoadExtensions,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { nativeFingerprint } from "@zerolux/bridge";

/**
 * Two observers of one pi: the chat extension (its `message_start` hook) and a host reading
 * pi's RPC output (`message_start` events, serialized). The fingerprint is for correlating
 * them, so the same native input must fingerprint the same on both sides; and inputs that
 * differ only in text must not.
 */
test("the extension hook and the serialized RPC event fingerprint the same native input alike", async () => {
  const root = await mkdtemp(join(tmpdir(), "zerolux-pi-fingerprint-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    }),
  );
  // The extension under test lives in the fixture workspace and writes only digests.
  const digests = join(root, "hook-digests");
  await writeFile(
    join(cwd, "fingerprint-extension.ts"),
    `import { nativeFingerprint } from ${JSON.stringify(
      new URL("../../../packages/bridge/src/chat-bridge.ts", import.meta.url)
        .pathname,
    )};
import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("message_start", (event) => {
    if (["user", "custom"].includes(event.message.role))
      appendFileSync(${JSON.stringify(digests)}, nativeFingerprint(event.message) + "\\n");
  });
}
`,
  );
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
  modelRuntime.registerProvider("zerolux-fingerprint-fixture", {
    baseUrl: "https://fixture.invalid",
    api: "zerolux-fingerprint-fixture",
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
    streamSimple(model) {
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
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    },
  });
  const loaded = await discoverAndLoadExtensions(
    [join(cwd, "fingerprint-extension.ts")],
    cwd,
    agentDir,
  );
  expect(loaded.errors).toEqual([]);
  const resourceLoader: ResourceLoader = {
    getExtensions: () => loaded,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Deterministic fingerprint fixture.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources() {},
    async reload() {},
  };
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: modelRuntime.getModel("zerolux-fingerprint-fixture", "fixture")!,
    modelRuntime,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
    tools: [],
    thinkingLevel: "off",
  });
  // What a host reads: the event as pi's RPC mode writes it to stdout, then parses it.
  const wire: string[] = [];
  session.subscribe((event) => {
    if (
      event.type === "message_start" &&
      ["user", "custom"].includes(event.message.role)
    )
      wire.push(nativeFingerprint(JSON.parse(JSON.stringify(event)).message));
  });
  try {
    await session.prompt("rm -rf build");
    await session.sendCustomMessage(
      {
        customType: "zerolux-chat-delivery",
        content: "[envelope]",
        display: true,
        details: { deliveryIds: ["d1"] },
      },
      { triggerTurn: true },
    );
    await session.prompt("rm -rf buidl");
    const hook = (await readFile(digests, "utf8")).trim().split("\n");
    expect(hook).toHaveLength(3);
    expect(wire).toEqual(hook);
    // Inputs of the same time and shape with different text are told apart.
    expect(new Set(hook).size).toBe(3);
    for (const digest of hook) expect(digest).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    session.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
