import { expect, test } from "bun:test";
import { API, operations, stateFor, status } from "./tracker.ts";

const STATES = [
  { id: "s-backlog", name: "Backlog", type: "backlog" },
  { id: "s-todo", name: "Todo", type: "unstarted" },
  { id: "s-doing", name: "In Progress", type: "started" },
  { id: "s-review", name: "In Review", type: "started" },
  { id: "s-done", name: "Done", type: "completed" },
  { id: "s-cancel", name: "Canceled", type: "canceled" },
];

test("Linear's states and ZeroLux's map both ways", () => {
  expect(status({ name: "In Review", type: "started" })).toBe("in_review");
  expect(status({ name: "Triage", type: "triage" })).toBe("backlog");
  expect(stateFor(STATES, "in_review")).toBe("s-review");
  expect(stateFor(STATES, "in_progress")).toBe("s-doing");
  expect(stateFor(STATES, "done")).toBe("s-done");
});

test("a team's issues are read, created, changed and commented on", async () => {
  const asked: { query: string; variables: Record<string, any> }[] = [];
  const call = async (url: string, init: RequestInit = {}) => {
    expect(url).toBe(API);
    expect(new Headers(init.headers).get("authorization")).toBe("lin_key");
    const body = JSON.parse(String(init.body));
    asked.push(body);
    const q: string = body.query;
    if (q.includes("teams"))
      return Response.json({
        data: { teams: { nodes: [{ id: "T", name: "Eng" }] } },
      });
    if (q.includes("states"))
      return Response.json({ data: { team: { states: { nodes: STATES } } } });
    if (q.includes("issues"))
      return Response.json({
        data: {
          team: {
            issues: {
              nodes: [
                {
                  id: "I1",
                  identifier: "ENG-1",
                  title: "CI",
                  description: null,
                  priority: 2,
                  dueDate: "2026-11-01",
                  url: "https://linear.app/x/ENG-1",
                  state: { name: "In Review", type: "started" },
                  labels: { nodes: [{ name: "ci" }] },
                },
              ],
            },
          },
        },
      });
    if (q.includes("issueCreate"))
      return Response.json({
        data: {
          issueCreate: {
            issue: { id: "I2", url: "https://linear.app/x/ENG-2" },
          },
        },
      });
    if (q.includes("issueUpdate") || q.includes("commentCreate"))
      return Response.json({ data: { ok: { success: true } } });
    return Response.json({ errors: [{ message: "Unknown" }] });
  };
  const linear = operations(() => "lin_key", call);
  expect(await linear.projects()).toEqual({
    projects: [{ remote_id: "T", name: "Eng" }],
  });
  expect((await linear.tasks({ remote_id: "T" })).tasks[0]).toEqual({
    remote_id: "I1",
    title: "CI",
    description: "",
    status: "in_review",
    priority: "high",
    labels: ["ci"],
    due: "2026-11-01",
    url: "https://linear.app/x/ENG-1",
  });
  expect(
    await linear.create({
      remote_id: "T",
      task: { title: "Ship", status: "todo", priority: "urgent" },
    }),
  ).toEqual({ remote_id: "I2", url: "https://linear.app/x/ENG-2" });
  expect(asked.at(-1)!.variables.input).toEqual({
    teamId: "T",
    title: "Ship",
    priority: 1,
    stateId: "s-todo",
  });
  await linear.update({
    remote_id: "T",
    task_id: "I2",
    changes: { status: "done" },
  });
  expect(asked.at(-1)!.variables).toEqual({
    id: "I2",
    input: { stateId: "s-done" },
  });
  await linear.comment({ task_id: "I2", text: "Shipped" });
  expect(asked.at(-1)!.variables.input).toEqual({
    issueId: "I2",
    body: "Shipped",
  });
});

test("a refusal says why, and without a key it says what to give", async () => {
  const refusing = operations(
    () => "k",
    async () =>
      Response.json(
        { errors: [{ message: "Authentication required" }] },
        { status: 401 },
      ),
  );
  await expect(refusing.projects()).rejects.toThrow("Authentication required");
  await expect(operations(() => "").projects()).rejects.toThrow("API key");
});
