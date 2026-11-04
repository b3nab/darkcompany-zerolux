import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionBlock } from "@zerolux/chat";
import { SessionBlocks } from "@/components/session-blocks";
import { SessionAgents } from "@/components/tool-call";

const sealed = `gAAAAAB${"x".repeat(80)}==`;
const agents = {
  name: (target: string) =>
    target === "/root"
      ? "aspen"
      : target === "/root/logs"
        ? "birch"
        : undefined,
  open: () => undefined,
};
const tool = (id: string, name: string, input: unknown): SessionBlock => ({
  key: `${id}.0`,
  time: null,
  kind: "tool",
  id,
  name,
  input,
  result: { output: "", error: false, time: null, at: 1 },
});
const message = (
  key: string,
  purpose: string,
  text: string | null,
): SessionBlock => ({
  key,
  time: null,
  kind: "agent_message",
  from: "/root",
  to: "/root/logs",
  purpose,
  text,
});

test("agents' calls and messages to each other name them, and a sealed message never shows", () => {
  const shown = renderToStaticMarkup(
    <SessionAgents.Provider value={agents}>
      <SessionBlocks
        blocks={[
          tool("t1", "send_message", {
            target: "/root/logs",
            message: null,
            encrypted: true,
          }),
          tool("t2", "followup_task", {
            target: "/root/logs",
            message: sealed,
          }),
          message("3", "new_task", null),
          message("4", "message", "Check the logs first."),
        ]}
      />
    </SessionAgents.Provider>,
  );
  // Each names the subagent by its name, never by a call's raw input.
  expect(shown).toContain("birch");
  expect(shown).toContain("aspen");
  expect(shown).not.toContain("send_message");
  expect(shown).not.toContain("{");
  expect(shown).not.toContain(sealed);
  // A message in the clear reads as it was written.
  expect(shown).toContain("Check the logs first.");
});
