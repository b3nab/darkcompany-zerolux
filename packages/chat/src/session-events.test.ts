import { afterEach, expect, test } from "bun:test";
import type { Approval } from "./chat";
import {
  blockRuns,
  placeApprovals,
  chatTurns,
  currentStep,
  sessionBlocks,
  recordsResync,
  sessionReader,
  toolText,
  turnSummary,
} from "./session-events";
import type { SessionRecord } from "./session-events";
import { toolLine } from "./tool-view";
import type { SessionEvent } from "./session-events";

const at = (event: Record<string, unknown>, offset: number, time?: string) =>
  ({ at: offset, time: time ?? null, ...event }) as SessionEvent;
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

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
  // Keys name the record and the place in it: the call and the text share record 30.
  expect(blocks).toEqual([
    {
      key: "10.0",
      time: null,
      kind: "input",
      text: "Run the tests",
      chat: "c-group",
      at: 10,
    },
    {
      key: "20.0",
      time: null,
      kind: "thinking",
      text: "Tests first.",
      until: null,
    },
    {
      key: "30.0",
      time: null,
      kind: "tool",
      id: "t1",
      name: "Bash",
      input: { command: "bun test" },
      result: { output: "12 pass", error: false, time: null },
    },
    { key: "30.1", time: null, kind: "text", text: "Running them now." },
    // The turn ended before Read gave anything back.
    {
      key: "50.0",
      time: null,
      kind: "tool",
      id: "t2",
      name: "Read",
      input: { path: "a.ts" },
      stopped: true,
    },
    {
      key: "60.0",
      time: null,
      kind: "turn",
      status: "interrupted",
      since: null,
    },
  ]);
  // Tools one after another make one run; anything between them starts another.
  expect(
    blockRuns(blocks).map((r) =>
      r.kind === "tools" ? r.tools.map((t) => t.id) : r.kind,
    ),
  ).toEqual(["input", "thinking", ["t1"], "text", ["t2"], "turn"]);
  const [first, second] = blockRuns([blocks[2]!, blocks[4]!]);
  expect(first).toMatchObject({ kind: "tools", key: "30.0" });
  expect(second).toBeUndefined();
});

test("a harness's own notice is a line of its own, not the owner's input, and starts no turn's time", () => {
  const blocks = sessionBlocks([
    at(
      { type: "notice", text: 'Background command "Build" completed' },
      0,
      "t0",
    ),
    at({ type: "text", text: "It built." }, 10, "t1"),
    at({ type: "turn_ended", status: "completed" }, 20, "t2"),
  ]);
  expect(blocks.map((block) => block.kind)).toEqual(["notice", "text", "turn"]);
  expect(blocks[2]).toMatchObject({ kind: "turn", since: "t1" });
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

test("a chat's turns start at its inputs, end with the turn, and skip other chats' work", () => {
  const events = [
    at({ type: "turn_started" }, 0),
    at({ type: "input", text: "Hi", chat: "c-group", delivery: "d1" }, 10),
    at({ type: "thinking", text: "Plan." }, 20),
    at(
      { type: "tool_call", id: "t1", name: "Bash", input: { command: "ls" } },
      30,
    ),
    at({ type: "turn_ended", status: "completed" }, 40),
    at({ type: "input", text: "Other", chat: "c-dm", delivery: "d2" }, 50),
    at({ type: "text", text: "Not here" }, 60),
    at({ type: "input", text: "Again", chat: "c-group", delivery: "d3" }, 70),
    at({ type: "text", text: "On it" }, 80),
  ];
  const turns = chatTurns(events, "c-group");
  expect(turns.map((t) => [t.delivery, t.ended, t.events.length])).toEqual([
    ["d1", true, 3],
    ["d3", false, 1],
  ]);
  // An input joining a running turn takes it over: the earlier part is done.
  const joined = chatTurns(
    [
      at({ type: "input", text: "A", chat: "c-group", delivery: "d1" }, 0),
      at({ type: "text", text: "On A" }, 10),
      at({ type: "input", text: "B", chat: "c-group", delivery: "d2" }, 20),
    ],
    "c-group",
  );
  expect(joined.map((t) => [t.delivery, t.ended])).toEqual([
    ["d1", true],
    ["d2", false],
  ]);
  const first = sessionBlocks(turns[0]!.events);
  expect(turnSummary(first)).toEqual({
    tools: 1,
    reasoned: true,
    files: 0,
    added: 0,
    removed: 0,
  });
});

/** A kernel serving one record's events, two per page back, all of them forward. */
function fakeRecord(events: SessionEvent[], end: number) {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    const query = new URL(url, "http://kernel.test").searchParams;
    const before = query.get("before");
    if (before !== null) {
      const stop = Math.min(Number(before), end);
      const page = events.filter((e) => e.at < stop).slice(-2);
      const first = events.indexOf(page[0]!) > 0 ? page[0]!.at : 0;
      return Response.json({ events: page, first, next: stop, end });
    }
    const after = Number(query.get("after"));
    return Response.json({
      events: events.filter((e) => e.at >= after),
      first: after,
      next: end,
      end,
    });
  }) as typeof fetch;
  return urls;
}

