import { expect, test } from "bun:test";
import {
  applyLive,
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
    ],
  });
  expect(state).toEqual({
    seq: 7,
    items: [
      { id: "t", kind: "thinking", text: "Let me look", done: true },
      { id: "m", kind: "text", text: "Hello" },
      { id: "cmd", kind: "output", text: "line 2\n" },
    ],
    queue: [{ id: "q1", text: "then run the tests" }],
  });
  // The turn's end leaves what waits for the next one.
  expect(applyLive(state!, { first: 8, changes: [{ type: "clear" }] })).toEqual(
    { seq: 8, items: [], queue: [{ id: "q1", text: "then run the tests" }] },
  );
  // A missing change: the state is read again.
  expect(
    applyLive(state!, { first: 9, changes: [{ type: "clear" }] }),
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
