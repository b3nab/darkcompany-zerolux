import { expect, test } from "bun:test";
import { Bridge } from "./bridge";
import type { Host, Transport } from "./bridge";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function host() {
  const notices: string[] = [],
    sent: string[] = [];
  const value: Host = {
    cwd: "/workspace",
    sessionId: "session",
    isIdle: () => true,
    hasPendingMessages: () => false,
    send: (text) => {
      sent.push(text);
    },
    abort: () => {},
    notify: (text) => {
      notices.push(text);
    },
    status: () => {},
  };
  return { value, notices, sent };
}
const connection = {
  id: "conn",
  actor_id: "actor",
  project_id: "project",
  workspace: "/workspace",
  session_id: "session",
};
const claim = {
  task: { id: "task", title: "Test" },
  run: { id: "run" },
  prompt: "Do the task",
};

for (const response of [null, claim]) {
  test(`a delayed ${response ? "claim" : "empty queue"} after shutdown cannot start a turn or touch the old UI`, async () => {
    const pending = deferred<unknown>(),
      entered = deferred<void>();
    const calls: string[] = [],
      h = host();
    const transport: Transport = async <T>(_base: string, path: string) => {
      calls.push(path);
      if (path === "/health") return { capabilities: ["byoh-v1"] } as T;
      if (path === "/connections") return connection as T;
      if (path === "/worker/claim") {
        entered.resolve();
        return (await pending.promise) as T;
      }
      return undefined as T;
    };
    const bridge = new Bridge(h.value, transport);
    await bridge.connect("project", "actor", "http://127.0.0.1:4310");
    const take = bridge.take().catch((error) => error);
    await entered.promise;
    await bridge.disconnect();
    const noticeCount = h.notices.length;
    pending.resolve(response);
    await take;
    expect(h.sent).toEqual([]);
    expect(h.notices).toHaveLength(noticeCount);
    expect(bridge.connected).toBe(false);
    if (response) expect(calls).toContain("/worker/runs/run/finish");
  });
}

test("a late connect response is explicitly released after session shutdown", async () => {
  const pending = deferred<unknown>(),
    entered = deferred<void>();
  const calls: string[] = [],
    h = host();
  const transport: Transport = async <T>(_base: string, path: string) => {
    calls.push(path);
    if (path === "/health") return { capabilities: ["byoh-v1"] } as T;
    if (path === "/connections") {
      entered.resolve();
      return (await pending.promise) as T;
    }
    return undefined as T;
  };
  const bridge = new Bridge(h.value, transport);
  const connecting = bridge
    .connect("project", "actor", "http://127.0.0.1:4310")
    .catch((error) => error);
  await entered.promise;
  await bridge.disconnect();
  pending.resolve(connection);
  expect(await connecting).toBeInstanceOf(Error);
  expect(calls).toContain("/connections/conn/disconnect");
  expect(h.sent).toEqual([]);
  expect(h.notices).toEqual([]);
});

test("a heartbeat failure arriving after disconnect does not touch the old session UI", async () => {
  const pending = deferred<unknown>(),
    entered = deferred<void>();
  const h = host();
  const transport: Transport = async <T>(_base: string, path: string) => {
    if (path === "/health") return { capabilities: ["byoh-v1"] } as T;
    if (path === "/connections") return connection as T;
    if (path.endsWith("/heartbeat")) {
      entered.resolve();
      return (await pending.promise) as T;
    }
    return undefined as T;
  };
  const bridge = new Bridge(h.value, transport, 1);
  await bridge.connect("project", "actor", "http://127.0.0.1:4310");
  await entered.promise;
  await bridge.disconnect();
  const noticeCount = h.notices.length;
  pending.reject(new Error("late failure"));
  await Bun.sleep(5);
  expect(h.notices).toHaveLength(noticeCount);
});