test("a session is read back from the end to a time, then forward as it grows", async () => {
  const time = (minute: number) => `2026-01-01T10:0${minute}:00Z`;
  const events = [0, 1, 2, 3, 4].map((n) =>
    at({ type: "text", text: `e${n}` }, n * 10, time(n)),
  );
  fakeRecord(events.slice(0, 4), 40);
  let shown: SessionRecord | undefined;
  const reader = sessionReader("s/1", "c-group", (record) => (shown = record));
  // Back to the first event at or before 10:01: two pages.
  await reader.earlier(Date.parse(time(1)));
  expect(shown?.events.map((e) => e.at)).toEqual([0, 10, 20, 30]);
  expect(shown?.first).toBe(0);
  // The record grew by one event.
  fakeRecord(events, 50);
  await reader.grow(50);
  expect(shown?.events.map((e) => e.at)).toEqual([0, 10, 20, 30, 40]);
  expect(shown?.next).toBe(50);
  reader.close();
});

test("after a reconnection a record on screen is read to its end, though its notice was missed", async () => {
  const events = [0, 1, 2].map((n) =>
    at({ type: "text", text: `e${n}` }, n * 10),
  );
  fakeRecord(events.slice(0, 1), 10);
  let shown: SessionRecord | undefined;
  const reader = sessionReader("s-missed", undefined, (r) => (shown = r));
  await reader.earlier();
  expect(shown?.events.map((e) => e.at)).toEqual([0]);
  // The record grew while its notice was lost.
  const urls = fakeRecord(events, 30);
  recordsResync();
  // Reads go one after another: this one waits for the resync's.
  await reader.grow(0);
  expect(shown?.events.map((e) => e.at)).toEqual([0, 10, 20]);
  // A closed reader reads nothing more.
  reader.close();
  urls.length = 0;
  recordsResync();
  await reader.grow(0);
  expect(urls.filter((url) => url.includes("s-missed"))).toEqual([]);
});

test("the reader's first read starts at the end, scoped to the chat", async () => {
  const urls = fakeRecord([at({ type: "text", text: "x" }, 0)], 10);
  const reader = sessionReader("s/1", "c group", () => {});
  await reader.earlier();
  expect(urls).toEqual([
    `/api/sessions/s%2F1/events?before=${Number.MAX_SAFE_INTEGER}&chat=c%20group`,
  ]);
});

test("a native session of the project is read where its harness keeps it, from the end", async () => {
  const urls = fakeRecord([at({ type: "text", text: "x" }, 0)], 10);
  const reader = sessionReader(
    "claude/1",
    undefined,
    () => {},
    undefined,
    true,
  );
  await reader.earlier();
  expect(urls).toEqual([
    `/api/sessions/native/claude%2F1/events?before=${Number.MAX_SAFE_INTEGER}`,
  ]);
  reader.close();
});

test("a kernel that reads only forward asks for an update instead of looping", async () => {
  let calls = 0;
  globalThis.fetch = (async (_url: string) => {
    calls++;
    return Response.json({ events: [], next: 0, end: 0 });
  }) as typeof fetch;
  let shown: SessionRecord | undefined;
  await sessionReader("s1", undefined, (r) => (shown = r)).earlier(0);
  expect(calls).toBe(1);
});

