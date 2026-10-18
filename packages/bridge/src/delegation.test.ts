import { expect, test } from "bun:test";
import {
  readSession,
  sendSession,
  startSession,
  stopSession,
} from "./delegation.ts";

function kernel() {
  const calls: { path: string; body?: unknown }[] = [];
  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    calls.push({ path, body });
    if (path === "/sessions")
      return { session: { id: "child", title: "Codex" } } as T;
    if (path === "/sessions/child")
      return {
        session: {
          id: "child",
          title: "Codex",
          harness: "codex",
          status: "connected",
          activity: "idle",
          last_turn: "completed",
          summary: "Tests pass",
        },
      } as T;
    if (path.startsWith("/sessions/child/events"))
      return {
        events: [
          { type: "input", text: "earlier" },
          { type: "text", text: "old answer" },
          { type: "input", text: "run the tests" },
          { type: "tool_call", name: "shell" },
          { type: "text", text: "All 12 pass." },
          { type: "text", text: "Nothing else to do." },
        ],
      } as T;
    return {} as T;
  };
  return { calls, call };
}

test("a delegated session starts with its work, answers, takes more words and stops", async () => {
  const k = kernel();
  const started = await startSession(k.call, {
    harness: "codex",
    workspace: "/work",
    prompt: "run the tests",
    model: "fixture-model",
  });
  expect(started.id).toBe("child");
  expect(k.calls.slice(0, 2)).toEqual([
    {
      path: "/sessions",
      body: { harness: "codex", workspace: "/work", model: "fixture-model" },
    },
    { path: "/sessions/child/input", body: { text: "run the tests" } },
  ]);
  expect(await readSession(k.call, "child")).toEqual({
    id: "child",
    title: "Codex",
    harness: "codex",
    status: "connected",
    working: false,
    last_turn: "completed",
    answer: "All 12 pass.\n\nNothing else to do.",
  });
  await sendSession(k.call, "child", "also lint", "queue");
  await stopSession(k.call, "child");
  expect(k.calls.slice(-2)).toEqual([
    {
      path: "/sessions/child/input",
      body: { text: "also lint", mode: "queue" },
    },
    { path: "/sessions/child/stop", body: {} },
  ]);
});
