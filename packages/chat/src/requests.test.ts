import { expect, test } from "bun:test";
import type { Approval } from "./chat";
import { permissionShown } from "./requests";

const asking = (details: Record<string, unknown>): Approval => ({
  id: "a1",
  actor_id: "aspen",
  session_id: "s1",
  conversation_id: null,
  delivery_id: null,
  kind: "permission",
  summary: "An agent asks",
  details,
  status: "pending",
  decision: null,
  scope: null,
  reason: null,
  answer: null,
  native_request_id: "n1",
  created_at: 0,
});

test("a permission reads as what it would do, for each harness", () => {
  expect(
    permissionShown(asking({ tool: "Bash", input: { command: "bun test" } })),
  ).toEqual({ wants: "wants to run", command: "bun test", text: undefined });
  expect(
    permissionShown(
      asking({
        tool: "Edit",
        input: { file_path: "src/a.ts", old_string: "a", new_string: "b\nc" },
      }),
    ),
  ).toEqual({
    wants: "wants to edit a file",
    files: [{ path: "src/a.ts", added: 2, removed: 1 }],
  });
  expect(
    permissionShown(
      asking({
        method: "item/commandExecution/requestApproval",
        params: { reason: "Needs the network" },
        item: { command: "bun install", cwd: "/work" },
      }),
    ),
  ).toEqual({
    wants: "wants to run",
    command: "bun install",
    cwd: "/work",
    text: "Needs the network",
  });
  expect(
    permissionShown(
      asking({
        method: "item/fileChange/requestApproval",
        params: {},
        item: {
          changes: [
            { path: "a.md", diff: "--- a\n+++ b\n+one\n+two\n-three" },
            { path: "b.md", diff: "+x" },
          ],
        },
      }),
    ).files,
  ).toEqual([
    { path: "a.md", added: 2, removed: 1 },
    { path: "b.md", added: 1, removed: 0 },
  ]);
  expect(
    permissionShown(
      asking({ method: "confirm", title: "Deploy", message: "Now?" }),
    ),
  ).toEqual({ wants: "asks you to confirm", text: "Deploy: Now?" });
  expect(permissionShown(asking({ other: true })).text).toBe("An agent asks");
});
