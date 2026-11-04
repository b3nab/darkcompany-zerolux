import { expect, test } from "bun:test";
import type { ToolBlock } from "./session-events";
import {
  changeCount,
  diffLines,
  exploration,
  exploredPhrase,
  isSubagent,
  latestPlan,
  plainLine,
  toolItems,
  toolOutcome,
  toolPhrase,
  toolState,
  toolView,
  toolsPhrase,
} from "./tool-view";

test("a command reads the same from Claude Code, pi and a Codex script", () => {
  expect(
    toolView("Bash", { command: "bun test", description: "Run the tests" }),
  ).toEqual({
    kind: "command",
    commands: ["bun test"],
    description: "Run the tests",
  });
  expect(toolView("bash", { command: "ls" })).toEqual({
    kind: "command",
    commands: ["ls"],
    description: undefined,
  });
  const script =
    'text(await tools.exec_command({cmd:"pwd","max_output_tokens":1000}));\n' +
    'text(await tools.exec_command({cmd:"rg \\"todo\\" src"}));\n';
  expect(toolView("exec", script)).toEqual({
    kind: "command",
    commands: ["pwd", 'rg "todo" src'],
  });
  // A script without commands is shown as it is.
  expect(toolView("exec", "await tools.wait(1)")).toEqual({
    kind: "command",
    commands: [],
    script: "await tools.wait(1)",
  });
});

test("files, searches, the web, subagents and plans each get their own view", () => {
  expect(
    toolView("Read", { file_path: "src/a.ts", offset: 10, limit: 20 }),
  ).toMatchObject({ kind: "read", path: "src/a.ts" });
  expect(toolView("read", { path: "a.md" })).toEqual({
    kind: "read",
    path: "a.md",
    lines: undefined,
  });
  expect(
    toolView("edit", {
      path: "a.ts",
      edits: [{ oldText: "one", newText: "two\nthree" }],
    }),
  ).toEqual({
    kind: "edit",
    path: "a.ts",
    changes: [{ before: "one", after: "two\nthree" }],
  });
  const edit = toolView("Edit", {
    file_path: "a.ts",
    old_string: "a\nb",
    new_string: "c",
  });
  expect(edit.kind === "edit" && changeCount(edit.changes)).toEqual({
    added: 1,
    removed: 2,
  });
  expect(
    toolView(
      "apply_patch",
      "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: src/b.ts\n+c\n*** End Patch",
    ),
  ).toMatchObject({ kind: "patch", files: ["src/a.ts", "src/b.ts"] });
  expect(toolView("Grep", { pattern: "TODO", path: "src" })).toEqual({
    kind: "search",
    pattern: "TODO",
    path: "src",
  });
  expect(
    toolView("WebFetch", { url: "https://example.com", prompt: "?" }),
  ).toEqual({ kind: "web", url: "https://example.com" });
  expect(
    toolView("Agent", { description: "Find the bug", prompt: "Look at…" }),
  ).toEqual({
    kind: "agent",
    action: "start",
    title: "Find the bug",
    prompt: "Look at…",
  });
  expect(
    toolView("TodoWrite", {
      todos: [
        { content: "Read", status: "completed" },
        { content: "Fix", status: "in_progress" },
        { content: "Test", status: "pending" },
      ],
    }),
  ).toEqual({
    kind: "plan",
    steps: [
      { text: "Read", status: "done" },
      { text: "Fix", status: "active" },
      { text: "Test", status: "pending" },
    ],
  });
});

test("ZeroLux's own tools read as interactions, other MCP tools by server and tool", () => {
  expect(
    toolView("mcp__zerolux__send", { chat: "c-group", text: "Done." }),
  ).toEqual({
    kind: "zerolux",
    action: "send",
    chat: "c-group",
    text: "Done.",
    title: undefined,
  });
  expect(
    toolView("zerolux_thread", { chat: "c-group", on: "m1", title: "Plan" }),
  ).toMatchObject({ kind: "zerolux", action: "thread", title: "Plan" });
  expect(toolView("zerolux_close_thread", { chat: "c-thread" })).toMatchObject({
    kind: "zerolux",
    action: "close",
  });
  expect(toolView("mcp__docs__search", { query: "x" })).toEqual({
    kind: "mcp",
    server: "docs",
    tool: "search",
    args: { query: "x" },
  });
  expect(toolView("ToolSearch", { query: "x" })).toEqual({
    kind: "other",
    name: "ToolSearch",
    args: { query: "x" },
  });
});

