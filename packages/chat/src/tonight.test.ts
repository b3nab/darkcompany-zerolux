import { expect, test } from "bun:test";
import { ago } from "./chat";
import type { Approval, ChatSession, Conversation } from "./chat";
import type { Actor } from "./client";
import { memberTone } from "./presence";
import { shiftWindow } from "./shift";
import { fileKind, fileSize } from "./storage";
import type { StoredFile } from "./storage";
import {
  facade,
  greeting,
  homeLabel,
  needsYou,
  requestsFor,
  runningNow,
} from "./tonight";

const owner: Actor = {
  id: "owner",
  name: "Owner",
  kind: "human",
  owner_id: null,
  invited_by: null,
  harness: null,
  model: null,
  effort: null,
  permission_mode: null,
  approval_policy: null,
  sandbox: null,
  created_at: 0,
  archived: false,
};
const session = (id: string, patch: Partial<ChatSession>): ChatSession => ({
  id,
  owner_id: "owner",
  shared: null,
  actor_id: "lin",
  host_id: null,
  harness: "pi",
  native_session_id: id,
  title: "lin at work",
  workspace: "/w",
  status: "connected",
  attention_reason: null,
  waiting: 0,
  created_at: 0,
  pinned_at: null,
  archived_at: null,
  budget_usd: null,
  parent_session_id: null,
  ...patch,
});
const general: Conversation = {
  id: "general",
  kind: "group",
  title: "General",
  paused: false,
  members: [],
  last_seq: 1,
  last_message: { author_id: "owner", text: "Hello", created_at: 1 },
};
const approval = (status: Approval["status"]): Approval => ({
  id: `a-${status}`,
  actor_id: "lin",
  session_id: "s",
  conversation_id: "general",
  delivery_id: "d",
  kind: "permission",
  summary: "Run bun test",
  details: {},
  status,
  answer: null,
  decision: null,
  scope: null,
  reason: null,
  native_request_id: "n",
  created_at: 5,
});

test("what needs you: your sessions' open requests, and those of them stuck", () => {
  const mine = { ...approval("pending"), session_id: "s1" };
  // Another person's session, shared with you: its requests and trouble are theirs.
  const theirs = {
    ...approval("pending"),
    id: "a-theirs",
    session_id: "s2",
  };
  const needs = needsYou(
    {
      approvals: [mine, approval("delivered"), theirs],
      sessions: [
        session("s1", { status: "attention" }),
        session("s2", { status: "attention", owner_id: "birch" }),
      ],
      conversations: [general],
    },
    "owner",
  );
  expect(needs.map((n) => [n.kind, n.title, n.where])).toEqual([
    ["Permission", "Run bun test", "General"],
    ["pi", "The session needs your attention", undefined],
  ]);
  expect(needs[0]!.approvalId).toBe("a-pending");
  expect(needs[1]!.place).toEqual({ session: "s1" });
  expect(
    requestsFor(
      {
        approvals: [mine, theirs],
        sessions: [session("s1", {}), session("s2", { owner_id: "birch" })],
      },
      "birch",
    ).map((a) => a.id),
  ).toEqual(["a-theirs"]);
});

test("what runs: an agent answering in a chat and a session elsewhere", () => {
  const running = runningNow({
    approvals: [],
    sessions: [
      session("s1", {
        activity: "working",
        activity_conversation_id: "general",
      }),
      session("s2", { activity: "working" }),
      session("s3", { activity: "idle" }),
    ],
    conversations: [general],
  });
  expect(running.map((r) => [r.what, r.place])).toEqual([
    ["Answering in General", { chat: "general" }],
    ["lin at work", { session: "s2" }],
  ]);
});

test("the facade keeps every light, in fixed scattered seats", () => {
  const tones = memberTone(owner, "owner", []);
  expect(tones).toBe("on");
  const cells = facade(["on", "working", "attention"]);
  expect(cells).toHaveLength(24);
  expect(cells.filter((c) => c !== "stopped").sort()).toEqual([
    "attention",
    "on",
    "working",
  ]);
  expect(facade(["on", "working", "attention"])).toEqual(cells);
  expect(facade(Array(30).fill("working"))).toHaveLength(32);
});

test("the shift ends on the next even hour and places times inside it", () => {
  const shift = shiftWindow(Date.UTC(2000, 0, 1, 7, 30));
  expect(shift.end).toBe(Date.UTC(2000, 0, 1, 8));
  expect(shift.ticks).toHaveLength(8);
  expect(shift.at(shift.start)).toBe(0);
  expect(shift.at(shift.end + 1)).toBe(1);
  expect(greeting(9)).toBe("Good morning");
  expect(greeting(23)).toBe("Good evening");
  expect([4, 5, 13, 17, 18, 23].map(homeLabel)).toEqual([
    "Tonight",
    "Today",
    "Today",
    "Today",
    "Tonight",
    "Tonight",
  ]);
});

test("files get an icon kind and a readable size", () => {
  const file = (content_type: string): StoredFile => ({
    id: "f",
    name: "f",
    folder: "",
    size: 1,
    content_type,
    created_by: "lin",
    updated_at: 1,
    conversation_id: null,
  });
  expect(
    ["image/png", "text/markdown", "application/zip", "text/csv"].map((t) =>
      fileKind(file(t)),
    ),
  ).toEqual(["image", "text", "archive", "sheet"]);
  expect([512, 2048, 3 * 1024 ** 2].map(fileSize)).toEqual([
    "512 B",
    "2 KB",
    "3.0 MB",
  ]);
});

test("ago reads the same without RelativeTimeFormat, as on the phone", () => {
  const relative = Intl.RelativeTimeFormat;
  const now = Date.UTC(2000, 0, 1, 12);
  try {
    (Intl as { RelativeTimeFormat?: unknown }).RelativeTimeFormat = undefined;
    expect(ago(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(ago(now - 60 * 60_000, now)).toBe("1 hour ago");
    expect(ago(now - 3 * 86_400_000, now)).toBe("3 days ago");
    expect(ago(now, now)).toBe("now");
  } finally {
    (Intl as { RelativeTimeFormat?: unknown }).RelativeTimeFormat = relative;
  }
});
