import { describe, expect, test } from "bun:test";
import { Bridge, boundedText } from "./bridge";
import type { Claim, Host, Transport } from "./bridge";
import zerolux from "./index";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function fixture(heartbeatMs = 60_000, timeoutMs = 60_000) {
  const calls: { path: string; body?: unknown }[] = [];
  const sent: string[] = [];
  const notices: string[] = [];
  let aborts = 0;
  let idle = true;
  let pending = false;
  let failure = "";
  let claim: Claim | null = {
    task: { id: "task-1", title: "Test" },
    run: { id: "run-1" },
    prompt: "Owned task prompt",
  };
  const transport: Transport = async <T>(
    _base: string,
    path: string,
    body?: unknown,
  ) => {
    calls.push({ path, body });
    if (failure && path.includes(failure))
      throw new Error("fixture network failure");
    if (path === "/health") return { capabilities: ["byoh-v1"] } as T;
    if (path === "/connections")
      return {
        id: "conn-1",
        actor_id: "agent-1",
        project_id: "project-1",
        workspace: "/worktree",
        session_id: "this-session",
      } as T;
    if (path === "/worker/claim") return claim as T;
    return undefined as T;
  };
  const host: Host = {
    cwd: "/worktree",
    sessionId: "this-session",
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    send: (p) => {
      sent.push(p);
      idle = false;
    },
    abort: () => {
      aborts++;
      idle = true;
    },
    notify: (text) => notices.push(text),
    status: () => {},
  };
  const bridge = new Bridge(host, transport, heartbeatMs, timeoutMs);
  return {
    bridge,
    calls,
    sent,
    notices,
    get aborts() {
      return aborts;
    },
    setIdle: (value: boolean) => {
      idle = value;
    },
    setPending: (value: boolean) => {
      pending = value;
    },
    setFailure: (value: string) => {
      failure = value;
    },
    emptyQueue: () => {
      claim = null;
    },
    connect: () =>
      bridge.connect("project-1", "agent-1", "http://127.0.0.1:4310"),
    finishCalls: () => calls.filter((c) => c.path.endsWith("/finish")),
  };
}
const message = (text: string, stopReason = "stop") => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason,
});
async function eventually(condition: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error("Condition did not settle");
}