test("results read as text and images from every harness's blocks", () => {
  const plain = { images: [], exit: undefined, denied: false, timedOut: false };
  expect(toolOutcome("12 pass\n")).toEqual({ ...plain, text: "12 pass" });
  expect(
    toolOutcome([
      { type: "text", text: "Saved" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAA" },
      },
      { type: "image", data: "BBB", mimeType: "image/jpeg" },
    ]),
  ).toEqual({
    ...plain,
    text: "Saved",
    images: ["data:image/png;base64,AAA", "data:image/jpeg;base64,BBB"],
  });
  expect(toolOutcome({ ok: true })).toEqual({
    ...plain,
    text: '{\n  "ok": true\n}',
  });
  // Codex reports each command as a JSON chunk: what it printed and its exit code.
  expect(
    toolOutcome([
      { type: "input_text", text: "Script completed\nOutput:\n" },
      {
        type: "input_text",
        text: '{"exit_code":0,"output":"/home/owner\\n"}',
      },
      {
        type: "input_text",
        text: '{"i":1,"value":{"exit_code":1,"output":"no such file\\n"}}',
      },
    ]),
  ).toEqual({ ...plain, text: "/home/owner\n\nno such file", exit: 1 });
  expect(
    toolOutcome(
      "The user doesn't want to proceed with this tool use. The tool use was rejected.",
    ).denied,
  ).toBe(true);
  expect(
    toolOutcome("Permission for this action was denied by a check.").denied,
  ).toBe(true);
  expect(toolOutcome("Command timed out after 2m 0.0s").timedOut).toBe(true);
  // Each harness reports a command's end in its own words; they become fields.
  expect(toolOutcome("Exit code 2\nerror: no tests")).toMatchObject({
    text: "error: no tests",
    exit: 2,
  });
  expect(toolOutcome("1 fail\n\nCommand exited with code 1")).toMatchObject({
    text: "1 fail",
    exit: 1,
  });
  expect(
    toolOutcome([
      { type: "text", text: "partial\n\nCommand timed out after 10 seconds" },
    ]),
  ).toMatchObject({ text: "partial", timedOut: true });
  expect(toolOutcome([{ type: "text", text: "(no output)" }]).text).toBe("");
  expect(
    toolOutcome([
      {
        type: "input_text",
        text: "Script completed\nWall time 1.8 seconds\nOutput:\n",
      },
      {
        type: "input_text",
        text: "Result \ue200cite\ue202turn1search0\ue201 found",
      },
    ]).text,
  ).toBe("Result  found");
});

test("a change reads line by line: what stayed, what went, what came", () => {
  expect(diffLines("a\nb\nc", "a\nB\nc\nd")).toEqual([
    { kind: "same", text: "a" },
    { kind: "removed", text: "b" },
    { kind: "added", text: "B" },
    { kind: "same", text: "c" },
    { kind: "added", text: "d" },
  ]);
  expect(diffLines("", "new")).toEqual([{ kind: "added", text: "new" }]);
});

test("a preview line drops Markdown marks and keeps the words", () => {
  expect(
    plainLine(
      "\n## Found it: the `fixture` used a **real** path, see [docs](https://x.test).\nMore",
    ),
  ).toBe("Found it: the fixture used a real path, see docs.");
  expect(plainLine("- *one* item with snake_case_name")).toBe(
    "one item with snake_case_name",
  );
});

const call = (name: string, input: unknown, more: object = {}) =>
  ({
    key: `${name}.${JSON.stringify(input)}`,
    time: null,
    kind: "tool",
    id: name,
    name,
    input,
    result: { output: "ok", error: false, time: null },
    ...more,
  }) as ToolBlock;

