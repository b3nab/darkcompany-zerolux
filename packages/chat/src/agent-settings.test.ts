import { afterEach, expect, test } from "bun:test";
import { ApiError, setKernelUrl } from "./client";
import type { Actor } from "./client";
import {
  agentLaunchSettings,
  agentSettingFields,
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

test("agent settings post only supplied fields, preserve clearing and return the saved actor", async () => {
  let sent: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent = { url, init };
    return Response.json({ actor });
  }) as typeof fetch;
  expect(
    await setAgentSettings(actor.id, {
      model: "  fixture-model  ",
      effort: "  ",
      permission_mode: undefined,
    }),
  ).toEqual(actor);
  expect(sent?.url).toBe("/api/actors/fixture-agent/settings");
  expect(sent?.init.method).toBe("POST");
  expect(JSON.parse(sent!.init.body as string)).toEqual({
    model: "fixture-model",
    effort: "",
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
