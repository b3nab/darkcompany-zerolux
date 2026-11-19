import { expect, test } from "bun:test";
import type { ToolBlock } from "./session-events";
import { agentNames, subagentAt, subagentStarted } from "./subagents";
import type { Subagent } from "./subagents";

const subagent = (id: string, name: string | null, path?: string) =>
  ({
    id,
    name,
    description: null,
    kind: null,
    tool_call_id: null,
    parent_id: null,
    updated_at: null,
    path,
  }) satisfies Subagent;

test("a call names a subagent by its path, a path under the caller's, its name or its ID", () => {
  const all = [
    subagent("a-1", "Aspen", "/root/logs"),
    subagent("a-2", "Birch", "/root/logs/tests"),
    subagent("a-3", "Cedar"),
  ];
  expect(subagentAt(all, "/root/logs")?.id).toBe("a-1");
  expect(subagentAt(all, "tests")?.id).toBe("a-2");
  expect(subagentAt(all, "Cedar")?.id).toBe("a-3");
  expect(subagentAt(all, "a-3")?.id).toBe("a-3");
  expect(subagentAt(all, "/root/gone")).toBeUndefined();
  // Whom a tool names reads by name; one not found keeps what the tool said.
  const names = agentNames(all);
  expect(names("/root/logs/tests")).toBe("Birch");
  expect(names("/root")).toBeUndefined();
});

test("the subagent a call started: by the call where the harness records it, else by the name it was given", () => {
  const call = (id: string, name: string, input: unknown, output?: string) =>
    ({
      key: id,
      time: null,
      kind: "tool",
      id,
      name,
      input,
      ...(output === undefined
        ? {}
        : { result: { output, error: false, time: null } }),
    }) as ToolBlock;
  const all = [
    { ...subagent("a-1", "Aspen"), tool_call_id: "toolu_1" },
    subagent("a-2", "Birch", "/root/logs"),
    subagent("a-3", "Cedar", "/root/logs/tests"),
  ];
  // Claude Code records the call that started it.
  expect(subagentStarted(all, call("toolu_1", "Task", {}))?.id).toBe("a-1");
  // Codex answers the path it gave the agent; while it starts, the call names it.
  const spawned = { task_name: "tests", message: "Run them" };
  expect(
    subagentStarted(
      all,
      call("c1", "spawn_agent", spawned, '{"task_name":"/root/logs/tests"}'),
    )?.id,
  ).toBe("a-3");
  expect(subagentStarted(all, call("c2", "spawn_agent", spawned))?.id).toBe(
    "a-3",
  );
  // A call that starts none, and one whose agent is not there, open nothing.
  expect(subagentStarted(all, call("c3", "wait_agent", {}))).toBeUndefined();
  expect(
    subagentStarted(
      all,
      call("c4", "spawn_agent", {}, '{"task_name":"/root/gone"}'),
    ),
  ).toBeUndefined();
});