test("only looking around folds: reads, lists and searches in a row become one line", () => {
  expect(exploration(toolView("Read", { file_path: "a.ts" }))).toBe("read");
  expect(
    exploration(toolView("bash", { command: "cd src && rg todo | head -5" })),
  ).toBe("search");
  expect(exploration(toolView("Bash", { command: "ls -la" }))).toBe("list");
  expect(
    exploration(toolView("Bash", { command: "sed -i s/a/b/ x" })),
  ).toBeUndefined();
  expect(
    exploration(toolView("Bash", { command: "bun test" })),
  ).toBeUndefined();
  const tools = [
    call("Read", { file_path: "a.ts" }),
    call("Grep", { pattern: "todo" }),
    call("Read", { file_path: "a.ts" }),
    call("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }),
    call("Read", { file_path: "b.ts" }),
  ];
  const items = toolItems(tools);
  expect(
    items.map((item) =>
      item.kind === "explored" ? item.tools.length : item.name,
    ),
  ).toEqual([3, "Edit", "Read"]);
  const group = items[0];
  expect(group?.kind === "explored" && exploredPhrase(group.tools)).toEqual({
    verb: "Explored",
    subject: "1 file, 1 search",
  });
});

test("a tool's state: refused, failed, or a search that found nothing and is done", () => {
  const state = (tool: ToolBlock) =>
    toolState(
      tool,
      toolView(tool.name, tool.input),
      tool.result && toolOutcome(tool.result.output),
    );
  expect(state(call("Bash", { command: "ls" }, { result: undefined }))).toBe(
    "running",
  );
  expect(
    state(
      call("Bash", { command: "ls" }, { result: undefined, stopped: true }),
    ),
  ).toBe("stopped");
  const chunk = (exit: number) => [
    { type: "input_text", text: `{"exit_code":${exit},"output":""}` },
  ];
  const ran = (command: string, exit: number) =>
    call(
      "exec",
      `text(await tools.exec_command({cmd:${JSON.stringify(command)}}));`,
      {
        result: { output: chunk(exit), error: false, time: null },
      },
    );
  expect(state(ran("rg nothing", 1))).toBe("done");
  expect(state(ran("bun test", 1))).toBe("error");
  expect(
    state(
      call(
        "Bash",
        { command: "rm x" },
        {
          result: {
            output: "The user doesn't want to proceed with this tool use.",
            error: true,
            time: null,
          },
        },
      ),
    ),
  ).toBe("denied");
});

test("a run of tools in a few words, and the plan as it stands now", () => {
  expect(
    toolsPhrase([
      call("Bash", { command: "bun test" }),
      call("Bash", { command: "ls" }),
      call("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }),
      call("Write", { file_path: "a.ts", content: "c" }),
      call("Read", { file_path: "b.ts" }),
      call("mcp__zerolux__send", { chat: "c", text: "Done" }),
    ]),
  ).toBe("Ran 2 commands · edited 1 file · read 1 file · 1 ZeroLux message");
  expect(
    toolsPhrase([
      call("mcp__browser__navigate", { url: "http://127.0.0.1/" }),
      call("mcp__browser__screenshot", {}),
      call("TodoWrite", { todos: [] }),
      call("ToolSearch", { query: "browser" }),
    ]),
  ).toBe("Called 2 MCP tools · updated the plan · used 1 tool");
  const plan = (status: string) =>
    call("TodoWrite", { todos: [{ content: "Fix", status }] });
  expect(
    latestPlan([
      { key: "1", time: null, kind: "text", text: "Starting" },
      plan("in_progress"),
      { key: "2", time: null, kind: "text", text: "More" },
      { ...plan("completed"), key: "3" },
    ]),
  ).toEqual([{ text: "Fix", status: "done" }]);
  expect(latestPlan([])).toBeUndefined();
});

const sealedText = `gAAAAAB${"x".repeat(80)}==`;

test("agents' calls on each other name whom they act on, and a sealed message never shows", () => {
  const views = [
    toolView("spawn_agent", { task_name: "logs", message: sealedText }),
    toolView("send_message", { target: "/root/logs", message: sealedText }),
    toolView("followup_task", { target: "logs", encrypted: true }),
    toolView("send_input", { target: "a-1", message: "Check the logs" }),
    toolView("SendMessage", {
      to: "lead",
      summary: "Report",
      message: "Done.",
    }),
    toolView("interrupt_agent", { target: "/root/logs" }),
    toolView("close_agent", { target: "a-1" }),
    toolView("resume_agent", { id: "a-1" }),
    toolView("TaskStop", { task_id: "b-9" }),
    toolView("wait_agent", { timeout_ms: 60000 }),
    toolView("list_agents", { path_prefix: "/root" }),
    toolView("SubagentHandback", { message: "The note is written." }),
  ];
  expect(
    views.map(
      (view) =>
        view.kind === "agent" && [
          view.action,
          view.target,
          view.encrypted ?? false,
          Boolean(view.prompt),
        ],
    ),
  ).toEqual([
    ["start", undefined, true, false],
    ["message", "/root/logs", true, false],
    ["task", "logs", true, false],
    ["message", "a-1", false, true],
    ["message", "lead", false, true],
    ["interrupt", "/root/logs", false, false],
    ["close", "a-1", false, false],
    ["resume", "a-1", false, false],
    ["stop", "b-9", false, false],
    ["wait", undefined, false, false],
    ["list", "/root", false, false],
    ["handback", undefined, false, true],
  ]);
  // The agent a call names reads by its name; sealed words are nowhere.
  const names: Record<string, string> = {
    "/root/logs": "Aspen",
    logs: "Aspen",
  };
  for (const view of views) {
    const phrase = toolPhrase(
      view,
      false,
      undefined,
      (target) => names[target],
    );
    expect(JSON.stringify([view, phrase])).not.toContain(sealedText);
    if (view.kind === "agent" && view.target && names[view.target])
      expect(phrase.subject).toBe("Aspen");
  }
  // Only a started agent is drawn as a subagent; the other calls are tools in a row.
  expect(isSubagent(call("spawn_agent", { task_name: "logs" }))).toBe(true);
  expect(isSubagent(call("Agent", { description: "Find it" }))).toBe(true);
  expect(isSubagent(call("send_message", { target: "/root" }))).toBe(false);
  expect(isSubagent(call("SendMessage", { to: "lead", message: "Hi" }))).toBe(
    false,
  );
});

test("the tools agents call most read in words, never as their raw name, arguments or sealed text", () => {
  const frequent: [string, unknown][] = [
    [
      "mcp__claude-in-chrome__browser_batch",
      { actions: [{ name: "computer", input: { action: "screenshot" } }] },
    ],
    [
      "mcp__claude-in-chrome__javascript_tool",
      { action: "javascript_exec", text: "document.title", tabId: 1 },
    ],
    ["mcp__claude-in-chrome__computer", { action: "left_click", tabId: 1 }],
    ["mcp__claude-in-chrome__navigate", { url: "https://example.com/a" }],
    ["mcp__claude-in-chrome__tabs_context_mcp", { createIfEmpty: true }],
    ["mcp__claude-in-chrome__find", { query: "Send", tabId: 1 }],
    ["mcp__claude-in-chrome__tabs_close_mcp", { tabId: 1 }],
    [
      "mcp__deepwiki__ask_wiki_question",
      { repoName: "aspen/birch", question: "Which version?" },
    ],
    ["ToolSearch", { query: "select:WebFetch", max_results: 1 }],
    ["sleep", { duration_ms: 45000 }],
    ["js", { code: "1 + 1", title: "Add" }],
    ["request_user_input_async", { questions: [{ title: "Which?" }] }],
    ["zerolux_background_run", { command: "bun test" }],
    ["zerolux_background_read", { id: "b-1" }],
    ["mcp__zerolux__session_start", { harness: "pi", prompt: "Fix it" }],
    ["send_message", { target: "/root", message: sealedText }],
    ["followup_task", { target: "/root/logs", message: sealedText }],
    ["wait_agent", { timeout_ms: 30000 }],
    ["list_agents", {}],
    ["SendMessage", { to: "lead", message: "Done." }],
    ["SubagentHandback", { message: "Done." }],
    ["TaskStop", { task_id: "b-9" }],
  ];
  for (const [name, args] of frequent) {
    const { verb, subject } = toolPhrase(toolView(name, args), false);
    const bare = name.replace(/^mcp__.+?__|^zerolux_/, "");
    expect([bare, bare.replaceAll("_", " ")]).not.toContain(verb);
    expect(`${verb} ${subject ?? ""}`).not.toMatch(/[{}]|gAAAAA/);
  }
});
