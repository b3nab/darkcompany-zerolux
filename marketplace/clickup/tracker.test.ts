import { expect, test } from "bun:test";
import { API, operations, status, statusFor } from "./tracker.ts";

const STATUSES = [
  { status: "to do", type: "open" },
  { status: "in progress", type: "custom" },
  { status: "review", type: "custom" },
  { status: "complete", type: "closed" },
];

test("a list's statuses and ZeroLux's states map both ways", () => {
  expect(status({ status: "Review", type: "custom" })).toBe("in_review");
  expect(status({ status: "complete", type: "closed" })).toBe("done");
  expect(status({ status: "to do", type: "open" })).toBe("todo");
  expect(statusFor(STATUSES, "in_review")).toBe("review");
  expect(statusFor(STATUSES, "cancelled")).toBeUndefined();
});

test("lists are found across spaces and folders, and their tasks kept in step", async () => {
  const sent: { path: string; method: string; body?: any }[] = [];
  const call = async (url: string, init: RequestInit = {}) => {
    expect(new Headers(init.headers).get("authorization")).toBe("pk_1");
    const path = url.slice(API.length);
    const method = init.method ?? "GET";
    sent.push({
      path,
      method,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const answers: Record<string, unknown> = {
      "/team": { teams: [{ id: "T" }] },
      "/team/T/space": { spaces: [{ id: "S", name: "Eng" }] },
      "/space/S/list": { lists: [{ id: "L1", name: "Inbox" }] },
      "/space/S/folder": {
        folders: [{ name: "Web", lists: [{ id: "L2", name: "Sprint" }] }],
      },
      "/list/L2": { statuses: STATUSES },
      "/list/L2/task?include_closed=true&subtasks=true": {
        tasks: [
          {
            id: "C1",
            name: "CI",
            description: null,
            status: { status: "review", type: "custom" },
            priority: { priority: "normal" },
            due_date: "1793491200000",
            url: "https://app.clickup.com/t/C1",
            tags: [{ name: "ci" }],
          },
        ],
      },
    };
    if (method === "POST" && path === "/list/L2/task")
      return Response.json({ id: "C2", url: "https://app.clickup.com/t/C2" });
    return Response.json(answers[path] ?? {});
  };
  const clickup = operations(() => "pk_1", call);
  expect(await clickup.projects()).toEqual({
    projects: [
      { remote_id: "L1", name: "Eng / Inbox" },
      { remote_id: "L2", name: "Eng / Web / Sprint" },
    ],
  });
  expect((await clickup.tasks({ remote_id: "L2" })).tasks[0]).toEqual({
    remote_id: "C1",
    title: "CI",
    description: "",
    status: "in_review",
    priority: "medium",
    labels: ["ci"],
    due: "2026-11-01",
    url: "https://app.clickup.com/t/C1",
  });
  expect(
    await clickup.create({
      remote_id: "L2",
      task: {
        title: "Ship",
        status: "in_progress",
        priority: "high",
        due: "2026-11-02",
      },
    }),
  ).toEqual({ remote_id: "C2", url: "https://app.clickup.com/t/C2" });
  expect(sent.at(-1)!.body).toEqual({
    name: "Ship",
    priority: 2,
    due_date: Date.parse("2026-11-02T00:00:00Z"),
    status: "in progress",
  });
  await clickup.update({
    remote_id: "L2",
    task_id: "C2",
    changes: { status: "done" },
  });
  expect(sent.at(-1)).toMatchObject({
    path: "/task/C2",
    method: "PUT",
    body: { status: "complete" },
  });
  await clickup.comment({ task_id: "C2", text: "Shipped" });
  expect(sent.at(-1)!.body).toEqual({ comment_text: "Shipped" });
});

test("without its token it says what to give", async () => {
  await expect(operations(() => "").projects()).rejects.toThrow("API token");
});
