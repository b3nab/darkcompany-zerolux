import { afterEach, expect, test } from "bun:test";
import { ApiError, setKernelUrl } from "./client";
import type { Actor } from "./client";
import {
  agentLaunchSettings,
  agentModelOption,
  agentModelValue,
  agentSettingFields,
  canApplyAgentSettings,
  planMode,
  setAgentSettings,
  settingChoices,
} from "./workspace";

const actor: Actor = {
  id: "fixture-agent",
  name: "Agent",
  kind: "agent",
  owner_id: "fixture-owner",
  invited_by: null,
  harness: "claude-code",
  model: "fixture-model",
  effort: null,
  permission_mode: "plan",
  approval_policy: null,
  sandbox: null,
  created_at: 0,
  archived: false,
};
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setKernelUrl("");
});

test("agent settings post only supplied native choices and return the confirmed actor", async () => {
  let sent: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent = { url, init };
    return Response.json({ actor });
  }) as typeof fetch;
  expect(
    await setAgentSettings(actor.id, {
      model: "  fixture-model  ",
      effort: " high ",
      permission_mode: undefined,
    }),
  ).toEqual(actor);
  expect(sent?.url).toBe("/api/actors/fixture-agent/settings");
  expect(sent?.init.method).toBe("POST");
  expect(JSON.parse(sent!.init.body as string)).toEqual({
    model: "fixture-model",
    effort: "high",
  });
});

test("an explicit kernel and escaped actor identifier are preserved for settings updates", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return Response.json({ actor });
  }) as typeof fetch;
  setKernelUrl("https://other.example.test");
  await setAgentSettings(
    "agent/with space",
    { effort: "high" },
    "https://workspace.example.test",
  );
  expect(urls).toEqual([
    "https://workspace.example.test/api/actors/agent%2Fwith%20space/settings",
  ]);
});

