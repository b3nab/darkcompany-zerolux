import { expect, test } from "bun:test";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ChatHttpError,
  Transport,
  type ChatRequest,
  type Inbox,
} from "@zerolux/bridge";
import type { StartQuery } from "./agent.ts";
import { Runner } from "./runner.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fixture() {
  const session = {
    id: "link",
    actor_id: "claude",
    harness: "claude-code",
    native_session_id: "native",
    workspace: "/work",
    status: "connected",
  };
  const inbox: Inbox = {
    session,
    conversations: [
      {
        id: "general",
        title: "General",
        kind: "group",
        paused: false,
        members: [
          { actor_id: "owner", name: "Owner", kind: "human", session_id: null },
          {
            actor_id: "claude",
            name: "claude",
            kind: "agent",
            session_id: "link",
          },
        ],
      },
    ],
    deliveries: [],
  };
  // The kernel: which token every call used, which tokens are revoked, which session each names.
  const calls: { token: string; path: string; body?: any }[] = [];
  const revoked = new Set<string>();
  const approvals: { id: string; status: string; decision: string | null }[] =
    [];
  const sessions = new Map<string, typeof session>();
  let hold: Promise<void> | undefined;
  /** The kernel revokes the token at this request, as at a claim refused midway. */
  let revokeAt: string | undefined;
  let failStart = 0;
  let slowStop: Promise<void> | undefined;
  const timeline: string[] = [];
  const connect = (_base: string, token: string): ChatRequest =>
    (async <T>(path: string, body?: unknown) => {
      calls.push({ token, path, body: structuredClone(body) });
      if (hold) await hold;
      if (revokeAt && path.includes(revokeAt)) revoked.add(token);
      if (revoked.has(token)) throw new ChatHttpError(403);
      if (path === "/chat/approvals") {
        if (body === undefined)
          return { approvals: structuredClone(approvals) } as T;
        approvals.push({
          id: (body as { id: string }).id,
          status: "pending",
          decision: null,
        });
        return { approval: structuredClone(approvals.at(-1)) } as T;
      }
      const approval = approvals.find((a) => path.includes(`/${a.id}/`));
      if (approval && path.endsWith("/dispatch")) {
        if (approval.status !== "decided") throw new ChatHttpError(409);
        approval.status = "uncertain";
        return { approval } as T;
      }
      if (path === "/chat/inbox")
        return {
          ...structuredClone(inbox),
          session: sessions.get(token) ?? session,
        } as T;
      const delivery = inbox.deliveries.find((d) => path.includes(`/${d.id}/`));
      if (path.endsWith("/dispatch") && delivery) {
        if (delivery.status !== "stored") throw new ChatHttpError(409);
        delivery.status = "uncertain";
        return { delivery, message: delivery.message } as T;
      }
      return {} as T;
    }) as ChatRequest;

  const starts: Options[] = [];
  const inputs: SDKUserMessage[] = [];
  let emit!: (m: SDKMessage) => void;
  let interrupts = 0,
    closes = 0;
  const start: StartQuery = ({ prompt, options }) => {
    starts.push(options);
    void (async () => {
      for await (const input of prompt) inputs.push(input);
    })();
    const queue: SDKMessage[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    emit = (m) => {
      queue.push(m);
      wake?.();
    };
    async function* stream() {
      for (;;) {
        const next = queue.shift();
        if (next) yield next;
        else if (closed) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    }
    return Object.assign(stream(), {
      interrupt: async () => {
        interrupts++;
        return undefined;
      },
      close: () => {
        closes++;
        closed = true;
        wake?.();
      },
    }) as unknown as Query;
  };
  const subscribers: { started: string[]; stopped: number } = {
    started: [],
    stopped: 0,
  };
  const runner = new Runner(
    { nativeSessionId: "native", workspace: "/work", mode: "default" },
    {
      start,
      connect,
      saved: async () => false,
      subscriber: () => ({
        start: async (_executable, _base, token) => {
          if (failStart > 0) {
            failStart--;
            throw new Error("subscriber failed");
          }
          subscribers.started.push(token);
          timeline.push(`start ${token}`);
        },
        stop: async () => {
          timeline.push("stopping");
          if (slowStop) await slowStop;
          subscribers.stopped++;
          timeline.push("stopped");
        },
      }),
    },
  );
  const bind = (token: string) =>
    runner.handle("bind", {
      base_url: "http://127.0.0.1:4310",
      token,
      executable: "/bin/zerolux",
    }) as Promise<{ link_id: string }>;
  return {
    inbox,
    calls,
    revoked,
    approvals,
    sessions,
    runner,
    bind,
    starts,
    inputs,
    subscribers,
    interrupts: () => interrupts,
    closes: () => closes,
    hold: (gate: Promise<void> | undefined) => {
      hold = gate;
    },
    revokeAt: (path: string) => {
      revokeAt = path;
    },
    failStart: () => {
      failStart = 1;
    },
    slowStop: (gate: Promise<void> | undefined) => {
      slowStop = gate;
    },
    timeline,
    consumed: (...ids: string[]) =>
      emit({
        type: "assistant",
        user_message_uuids: ids,
        user_message_uuid: ids.at(-1),
      } as unknown as SDKMessage),
    state: (to: "running" | "idle") =>
      emit({
        type: "system",
        subtype: "session_state_changed",
        state: to,
        uuid: crypto.randomUUID(),
        session_id: "native",
      } as SDKMessage),
    message: (id: string, text: string) =>
      inbox.deliveries.push({
        id,
        session_id: "link",
        status: "stored",
        message: {
          id: `m-${id}`,
          conversation_id: "general",
          author_id: "owner",
          text,
          seq: inbox.deliveries.length + 1,
        },
      }),
  };
}

test("the first bind names the session and starts it once, in its folder and mode", async () => {
  const f = fixture();
  const { link_id } = await f.bind("t1");
  await tick();
  // The link is the ZeroLux session: the kernel can still name it after a lost answer.
  expect(link_id).toBe("link");
  expect(f.starts).toHaveLength(1);
  expect(f.starts[0]).toMatchObject({
    cwd: "/work",
    sessionId: "native",
    permissionMode: "default",
  });
  expect(f.runner.describe()).toMatchObject({
    kind: "claude-runner",
    native_session_id: "native",
    workspace: "/work",
    permission_mode: "default",
    bound: true,
  });
  expect(f.subscribers.started).toEqual(["t1"]);
});

test("a new token takes over the same link only after prepare; the session goes on", async () => {
  const f = fixture();
  const first = await f.bind("t1");
  await expect(f.bind("t2")).rejects.toThrow();
  await f.runner.handle("prepare", { link_id: first.link_id });
  const before = f.calls.length;
  // Work the bridge does while the link is rebound waits for the new token.
  const refresh = f.runner.agent.refresh();
  await tick();
  expect(f.calls.length).toBe(before);
  const second = await f.bind("t2");
  await refresh;
  expect(second.link_id).toBe(first.link_id);
  expect(f.starts).toHaveLength(1);
  expect(f.interrupts() + f.closes()).toBe(0);
  // Nothing went out with the old token after prepare answered.
  expect(f.calls.slice(before).every((c) => c.token === "t2")).toBe(true);
  expect(f.subscribers).toEqual({ started: ["t1", "t2"], stopped: 1 });
});

test("prepare answers only once requests in flight have ended", async () => {
  const f = fixture();
  const { link_id } = await f.bind("t1");
  let release!: () => void;
  f.hold(new Promise<void>((resolve) => (release = resolve)));
  const refresh = f.runner.agent.refresh();
  await tick();
  let prepared = false;
  const prepare = f.runner
    .handle("prepare", { link_id })
    .then(() => (prepared = true));
  await tick();
  expect(prepared).toBe(false);
  f.hold(undefined);
  release();
  await prepare;
  await refresh.catch(() => {});
  expect(prepared).toBe(true);
});

test("a bind naming another ZeroLux session is refused, and its token is not used again", async () => {
  const f = fixture();
  const { link_id } = await f.bind("t1");
  await f.runner.handle("prepare", { link_id });
  f.sessions.set("t3", { ...f.inbox.session, id: "another-link" });
  await expect(f.bind("t3")).rejects.toThrow();
  expect(f.calls.filter((c) => c.token === "t3").map((c) => c.path)).toEqual([
    "/chat/inbox",
  ]);
  // The right session still binds.
  expect((await f.bind("t2")).link_id).toBe(link_id);
});

test("a revoked token closes the link, never the session; a later bind needs no prepare", async () => {
  const f = fixture();
  const { link_id } = await f.bind("t1");
  f.message("d1", "work");
  await f.runner.agent.refresh();
  f.state("running");
  await tick();
  f.revoked.add("t1");
  await f.runner.agent.refresh();
  await tick();
  expect(f.interrupts()).toBe(0);
  expect(f.closes()).toBe(0);
  expect(f.subscribers.stopped).toBe(1);
  expect(f.runner.describe().bound).toBe(false);
  expect((await f.bind("t2")).link_id).toBe(link_id);
  expect(f.starts).toHaveLength(1);
});

test("a message the agent writes while the link is rebound goes out after bind, once", async () => {
  const f = fixture();
  const { link_id } = await f.bind("t1");
  await f.runner.handle("prepare", { link_id });
  const post = f.runner.agent.bridge.post("general", "written during the gap");
  await tick();
  await f.bind("t2");
  expect(await post).toBe("published");
  const posts = f.calls.filter((c) => c.path.endsWith("/messages"));
  expect(posts.map((c) => c.token)).toEqual(["t2"]);
});

test("Stop interrupts only a turn a chat message started, and ends the session", async () => {
  const f = fixture();
  const { link_id } = await f.bind("t1");
  f.message("d1", "long task");
  await f.runner.agent.refresh();
  f.state("running");
  await tick();
  await f.runner.handle("stop", { link_id });
  expect(f.interrupts()).toBe(1);
  expect(f.closes()).toBe(1);
  await f.runner.finished;
  await expect(f.runner.handle("stop", { link_id: "other" })).rejects.toThrow();
});

test("a paused request gives up after the rebind wait, as an unreachable kernel", async () => {
  const transport = new Transport(() => {}, 10);
  transport.bind((async () => ({})) as ChatRequest);
  await transport.pause();
  await expect(transport.request("/chat/inbox")).rejects.toThrow("unreachable");
});

test("the same bind again, or prepare again, changes nothing", async () => {
  const f = fixture();
  const { link_id } = await f.bind("t1");
  expect((await f.bind("t1")).link_id).toBe(link_id);
  expect(f.starts).toHaveLength(1);
  expect(f.subscribers.started).toEqual(["t1"]);
  await f.runner.handle("prepare", { link_id });
  await f.runner.handle("prepare", { link_id });
  expect(f.subscribers.stopped).toBe(1);
  await f.bind("t2");
  expect(f.subscribers.started).toEqual(["t1", "t2"]);
  expect(f.starts).toHaveLength(1);
});

test("a rebind keeps the session's work: approval, reads, outbox and activity", async () => {
  const f = fixture();
  const { link_id } = await f.bind("t1");
  f.message("d1", "run it");
  await f.runner.agent.refresh();
  f.state("running");
  f.consumed("d1");
  await tick();
  // A permission request waits for the owner across the restart.
  const asked = f.starts[0]!.canUseTool!(
    "Bash",
    {},
    { signal: new AbortController().signal, toolUseID: "tool", requestId: "r" },
  );
  f.message("d2", "and this");
  await f.runner.agent.refresh();
  await tick();
  await f.runner.handle("prepare", { link_id });
  const quiet = f.calls.length;
  // During the gap: d2 enters the turn, the agent writes, the owner decides.
  f.consumed("d2");
  const post = f.runner.agent.bridge.post("general", "during the gap");
  f.approvals[0]!.status = "decided";
  f.approvals[0]!.decision = "allow";
  await tick();
  expect(f.calls.length).toBe(quiet);
  await f.bind("t2");
  await f.runner.agent.refresh();
  await tick();
  expect(await post).toBe("published");
  expect((await asked)?.behavior).toBe("allow");
  const after = f.calls.slice(quiet);
  expect(after.every((c) => c.token === "t2")).toBe(true);
  expect(
    after.some(
      (c) =>
        c.path === "/chat/deliveries/d2/receipt" && c.body?.status === "read",
    ),
  ).toBe(true);
  // The restarted kernel forgot the activity: it is published again.
  expect(
    after.some(
      (c) =>
        c.path.endsWith("/activity") &&
        c.body?.activity === "working" &&
        c.body?.conversation_id === "general",
    ),
  ).toBe(true);
});

test("a claim refused midway by revocation sends nothing to the agent, and keeps the session", async () => {
  const f = fixture();
  await f.bind("t1");
  f.message("d1", "first");
  // A second batch (another sender), so the claim of d1 succeeds before d2 is refused.
  f.inbox.conversations[0]!.members.push({
    actor_id: "birch",
    name: "birch",
    kind: "agent",
    session_id: "other",
  });
  f.message("d2", "second");
  f.inbox.deliveries[1]!.message.author_id = "birch";
  f.revokeAt("/d2/dispatch");
  await f.runner.agent.refresh();
  await tick();
  expect(f.inputs).toHaveLength(0);
  expect(f.runner.agent.bridge.connected).toBe(true);
  expect(f.runner.describe().bound).toBe(false);
  expect(f.interrupts() + f.closes()).toBe(0);
});

test("a bind that fails halfway can be tried again with the same token", async () => {
  const f = fixture();
  f.failStart();
  await expect(f.bind("t1")).rejects.toThrow();
  expect(f.starts).toHaveLength(0);
  const { link_id } = await f.bind("t1");
  expect(link_id).toBe("link");
  expect(f.starts).toHaveLength(1);
  expect(f.runner.describe().bound).toBe(true);
});

test("control operations run one at a time: prepare during a bind waits for it", async () => {
  const f = fixture();
  await f.bind("t1");
  await f.runner.handle("prepare", { link_id: "link" });
  let release!: () => void;
  f.hold(new Promise<void>((resolve) => (release = resolve)));
  const bind = f.bind("t2");
  let prepared = false;
  const prepare = f.runner
    .handle("prepare", { link_id: "link" })
    .then(() => (prepared = true));
  await tick();
  expect(prepared).toBe(false);
  f.hold(undefined);
  release();
  await bind;
  await prepare;
  // The later prepare paused the newly bound link: it waits for the next bind.
  expect(f.runner.describe().bound).toBe(false);
  expect(f.subscribers.stopped).toBe(2);
});

test("Stop answers again after a lost answer, and does not wait for a paused link", async () => {
  const f = fixture();
  const { link_id } = await f.bind("t1");
  await f.runner.handle("prepare", { link_id });
  await f.runner.handle("stop", { link_id });
  expect(await f.runner.handle("stop", { link_id })).toEqual({});
  await expect(f.bind("t2")).rejects.toThrow();
});

test("a claim that succeeds after the link was revoked never reaches the agent", async () => {
  const transport = new Transport(() => {});
  let answer!: () => void;
  const late = new Promise<void>((resolve) => (answer = resolve));
  transport.bind((async (path: string) => {
    if (path.endsWith("/dispatch")) {
      await late;
      return { delivery: {}, message: {} };
    }
    throw new ChatHttpError(401);
  }) as ChatRequest);
  const claim = transport.request("/chat/deliveries/d1/dispatch", {});
  await expect(transport.request("/chat/inbox")).rejects.toThrow("revoked");
  answer();
  await expect(claim).rejects.toThrow("revoked");
});

test("after a revocation, the new subscriber starts only once the old one has ended", async () => {
  const f = fixture();
  await f.bind("t1");
  let ended!: () => void;
  f.slowStop(new Promise<void>((resolve) => (ended = resolve)));
  f.revoked.add("t1");
  await f.runner.agent.refresh();
  const bind = f.bind("t2");
  await tick();
  expect(f.timeline.at(-1)).toBe("stopping");
  ended();
  await bind;
  expect(f.timeline.slice(-3)).toEqual(["stopping", "stopped", "start t2"]);
});

test("a runner whose first bind never named a session can still be stopped", async () => {
  const f = fixture();
  await f.runner.handle("stop", { link_id: "link" });
  await f.runner.finished;
  expect(await f.runner.handle("stop", { link_id: "link" })).toEqual({});
  await expect(f.bind("t1")).rejects.toThrow();
  expect(f.starts).toHaveLength(0);

  // A first bind that failed reading the inbox: Stop still ends the process.
  const g = fixture();
  g.revoked.add("t1");
  await expect(g.bind("t1")).rejects.toThrow();
  await expect(
    g.runner.handle("prepare", { link_id: "link" }),
  ).rejects.toThrow();
  await g.runner.handle("stop", { link_id: "link" });
  await g.runner.finished;
  expect(g.starts).toHaveLength(0);
});

test("once the session is named, another link cannot stop or prepare it", async () => {
  const f = fixture();
  await f.bind("t1");
  await expect(f.runner.handle("stop", { link_id: "other" })).rejects.toThrow();
  await expect(
    f.runner.handle("prepare", { link_id: "other" }),
  ).rejects.toThrow();
  expect(f.runner.describe().bound).toBe(true);
  expect(f.interrupts() + f.closes()).toBe(0);
});
