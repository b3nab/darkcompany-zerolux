import { expect, test } from "bun:test";
import type { DiscoveredSession } from "./chat";
import { byActivity } from "./native";
import { nativeMatches } from "./presence";

const native = (
  id: string,
  last_activity_at: number | null,
  more: Partial<DiscoveredSession> = {},
): DiscoveredSession => ({
  id,
  harness: "claude-code",
  title: id,
  workspace: "/projects/aspen",
  last_activity_at,
  native_session_id: id,
  availability: "attachable",
  can_create_context: true,
  reason: null,
  ...more,
});

test("a project's native sessions come the latest active first, those without activity last", () => {
  expect(
    byActivity([native("a", 10), native("b", null), native("c", 30)]).map(
      (s) => s.id,
    ),
  ).toEqual(["c", "a", "b"]);
});

test("a native session is found by each word typed: its title, folder or harness", () => {
  const release = native("s1", 1, {
    title: "Release check",
    harness: "codex",
    workspace: "/projects/aspen/web",
  });
  expect(nativeMatches(release, "")).toBe(true);
  expect(nativeMatches(release, "RELEASE  web")).toBe(true);
  expect(nativeMatches(release, "codex aspen")).toBe(true);
  expect(nativeMatches(release, "release birch")).toBe(false);
});
