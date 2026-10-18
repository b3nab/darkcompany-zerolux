import { expect, test } from "bun:test";
import { accountReady } from "./accounts";
import type { HostAccounts } from "./accounts";

test("a harness is ready on a computer once one's own account is connected", () => {
  const none: HostAccounts = {
    claude: { method: null },
    codex: {
      signed_in: false,
      method: null,
      email: null,
      plan: null,
      error: null,
    },
    pi: { providers: [] },
  };
  expect(accountReady(none, "claude-code")).toBe(false);
  expect(accountReady(none, "codex")).toBe(false);
  expect(accountReady(none, "pi")).toBe(false);
  const all: HostAccounts = {
    claude: { method: "api_key" },
    codex: { ...none.codex, signed_in: true, method: "chatgpt" },
    pi: { providers: ["anthropic"] },
  };
  expect(accountReady(all, "claude-code")).toBe(true);
  expect(accountReady(all, "codex")).toBe(true);
  expect(accountReady(all, "pi")).toBe(true);
  expect(accountReady(undefined, "pi")).toBe(false);
});
