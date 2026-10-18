import { expect, test } from "bun:test";
import {
  applyLive,
  contextShare,
  liveNotice,
  liveResync,
  liveState,
  noLive,
  watchLive,
} from "./live";
import type { LiveNotice, LiveRead, LiveState } from "./live";

const notice = (
  first: number,
  changes: LiveNotice["changes"],
  session_id = "aspen",
): LiveNotice => ({ type: "session.live", session_id, first, changes });

test("changes build what is in progress, in order, each applied once", () => {
  let state: LiveState | undefined = applyLive(noLive, {
    first: 1,
    changes: [
      { type: "append", item: "t", kind: "thinking", text: "Let me " },
      { type: "append", item: "t", kind: "thinking", text: "look" },
      { type: "append", item: "m", kind: "text", text: "Hello" },
    ],
  });
  expect(state).toEqual({
    seq: 3,
    items: [
      { id: "t", kind: "thinking", text: "Let me look" },
      { id: "m", kind: "text", text: "Hello" },
    ],
    queue: [],
    usage: null,
  });
  // A notice already applied in part: only what follows seq counts.
  state = applyLive(state!, {
    first: 3,
    changes: [
      { type: "append", item: "m", kind: "text", text: "Hello" },
      { type: "set", item: "cmd", kind: "output", text: "line 1\n" },
      { type: "set", item: "cmd", kind: "output", text: "line 2\n" },
      { type: "done", item: "t" },
      { type: "queue", items: [{ id: "q1", text: "then run the tests" }] },
      { type: "usage", context_tokens: 42_000, context_window: 200_000 },
    ],
  });
  const usage = {
    context_tokens: 42_000,
    context_window: 200_000,
    total_tokens: null,
    cost_usd: null,
  };
  expect(state).toEqual({
    seq: 8,
    items: [
      { id: "t", kind: "thinking", text: "Let me look", done: true },
      { id: "m", kind: "text", text: "Hello" },
      { id: "cmd", kind: "output", text: "line 2\n" },
    ],
    queue: [{ id: "q1", text: "then run the tests" }],
    usage,
  });
  // The turn's end leaves what waits for the next one, and what it used.
  expect(applyLive(state!, { first: 9, changes: [{ type: "clear" }] })).toEqual(
    {
      seq: 9,
      items: [],
      queue: [{ id: "q1", text: "then run the tests" }],
      usage,
    },
  );
  // A missing change: the state is read again.
  expect(
    applyLive(state!, { first: 10, changes: [{ type: "clear" }] }),
  ).toBeUndefined();
});

test("a followed session reads its state, then follows the notices", async () => {
  const reads: string[] = [];
  let answer: LiveRead = {
    seq: 4,
    items: [{ id: "m", kind: "text", text: "Hel" }],
  };
  const read = async (sessionId: string) => {
    reads.push(sessionId);
    return answer;
  };
  let heard = 0;
  const stop = watchLive("aspen", read, () => heard++);
  // A notice while the first read is out waits for it.
  liveNotice(
    notice(4, [
      { type: "append", item: "m", kind: "text", text: "XX" },
      { type: "append", item: "m", kind: "text", text: "lo" },
    ]),
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(liveState("aspen").items).toEqual([
    { id: "m", kind: "text", text: "Hello" },
  ]);
  // A kernel without a queue reads as an empty one.
  expect(liveState("aspen").queue).toEqual([]);
  expect(liveState("aspen").seq).toBe(5);
  // A gap reads it again.
  answer = { seq: 9, items: [], queue: [{ id: "q1", text: "next" }] };
  liveNotice(notice(8, [{ type: "clear" }]));
  await Promise.resolve();
  await Promise.resolve();
  expect(liveState("aspen")).toEqual({
    seq: 9,
    items: [],
    queue: [{ id: "q1", text: "next" }],
    usage: null,
  });
  // So does a reconnection.
  liveResync();
  await Promise.resolve();
  expect(reads).toEqual(["aspen", "aspen", "aspen"]);
  expect(heard).toBeGreaterThan(0);
  // Others' notices and unfollowed sessions change nothing.
  liveNotice(notice(10, [{ type: "clear" }], "birch"));
  expect(liveState("birch")).toEqual(noLive);
  stop();
  expect(liveState("aspen")).toEqual(noLive);
});

test("the context's share is known only when the harness says both numbers", () => {
  expect(
    contextShare({
      context_tokens: 50_000,
      context_window: 200_000,
      total_tokens: null,
      cost_usd: null,
    }),
  ).toBe(0.25);
  // Without both numbers, or past the window, the share says what it can.
  expect(contextShare(null)).toBeUndefined();
  expect(
    contextShare({
      context_tokens: 9,
      context_window: null,
      total_tokens: 9,
      cost_usd: 0,
    }),
  ).toBeUndefined();
  expect(
    contextShare({
      context_tokens: 300,
      context_window: 200,
      total_tokens: null,
      cost_usd: null,
    }),
  ).toBe(1);
});