test("an owner's command is a block of its own, opening no turn and no chat's work", () => {
  const t = (s: number) => `2026-01-01T10:00:${String(s).padStart(2, "0")}Z`;
  const events = [
    at({ type: "command", text: "/compact keep the plan" }, 0, t(0)),
    at({ type: "compacted", summary: "The plan" }, 10, t(5)),
    at(
      { type: "input", text: "go", chat: "c-group", delivery: "d1" },
      20,
      t(30),
    ),
    at({ type: "text", text: "done" }, 30, t(40)),
    at({ type: "turn_ended", status: "completed" }, 40, t(42)),
  ];
  const blocks = sessionBlocks(events);
  expect(blocks.map((b) => b.kind)).toEqual([
    "command",
    "compacted",
    "input",
    "text",
    "turn",
  ]);
  expect(blocks[0]).toMatchObject({
    kind: "command",
    text: "/compact keep the plan",
  });
  // The turn's time starts at its input, not at the command or compaction before it.
  expect(blocks.at(-1)).toMatchObject({ kind: "turn", since: t(30) });
  // Nor is the command part of a chat's work.
  const [turn] = chatTurns(
    [
      at({ type: "input", text: "go", chat: "c-group", delivery: "d1" }, 0),
      at({ type: "command", text: "/compact" }, 10),
      at({ type: "text", text: "done" }, 20),
    ],
    "c-group",
  );
  expect(turn?.events.map((e) => e.type)).toEqual(["text"]);
});

test("a turn knows when it began, reasoning how long it took, a summary what it changed", () => {
  const t = (s: number) => `2026-01-01T10:00:${String(s).padStart(2, "0")}Z`;
  const blocks = sessionBlocks([
    at({ type: "turn_started" }, 0, t(0)),
    at({ type: "thinking", text: "**Fixing the path**\nThen test." }, 10, t(1)),
    at(
      {
        type: "tool_call",
        id: "e1",
        name: "Edit",
        input: { file_path: "a.ts", old_string: "a\nb", new_string: "c" },
      },
      20,
      t(5),
    ),
    at({ type: "tool_result", id: "e1", output: "ok", error: false }, 30, t(6)),
    at(
      {
        type: "tool_call",
        id: "w1",
        name: "Write",
        input: { file_path: "b.ts", content: "x\ny" },
      },
      40,
      t(7),
    ),
    at({ type: "tool_result", id: "w1", output: "ok", error: false }, 50, t(8)),
    at({ type: "turn_ended", status: "completed" }, 60, t(30)),
  ]);
  expect(blocks[0]).toMatchObject({ kind: "thinking", until: t(5) });
  expect(blocks.at(-1)).toMatchObject({
    kind: "turn",
    since: t(0),
    time: t(30),
  });
  expect(turnSummary(blocks)).toEqual({
    tools: 2,
    reasoned: true,
    files: 2,
    added: 3,
    removed: 2,
  });
  // The live step names the reasoning by its heading.
  expect(currentStep(blocks.slice(0, 1))).toBe("Fixing the path");
});

test("a read is drawn once when it ends, and not at all when it changed nothing", async () => {
  const time = (minute: number) => `2026-01-01T10:0${minute}:00Z`;
  const events = [0, 1, 2, 3].map((n) =>
    at({ type: "text", text: `e${n}` }, n * 10, time(n)),
  );
  fakeRecord(events, 40);
  let draws = 0;
  const reader = sessionReader("s1", "c-group", () => draws++);
  // Two pages back to 10:00, one drawing.
  await reader.earlier(Date.parse(time(0)));
  expect(draws).toBe(1);
  // A notice for what is already read draws nothing.
  await reader.grow(40);
  expect(draws).toBe(1);
  // Nor does a page that only moves on: another chat's work, filtered out.
  fakeRecord(events, 60);
  await reader.grow(60);
  expect(draws).toBe(1);
  reader.close();
});

test("subagents and requests stand on their own; requests sit where they were made", () => {
  const t = (s: number) => `2026-01-01T10:00:${String(s).padStart(2, "0")}Z`;
  const blocks = sessionBlocks([
    at(
      { type: "tool_call", id: "r1", name: "Read", input: { file_path: "a" } },
      0,
      t(1),
    ),
    at(
      {
        type: "tool_call",
        id: "s1",
        name: "Agent",
        input: { description: "Look" },
      },
      10,
      t(2),
    ),
    at(
      { type: "tool_call", id: "b1", name: "Bash", input: { command: "rm x" } },
      20,
      t(5),
    ),
    at({ type: "text", text: "Done" }, 30, t(9)),
  ]);
  const approval = (id: string, created: string) =>
    ({ id, created_at: Date.parse(created) }) as Approval;
  const items = placeApprovals(blocks, [
    approval("late", t(20)),
    approval("ask", t(6)),
  ]);
  expect(items.map((i) => (i.kind === "approval" ? i.key : i.key))).toEqual([
    "0.0",
    "10.0",
    "20.0",
    "ask",
    "30.0",
    "late",
  ]);
  expect(
    blockRuns(items).map((r) =>
      r.kind === "tools" ? r.tools.map((x) => x.name).join("+") : r.kind,
    ),
  ).toEqual(["Read", "tool", "Bash", "approval", "text", "approval"]);
});
