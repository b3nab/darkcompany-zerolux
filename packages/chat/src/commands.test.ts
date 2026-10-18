import { expect, test } from "bun:test";
import { commandsFor, sessionCommand } from "./commands";

test("a known command runs with what follows it; other text goes to the session", () => {
  expect(sessionCommand("/compact")).toEqual({ name: "compact", args: "" });
  expect(sessionCommand("  /compact  keep the plan \n")).toEqual({
    name: "compact",
    args: "keep the plan",
  });
  // The phone's keyboard may capitalize the first letter.
  expect(sessionCommand("/Compact")).toEqual({ name: "compact", args: "" });
  expect(sessionCommand("/unknown")).toBeUndefined();
  expect(sessionCommand("please /compact")).toBeUndefined();
  expect(sessionCommand("/compacting")).toBeUndefined();
});

test("the menu offers the commands that match what is typed so far", () => {
  expect(commandsFor("/").map((c) => c.name)).toEqual(["compact"]);
  expect(commandsFor("/Co").map((c) => c.name)).toEqual(["compact"]);
  expect(commandsFor("/x")).toEqual([]);
  expect(commandsFor("/compact now")).toEqual([]);
  expect(commandsFor("compact")).toEqual([]);
});
