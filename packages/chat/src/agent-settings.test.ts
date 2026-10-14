import { afterEach, expect, test } from "bun:test";
import { ApiError, setKernelUrl } from "./client";
import type { Actor } from "./client";
import {
  agentLaunchSettings,
  agentSettingFields,
  canApplyAgentSettings,
  setAgentSettings,
} from "./workspace";

const actor: Actor = {
  id: "fixture-agent",
  name: "Agent",
  kind: "agent",
  owner_id: "fixture-owner",
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
