import { expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { PiSettings } from "./settings.ts";

function fixture() {
  const models = [
    {
      id: "native-choice",
      name: "Native choice",
      provider: "provider-one",
      reasoning: true,
    },
    {
      id: "native-choice",
      name: "Other provider",
      provider: "provider-two",
      reasoning: false,
    },
  ] as Model<"openai-responses">[];
  let model = models[0]!;
  let effort = getSupportedThinkingLevels(model)[1]!;
  let authenticated = true;
  const calls: unknown[] = [];
  const pi = {
    getThinkingLevel: () => effort,
    setModel: async (next: typeof model) => {
      calls.push(["model", next]);
      if (!authenticated) return false;
      model = next;
      effort = getSupportedThinkingLevels(next)[0]!;
      return true;
    },
    setThinkingLevel: (next: typeof effort) => {
      calls.push(["effort", next]);
      effort = next;
    },
  } satisfies Pick<
    ExtensionAPI,
    "getThinkingLevel" | "setModel" | "setThinkingLevel"
  >;
  const ctx = {
    get model() {
      return model;
    },
    modelRegistry: { getAvailable: () => models },
  } as unknown as Pick<ExtensionContext, "model" | "modelRegistry">;
  return {
    settings: new PiSettings(pi, ctx),
    models,
    calls,
    unavailable: () => {
      authenticated = false;
    },
  };
}

test("pi reports the native model, effort and provider-specific choices without credentials", () => {
  const f = fixture();
  Object.assign(f.models[0]!, { headers: { authorization: "fixture-secret" } });
  const snapshot = f.settings.read();
  expect(snapshot.values).toEqual({
    model: "provider-one/native-choice",
    effort: getSupportedThinkingLevels(f.models[0]!)[1]!,
  });
  expect(snapshot.models.map((m) => m.value)).toEqual([
    "provider-one/native-choice",
    "provider-two/native-choice",
  ]);
  expect(snapshot.models[0]!.efforts).toEqual(
    getSupportedThinkingLevels(f.models[0]!),
  );
  expect(snapshot.models[1]!.efforts).toEqual(
    getSupportedThinkingLevels(f.models[1]!),
  );
  expect(JSON.stringify(snapshot)).not.toContain("fixture-secret");
  expect(f.calls).toEqual([]);
});

test("pi applies native changes to the same running session and returns the resulting state", async () => {
  const f = fixture();
  const level = getSupportedThinkingLevels(f.models[1]!)[0]!;
  const after = await f.settings.apply({
    model: "provider-two/native-choice",
    effort: level,
  });
  expect(after.values).toEqual({
    model: "provider-two/native-choice",
    effort: level,
  });
  expect(f.calls).toEqual([
    ["model", f.models[1]],
    ["effort", level],
  ]);
});

test("pi validates the complete change before changing anything and supports a read-only preflight", async () => {
  const f = fixture();
  await expect(
    f.settings.apply({
      model: "provider-two/native-choice",
      effort: "not-advertised",
    }),
  ).rejects.toThrow();
  await expect(f.settings.apply({ model: "missing" })).rejects.toThrow();
  await expect(f.settings.apply({ permission_mode: "auto" })).rejects.toThrow();
  await expect(f.settings.apply({ model: "" })).rejects.toThrow();
  await f.settings.apply({ model: "provider-two/native-choice" }, true);
  expect(f.calls).toEqual([]);
});

test("pi rejects a native refusal without pretending the effort or model changed", async () => {
  const f = fixture();
  const before = f.settings.values();
  f.unavailable();
  await expect(
    f.settings.apply({ model: "provider-two/native-choice" }),
  ).rejects.toThrow();
  expect(f.settings.values()).toEqual(before);
  expect(f.calls).toHaveLength(1);
});

test("pi reads refreshed native choices and changes effort without rewriting the model", async () => {
  const f = fixture();
  f.models.push({ ...f.models[0]!, id: "added-by-provider" });
  expect(f.settings.read().models.at(-1)!.value).toBe(
    "provider-one/added-by-provider",
  );
  const effort = getSupportedThinkingLevels(f.models[0]!).at(-1)!;
  await f.settings.apply({ effort });
  expect(f.calls).toEqual([["effort", effort]]);
});
