import { expect, test } from "bun:test";
import { matchParts } from "./history";

test("the words searched stand out in a match, whatever their case", () => {
  expect(matchParts("Fix the build, then BUILD again", "build")).toEqual([
    { text: "Fix the ", match: false },
    { text: "build", match: true },
    { text: ", then ", match: false },
    { text: "BUILD", match: true },
    { text: " again", match: false },
  ]);
  // Each word on its own, and characters a pattern would read are only text.
  expect(matchParts("run f(b) now", "  (b)  run ")).toEqual([
    { text: "run", match: true },
    { text: " f", match: false },
    { text: "(b)", match: true },
    { text: " now", match: false },
  ]);
  expect(matchParts("nothing typed", " ")).toEqual([
    { text: "nothing typed", match: false },
  ]);
});
