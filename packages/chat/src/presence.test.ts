import { expect, test } from "bun:test";
import type { Approval, ChatSession } from "./chat";
import type { Actor } from "./client";
import {
  attentionInbox,
  consoleSessions,
  delegatedBy,
  delegatedTo,
  noticeText,
  sessionAttention,
  sessionAttentions,
  sessionMatches,
  sessionNotices,
} from "./presence";

const session = (
  id: string,
  status: ChatSession["status"],
  activity: ChatSession["activity"] = null,
): ChatSession => ({
  id,
  owner_id: "owner",
  shared: null,
  actor_id: "aspen",
  host_id: null,
  harness: "pi",
  native_session_id: `native-${id}`,
  title: id,
  workspace: "/home/owner/work",
  status,
  attention_reason: null,
  activity,
  waiting: 0,
  created_at: 1,
  pinned_at: null,
  archived_at: null,
  budget_usd: null,
  parent_session_id: null,
});

test("the console lists live sessions working first, and keeps the stopped ones apart", () => {
  const { live, stopped } = consoleSessions([
    session("starting", "connecting"),
    session("idle", "connected", "idle"),
    session("done", "stopped"),
    session("busy", "connected", "working"),
  ]);
  expect(live.map((s) => s.id)).toEqual(["busy", "idle", "starting"]);
  expect(stopped.map((s) => s.id)).toEqual(["done"]);
});

test("a session is found by each word typed: its title, agent, folder, harness or summary", () => {
  const release = {
    ...session("release", "connected"),
    title: "Release check",
    summary: "The tests pass on main",
  };
  const actors = [{ id: "aspen", name: "Aspen" }] as Actor[];
  expect(sessionMatches(release, actors, "")).toBe(true);
  expect(sessionMatches(release, actors, "aspen  RELEASE")).toBe(true);
  expect(sessionMatches(release, actors, "work pi")).toBe(true);
  expect(sessionMatches(release, actors, "tests main")).toBe(true);
  expect(sessionMatches(release, actors, "release birch")).toBe(false);
});

const request = (
  sessionId: string,
  kind: Approval["kind"],
  status: Approval["status"] = "pending",
): Approval => ({
  id: `${sessionId}-${kind}`,
  actor_id: "aspen",
  session_id: sessionId,
  conversation_id: null,
  delivery_id: null,
  kind,
  summary: "Run bun test",
  details: {},
  status,
  decision: null,
  scope: null,
  reason: null,
  answer: null,
  native_request_id: "n1",
  created_at: 1,
});

test("a session's state for you: what it asks first, then work, failure, news, quiet", () => {
  const idle = { ...session("a", "connected", "idle"), output_at: 100 };
  expect(sessionAttention(idle, [request("a", "permission")])).toBe("approval");
  expect(sessionAttention(idle, [request("a", "question")])).toBe("input");
  // An answered request asks nothing.
  expect(
    sessionAttention(idle, [request("a", "permission", "resolved")], 200),
  ).toBe("idle");
  expect(sessionAttention(session("a", "connected", "working"), [])).toBe(
    "working",
  );
  expect(sessionAttention({ ...idle, last_turn: "error" }, [], 200)).toBe(
    "failed",
  );
  expect(sessionAttention(idle, [], 50)).toBe("unseen");
  expect(sessionAttention(idle, [], 150)).toBe("idle");
  const inbox = attentionInbox(
    [
      { ...session("quiet", "connected", "idle"), output_at: 10 },
      { ...session("new", "connected", "idle"), output_at: 300 },
      session("busy", "connected", "working"),
      { ...session("asks", "connected", "idle"), output_at: 5 },
    ],
    [request("asks", "permission")],
    { quiet: 20, new: 100 },
  );
  expect(inbox.map((row) => [row.session.id, row.attention])).toEqual([
    ["asks", "approval"],
    ["busy", "working"],
    ["new", "unseen"],
    ["quiet", "idle"],
  ]);
  // Pinned first, whatever their state; archived ones leave the Console's lists.
  const pinned = attentionInbox(
    [
      session("busy", "connected", "working"),
      { ...session("kept", "connected", "idle"), pinned_at: 5 },
    ],
    [],
    {},
  );
  expect(pinned.map((row) => row.session.id)).toEqual(["kept", "busy"]);
  const lists = consoleSessions([
    session("on", "connected"),
    { ...session("away", "connected"), archived_at: 9 },
  ]);
  expect(lists.live.map((s) => s.id)).toEqual(["on"]);
  expect(lists.archived.map((s) => s.id)).toEqual(["away"]);
});

test("a session tells you when it starts needing you, fails or finishes, once, and never at first sight", () => {
  const working = session("aspen", "connected", "working");
  const idle = {
    ...session("aspen", "connected", "idle"),
    summary: "Fixed the build",
  };
  const asks = [request("aspen", "permission")];
  const look = (sessions: ChatSession[], approvals: Approval[] = []) =>
    sessionAttentions(sessions, approvals);
  expect(sessionNotices({}, look([working]))).toEqual([]);
  expect(sessionNotices(look([working]), look([working]))).toEqual([]);
  expect(sessionNotices(look([working]), look([working], asks))).toEqual([
    { id: "aspen", notice: "approval" },
  ]);
  // Answered, it works on: nothing to say until it ends.
  expect(sessionNotices(look([working], asks), look([working]))).toEqual([]);
  expect(sessionNotices(look([working]), look([idle]))).toEqual([
    { id: "aspen", notice: "finished" },
  ]);
  expect(
    sessionNotices(look([idle]), look([{ ...idle, last_turn: "error" }])),
  ).toEqual([{ id: "aspen", notice: "failed" }]);
  // A stopped session is no longer followed.
  expect(
    sessionNotices(look([working]), look([session("aspen", "stopped")])),
  ).toEqual([]);
  expect(noticeText("approval", working, asks, "aspen").title).toBe(
    "aspen asks for approval",
  );
  expect(noticeText("finished", idle, [], "aspen")).toEqual({
    title: "aspen finished",
    body: "Fixed the build",
  });
});

test("a session knows the session that delegated work to it, and the ones it delegated to", () => {
  const lead = session("lead", "connected");
  const first = { ...session("first", "connected"), parent_session_id: "lead" };
  const second = {
    ...session("second", "stopped"),
    parent_session_id: "lead",
    created_at: 2,
  };
  const all = [lead, first, second, session("apart", "connected")];
  expect(delegatedBy(first, all)).toBe(lead);
  expect(delegatedBy(lead, all)).toBeUndefined();
  // The latest first.
  expect(delegatedTo("lead", all).map((s) => s.id)).toEqual([
    "second",
    "first",
  ]);
  expect(delegatedTo("apart", all)).toEqual([]);
});
