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
    setModel: async (value: string) => {
      if (reject) throw new Error("Native rejection");
      calls.push(["model", value]);
      model = value === "native-alias" ? "native-model-id" : value;
    },
    applyFlagSettings: async (settings: {
      model?: string;
      effortLevel?: string;
    }) => {
      if (reject) throw new Error("Native rejection");
      calls.push(["flags", settings]);
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
  expect(
    result.models.map(({ value, resolved_model, efforts }) => ({
      value,
      resolved_model,
      efforts,
    })),
  ).toEqual([
    {
      value: "native-alias",
      resolved_model: "native-model-id",
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
    ["model", "native-alias"],
    ["flags", { effortLevel: "other-effort" }],
    ["mode", "plan"],
  ]);
  expect(result.values).toEqual({
    model: "native-model-id",
    effort: "other-effort",
    permission_mode: "plan",
  });
});

test("Claude checks field shape and permission mode before mutation", async () => {
  const f = fixture();
  for (const patch of [
    { effort: "" },
    { model: "new-native-model", effort: 1 },
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
  await expect(f.settings.apply({ permission_mode: "plan" })).rejects.toThrow();
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

test("Claude accepts a native model ID missing from its initial catalog and confirms its effective value", async () => {
  const f = fixture();
  await f.settings.apply({ model: "new-native-model" }, true);
  expect(f.calls).toHaveLength(0);
  const result = await f.settings.apply({ model: "new-native-model" });
  expect(result.values.model).toBe("new-native-model");
  expect(f.calls).toEqual([["model", "new-native-model"]]);
  expect(result.models.some(({ value }) => value === "new-native-model")).toBe(
    false,
  );
  await f.settings.verifyStart({
    model: "new-native-model",
    effort: "native-effort",
  });
  expect(f.calls).toHaveLength(1);
});

test("Claude changes effort after choosing a model absent from its startup catalog", async () => {
  const f = fixture();
  await f.settings.apply({ model: "new-native-model" });
  await f.settings.apply({ effort: "new-native-effort" }, true);
  expect(f.calls).toEqual([["model", "new-native-model"]]);
  const confirmed = await f.settings.apply({ effort: "new-native-effort" });
  expect(confirmed.values.model).toBe("new-native-model");
  expect(confirmed.values.effort).toBe("new-native-effort");
  expect(f.calls).toEqual([
    ["model", "new-native-model"],
    ["flags", { effortLevel: "new-native-effort" }],
  ]);
});

test("a refused or unconfirmed custom model is never reported as applied or retried", async () => {
  const refused = fixture();
  refused.reject();
  await expect(
    refused.settings.apply({ model: "new-native-model" }),
  ).rejects.toThrow();
  expect((await refused.settings.read()).values.model).toBe("native-model-id");

  const unconfirmed = fixture();
  let attempts = 0;
  unconfirmed.query.setModel = async () => {
    attempts++;
  };
  await expect(
    unconfirmed.settings.apply({ model: "new-native-model" }),
  ).rejects.toThrow();
  expect(attempts).toBe(1);
  expect((await unconfirmed.settings.read()).values.model).toBe(
    "native-model-id",
  );
});

test("Claude never invents a catalog or reports an unconfirmed effort change as applied", async () => {
  const f = fixture();
  f.query.supportedModels = async () => [];
  expect((await f.settings.read()).models).toEqual([]);
  let attempts = 0;
  f.query.applyFlagSettings = async () => {
    attempts++;
  };
  await expect(
    f.settings.apply({ effort: "new-native-effort" }),
  ).rejects.toThrow();
  expect(attempts).toBe(1);
  expect((await f.settings.read()).values.effort).toBe("native-effort");
  f.query.applyFlagSettings = async () => {
    attempts++;
    throw new Error("Native refusal");
  };
  await expect(
    f.settings.apply({ effort: "new-native-effort" }),
  ).rejects.toThrow();
  expect(attempts).toBe(2);
  expect((await f.settings.read()).values.effort).toBe("native-effort");
  await expect(new ClaudeSettings(() => undefined).read()).rejects.toThrow();
});
