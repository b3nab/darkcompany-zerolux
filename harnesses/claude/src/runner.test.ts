import { expect, test } from "bun:test";
import { basename, join } from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ChatHttpError,
  Transport,
  integrationCode,
  integrationRevision,
  type ChatRequest,
  type Inbox,
  type IntegrationCode,
} from "@zerolux/bridge";
import type { StartQuery } from "./agent.ts";
import type { ClaudeExecution } from "./execution.ts";
import { catalog, nativeCode, Runner } from "./runner.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fixture(
  saved = false,
  options: {
    systemPrompt?: "claude_code";
    execution?: ClaudeExecution;
    managed?: boolean;
    initial?: { model: string; effort: string };
    appliedModel?: string;
    subscriberStart?: (executable: string) => void;
    code?: IntegrationCode;
    native?: IntegrationCode;
    context?: (
      model: string,
    ) => Promise<{ totalTokens: number; maxTokens: number }>;
    rejectEffort?: boolean;
  } = {},
) {
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
  const sessions = new Map<string, Inbox["session"]>();
  let hold: Promise<void> | undefined;
  let savedGate: Promise<void> | undefined;
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
  const contextReads: { detail?: string }[] = [];
  let emit!: (m: SDKMessage) => void;
  let interrupts = 0,
    closes = 0;
  const reportedModel = options.appliedModel;
  const context = options.context;
  const rejectEffort = options.rejectEffort;
  const start: StartQuery = ({ prompt, options }) => {
    starts.push(options);
    let model = options.model ?? "native-model";
    let effort: string = options.effort ?? "high";
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
      initializationResult: async () => ({
        current_permission_mode: "default",
      }),
      supportedModels: async () =>
        ["native-model", "other-model"].map((value) => ({
          value,
          displayName: value,
          supportedEffortLevels: ["high"],
        })),
      getSettings: async () => ({
        applied: {
          model: reportedModel ?? model,
          effort,
        },
      }),
      setModel: async (value: string) => {
        model = value;
      },
      applyFlagSettings: async (values: { effortLevel?: string }) => {
        if (rejectEffort) throw new Error("native refusal");
        if (values.effortLevel) effort = values.effortLevel;
      },
      getContextUsage: async (options: { detail?: string }) => {
        contextReads.push(options);
        return context
          ? context(model)
          : {
              totalTokens: 42_000,
              maxTokens: model === "other-model" ? 1_000_000 : 200_000,
            };
      },
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
    {
      nativeSessionId: "native",
      workspace: "/work",
      mode: "default",
      initial: options.initial,
      ...(options.managed ? { managed: true } : {}),
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    },
    {
      start,
      connect,
      saved: async () => {
        await savedGate;
        return saved;
      },
      execution: options.execution,
      code: options.code,
      native: options.native,
      subscriber: () => ({
        start: async (executable, _base, token) => {
          options.subscriberStart?.(executable);
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
  const bind = (token: string, resume = false, executable = "/bin/zerolux") =>
    runner.handle("bind", {
      base_url: "http://127.0.0.1:4310",
      token,
      executable,
      resume,
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
    contextReads,
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
    slowSaved: (gate: Promise<void> | undefined) => {
      savedGate = gate;
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

test("unconfirmed startup settings cannot dispatch queued input or silently start again", async () => {
  const f = fixture(false, {
    initial: { model: "other-model", effort: "high" },
    appliedModel: "native-model",
  });
  f.message("waiting", "Queued before binding");
  try {
    await expect(f.bind("t1")).rejects.toThrow();
    await f.runner.agent.refresh();
    await expect(f.bind("t2")).rejects.toThrow();
    expect(f.starts).toHaveLength(1);
    expect(f.starts[0]).toMatchObject({ model: "other-model", effort: "high" });
    expect(f.inputs).toEqual([]);
    expect(f.calls.filter((call) => call.path.endsWith("/dispatch"))).toEqual(
      [],
    );
  } finally {
    f.runner.agent.close();
  }
});

test("binding and settings reads refresh native context without a turn or a new query", async () => {
  let window = 200_000;
  let fail = false;
  const f = fixture(false, {
    context: async (model) => {
      if (fail) throw new Error("context unavailable");
      return {
        totalTokens: 42_000,
        maxTokens: model === "other-model" ? 1_000_000 : window,
      };
    },
  });
  const usage = () =>
    f.calls
      .flatMap((c) => c.body?.changes ?? [])
      .filter((change: { type: string }) => change.type === "usage")
      .at(-1);
  try {
    const { link_id } = await f.bind("t1");
    await tick();
    expect(usage()).toMatchObject({ context_window: 200_000 });
    window = 500_000;
    await f.runner.handle("settings", { link_id });
    await tick();
    expect(usage()).toMatchObject({ context_window: 500_000 });
    await f.runner.handle("settings", {
      link_id,
      values: { model: "other-model" },
    });
    await tick();
    expect(usage()).toMatchObject({ context_window: 1_000_000 });
    const reads = f.contextReads.length;
    await f.runner.handle("settings", {
      link_id,
      values: { model: "native-model" },
      check: true,
    });
    expect(f.contextReads).toHaveLength(reads);
    expect(f.runner.agent.settings.values().model).toBe("other-model");
    fail = true;
    await f.runner.handle("settings", {
      link_id,
      values: { model: "native-model" },
    });
    await tick();
    expect(f.runner.agent.settings.values().model).toBe("native-model");
    expect(usage()).toMatchObject({
      context_window: null,
      context_tokens: null,
    });
    expect(f.contextReads.every((read) => read.detail === "summary")).toBe(
      true,
    );
    expect(f.inputs).toEqual([]);
    expect(f.starts).toHaveLength(1);
  } finally {
    f.runner.agent.close();
  }
});

test("context refresh preserves a setter failure after the model changed", async () => {
  const f = fixture(false, { rejectEffort: true });
  try {
    const { link_id } = await f.bind("t1");
    await tick();
    await expect(
      f.runner.handle("settings", {
        link_id,
        values: { model: "other-model", effort: "low" },
      }),
    ).rejects.toThrow();
    await tick();
    expect((await f.runner.agent.settings.read()).values.model).toBe(
      "other-model",
    );
    const usage = f.calls
      .flatMap((c) => c.body?.changes ?? [])
      .filter((change: { type: string }) => change.type === "usage");
    expect(usage.at(-1)).toMatchObject({ context_window: 1_000_000 });
    expect(f.inputs).toEqual([]);
    expect(f.starts).toHaveLength(1);
  } finally {
    f.runner.agent.close();
  }
});

test("binding does not wait for an unavailable context counter", async () => {
  let resolve!: (usage: { totalTokens: number; maxTokens: number }) => void;
  const f = fixture(false, {
    context: () => new Promise((done) => (resolve = done)),
  });
  try {
    const { link_id } = await f.bind("t1");
    expect(link_id).toBe("link");
    expect(f.runner.describe().bound).toBe(true);
    await tick();
    resolve({ totalTokens: 42_000, maxTokens: 1_000_000 });
    await tick();
    expect(f.inputs).toEqual([]);
  } finally {
    f.runner.agent.close();
  }
});

test.each([false, true])(
  "startup metadata is independent of transport binding (managed=%s)",
  async (managed) => {
    const f = fixture(false, { managed });
    let proceed = () => {};
    let binding: Promise<{ link_id: string }> | undefined;
    try {
      expect(f.runner.describe()).toMatchObject({
        started: false,
        bound: false,
      });
      f.failStart();
      await expect(f.bind("t1")).rejects.toThrow("subscriber failed");
      expect(f.runner.describe()).toMatchObject({
        started: false,
        bound: false,
      });
      expect(f.starts).toHaveLength(0);

      f.slowSaved(new Promise<void>((resolve) => (proceed = resolve)));
      binding = f.bind("t1");
      await tick();
      // A connected transport during preflight is not evidence of a native query.
      expect(f.runner.describe()).toMatchObject({
        started: false,
        bound: true,
      });
      expect(f.starts).toHaveLength(0);
      proceed();
      await binding;
      expect(f.runner.describe()).toMatchObject({ started: true, bound: true });
      await f.runner.handle("prepare", { link_id: "link" });
      expect(f.runner.describe()).toMatchObject({
        started: true,
        bound: false,
      });
      expect(f.closes()).toBe(0);
      await f.bind("t2");
      expect(f.runner.describe()).toMatchObject({ started: true, bound: true });
      expect(f.starts).toHaveLength(1);
      expect(f.inputs).toEqual([]);
      if (!managed) {
        expect(f.starts[0]!.hooks).toBeUndefined();
        expect(f.runner.describe()).not.toHaveProperty("native_guard");
      }
    } finally {
      proceed();
      await binding?.catch(() => {});
      f.runner.agent.close();
    }
  },
);

test("a required resume uses the saved native session and never substitutes a new one", async () => {
  const saved = fixture(true, { managed: true, systemPrompt: "claude_code" });
  const { link_id } = await saved.bind("t1", true);
  expect(saved.starts).toHaveLength(1);
  expect(saved.starts[0]?.resume).toBe("native");
  expect(saved.starts[0]?.sessionId).toBeUndefined();
  expect(saved.starts[0]).toMatchObject({
    permissionMode: "default",
    systemPrompt: { type: "preset", preset: "claude_code" },
  });
  expect(saved.starts[0]!.model).toBeUndefined();
  expect(saved.starts[0]!.effort).toBeUndefined();
  await saved.runner.handle("stop", { link_id });

  const missing = fixture();
  await expect(missing.bind("t1", true)).rejects.toThrow();
  expect(missing.starts).toHaveLength(0);
  expect(missing.inputs).toHaveLength(0);
  expect(missing.subscribers.stopped).toBe(1);
  await missing.runner.handle("stop", { link_id: "link" });
});

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

test("a surviving legacy subscriber can recover with the desktop's compatible executable without restarting or resending", async () => {
  const f = fixture(false, {
    managed: true,
    subscriberStart: (executable) => {
      // The already running bridge retains the earlier executable-name contract.
      if (basename(executable) !== "zerolux")
        throw new Error("Expected the installed ZeroLux executable");
    },
  });
  try {
    const { link_id } = await f.bind("cli");
    f.message("in-flight", "work already sent");
    await f.runner.agent.refresh();
    f.state("running");
    await tick();
    expect(f.inputs).toHaveLength(1);
    expect(f.inbox.deliveries[0]?.status).toBe("uncertain");
    const inputs = structuredClone(f.inputs);

    await f.runner.handle("prepare", { link_id });
    await expect(
      f.bind(
        "failed-desktop",
        true,
        "/Applications/ZeroLux.app/Contents/MacOS/zerolux-desktop",
      ),
    ).rejects.toThrow();
    expect(f.runner.describe()).toMatchObject({ started: true, bound: false });

    expect(
      await f.bind(
        "desktop",
        true,
        "/Applications/ZeroLux.app/Contents/MacOS/zerolux",
      ),
    ).toEqual({ link_id });
    await f.runner.agent.refresh();
    await tick();
    expect(f.runner.describe()).toMatchObject({
      native_session_id: "native",
      started: true,
      bound: true,
    });
    expect(f.starts).toHaveLength(1);
    expect(f.interrupts() + f.closes()).toBe(0);
    expect(f.inputs).toEqual(inputs);
    expect(f.subscribers.started).toEqual(["cli", "desktop"]);
    expect(
      f.calls.filter((call) => call.path.endsWith("/dispatch")),
    ).toHaveLength(1);
  } finally {
    f.runner.agent.close();
  }
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
  await expect(transport.request("/chat/inbox")).rejects.toThrow();
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
  await expect(transport.request("/chat/inbox")).rejects.toThrow();
  answer();
  await expect(claim).rejects.toThrow();
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

test("a managed Stop observed during preflight prevents query startup", async () => {
  const f = fixture(false, { managed: true });
  let release!: () => void;
  f.slowSaved(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const binding = f.bind("t1").then(
    () => undefined,
    (error) => error as Error,
  );
  try {
    await tick();
    const stopping = f.runner.handle("stop", { link_id: "link" });
    release();
    expect(await binding).toBeInstanceOf(Error);
    await stopping;
    expect(f.starts).toHaveLength(0);
    expect(f.inputs).toHaveLength(0);
  } finally {
    release();
    await f.runner.handle("stop", { link_id: "link" });
  }
});

test("Stop during identity lookup preempts only the link actually named by bind", async () => {
  for (const id of ["link", "unrelated"]) {
    const f = fixture(false, { managed: true });
    let release!: () => void;
    f.hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const binding = f.bind("t1").then(
      () => undefined,
      (error) => error as Error,
    );
    try {
      await tick();
      const stopping = f.runner.handle("stop", { link_id: id }).then(
        () => undefined,
        (error) => error as Error,
      );
      f.hold(undefined);
      release();
      if (id === "link") {
        expect(await binding).toBeInstanceOf(Error);
        expect(await stopping).toBeUndefined();
        expect(f.starts).toHaveLength(0);
      } else {
        expect(await binding).toBeUndefined();
        expect(await stopping).toBeInstanceOf(Error);
        expect(f.starts).toHaveLength(1);
      }
    } finally {
      release();
      await f.runner.handle("stop", { link_id: "link" });
    }
  }
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

test("managed startup enables Chrome and uses the native preset without model or effort overrides", async () => {
  const f = fixture(false, { managed: true, systemPrompt: "claude_code" });
  await f.bind("t1");
  expect(f.starts[0]).toMatchObject({
    sessionId: "native",
    permissionMode: "default",
    extraArgs: { chrome: null },
    systemPrompt: { type: "preset", preset: "claude_code" },
  });
  for (const key of ["model", "effort", "hooks"])
    expect(f.starts[0]).not.toHaveProperty(key);
  await f.runner.handle("stop", { link_id: "link" });
});

test("managed startup exposes native session state events to the adapter", async () => {
  const f = fixture(false, { managed: true });
  await f.bind("t1");
  expect(f.starts[0]?.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe("1");
  await f.runner.handle("stop", { link_id: "link" });
});

test("host shutdown waits for actual native exit", async () => {
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => (exit = resolve));
  const execution = {
    requestStop() {},
    describe: () => ({ native_pid: 1, native_phase: "running" }),
    waitForExit: () => exited,
  } as unknown as ClaudeExecution;
  const f = fixture(true, { managed: true, execution });
  await f.bind("t1", true);
  let closed = false;
  const closing = f.runner.closeNative().then(() => {
    closed = true;
  });
  try {
    await tick();
    expect(closed).toBe(false);
  } finally {
    exit();
    await closing;
  }
  expect(closed).toBe(true);
});

test("a native executable update uses the existing checkpoint and waits for native exit without owner input", async () => {
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => (exit = resolve));
  const revision = "a".repeat(64);
  const native = { revision: "old-native", current: () => "new-native" };
  const execution = {
    requestStop() {},
    describe: () => ({ native_pid: 1, native_phase: "running" }),
    waitForExit: () => exited,
  } as unknown as ClaudeExecution;
  const f = fixture(true, {
    managed: true,
    execution,
    code: { revision, current: () => revision },
    native,
  });
  const request = { link_id: "link", revision, native_revision: "new-native" };
  try {
    await f.bind("t1", true);
    await tick();
    expect(f.runner.describe().native_revision).toBe(native.revision);
    expect(await f.runner.handle("update", request)).toMatchObject({
      ready: true,
      settings: {
        model: "native-model",
        effort: "high",
        permission_mode: "default",
      },
    });
    let committed = false;
    const committing = f.runner.handle("update_commit", request).then(() => {
      committed = true;
    });
    await tick();
    expect(committed).toBe(false);
    expect(f.closes()).toBe(1);
    expect(f.inputs).toHaveLength(0);
    exit();
    await committing;
    expect(committed).toBe(true);
    expect(f.starts).toHaveLength(1);
    expect(f.interrupts()).toBe(0);
  } finally {
    exit();
    f.runner.agent.close();
  }
});

test("native updates wait for existing work and refuse a changed executable checkpoint", async () => {
  const revision = "a".repeat(64);
  let installed = "new-native";
  const execution = {
    requestStop() {},
    describe: () => ({ native_pid: 1, native_phase: "running" }),
    waitForExit: async () => {},
  } as unknown as ClaudeExecution;
  const f = fixture(true, {
    managed: true,
    execution,
    code: { revision, current: () => revision },
    native: { revision: "old-native", current: () => installed },
  });
  const request = { link_id: "link", revision, native_revision: installed };
  try {
    await f.bind("t1", true);
    f.state("running");
    await tick();
    expect(await f.runner.handle("update", request)).toEqual({ pending: true });
    expect(f.closes()).toBe(0);
    f.state("idle");
    await tick();
    expect(await f.runner.handle("update", request)).toMatchObject({
      ready: true,
    });
    installed = "another-native";
    await expect(f.runner.handle("update_commit", request)).rejects.toThrow();
    expect(f.runner.describe().bound).toBe(true);
    expect(f.closes()).toBe(0);
    expect(f.inputs).toHaveLength(0);
  } finally {
    f.runner.agent.close();
  }
});

test("an update verifies the target in another immutable release directory without replacing the old entry", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zcl-release-")));
  const oldEntry = join(root, "old", "runner.js");
  const entry = join(root, "new", "runner.js");
  await mkdir(join(root, "old"));
  await mkdir(join(root, "new"));
  await writeFile(oldEntry, "old release");
  await writeFile(entry, "new release");
  const code = integrationCode(pathToFileURL(oldEntry).href)!;
  const revision = integrationRevision(entry);
  const execution = {
    requestStop() {},
    describe: () => ({ native_pid: 1, native_phase: "running" }),
    waitForExit: async () => {},
  } as unknown as ClaudeExecution;
  const f = fixture(true, { managed: true, execution, code });
  try {
    await f.bind("t1", true);
    expect(f.runner.describe().capabilities).toContain("integration-target-v1");
    // The old protocol cannot authorize another immutable directory.
    expect(
      await f.runner.handle("update", { link_id: "link", revision }),
    ).toEqual({ pending: false });
    const request = { link_id: "link", revision, entry };
    expect(await f.runner.handle("update", request)).toMatchObject({
      ready: true,
    });
    await expect(
      f.runner.handle("update_commit", { ...request, entry: oldEntry }),
    ).rejects.toThrow();
    expect(f.closes()).toBe(0);
    await writeFile(entry, "changed target");
    await expect(f.runner.handle("update_commit", request)).rejects.toThrow();
    expect(f.closes()).toBe(0);
    expect(f.inputs).toHaveLength(0);
    await writeFile(entry, "new release");
    expect(await f.runner.handle("update", request)).toMatchObject({
      ready: true,
    });
    expect(await f.runner.handle("update_commit", request)).toEqual({
      updating: true,
    });
    expect(f.starts).toHaveLength(1);
    expect(f.inputs).toHaveLength(0);
    expect(await readFile(oldEntry, "utf8")).toBe("old release");
    expect(code.current()).toBe(code.revision);
  } finally {
    f.runner.agent.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an integration update still accepts the existing protocol without a native revision", async () => {
  const revision = "b".repeat(64);
  const execution = {
    requestStop() {},
    describe: () => ({ native_pid: 1, native_phase: "running" }),
    waitForExit: async () => {},
  } as unknown as ClaudeExecution;
  const f = fixture(true, {
    managed: true,
    execution,
    code: { revision: "a".repeat(64), current: () => revision },
  });
  const request = { link_id: "link", revision };
  try {
    await f.bind("t1", true);
    expect(await f.runner.handle("update", request)).toMatchObject({
      ready: true,
    });
    expect(await f.runner.handle("update_commit", request)).toEqual({
      updating: true,
    });
    expect(f.closes()).toBe(1);
    expect(f.starts).toHaveLength(1);
    expect(f.inputs).toHaveLength(0);
  } finally {
    f.runner.agent.close();
  }
});

test("a model catalog initializes the chosen executable without sending input, saving a session or running integrations", async () => {
  const inputs: SDKUserMessage[] = [];
  let options!: Options;
  let drained!: Promise<void>;
  let closes = 0;
  let disposed = 0;
  const start: StartQuery = ({ prompt, options: given }) => {
    options = given;
    drained = (async () => {
      for await (const input of prompt) inputs.push(input);
    })();
    return {
      supportedModels: async () => [
        {
          value: "native-alias",
          resolvedModel: "native-version",
          displayName: "A model",
          supportedEffortLevels: ["high"],
        },
      ],
      close: () => {
        closes++;
      },
      return: async () => {
        disposed++;
        return { done: true, value: undefined };
      },
    } as unknown as Query;
  };
  const models = await catalog(start, "/project", "/installed/claude");
  await drained;
  expect(options).toMatchObject({
    cwd: "/project",
    pathToClaudeCodeExecutable: "/installed/claude",
    persistSession: false,
    tools: [],
    mcpServers: {},
    strictMcpConfig: true,
    settings: { disableAllHooks: true },
  });
  expect(options.resume).toBeUndefined();
  expect(options.sessionId).toBeUndefined();
  expect(inputs).toHaveLength(0);
  expect(
    models.map(({ value, resolved_model, efforts }) => ({
      value,
      resolved_model,
      efforts,
    })),
  ).toEqual([
    {
      value: "native-alias",
      resolved_model: "native-version",
      efforts: ["high"],
    },
  ]);
  expect(closes).toBe(1);
  expect(disposed).toBe(1);
});

test("a failed or timed out catalog disposes its native query and closes the empty input", async () => {
  for (const fail of [true, false]) {
    let closed = 0;
    let drained!: Promise<IteratorResult<SDKUserMessage>>;
    const start: StartQuery = ({ prompt }) => {
      drained = prompt[Symbol.asyncIterator]().next();
      return {
        supportedModels: () =>
          fail
            ? Promise.reject(new Error("Unavailable"))
            : new Promise(() => {}),
        close: () => {
          closed++;
        },
        return: async () => ({ done: true, value: undefined }),
      } as unknown as Query;
    };
    await expect(
      catalog(start, "/project", "/installed/claude", 1),
    ).rejects.toThrow();
    expect((await drained).done).toBe(true);
    expect(closed).toBe(1);
  }
});

test("native revisions identify the actual installed file and change when it is replaced", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zcl-native-")));
  try {
    const path = join(root, "claude");
    await writeFile(path, "first executable");
    const code = nativeCode(path)!;
    expect(code.executable).toBe(path);
    expect(JSON.parse(code.revision)).toHaveLength(3);
    expect(code.current()).toBe(code.revision);
    await writeFile(path, "second executable, replaced");
    expect(code.current()).not.toBe(code.revision);
    await writeFile(path, "");
    expect(nativeCode(path)).toBeUndefined();
    expect(() => code.current()).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
