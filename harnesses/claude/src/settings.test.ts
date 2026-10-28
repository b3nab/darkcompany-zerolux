import { expect, test } from "bun:test";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSettings } from "./settings.ts";

function fixture() {
  let model = "native-model-id",
    effort: string | null = "native-effort";
  let reject = false;
  const calls: unknown[] = [];
  const query = {
    initializationResult: async () => ({}),
    getSettings: async () => ({
      applied: { model, effort },
      effective: { env: { SECRET: "fixture-secret" } },
      sources: [{ secret: "fixture-secret" }],
    }),
    supportedModels: async () => [
      {
        value: "native-alias",
        resolvedModel: "native-model-id",
        displayName: "Native label",
        supportedEffortLevels: ["native-effort", "other-effort"],
      },
    ],
    applyFlagSettings: async (settings: {
      model?: string;
      effortLevel?: string;
    }) => {
      if (reject) throw new Error("Native rejection");
      calls.push(["flags", settings]);
      if (settings.model) model = "native-model-id";
      if (settings.effortLevel) effort = settings.effortLevel;
    },
    setPermissionMode: async (mode: string) => {
      if (reject) throw new Error("Native rejection");
      calls.push(["mode", mode]);
    },
  };
  const settings = new ClaudeSettings(
    () => query as unknown as Query & { getSettings: () => Promise<unknown> },
  );
  settings.observe({
    type: "system",
    subtype: "init",
    model,
    permissionMode: "auto",
  } as SDKMessage);
  return {
    settings,
    query,
    calls,
    reject: () => {
      reject = true;
    },
    nativeEffort: (value: string | null) => {
      effort = value;
    },
  };
}

test("Claude projects applied values and native model/effort choices, never settings sources or secrets", async () => {
  const f = fixture();
  const result = await f.settings.read();
  expect(result.values).toEqual({
    model: "native-model-id",
    effort: "native-effort",
    permission_mode: "auto",
  });
  expect(result.models).toEqual([
    {
      value: "native-alias",
      resolved_model: "native-model-id",
      label: "Native label",
      efforts: ["native-effort", "other-effort"],
    },
  ]);
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
  expect(f.calls).toEqual([]);
});

test("Claude applies session-local flags and permission mode without prompts or new sessions", async () => {
  const f = fixture();
  const result = await f.settings.apply({
    model: "native-alias",
    effort: "other-effort",
    permission_mode: "plan",
  });
  expect(f.calls).toEqual([
    ["flags", { model: "native-alias", effortLevel: "other-effort" }],
    ["mode", "plan"],
  ]);
  expect(result.values).toEqual({
    model: "native-model-id",
    effort: "other-effort",
    permission_mode: "plan",
  });
});

test("Claude checks every field against native choices before mutation", async () => {
  const f = fixture();
  for (const patch of [
    { model: "invented" },
    { effort: "invented" },
    { model: "native-alias", permission_mode: "invented" },
    { sandbox: "read-only" },
  ])
    await expect(f.settings.apply(patch)).rejects.toThrow();
  await f.settings.apply({ effort: "other-effort" }, true);
  expect(f.calls).toEqual([]);
});

test("Claude preserves refusals and reads actual native values instead of echoing requested ones", async () => {
  const f = fixture();
  f.reject();
  await expect(f.settings.apply({ permission_mode: "plan" })).rejects.toThrow(
    "Native rejection",
  );
  expect((await f.settings.read()).values.permission_mode).toBe("auto");
  f.nativeEffort(null);
  expect((await f.settings.read()).values.effort).toBeNull();
  f.settings.observe({
    type: "system",
    subtype: "status",
    status: null,
    permissionMode: "default",
  } as SDKMessage);
  expect((await f.settings.read()).values.permission_mode).toBe("default");
});

test("Claude never invents an effort catalog or a successful capability when native data is absent", async () => {
  const f = fixture();
  f.query.supportedModels = async () => [];
  expect((await f.settings.read()).models).toEqual([]);
  await expect(f.settings.apply({ effort: "native-effort" })).rejects.toThrow();
  await expect(new ClaudeSettings(() => undefined).read()).rejects.toThrow();
});
