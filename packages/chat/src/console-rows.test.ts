import { expect, test } from "bun:test";
import type { Approval, ChatSession, DiscoveredSession } from "./chat";
import { consoleRows, dayGroup } from "./console-rows";

// A fixed afternoon: Tuesday 3 November 2026, 15:00 local time.
const now = new Date(2026, 10, 3, 15, 0).getTime();
const at = (days: number, hour = 10) =>
  new Date(2026, 10, 3 - days, hour, 0).getTime();

const session = (id: string, more: Partial<ChatSession> = {}): ChatSession => ({
  id,
  owner_id: "owner",
  shared: null,
  created: false,
  actor_id: null,
  host_id: null,
  harness: "pi",
  native_session_id: `native-${id}`,
  title: id,
  workspace: "/home/owner/work",
  status: "connected",
  attention_reason: null,
  activity: null,
  waiting: 0,
  created_at: at(30),
  pinned_at: null,
  archived_at: null,
  budget_usd: null,
  parent_session_id: null,
  ...more,
});
const native = (id: string, last: number | null): DiscoveredSession => ({
  id,
  harness: "claude-code",
  title: id,
  workspace: "/home/owner/work",
  last_activity_at: last,
  native_session_id: id,
  availability: "attention",
  can_create_context: false,
  reason: null,
});
const asking: Approval = {
  id: "a1",
  session_id: "asks",
  status: "pending",
  kind: "permission",
} as Approval;

test("the Live view groups pinned, needing you, running, then by day, the latest active first in each", () => {
  const rows = consoleRows({
    live: true,
    now,
    approvals: [asking],
    sessions: [
      session("older", { output_at: at(20) }),
      session("today-early", { output_at: at(0, 9) }),
      session("pinned-old", { output_at: at(40), pinned_at: 1 }),
      session("works", { activity: "working", output_at: at(3) }),
      session("asks", { output_at: at(10) }),
      session("today-late", { output_at: at(0, 14) }),
      session("yesterday", { output_at: at(1) }),
      session("this-week", { output_at: at(4) }),
    ],
  });
  expect(rows.map((r) => [r.key, r.group])).toEqual([
    ["pinned-old", "pinned"],
    ["asks", "needs"],
    ["works", "running"],
    ["today-late", "today"],
    ["today-early", "today"],
    ["yesterday", "yesterday"],
    ["this-week", "week"],
    ["older", "older"],
  ]);
});

test("a session with no output yet is dated by when it began, and a tie goes to the latest begun", () => {
  const rows = consoleRows({
    live: true,
    now,
    approvals: [],
    sessions: [
      session("never-wrote", { created_at: at(0, 12) }),
      session("tie-first", { output_at: at(2), created_at: at(9) }),
      session("tie-second", { output_at: at(2), created_at: at(5) }),
    ],
  });
  expect(rows.map((r) => [r.key, r.group, r.at])).toEqual([
    ["never-wrote", "today", at(0, 12)],
    ["tie-second", "week", at(2)],
    ["tie-first", "week", at(2)],
  ]);
});

test("the project's own sessions join the days by their own last activity, one without any last", () => {
  const rows = consoleRows({
    live: true,
    now,
    approvals: [],
    sessions: [session("ours", { output_at: at(1) })],
    natives: [native("theirs", at(0, 8)), native("unknown", null)],
  });
  expect(rows.map((r) => [r.kind, r.group])).toEqual([
    ["native", "today"],
    ["session", "yesterday"],
    ["native", "older"],
  ]);
});

test("a delegate stays right under its coordinator, in its coordinator's group", () => {
  const rows = consoleRows({
    live: true,
    now,
    approvals: [],
    sessions: [
      session("child", { output_at: at(0, 14), parent_session_id: "lead" }),
      session("lead", { output_at: at(5) }),
      session("other", { output_at: at(1) }),
    ],
  });
  expect(rows.map((r) => [r.key, r.group, r.depth])).toEqual([
    ["other", "yesterday", 0],
    ["lead", "week", 0],
    ["child", "week", 1],
  ]);
});

test("the other lists are by last activity alone, delegates under their coordinator", () => {
  const rows = consoleRows({
    now,
    approvals: [],
    sessions: [
      session("b", { output_at: at(3) }),
      session("a", { output_at: at(1), pinned_at: 1 }),
      session("c", { output_at: at(0), parent_session_id: "b" }),
    ],
  });
  expect(rows.map((r) => [r.key, r.group, r.depth])).toEqual([
    ["a", undefined, 0],
    ["b", undefined, 0],
    ["c", undefined, 1],
  ]);
});

test("days are calendar days: late last night is yesterday, a week back is older", () => {
  const justAfterMidnight = new Date(2026, 10, 3, 0, 20).getTime();
  expect(
    dayGroup(new Date(2026, 10, 2, 23, 50).getTime(), justAfterMidnight),
  ).toBe("yesterday");
  expect(dayGroup(at(0, 0), now)).toBe("today");
  expect(dayGroup(at(6), now)).toBe("week");
  expect(dayGroup(at(7), now)).toBe("older");
  expect(dayGroup(undefined, now)).toBe("older");
});
