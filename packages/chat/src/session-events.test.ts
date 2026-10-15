import { expect, test } from "bun:test";
import { sessionBlocks, toolLine, toolText } from "./session-events";
import type { SessionEvent } from "./session-events";

const at = (event: Record<string, unknown>, offset: number) =>
  ({ at: offset, time: null, ...event }) as SessionEvent;

test("a session's events become blocks: a tool joins its result, a turn's start draws nothing", () => {
  const blocks = sessionBlocks([
    at({ type: "turn_started" }, 0),
    at(
      { type: "input", text: "Run the tests", chat: "c-group", delivery: "d1" },
      10,
    ),
    at({ type: "thinking", text: "Tests first." }, 20),
    at(
      {
        type: "tool_call",
        id: "t1",
        name: "Bash",
        input: { command: "bun test" },
      },
      30,
    ),
    at({ type: "text", text: "Running them now." }, 30),
    at({ type: "tool_result", id: "t1", output: "12 pass", error: false }, 40),
    at(
      { type: "tool_call", id: "t2", name: "Read", input: { path: "a.ts" } },
      50,
    ),
    at({ type: "turn_ended", status: "interrupted" }, 60),
  ]);
  expect(blocks).toEqual([
    { kind: "input", text: "Run the tests", chat: "c-group" },
    { kind: "thinking", text: "Tests first." },
    {
      kind: "tool",
      id: "t1",
      name: "Bash",
      input: { command: "bun test" },
      result: { output: "12 pass", error: false },
    },
    { kind: "text", text: "Running them now." },
    { kind: "tool", id: "t2", name: "Read", input: { path: "a.ts" } },
    { kind: "turn", status: "interrupted" },
  ]);
});

test("a tool reads as one line of what it was given, and its values as text", () => {
  expect(toolLine({ command: "bun test", description: "Run" })).toBe(
    "bun test",
  );
  expect(toolLine({ file_path: "src/a.ts", limit: 20 })).toBe("src/a.ts");
  expect(toolLine({ limit: 20, note: "first text" })).toBe("first text");
  expect(toolLine("plain")).toBe("");
  expect(toolText("12 pass")).toBe("12 pass");
  expect(toolText({ ok: true })).toBe('{\n  "ok": true\n}');
});
