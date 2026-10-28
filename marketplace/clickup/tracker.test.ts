import { expect, test } from "bun:test";
import { API, operations, status, statusFor } from "./tracker.ts";

const STATUSES = [
  { status: "backlog", type: "open" },
  { status: "to do", type: "custom" },
  { status: "in progress", type: "custom" },
  { status: "review", type: "custom" },
  { status: "complete", type: "closed" },
];

test("ClickUp's statuses and Projects' states map both ways", () => {
  expect(status({ status: "review", type: "custom" })).toBe("in_review");
  expect(status({ status: "complete", type: "closed" })).toBe("done");
  expect(status({ status: "Open", type: "open" })).toBe("todo");
  expect(statusFor(STATUSES, "in_review")).toBe("review");
  expect(statusFor(STATUSES, "done")).toBe("complete");
});

const TASK = {
  id: "t1",
  custom_id: "WEB-3",
  name: "CI",
  text_content: "Set it up",
  status: { status: "review", type: "custom" },
  priority: { priority: "high" },
  due_date: String(Date.parse("2026-11-01T00:00:00Z")),
  url: "https://app.clickup.com/t/t1",
  tags: [{ name: "ci" }, { name: "old" }],
  assignees: [{ username: "ben" }],
  date_updated: "1792000000000",
};

test("an account's lists and tasks are read live, created, changed, commented on and deleted there", async () => {
  const sent: { path: string; method: string; body?: any }[] = [];
  const call = async (url: string, init: RequestInit = {}) => {
    expect(new Headers(init.headers).get("authorization")).toBe("pk_1");
    const method = init.method ?? "GET";
    const path = url.slice(API.length);
    sent.push({
      path,
      method,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (path === "/user")
      return Response.json({ user: { email: "ben@example.com" } });
    if (path === "/team") return Response.json({ teams: [{ id: "T" }] });
    if (path === "/team/T/space")
      return Response.json({ spaces: [{ id: "S", name: "Web" }] });
    if (path === "/space/S/list")
      return Response.json({ lists: [{ id: "L", name: "Sprint" }] });
    if (path === "/space/S/folder") return Response.json({ folders: [] });
    if (path.startsWith("/list/L/task?"))
      return Response.json({ tasks: [TASK], last_page: true });
    if (path === "/list/L") return Response.json({ statuses: STATUSES });
    if (path === "/list/L/task")
      return Response.json({ ...TASK, id: "t2", custom_id: null });
    if (path === "/task/t1/comment" && method === "GET")
      return Response.json({
        comments: [
          {
            id: "c1",
            comment_text: "Looks good",
            date: "1792000000000",
            user: { username: "ana" },
          },
        ],
      });
    if (path === "/task/t1/comment")
      return Response.json({ id: 9, date: 1792000000001 });
    if (path.startsWith("/task/t1/tag/")) return Response.json({});
    if (path === "/task/t1") return Response.json(TASK);
    if (path === "/task/gone") return new Response(null, { status: 404 });
    throw new Error(`unexpected ${method} ${path}`);
  };
  const clickup = operations(() => "pk_1", call);
  expect(await clickup.check()).toEqual({ account: "ben@example.com" });
  expect((await clickup.projects()).projects).toEqual([
    { id: "L", name: "Web / Sprint" },
  ]);
  const [task] = (await clickup.tasks({ project: "L" })).tasks;
  expect(task).toMatchObject({
    id: "t1",
    key: "WEB-3",
    status: "in_review",
    priority: "high",
    due: "2026-11-01",
    labels: ["ci", "old"],
    people: ["ben"],
  });
  expect((await clickup.task({ task: "t1" })).comments).toEqual([
    expect.objectContaining({ author: "ana", text: "Looks good" }),
  ]);
  const created = await clickup.create_task({
    project: "L",
    task: { title: "Docs", status: "done", labels: ["docs"] },
  });
  expect(created.key).toBe("#t2");
  expect(
    sent.find((call) => call.path === "/list/L/task" && call.method === "POST")!
      .body,
  ).toEqual({
    name: "Docs",
    status: "complete",
    tags: ["docs"],
  });
  await clickup.update_task({
    project: "L",
    task: "t1",
    changes: { labels: ["ci", "new"], priority: "low" },
  });
  expect(
    sent
      .filter((call) => call.path.startsWith("/task/t1/tag/"))
      .map((call) => `${call.method} ${call.path}`),
  ).toEqual(["DELETE /task/t1/tag/old", "POST /task/t1/tag/new"]);
  expect(sent.find((call) => call.method === "PUT")!.body).toEqual({
    priority: 4,
  });
  await clickup.comment({ task: "t1", text: "Shipped" });
  await clickup.delete_task({ task: "t1" });
  await expect(clickup.task({ task: "gone" })).rejects.toThrow();
});
