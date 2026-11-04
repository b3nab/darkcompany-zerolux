import { expect, test } from "bun:test";
import { agentNames, subagentAt } from "./subagents";
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