test("a refused settings update remains an error", async () => {
  globalThis.fetch = (async () =>
    Response.json(
      { error: "Invalid setting" },
      { status: 400 },
    )) as unknown as typeof fetch;
  const error = await setAgentSettings(actor.id, {
    permission_mode: "invalid",
  }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(400);
  expect((error as ApiError).message).toBe("Invalid setting");
});

test("both clients offer common settings and only the native controls of each harness", () => {
  const keys = (harness: Actor["harness"]) =>
    agentSettingFields(harness).map((field) => field.key);
  expect(keys("pi")).toEqual(["model", "effort"]);
  expect(keys("claude-code")).toEqual(["model", "effort", "permission_mode"]);
  expect(keys("codex")).toEqual([
    "model",
    "effort",
    "approval_policy",
    "sandbox",
  ]);
  expect(Object.keys(agentSettingFields("claude-code")[2]!.options!)).toEqual([
    "default",
    "acceptEdits",
    "plan",
    "auto",
  ]);
  expect(Object.keys(agentSettingFields("codex")[2]!.options!)).toEqual([
    "untrusted",
    "on-request",
    "never",
  ]);
  expect(Object.keys(agentSettingFields("codex")[3]!.options!)).toEqual([
    "read-only",
    "workspace-write",
    "danger-full-access",
  ]);
});

test("model and effort selectors use only the native catalog, including unfamiliar choices", () => {
  expect(
    agentSettingFields("pi")
      .slice(0, 2)
      .map((field) => field.options),
  ).toEqual([{}, {}]);
  const models = [
    {
      value: "native-alias",
      resolved_model: "native-version",
      label: "From the harness",
      efforts: ["native-effort"],
    },
    { value: "other-native-model", label: "Other choice", efforts: [] },
  ];
  const fields = agentSettingFields("claude-code", models, "native-version");
  expect(fields[0]!.options).toEqual({
    "native-alias": "From the harness",
    "other-native-model": "Other choice",
  });
  expect(fields[1]!.options).toEqual({ "native-effort": "native-effort" });
  expect(
    agentSettingFields("claude-code", models, "other-native-model")[1]!.options,
  ).toEqual({});
});

test("retained drafts cannot be applied when native capabilities or choices change", () => {
  const fields = agentSettingFields(
    "pi",
    [{ value: "native-model", label: "Native", efforts: ["native-effort"] }],
    "native-model",
  );
  expect(
    canApplyAgentSettings({ effort: "native-effort" }, fields, [
      "model",
      "effort",
    ]),
  ).toBe(true);
  expect(
    canApplyAgentSettings({ effort: "native-effort" }, fields, ["model"]),
  ).toBe(false);
  expect(
    canApplyAgentSettings({ effort: "removed-effort" }, fields, ["effort"]),
  ).toBe(false);
  expect(
    canApplyAgentSettings({ model: "removed-model" }, fields, ["model"]),
  ).toBe(false);
  expect(canApplyAgentSettings({}, fields, ["model", "effort"])).toBe(false);
});

test("Claude accepts an explicit model ID without inventing effort choices", () => {
  const fields = agentSettingFields("claude-code", [], "native-new-model");
  expect(
    canApplyAgentSettings({ model: "native-new-model" }, fields, [
      "model",
      "effort",
    ]),
  ).toBe(true);
  expect(canApplyAgentSettings({ model: "   " }, fields, ["model"])).toBe(
    false,
  );
  expect(
    canApplyAgentSettings(
      { model: "native-new-model", effort: "high" },
      fields,
      ["model", "effort"],
    ),
  ).toBe(false);
  expect(
    canApplyAgentSettings({ model: "native-new-model" }, fields, ["effort"]),
  ).toBe(false);
  for (const harness of ["pi", "codex"] as const) {
    expect(
      canApplyAgentSettings(
        { model: "native-new-model" },
        agentSettingFields(harness),
        ["model"],
      ),
    ).toBe(false);
  }
});

test("model choices admit a custom ID only when supported and keep native matches", () => {
  const options = { "native-one": "Fixture one", "native-two": "Fixture two" };
  expect(settingChoices(options, "native-new", false)).toEqual([]);
  expect(
    settingChoices(options, " native-new ", true).map((choice) => choice.value),
  ).toEqual(["native-new"]);
  expect(
    settingChoices(options, "native-one", true).map((choice) => choice.value),
  ).toEqual(["native-one"]);
  expect(
    settingChoices(options, "", true).map((choice) => choice.value),
  ).toEqual(Object.keys(options));
  expect(
    settingChoices(options, "native", true).map((choice) => choice.value),
  ).toEqual(["native-one", "native-two", "native"]);
});

test("resolved model IDs select their alias without replacing an older version by a newer one", () => {
  const alias = {
    value: "native-alias",
    resolved_model: "native-v2",
    label: "Fixture",
    efforts: [],
  };
  expect(agentModelValue([alias], "native-v2")).toBe("native-alias");
  expect(agentModelValue([alias], "native-v1")).toBe("native-v1");
  expect(agentModelValue([alias], null)).toBe("");
  const explicit = {
    value: "native-v2",
    label: "Fixture version",
    efforts: [],
  };
  expect(agentModelValue([alias, explicit], "native-v2")).toBe("native-v2");
});

test("resolved model choices never select a reset or hybrid choice implicitly", () => {
  const alias = {
    value: "native-alias",
    resolved_model: "native-v2",
    label: "Fixture model",
    efforts: ["native-effort"],
  };
  const reset = { ...alias, value: "default", efforts: ["reset-effort"] };
  const hybrid = { ...alias, value: "opusplan", efforts: ["hybrid-effort"] };
  for (const models of [
    [reset, hybrid, alias],
    [alias, hybrid, reset],
  ]) {
    expect(agentModelValue(models, "native-v2")).toBe("native-alias");
    expect(agentModelValue(models, "native-alias")).toBe("native-alias");
    expect(agentModelValue(models, "default")).toBe("default");
    expect(agentModelValue(models, "opusplan")).toBe("opusplan");
    expect(agentModelValue(models, "native-v1")).toBe("native-v1");
    expect(
      Object.keys(
        agentSettingFields("claude-code", models, "native-v2")[1]!.options,
      ),
    ).toEqual(["native-effort"]);
  }
  expect(agentModelValue([reset, hybrid], "native-v2")).toBe("native-v2");
  expect(agentModelOption([reset, hybrid], "native-v2")).toBeUndefined();
});

test("an absent model cannot select a catalog entry without a resolved ID", () => {
  const models = [{ value: "native-model", label: "Fixture", efforts: [] }];
  for (const value of [undefined, null, ""]) {
    expect(agentModelOption(models, value)).toBeUndefined();
    expect(agentModelValue(models, value)).toBe("");
  }
});

test("blank launch fields omit overrides rather than clearing the agent's saved settings", () => {
  expect(agentLaunchSettings("  ", "")).toEqual({});
  expect(agentLaunchSettings(" fixture-model ", " high ")).toEqual({
    model: "fixture-model",
    effort: "high",
  });
  expect(agentLaunchSettings("fixture-model", " ")).toEqual({
    model: "fixture-model",
  });
  expect(agentLaunchSettings("", "low")).toEqual({ effort: "low" });
});

test("plan mode uses each harness's own setting, where it can change", () => {
  const codex = planMode("codex", { collaboration_mode: "plan" }, [
    "model",
    "collaboration_mode",
  ]);
  expect(codex?.on).toBe(true);
  expect(codex?.change(false)).toEqual({ collaboration_mode: "default" });
  const claude = planMode("claude-code", { permission_mode: "acceptEdits" }, [
    "permission_mode",
  ]);
  expect(claude?.on).toBe(false);
  expect(claude?.change(true)).toEqual({ permission_mode: "plan" });
  // pi has none; a harness that cannot change it now offers none.
  expect(planMode("pi", {}, ["model"])).toBeUndefined();
  expect(planMode("codex", {}, ["model"])).toBeUndefined();
});
