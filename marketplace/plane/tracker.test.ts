import { expect, test } from "bun:test";
import { operations, plain, stateFor, status, web } from "./tracker.ts";

const STATES = [
  { id: "s1", name: "Backlog", group: "backlog" },
  { id: "s2", name: "Todo", group: "unstarted" },
  { id: "s3", name: "In Progress", group: "started" },
  { id: "s4", name: "In Review", group: "started" },
  { id: "s5", name: "Done", group: "completed" },
];

test("Plane's state groups and Projects' states map both ways", () => {
  expect(status({ name: "In Review", group: "started" })).toBe("in_review");
  expect(status(undefined)).toBe("backlog");
  expect(stateFor(STATES, "in_review")).toBe("s4");
  expect(stateFor(STATES, "todo")).toBe("s2");
  expect(plain("<p>a &amp; b<br>c</p>")).toBe("a & b\nc");
  expect(web("https://api.plane.so")).toBe("https://app.plane.so");
  expect(web("https://plane.example.com/")).toBe("https://plane.example.com");
});

test("a workspace's work items are read live, created, changed, commented on and deleted there", async () => {
  const sent: { url: string; method: string; body?: any }[] = [];
  const labels = [{ id: "l1", name: "ui" }];
  const call = async (url: string, init: RequestInit = {}) => {
    expect(new Headers(init.headers).get("x-api-key")).toBe("k");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ url, method, body });
    const path = url
      .replace("https://plane.example.com/api/v1/workspaces/acme", "")
      .split("?")[0]!;
    if (path === "https://plane.example.com/api/v1/users/me/")
      return Response.json({ email: "ben@example.com" });
    if (path === "/projects/")
      return Response.json({
        results: [{ id: "P", name: "Web", identifier: "WEB" }],
      });
    if (path === "/projects/P/")
      return Response.json({ id: "P", name: "Web", identifier: "WEB" });
    if (path === "/projects/P/states/")
      return Response.json({ results: STATES });
    if (path === "/projects/P/labels/" && method === "POST") {
      labels.push({ id: "l2", name: body.name });
      return Response.json({ id: "l2", name: body.name });
    }
    if (path === "/projects/P/labels/")
      return Response.json({ results: labels });
    if (path === "/members/")
      return Response.json([{ id: "u1", display_name: "Ben" }]);
    const item = {
      id: "W1",
      name: body?.name ?? "CI",
      description_stripped: "Set it up",
      priority: "high",
      state: "s4",
      target_date: "2026-11-01",
      sequence_id: 7,
      labels: ["l1"],
      assignees: ["u1"],
      updated_at: "2026-10-22T10:00:00Z",
    };
    if (path === "/projects/P/issues/" && method === "GET")
      return Response.json({ results: [item] });
    if (path === "/projects/P/issues/" && method === "POST")
      return Response.json({ ...item, id: "W2", sequence_id: 8 });
    if (path === "/projects/P/issues/W1/" && method === "DELETE")
      return new Response(null, { status: 204 });
    if (path === "/projects/P/issues/W1/") return Response.json(item);
    if (path === "/projects/P/issues/W1/comments/" && method === "POST")
      return Response.json({ id: "c2", created_at: "2026-10-22T11:00:00Z" });
    if (path === "/projects/P/issues/W1/comments/")
      return Response.json({
        results: [
          {
            id: "c1",
            comment_stripped: "Looks good",
            actor_detail: { display_name: "Ana" },
            created_at: "2026-10-22T09:00:00Z",
          },
        ],
      });
    if (path === "/projects/P/issues/MISSING/")
      return new Response(null, { status: 404 });
    throw new Error(`unexpected ${method} ${url}`);
  };
  const plane = operations(
    () => ({ base_url: "https://plane.example.com", workspace: "acme" }),
    () => "k",
    call,
  );
  expect(await plane.check()).toEqual({ account: "ben@example.com" });
  expect((await plane.projects()).projects[0]).toMatchObject({
    id: "P",
    key: "WEB",
    name: "Web",
  });
  const [task] = (await plane.tasks({ project: "P" })).tasks;
  expect(task).toMatchObject({
    id: "W1",
    key: "WEB-7",
    title: "CI",
    status: "in_review",
    priority: "high",
    labels: ["ui"],
    people: ["Ben"],
    due: "2026-11-01",
    url: "https://plane.example.com/acme/browse/WEB-7/",
  });
  const read = await plane.task({ project: "P", task: "W1" });
  expect(read.comments).toEqual([
    expect.objectContaining({ author: "Ana", text: "Looks good" }),
  ]);
  const created = await plane.create_task({
    project: "P",
    task: { title: "Docs", status: "todo", labels: ["ui", "docs"], due: null },
  });
  expect(created.key).toBe("WEB-8");
  const posted = sent.find(
    (call) => call.method === "POST" && call.url.endsWith("/issues/"),
  )!;
  expect(posted.body).toMatchObject({
    name: "Docs",
    state: "s2",
    labels: ["l1", "l2"],
    target_date: null,
  });
  await plane.update_task({
    project: "P",
    task: "W1",
    changes: { status: "done" },
  });
  expect(sent.find((call) => call.method === "PATCH")!.body).toEqual({
    state: "s5",
  });
  await plane.comment({ project: "P", task: "W1", text: "a <b>" });
  expect(
    sent.find(
      (call) => call.method === "POST" && call.url.endsWith("/comments/"),
    )!.body,
  ).toEqual({
    comment_html: "<p>a &lt;b&gt;</p>",
  });
  await plane.delete_task({ project: "P", task: "W1" });
  await expect(plane.task({ project: "P", task: "MISSING" })).rejects.toThrow(
    "not found",
  );
});
