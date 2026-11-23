import { expect, test } from "bun:test";
import { StreamHandoff } from "./stream-handoff";
import type { SessionEvent } from "./session-events";

const text = (at: number, text: string): SessionEvent => ({
  type: "text",
  at,
  time: null,
  text,
});
test("finished output survives clear, an empty HTTP snapshot and an unrelated record until its own row arrives", () => {
  const h = new StreamHandoff();
  const seen = [text(1, "old")];
  h.observe(seen, []);
  h.change({ type: "append", item: "m", kind: "text", text: "fixture" });
  h.change({ type: "done", item: "m" });
  h.change({ type: "clear" });
  h.snapshot([]);
  const unrelated = [...seen, text(20, "different")];
  const before = h.project(unrelated);
  expect(before.rows.map((i) => i.id)).toEqual(["m"]);
  h.observe(unrelated, before.accepted);
  const page = [...unrelated, text(32, "fixture")];
  const next = h.project(page);
  expect(next.rows).toHaveLength(0);
  expect(next.accepted).toHaveLength(1);
  h.observe(page, next.accepted);
  expect(h.project(page).rows).toHaveLength(0);
});
test("an earlier identical reply cannot take a new stream and a recorded tool result must match the call", () => {
  const h = new StreamHandoff();
  const older = [text(10, "same")];
  h.observe(older, []);
  for (const id of ["x", "y"])
    h.change({ type: "set", item: id, kind: "text", text: "same" });
  h.change({ type: "set", item: "cmd", kind: "output", text: "out" });
  const p = h.project([
    ...older,
    text(20, "same"),
    {
      type: "tool_result",
      id: "other",
      output: "out",
      error: false,
      at: 25,
      time: null,
    },
  ]);
  expect(p.rows.map((i) => i.id)).toEqual(["y", "cmd"]);
});
