import { expect, test } from "bun:test";
import { operations, stateFor, status } from "./tracker.ts";

const STATES = [
  { id: "s1", name: "Backlog", group: "backlog" },
  { id: "s2", name: "Todo", group: "unstarted" },
  { id: "s3", name: "In Progress", group: "started" },
  { id: "s4", name: "In Review", group: "started" },
  { id: "s5", name: "Done", group: "completed" },
];

test("Plane's state groups and ZeroLux's states map both ways", () => {
  expect(status({ name: "In Review", group: "started" })).toBe("in_review");
  expect(status(undefined)).toBe("backlog");
  expect(stateFor(STATES, "in_review")).toBe("s4");
  expect(stateFor(STATES, "todo")).toBe("s2");
});

test("a project's work items are read, created, changed and commented on", async () => {
  const sent: { url: string; method: string; body?: any }[] = [];
  const call = async (url: string, init: RequestInit = {}) => {
    expect(new Headers(init.headers).get("x-api-key")).toBe("k");
    const method = init.method ?? "GET";
    sent.push({
      url,
      method,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.endsWith("/projects/"))
      return Response.json({ results: [{ id: "P", name: "Web" }] });
    if (url.endsWith("/states/")) return Response.json({ results: STATES });
    if (url.includes("/issues/?")) {
      return Response.json({
        results: [
          {
            id: "W1",
            name: "CI",
            description_stripped: "Set it up",
            priority: "high",
            state: "s4",
            target_date: null,
          },
        ],
      });
    }
    if (method === "POST" && url.endsWith("/issues/"))
      return Response.json({ id: "W2" });
    return Response.json({});
  };
  const plane = operations(
    () => ({ baseUrl: "https://plane.example/", workspace: "acme", key: "k" }),
    call,
  );
  expect(await plane.projects()).toEqual({
    projects: [{ remote_id: "P", name: "Web" }],
  });
  expect(sent[0]!.url).toBe(
    "https://plane.example/api/v1/workspaces/acme/projects/",
  );
  expect((await plane.tasks({ remote_id: "P" })).tasks).toEqual([
    {
      remote_id: "W1",
      title: "CI",
      description: "Set it up",
      status: "in_review",
      priority: "high",
      due: null,
      url: null,
    },
  ]);
  expect(
    await plane.create({
      remote_id: "P",
      task: {
        title: "Ship <it>",
        description: "a\nb",
        status: "todo",
        priority: "urgent",
      },
    }),
  ).toEqual({ remote_id: "W2", url: null });
  expect(sent.at(-1)!.body).toEqual({
    name: "Ship <it>",
    description_html: "<p>a<br>b</p>",
    priority: "urgent",
    state: "s2",
  });
  await plane.update({
    remote_id: "P",
    task_id: "W2",
    changes: { status: "done" },
  });
  expect(sent.at(-1)).toMatchObject({ method: "PATCH", body: { state: "s5" } });
  await plane.comment({ remote_id: "P", task_id: "W2", text: "1 < 2" });
  expect(sent.at(-1)!.body).toEqual({ comment_html: "<p>1 &lt; 2</p>" });
});

test("without its workspace and key it says what to give", async () => {
  await expect(
    operations(() => ({ baseUrl: "", workspace: "", key: "" })).projects(),
  ).rejects.toThrow("workspace and API key");
});
