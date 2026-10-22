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
    unseenInputs(
      inputs,
      "s1",
      [],
      [{ id: "q1", text: "after this", changeable: false }],
    ),
  ).toEqual([]);
});

test("a failed input stays until the record shows it arrived after all", () => {
  const failed = sent("a", "go on", 0, "failed");
  const elsewhere = { ...sent("b", "hi", 0), session_id: "s2" };
  expect(unseenInputs([failed, elsewhere], "s1", [], [])).toEqual([failed]);
  // The harness took it after reporting it lost: the session went on with it.
  expect(
    unseenInputs([failed, elsewhere], "s1", [input(10, "go on")], []),
  ).toEqual([]);
  // Written again after the failure: the record's one answers the new input, not the failed.
  const again = sent("c", "go on", 5);
  expect(unseenInputs([failed, again], "s1", [input(10, "go on")], [])).toEqual(
    [failed],
  );
});

test("read from its end again, a record's work shown starts after older inputs", () => {
  const inputs = [sent("a", "go on", 100), sent("b", "then this", 900)];
  // The view reopened at the record's last page, from 800: "go on" is above it.
  expect(
    unseenInputs(inputs, "s1", [], [], 800).map((input) => input.id),
  ).toEqual(["b"]);
  // A failed one still shows, wherever it was sent.
  expect(
    unseenInputs([sent("c", "go on", 100, "failed")], "s1", [], [], 800),
  ).toHaveLength(1);
});

test("images alone answer to the first input after them", () => {
  const inputs = [sent("a", "", 50)];
  expect(
    unseenInputs(inputs, "s1", [input(20, ""), input(60, "")], []),
  ).toEqual([]);
});
