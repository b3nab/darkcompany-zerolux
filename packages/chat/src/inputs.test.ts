import { expect, test } from "bun:test";
import { unseenInputs } from "./inputs";
import type { SentInput } from "./inputs";
import type { SessionBlock } from "./session-events";

const sent = (
  id: string,
  text: string,
  after: number,
  status: SentInput["status"] = "sent",
): SentInput => ({
  id,
  session_id: "s1",
  text,
  images: [],
  mode: "steer",
  after,
  status,
});
const input = (at: number, text: string): SessionBlock => ({
  key: `${at}:0`,
  time: null,
  kind: "input",
  text,
  chat: null,
  at,
});

test("a sent input shows until the record has it after where it was sent", () => {
  const inputs = [sent("a", "go on", 100)];
  expect(unseenInputs(inputs, "s1", [input(40, "go on")], [])).toEqual(inputs);
  expect(
    unseenInputs(
      inputs,
      "s1",
      [input(40, "go on"), input(120, "go  on\n")],
      [],
    ),
  ).toEqual([]);
});

test("the same words sent twice need two inputs in the record", () => {
  const inputs = [sent("a", "again", 0), sent("b", "again", 0)];
  expect(
    unseenInputs(inputs, "s1", [input(10, "again")], []).map((i) => i.id),
  ).toEqual(["b"]);
});

test("an input in the queue no longer shows as sent", () => {
  const inputs = [sent("a", "after this", 0)];
  expect(
    unseenInputs(inputs, "s1", [], [{ id: "q1", text: "after this" }]),
  ).toEqual([]);
});

test("a failed input stays, and other sessions' inputs never show", () => {
  const failed = sent("a", "go on", 0, "failed");
  const elsewhere = { ...sent("b", "hi", 0), session_id: "s2" };
  expect(
    unseenInputs([failed, elsewhere], "s1", [input(10, "go on")], []),
  ).toEqual([failed]);
});

test("images alone answer to the first input after them", () => {
  const inputs = [sent("a", "", 50)];
  expect(
    unseenInputs(inputs, "s1", [input(20, ""), input(60, "")], []),
  ).toEqual([]);
});
