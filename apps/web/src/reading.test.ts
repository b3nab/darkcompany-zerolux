import { expect, test } from "bun:test";
import { leavesOrFollows } from "./reading";

test("only the reader leaves the bottom: a scroll that came from what changed size keeps following", () => {
  // At the bottom it is followed, whoever scrolled there.
  expect(leavesOrFollows(false, 0, true)).toBe(true);
  expect(leavesOrFollows(false, 3, false)).toBe(true);
  // Away from it, the reader's own scroll stops following.
  expect(leavesOrFollows(true, 400, true)).toBe(false);
  // The box shrinking after a send, or new work coming in, moves the view too: nobody
  // chose that, so what was followed still is, and a place being read stays read.
  expect(leavesOrFollows(true, 400, false)).toBe(true);
  expect(leavesOrFollows(false, 400, false)).toBe(false);
});
