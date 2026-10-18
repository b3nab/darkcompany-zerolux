import { expect, test } from "bun:test";
import {
  checksOf,
  isStaged,
  isUnstaged,
  lineComment,
  parseGitDiff,
  type PullRequest,
} from "./git";

test("a file's diff reads as numbered lines, before and after", () => {
  const diff = [
    "diff --git a/notes.md b/notes.md",
    "index 1111111..2222222 100644",
    "--- a/notes.md",
    "+++ b/notes.md",
    "@@ -1,3 +1,3 @@ Title",
    " aspen",
    "-birch",
    "+cedar",
    " maple",
    "@@ -10,0 +11,1 @@",
    "+olive",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  const { lines, added, removed, binary } = parseGitDiff(diff);
  expect([added, removed, binary]).toEqual([2, 1, false]);
  expect(lines.map((line) => [line.kind, line.old, line.new])).toEqual([
    ["hunk", undefined, undefined],
    ["same", 1, 1],
    ["removed", 2, undefined],
    ["added", undefined, 2],
    ["same", 3, 3],
    ["hunk", undefined, undefined],
    ["added", undefined, 11],
  ]);
  // Header lines that look like changes are not lines of the file.
  expect(lines.some((line) => line.text.includes("b/notes.md"))).toBe(false);
  expect(
    parseGitDiff(
      "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n",
    ).binary,
  ).toBe(true);
});

test("changes say what is staged and what is not, and notes name their lines", () => {
  const untracked = { path: "new.md", from: null, staged: ".", unstaged: "?" };
  const both = { path: "a.md", from: null, staged: "M", unstaged: "M" };
  expect([isStaged(untracked), isUnstaged(untracked)]).toEqual([false, true]);
  expect([isStaged(both), isUnstaged(both)]).toEqual([true, true]);
  expect(lineComment("src/a.ts", 12, 12, " Use bun ")).toBe(
    "src/a.ts:12: Use bun",
  );
  expect(lineComment("src/a.ts", 12, 18, "Simpler")).toBe(
    "src/a.ts:12-18: Simpler",
  );
});

test("a pull request's checks from GitHub's runs and statuses", () => {
  const pr = {
    statusCheckRollup: [
      {
        __typename: "CheckRun",
        name: "test",
        status: "COMPLETED",
        conclusion: "SUCCESS",
      },
      {
        __typename: "CheckRun",
        name: "lint",
        status: "IN_PROGRESS",
        conclusion: null,
      },
      {
        __typename: "CheckRun",
        name: "build",
        status: "COMPLETED",
        conclusion: "TIMED_OUT",
      },
      {
        __typename: "CheckRun",
        name: "docs",
        status: "COMPLETED",
        conclusion: "SKIPPED",
      },
      {
        __typename: "StatusContext",
        context: "deploy",
        state: "PENDING",
        targetUrl: "https://ci.example.test/1",
      },
    ],
  } as PullRequest;
  expect(checksOf(pr)).toEqual([
    { name: "test", state: "passed", url: undefined },
    { name: "lint", state: "pending", url: undefined },
    { name: "build", state: "failed", url: undefined },
    { name: "docs", state: "skipped", url: undefined },
    { name: "deploy", state: "pending", url: "https://ci.example.test/1" },
  ]);
  expect(checksOf({ ...pr, statusCheckRollup: null })).toEqual([]);
});
