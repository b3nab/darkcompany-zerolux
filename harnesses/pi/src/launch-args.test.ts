import { expect, test } from "bun:test";
import { piResumeArgs } from "./launch-args.ts";

test("a terminal pi starts again with how it was set up, never with what chose its session or its first work", () => {
  expect(
    piResumeArgs([
      "--session",
      "/tmp/s.jsonl",
      "--model",
      "fixture/model",
      "--no-skills",
      "--append-system-prompt",
      "Be brief",
      "--api-key",
      "secret",
      "-e",
      "/ext/mine.ts",
      "--unknown-flag",
      "@file.md",
      "do this first",
      "--",
      "--offline",
    ]),
  ).toEqual([
    "--no-skills",
    "--append-system-prompt",
    "Be brief",
    "-e",
    "/ext/mine.ts",
  ]);
  expect(piResumeArgs([])).toEqual([]);
});
