import { expect, test } from "bun:test";
import { accountReady } from "./accounts";
import type { HostAccounts } from "./accounts";

test("a harness is ready on a computer once one's own account is connected", () => {
  const none: HostAccounts = {
    claude: {
      method: null,
      signed_in: false,
      email: null,
      plan: null,
      signing_in: false,
      error: null,
    },
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
    claude: { ...none.claude, method: "api_key" },
    codex: { ...none.codex, signed_in: true, method: "chatgpt" },
    pi: { providers: ["anthropic"] },
  };
  expect(accountReady(all, "claude-code")).toBe(true);
  expect(accountReady(all, "codex")).toBe(true);
  expect(accountReady(all, "pi")).toBe(true);
  expect(accountReady(undefined, "pi")).toBe(false);
  // Claude Code signed in with its own sign-in is ready too.
  const signedIn: HostAccounts = {
    ...none,
    claude: { ...none.claude, signed_in: true, method: "claude.ai" },
  };
  expect(accountReady(signedIn, "claude-code")).toBe(true);
});
