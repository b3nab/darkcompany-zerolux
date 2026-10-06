import { expect, test } from "bun:test";
import { listChats, mergeConversation } from "./chat";
import type { Conversation } from "./chat";

const empty: Conversation = {
  id: "group",
  kind: "group",
  title: "General",
  paused: false,
  members: [],
  last_seq: 0,
  last_message: null,
};
const current: Conversation = {
  ...empty,
  last_seq: 2,
  last_message: { author_id: "aspen", text: "Latest update", created_at: 20 },
};

test("an empty chat has no preview, and a loaded chat keeps the server's preview", () => {
  expect(mergeConversation(undefined, empty)).toEqual(empty);
  expect(mergeConversation(undefined, current)).toEqual(current);
  expect(mergeConversation(empty, current)).toEqual(current);
});

test("a delayed list or action cannot regress the message but still updates other metadata", () => {
  const older = {
    ...empty,
    paused: true,
    members: [{ actor_id: "owner", session_id: null }],
    last_seq: 1,
    last_message: { author_id: "owner", text: "Older update", created_at: 10 },
  };
  expect(mergeConversation(current, older)).toEqual({
    ...older,
    last_seq: current.last_seq,
    last_message: current.last_message,
  });
  expect(current.paused).toBe(false);
  expect(older.last_seq).toBe(1);
});

test("a delayed send acknowledgement cannot replace a later received message", () => {
  const acknowledged = {
    ...current,
    last_seq: 1,
    last_message: { author_id: "owner", text: "Sent earlier", created_at: 10 },
  };
  expect(mergeConversation(current, acknowledged)).toEqual(current);
});

test("message sequence, not wall-clock time, decides which preview is newer", () => {
  const newer = {
    ...current,
    last_seq: 3,
    last_message: {
      author_id: "owner",
      text: "After clock change",
      created_at: 5,
    },
  };
  expect(mergeConversation(current, newer)).toEqual(newer);
});

test("a refreshed response at the same sequence can update conversation metadata", () => {
  const renamed = { ...current, title: "Renamed", closed_at: 30 };
  expect(mergeConversation(current, renamed)).toEqual(renamed);
});

test("previews never cross conversation boundaries", () => {
  const other = { ...empty, id: "other" };
  expect(mergeConversation(current, other)).toEqual(other);
});

test("the chat list orders by the last message time and excludes threads", () => {
  const newer = {
    ...current,
    id: "direct",
    kind: "dm" as const,
    last_message: { author_id: "owner", text: "Direct update", created_at: 30 },
  };
  const thread = { ...newer, id: "thread", kind: "thread" as const };
  const quiet = { ...empty, id: "quiet" };
  const chats = [quiet, current, thread, newer];
  expect(listChats(chats, "all", new Set()).map((c) => c.id)).toEqual([
    "direct",
    "group",
    "quiet",
  ]);
  expect(chats[0]).toBe(quiet);
});
