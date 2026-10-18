import { expect, test } from "bun:test";
import {
  applyLive,
  liveNotice,
  liveResync,
  liveState,
  noLive,
  watchLive,
} from "./live";
import type { LiveNotice, LiveState } from "./live";

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
  });
  // A notice already applied in part: only what follows seq counts.
  state = applyLive(state!, {
    first: 3,
    changes: [
      { type: "append", item: "m", kind: "text", text: "Hello" },
      { type: "set", item: "cmd", kind: "output", text: "line 1\n" },
      { type: "set", item: "cmd", kind: "output", text: "line 2\n" },
      { type: "done", item: "t" },
    ],
  });
  expect(state).toEqual({
    seq: 6,
    items: [
      { id: "t", kind: "thinking", text: "Let me look", done: true },
      { id: "m", kind: "text", text: "Hello" },
      { id: "cmd", kind: "output", text: "line 2\n" },
    ],
  });
  expect(applyLive(state!, { first: 7, changes: [{ type: "clear" }] })).toEqual(
    { seq: 7, items: [] },
  );
  // A missing change: the state is read again.
  expect(
    applyLive(state!, { first: 8, changes: [{ type: "clear" }] }),
  ).toBeUndefined();
});

test("a followed session reads its state, then follows the notices", async () => {
  const reads: string[] = [];
  let answer: LiveState = {
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
  expect(liveState("aspen").seq).toBe(5);
  // A gap reads it again.
  answer = { seq: 9, items: [] };
  liveNotice(notice(8, [{ type: "clear" }]));
  await Promise.resolve();
  await Promise.resolve();
  expect(liveState("aspen")).toEqual({ seq: 9, items: [] });
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