describe("existing pi session bridge", () => {
  test("factory only registers commands/events; loading never starts a connection or turn", () => {
    const commands: string[] = [],
      events: string[] = [];
    zerolux({
      events: { on: () => () => {}, emit: () => {} },
      registerCommand: (name: string) => commands.push(name),
      on: (event: string) => {
        events.push(event);
        return () => {};
      },
    } as unknown as ExtensionAPI);
    expect(commands).toEqual(["zerolux"]);
    expect(events).toContain("agent_settled");
    expect(events).toContain("session_shutdown");
    expect(events).not.toContain("agent_end");
  });

  test("connect only shares metadata; take starts one task; settled submits only new final text", async () => {
    const f = fixture();
    expect(f.calls).toEqual([]);
    f.bridge.message(message("PRIVATE OLD CONVERSATION"));
    await f.connect();
    expect(f.sent).toEqual([]);
    expect(f.calls[1]?.body).toEqual({
      actor_id: "agent-1",
      project_id: "project-1",
      mode: "pi_session",
      workspace: "/worktree",
      session_id: "this-session",
    });
    await f.bridge.take();
    expect(f.sent).toEqual(["Owned task prompt"]);
    await expect(f.bridge.take()).rejects.toThrow("idle");
    f.bridge.message({
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "do not upload" },
        { type: "text", text: "Public final result" },
        { type: "toolCall", arguments: { secret: "do not upload" } },
      ],
    });
    expect(f.finishCalls()).toEqual([]);
    f.bridge.beforeSettle("completed");
    f.setIdle(true);
    await f.bridge.settled();
    await f.bridge.settled();
    expect(f.finishCalls()).toHaveLength(1);
    expect(f.finishCalls()[0]?.body).toEqual({
      stdout: "Public final result",
      stderr: "",
      exit_code: 0,
      failure_reason: null,
    });
    expect(JSON.stringify(f.calls)).not.toContain("PRIVATE");
    expect(JSON.stringify(f.calls)).not.toContain("do not upload");
    expect(f.calls.some((c) => c.path.includes("/actions"))).toBe(false);
    await f.bridge.disconnect();
    expect(f.aborts).toBe(0);
  });

  test("recovery can replace a transient error before the final settlement", async () => {
    const f = fixture();
    await f.connect();
    await f.bridge.take();
    f.bridge.message(message("Provider unavailable", "error"));
    f.bridge.beforeSettle("error");
    expect(f.finishCalls()).toHaveLength(0);
    f.bridge.message(message("Recovered and tested"));
    f.bridge.beforeSettle("completed");
    await f.bridge.settled();
    expect(f.finishCalls()[0]?.body).toMatchObject({
      stdout: "Recovered and tested",
      exit_code: 0,
    });
    await f.bridge.disconnect();
  });

  for (const reason of ["error", "aborted", "length", "toolUse", "pending"]) {
    test(`${reason} never produces a successful run`, async () => {
      const f = fixture();
      await f.connect();
      await f.bridge.take();
      f.bridge.message(message("Partial", reason));
      f.bridge.beforeSettle(reason === "aborted" ? "aborted" : "completed");
      await f.bridge.settled();
      expect(f.finishCalls()[0]?.body).toMatchObject({ exit_code: null });
      await f.bridge.disconnect();
    });
  }

  test("a settled run with no final assistant message fails", async () => {
    const f = fixture();
    await f.connect();
    await f.bridge.take();
    f.bridge.beforeSettle("completed");
    await f.bridge.settled();
    expect(f.finishCalls()[0]?.body).toMatchObject({ exit_code: null });
    await f.bridge.disconnect();
  });

  test("reload/disconnect aborts owned work once, fails it, and does not close pi", async () => {
    const f = fixture();
    await f.connect();
    await f.bridge.take();
    f.bridge.message(message("Partial work", "toolUse"));
    await f.bridge.disconnect("Pi reloaded");
    await f.bridge.disconnect();
    await f.bridge.settled();
    expect(f.aborts).toBe(1);
    expect(f.finishCalls()).toHaveLength(1);
    expect(f.finishCalls()[0]?.body).toMatchObject({
      stdout: "Partial work",
      failure_reason: "Pi reloaded",
    });
    expect(f.bridge.connected).toBe(false);
  });

  test("heartbeat loss stops active work rather than stealing/retrying tasks", async () => {
    const f = fixture(5);
    await f.connect();
    await f.bridge.take();
    f.setFailure("heartbeat");
    await eventually(() => !f.bridge.connected);
    expect(f.aborts).toBe(1);
    expect(f.calls.filter((c) => c.path === "/worker/claim")).toHaveLength(1);
  });

  test("run deadline aborts the task and releases its connection", async () => {
    const f = fixture(5, 1);
    await f.connect();
    await f.bridge.take();
    await eventually(() => !f.bridge.connected);
    expect(f.aborts).toBe(1);
    expect(f.finishCalls()[0]?.body).toMatchObject({
      failure_reason: "Pi task timed out",
    });
  });

  test("delivery failure disconnects, reports uncertainty, and never retries execution", async () => {
    const f = fixture();
    await f.connect();
    await f.bridge.take();
    f.bridge.message(message("Done"));
    f.bridge.beforeSettle("completed");
    f.setFailure("/finish");
    await f.bridge.settled();
    expect(f.bridge.connected).toBe(false);
    expect(f.finishCalls()).toHaveLength(1);
    expect(f.calls.filter((c) => c.path === "/worker/claim")).toHaveLength(1);
    expect(f.notices.some((n) => n.includes("delivery failed"))).toBe(true);
  });

  test("no queue, a busy pi, and pending messages never start a task", async () => {
    const f = fixture();
    await f.connect();
    f.setIdle(false);
    await expect(f.bridge.take()).rejects.toThrow("idle");
    f.setIdle(true);
    f.setPending(true);
    await expect(f.bridge.take()).rejects.toThrow("idle");
    f.setPending(false);
    f.emptyQueue();
    await f.bridge.take();
    expect(f.sent).toHaveLength(0);
    await f.bridge.disconnect();
  });
});

test("captured final text is UTF-8 safe and limited to 64 KiB", () => {
  const text = boundedText("🌙".repeat(30_000));
  expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(64 * 1024);
  expect(text).not.toContain("�");
  expect(text).toEndWith("[output truncated]");
});
