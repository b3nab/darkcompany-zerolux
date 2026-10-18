import { expect, test } from "bun:test";
import { commandsFor, sessionCommand } from "./commands";
import type { SessionCommand } from "./commands";

test("ZeroLux's own command runs with what follows it; other text goes to the session", () => {
  expect(sessionCommand("/compact")).toEqual({ name: "compact", args: "" });
  expect(sessionCommand("  /compact  keep the plan \n")).toEqual({
    name: "compact",
    args: "keep the plan",
  });
  // The phone's keyboard may capitalize the first letter.
  expect(sessionCommand("/Compact")).toEqual({ name: "compact", args: "" });
  expect(sessionCommand("/review")).toBeUndefined();
  expect(sessionCommand("please /compact")).toBeUndefined();
  expect(sessionCommand("/compacting")).toBeUndefined();
});

test("the menu offers ZeroLux's commands, then the harness's, by what is typed", () => {
  const harness: SessionCommand[] = [
    {
      name: "review",
      invoke: "/review",
      description: "Review the changes",
      hint: "[branch]",
    },
    { name: "compact", invoke: "/compact", description: "Claude's own" },
    { name: "deploy", invoke: "$deploy", description: "A Codex skill" },
  ];
  expect(commandsFor("/", harness).map((c) => c.invoke)).toEqual([
    "/compact",
    "/review",
  ]);
  // Where both have one, ZeroLux's stays.
  expect(commandsFor("/Co", harness)).toEqual([
    {
      name: "compact",
      invoke: "/compact",
      description: "Summarize the older work, so the session has room again",
      hint: "what to keep",
    },
  ]);
  expect(commandsFor("$", harness).map((c) => c.invoke)).toEqual(["$deploy"]);
  expect(commandsFor("/x", harness)).toEqual([]);
  expect(commandsFor("/compact now", harness)).toEqual([]);
  expect(commandsFor("compact", harness)).toEqual([]);
  expect(commandsFor("/").map((c) => c.invoke)).toEqual(["/compact"]);
});
