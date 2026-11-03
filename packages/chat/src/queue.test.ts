import { afterEach, expect, test } from "bun:test";
import { setKernelFetch } from "./client";
import {
  clearQueue,
  editQueued,
  removeQueued,
  reorderQueue,
  sendQueued,
} from "./queue";

afterEach(() => setKernelFetch());

const base = "http://192.0.2.10:4310/w/ws-a";

/** A kernel that notes each call, and answers a queue read with what it holds. */
function kernel() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  setKernelFetch(async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: url.slice(`${base}/api`.length),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    return Response.json(method === "GET" ? { queue: [] } : {});
  });
  return calls;
}

test("each change to a queue reaches its item, then the queue is read again as it now is", async () => {
  const calls = kernel();
  await editQueued(base, "s/1", "q 1", "Run the tests first");
  await removeQueued(base, "s/1", "q 1");
  await sendQueued(base, "s/1", "q 2");
  await reorderQueue(base, "s/1", ["q 3", "q 2"]);
  await clearQueue(base, "s/1");
  const read = { method: "GET", path: "/sessions/s%2F1/queue" };
  expect(calls).toEqual([
    {
      method: "PATCH",
      path: "/sessions/s%2F1/queue/q%201",
      body: { text: "Run the tests first" },
    },
    read,
    { method: "DELETE", path: "/sessions/s%2F1/queue/q%201" },
    read,
    { method: "POST", path: "/sessions/s%2F1/queue/q%202/send", body: {} },
    read,
    {
      method: "PUT",
      path: "/sessions/s%2F1/queue/order",
      body: { ids: ["q 3", "q 2"] },
    },
    read,
    { method: "DELETE", path: "/sessions/s%2F1/queue" },
    read,
  ]);
});

test("a change the kernel refuses fails, and the queue is not read for it", async () => {
  const calls: string[] = [];
  setKernelFetch(async (url, init) => {
    calls.push(init?.method ?? "GET");
    return Response.json({ error: "Not found" }, { status: 404 });
  });
  await expect(removeQueued(base, "s", "gone")).rejects.toThrow();
  expect(calls).toEqual(["DELETE"]);
});
