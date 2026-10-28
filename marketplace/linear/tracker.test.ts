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

test("Linear's states and Projects' map both ways", () => {
  expect(status({ name: "In Review", type: "started" })).toBe("in_review");
  expect(status({ name: "Triage", type: "triage" })).toBe("backlog");
  expect(stateFor(STATES, "in_review")).toBe("s-review");
  expect(stateFor(STATES, "in_progress")).toBe("s-doing");
  expect(stateFor(STATES, "done")).toBe("s-done");
});

const ISSUE = {
  id: "I1",
  identifier: "ENG-1",
  title: "CI",
  description: null,
  priority: 2,
  dueDate: "2026-11-01",
  url: "https://linear.app/x/ENG-1",
  updatedAt: "2026-10-22T10:00:00Z",
  state: { name: "In Review", type: "started" },
  labels: { nodes: [{ name: "ci" }] },
  assignee: { displayName: "ben" },
};

test("a workspace's issues are read live, created, changed, commented on and deleted there", async () => {
  const asked: { query: string; variables: Record<string, any> }[] = [];
  const call = async (url: string, init: RequestInit = {}) => {
    expect(url).toBe(API);
    expect(new Headers(init.headers).get("authorization")).toBe("lin_key");
    const body = JSON.parse(String(init.body));
    asked.push(body);
    const q: string = body.query;
    if (q.includes("viewer"))
      return Response.json({ data: { viewer: { email: "ben@example.com" } } });
    if (q.includes("teams"))
      return Response.json({
        data: { teams: { nodes: [{ id: "T", name: "Eng", key: "ENG" }] } },
      });
    if (q.includes("states"))
      return Response.json({ data: { team: { states: { nodes: STATES } } } });
    if (q.includes("labels { nodes { id name } }"))
      return Response.json({
        data: { team: { labels: { nodes: [{ id: "L1", name: "ci" }] } } },
      });
    if (q.includes("issues(first"))
      return Response.json({
        data: {
          team: {
            issues: {
              nodes: [ISSUE],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    if (q.includes("issue(id"))
      return body.variables.id === "GONE"
        ? Response.json({ errors: [{ message: "Entity not found: Issue" }] })
        : Response.json({
            data: {
              issue: {
                ...ISSUE,
                comments: {
                  nodes: [
                    {
                      id: "C1",
                      body: "Looks good",
                      createdAt: "2026-10-22T09:00:00Z",
                      user: { name: "Ana" },
                    },
                  ],
                },
              },
            },
          });
    if (q.includes("issueCreate"))
      return Response.json({
        data: {
          issueCreate: { issue: { ...ISSUE, id: "I2", identifier: "ENG-2" } },
        },
      });
    if (q.includes("issueUpdate"))
      return Response.json({ data: { issueUpdate: { issue: ISSUE } } });
    if (q.includes("commentCreate"))
      return Response.json({
        data: {
          commentCreate: {
            comment: { id: "C2", createdAt: "2026-10-22T11:00:00Z" },
          },
        },
      });
    if (q.includes("issueDelete"))
      return Response.json({ data: { issueDelete: { success: true } } });
    throw new Error(`unexpected ${q}`);
  };
  const linear = operations(() => "lin_key", call);
  expect(await linear.check()).toEqual({ account: "ben@example.com" });
  expect((await linear.projects()).projects).toEqual([
    { id: "T", key: "ENG", name: "Eng", description: "" },
  ]);
  const [task] = (await linear.tasks({ project: "T" })).tasks;
  expect(task).toMatchObject({
    id: "I1",
    key: "ENG-1",
    status: "in_review",
    priority: "high",
    labels: ["ci"],
    people: ["ben"],
  });
  expect((await linear.task({ project: "T", task: "I1" })).comments).toEqual([
    expect.objectContaining({ author: "Ana", text: "Looks good" }),
  ]);
  const created = await linear.create_task({
    project: "T",
    task: {
      title: "Docs",
      status: "todo",
      priority: "urgent",
      labels: ["CI", "unknown"],
    },
  });
  expect(created.key).toBe("ENG-2");
  const create = asked.find((body) => body.query.includes("issueCreate"))!;
  expect(create.variables.input).toEqual({
    teamId: "T",
    title: "Docs",
    priority: 1,
    stateId: "s-todo",
    labelIds: ["L1"],
  });
  await linear.update_task({
    project: "T",
    task: "I1",
    changes: { status: "done" },
  });
  expect(
    asked.find((body) => body.query.includes("issueUpdate"))!.variables,
  ).toEqual({
    id: "I1",
    input: { stateId: "s-done" },
  });
  await linear.comment({ task: "I1", text: "Shipped" });
  await linear.delete_task({ task: "I1" });
  await expect(linear.task({ project: "T", task: "GONE" })).rejects.toThrow();
});
