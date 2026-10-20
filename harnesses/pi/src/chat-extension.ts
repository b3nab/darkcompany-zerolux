import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  AgentLinkChild,
  ChatBridge,
  Transport,
  chatRequest,
  localURL,
  nativeFingerprint,
  integrationCode,
  listTasks,
  readSession,
  readTask,
  sendSession,
  startSession,
  startTask,
  stopSession,
  stopTask,
  type ChatHost,
  type LiveChange,
} from "@zerolux/bridge";
import { ChatControl, type PairRequest } from "./chat-control.ts";
import { PiSettings } from "./settings.ts";
import { listMetadata } from "./discover.ts";
import { checkTerminalTakeover } from "./terminal-takeover.ts";
import { installWake } from "./wake.ts";
import {
  verifyManaged,
  canPairManaged,
  reportManagedLinks,
  nativeMetadata,
  type NativeMetadata,
} from "./managed.ts";

export const CHAT_MESSAGE = "zerolux-chat-delivery";

/** A message entered pi's context: a chat envelope is read; anything else is the owner's. */
export function messageStarted(
  bridges: ChatBridge | ChatBridge[] | undefined,
  message: unknown,
  queued?: Map<string, string[]>,
) {
  const all = bridges === undefined ? [] : [bridges].flat();
  const m = message as
    | {
        role?: string;
        customType?: string;
        details?: { deliveryIds?: string[] };
        content?: string | { type: string; text?: string }[];
      }
    | undefined;
  const ids =
    m?.role === "custom" && m.customType === CHAT_MESSAGE
      ? (m.details?.deliveryIds ?? [])
      : [];
  let privateText = false;
  if (m?.role === "user" && queued) {
    let text =
      typeof m.content === "string"
        ? m.content
        : (m.content ?? [])
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("\n");
    for (const [content, delivered] of queued) {
      if (!text.includes(content)) continue;
      ids.push(...delivered);
      text = text.replace(content, "");
      queued.delete(content);
    }
    // Escape may restore several steers to the native editor. Added owner text
    // still makes this their private turn, even when it includes our envelopes.
    privateText =
      Boolean(text.trim()) ||
      (Array.isArray(m.content) && m.content.some((p) => p.type !== "text"));
  }
  if (privateText) for (const bridge of all) bridge.privateInput();
  // A delivery is one link's: the others see nothing of it.
  const fingerprint = ids.length ? nativeFingerprint(message) : undefined;
  const readings = ids.flatMap((id) =>
    all.flatMap((bridge) => bridge.read(id, fingerprint) ?? []),
  );
  if (readings.length) return Promise.all(readings).then(() => {});
  if (
    !privateText &&
    ["user", "custom", "bashExecution"].includes(m?.role ?? "")
  )
    for (const bridge of all) bridge.privateInput();
}

/** A passive factory; session_start advertises local presence, only Hire pairs the link. */
/** One kernel's link to this pi session: an agent can work in several workspaces at once. */
interface Link {
  bridge: ChatBridge;
  transport: Transport;
  child?: AgentLinkChild;
  linkId?: string;
  token?: string;
  base?: string;
}

/** The key of a link: its workspace. A kernel that names none gets the legacy single slot. */
const LEGACY = "";

/**
 * Runs one of this extension's own commands. pi dispatches an extension command only when
 * the message asks for it; otherwise the model would receive the command as text.
 */
export function runCommand(
  pi: Pick<ExtensionAPI, "sendUserMessage">,
  args: string,
  deliverAs?: "followUp",
) {
  pi.sendUserMessage(`/zerolux-chat ${args}`, {
    expandPromptTemplates: true,
    ...(deliverAs ? { deliverAs } : {}),
  });
}
/** The tools an agent's session takes part in chats with. */
const CHAT_TOOLS = [
  "zerolux_send",
  "zerolux_thread",
  "zerolux_close_thread",
  "zerolux_session_start",
  "zerolux_session_read",
  "zerolux_session_send",
  "zerolux_session_stop",
];
const installedCode = integrationCode(import.meta.url);

export default function chatExtension(pi: ExtensionAPI) {
  // An explicit --extension may also be installed in the project. One native
  // runtime gets one bridge, not two competing descriptors/tool registrations.
  let installed = false;
  pi.events.emit("zerolux:query-chat", {
    reply: () => {
      installed = true;
    },
  });
  if (installed) return;
  let control: ChatControl | undefined;
  /** By workspace ID. Each link has its own kernel, token, deliveries and replies. */
  const links = new Map<string, Link>();
  const queuedInputs = new Map<string, string[]>();
  /** The owner's direct inputs waiting to be seen entering pi's context. */
  const ownerInputs = new Set<{
    text: string;
    expanded: boolean;
    seen: () => void;
  }>();
  const bridges = () => [...links.values()].map((link) => link.bridge);
  let pairing = false;
  let takingOver = false;
  let disposed = false;
  let stopping: Promise<void> | undefined;
  let settled = true;
  // Removing a workspace cannot unmix the running native turn.
  let dialogShared = true;
  let uiPrompts = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let context: ExtensionContext | undefined;
  let pendingUpdate: { linkId: string; revision: string } | undefined;
  let updateQueued = false;
  let managed: Awaited<ReturnType<typeof verifyManaged>>;
  let metadata: NativeMetadata = { pid: process.pid };
  pi.on("session_start", async (_event, ctx) => {
    try {
      managed = await verifyManaged(pi, ctx);
    } catch {
      // Only the newly launched, explicitly marked RPC process. An ordinary hook throw
      // is swallowed by pi and would let startup work continue under the wrong profile.
      console.error(
        "ZeroLux refused native pi startup: entrusted identity/profile was not verified",
      );
      process.exit(3);
    }
    metadata = await nativeMetadata(ctx, managed);
  });
  const leaveWake = installWake(pi, join(getAgentDir(), "zerolux-wake"));

  const active = () =>
    Boolean(
      stopping ||
      pairing ||
      takingOver ||
      bridges().some((bridge) => bridge.connected),
    );
  const busyChanged = () => pi.events.emit("zerolux:chat-active", active());
  const unsubscribe = pi.events.on("zerolux:query-chat", (query) => {
    if (
      query &&
      typeof query === "object" &&
      "reply" in query &&
      typeof query.reply === "function"
    )
      query.reply(active());
  });
  /**
   * Chat tools belong to an agent's session. With only sessions of the owner's own linked
   * they are put away; a link being replaced leaves them as they are.
   */
  const chatTools = () => {
    const linked = bridges().filter((bridge) => bridge.connected);
    if (!linked.length) return;
    const agent = linked.some((bridge) => bridge.agent);
    const active = pi.getActiveTools();
    const wanted = agent
      ? [...new Set([...active, ...CHAT_TOOLS])]
      : active.filter((tool) => !CHAT_TOOLS.includes(tool));
    if (wanted.length !== active.length) pi.setActiveTools(wanted);
  };
  const status = () => {
    chatTools();
    const connected = bridges().filter((bridge) => bridge.connected).length;
    context?.ui.setStatus(
      "zerolux-chat",
      connected === 0
        ? undefined
        : connected === 1
          ? "chat: connected"
          : `chat: connected (${connected} workspaces)`,
    );
  };
  const cancelUpdate = () => {
    pendingUpdate = undefined;
    for (const bridge of bridges()) bridge.resumeInput();
  };
  const updateIdle = () =>
    !disposed &&
    !pairing &&
    !takingOver &&
    !stopping &&
    settled &&
    uiPrompts === 0 &&
    context?.isIdle() &&
    !context.hasPendingMessages() &&
    queuedInputs.size === 0 &&
    bridges().every((bridge) => !bridge.busy && !bridge.syncing);
  const scheduleUpdate = () => {
    if (!pendingUpdate || updateQueued || !updateIdle()) return;
    try {
      if (installedCode?.current() !== pendingUpdate.revision) {
        cancelUpdate();
        return;
      }
      updateQueued = true;
      // A native extension command, not model input; no autowake or new inference.
      runCommand(pi, "auto-reload", "followUp");
    } catch {
      cancelUpdate();
    }
  };
  /** Ends one link (its workspace) or all of them. Never Stops the agent. */
  const stop = (key?: string): Promise<void> => {
    // Wait for cleanup, then apply this request too: it may name another workspace.
    if (stopping) return stopping.then(() => stop(key));
    const ending =
      key === undefined
        ? [...links.entries()]
        : [...links.entries()].filter(([k]) => k === key);
    if (
      ending.some(([, link]) => link.bridge.sessionId === pendingUpdate?.linkId)
    )
      cancelUpdate();
    for (const [k] of ending) links.delete(k);
    if (links.size === 0 && refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
    stopping = (async () => {
      for (const [, link] of ending) {
        await link.bridge.stop();
        link.transport.close();
        await link.child?.stop();
      }
      status();
    })().finally(() => {
      stopping = undefined;
      busyChanged();
    });
    return stopping;
  };
  const refresh = () => {
    if (disposed || takingOver) return;
    for (const [key, link] of links) {
      const current = link.bridge;
      void current
        .invalidate()
        .then(() => {
          if (links.get(key)?.bridge === current && !current.connected)
            return stop(key);
          scheduleUpdate();
        })
        .catch(() => {});
    }
  };

  const host = (
    ctx: ExtensionContext,
    workspace: string,
    linkKey: string,
  ): ChatHost => ({
    harness: "pi",
    nativeSessionId: ctx.sessionManager.getSessionId(),
    workspace,
    idle: () => settled && ctx.isIdle() && !ctx.hasPendingMessages(),
    // Everything waiting in one message: pi steers one queued message per step.
    send: (batches) => {
      if (takingOver)
        throw new Error("Native pi is handing over its execution");
      if (links.size > 1) dialogShared = true;
      const content = batches.map((batch) => batch.content).join("\n\n");
      queuedInputs.set(
        content,
        batches.map((batch) => batch.id),
      );
      // Use pi's actual text-steering queue. Custom-message steers are invisible to
      // its pending-input UI and are discarded by Escape's clear/restore operation.
      // Native text steers remain visible/editable there; we never resubmit a claim.
      pi.sendUserMessage(content, { deliverAs: "steer" });
    },
    abort: () => {
      // A native abort affects every workspace, including steers not yet presented.
      // A bridge's turn ownership cannot establish exclusive native ownership.
      if (![...links.keys()].some((key) => key !== linkKey)) void ctx.abort();
    },
    notify: (message) => {
      if (!disposed) {
        ctx.ui.notify(message, "warning");
        ctx.ui.setStatus("zerolux-chat", "chat: attention");
      }
    },
  });

  async function pair(
    init: PairRequest,
    ctx: ExtensionContext,
    workspace: string,
  ): Promise<string> {
    await canPairManaged(managed);
    if (takingOver) throw new Error("Native pi is handing over its execution");
    const origin = localURL(init.base_url);
    // A kernel names its workspace; one that does not (older) gets the single legacy slot,
    // and only while no other workspace is linked.
    const key = init.workspace_id ?? LEGACY;
    if (
      key === LEGACY
        ? [...links.keys()].some((k) => k !== LEGACY)
        : links.has(LEGACY)
    )
      throw new Error(
        "This pi session is linked by a kernel that does not name its workspace; update it before linking several workspaces",
      );
    const existing = links.get(key);
    if (!existing && links.size > 0 && (!settled || !ctx.isIdle()))
      dialogShared = true;
    if (
      !pairing &&
      !stopping &&
      existing?.bridge.connected &&
      existing.token === init.token &&
      existing.base === origin &&
      existing.linkId
    )
      return existing.linkId;
    // A new token for a live link of the same workspace is its kernel relinking this
    // session (the control socket already verified it), e.g. after a restart: replace the
    // link without waiting for pi to be idle, and keep the open turn.
    const previous =
      !disposed && !pairing && !stopping && existing?.bridge.connected
        ? existing.bridge
        : undefined;
    // A busy pi pairs too: the kernel checks before a first hire and relinks regardless
    // (e.g. right after a reload), and chat messages join a running turn anyway.
    if (!previous && (disposed || stopping || pairing || existing))
      throw new Error("Pi's chat is already connecting");
    pairing = true;
    busyChanged();
    const native = host(ctx, workspace, key);
    // Revocation is not Stop: the kernel rotates tokens during a relink. Use the same
    // suspended transport as the Claude runner so open work survives either race order.
    const transport = new Transport(() =>
      native.notify(
        "The ZeroLux link lost authorization. Native work continues while the link is rebound.",
      ),
    );
    transport.bind(chatRequest(origin, init.token));
    const next = new ChatBridge(native, transport.request);
    // An off during the identity request must close this pending pair too.
    if (!previous) links.set(key, { bridge: next, transport });
    const mine = () => links.get(key);
    try {
      // Check the private bearer against this exact native session before doing anything else.
      await next.connect();
      if (disposed || mine()?.bridge !== (previous ?? next) || !next.connected)
        throw new Error("Pi changed while pairing");
      if (previous) {
        next.adopt(previous.handOff());
        // From here pi's events (input, context, end of turn) reach the new link, also
        // while the old subscriber is still stopping.
        const old = mine()!;
        links.set(key, { bridge: next, transport });
        old.transport.close();
        await old.child?.stop();
        // A Stop or shutdown while the old subscriber was stopping ends this relink too.
        if (disposed || mine()?.bridge !== next || !next.connected)
          throw new Error("Pairing was stopped");
      }
      const subscriber = new AgentLinkChild(refresh, () => {
        void next.attention(
          "LiveKit subscriber stopped; no prompt will be retried automatically",
        );
      });
      const link: Link = {
        bridge: next,
        transport,
        child: subscriber,
        token: init.token,
        base: origin,
        linkId: randomUUID(),
      };
      links.set(key, link);
      // The first invalidation also publishes a reply carried over from a relink.
      await subscriber.start(
        await realpath(init.executable),
        origin,
        init.token,
      );
      if (disposed || mine() !== link) throw new Error("Pairing was stopped");
      await next.ready();
      if (disposed || mine() !== link || !next.connected || !link.linkId)
        throw new Error("Pairing was stopped");
      status();
      await reportManagedLinks(
        managed,
        bridges().flatMap((bridge) =>
          bridge.sessionId ? [bridge.sessionId] : [],
        ),
        control
          ? join(getAgentDir(), "zerolux-links", `${control.instanceId}.json`)
          : undefined,
      ).catch(() => {});
      return link.linkId;
    } catch (error) {
      if (previous) {
        // A failed rebind must not cancel the open native turn. Before handoff the old
        // link remains; afterwards the new one keeps its state for the next verified pair.
        transport.close();
        if (mine()?.bridge === next) await mine()?.child?.stop();
        else await next.stop(); // Never adopted, or already explicitly stopped.
      } else {
        await next.stop();
        await stop(key);
      }
      throw error;
    } finally {
      pairing = false;
      busyChanged();
    }
  }

  /** The one link whose workspace has this chat. Never a guess: zero or several is an error. */
  const linkOf = (chat: string): ChatBridge => {
    const connected = bridges().filter((bridge) => bridge.connected);
    if (connected.length === 0) throw new Error("No ZeroLux chat is connected");
    const known = connected.filter((bridge) => bridge.knows(chat));
    if (known.length === 1) return known[0]!;
    throw new Error(
      known.length === 0
        ? "This chat belongs to none of the connected ZeroLux workspaces"
        : "This chat ID exists in several connected workspaces; it cannot be addressed",
    );
  };

  pi.registerTool({
    name: "zerolux_send",
    label: "ZeroLux message",
    description: "Post to a ZeroLux chat or thread.",
    parameters: Type.Object({
      chat: Type.String({ description: "Chat ID" }),
      text: Type.String({ description: "Message" }),
      reply_to: Type.Optional(
        Type.String({
          description: "Delivery ID answered",
        }),
      ),
    }),
    async execute(_id, args, signal) {
      if (signal?.aborted)
        throw new Error("Message cancelled before publication");
      const outcome = await linkOf(args.chat).post(
        args.chat,
        args.text,
        args.reply_to,
      );
      return {
        content: [
          {
            type: "text",
            text:
              outcome === "published"
                ? "Message saved in ZeroLux."
                : "ZeroLux is unreachable right now; your message is kept and will be published once it is back. Do not send it again.",
          },
        ],
        details: undefined,
      };
    },
  });
  pi.registerTool({
    name: "zerolux_thread",
    label: "ZeroLux thread",
    description: "Open or join the agents' thread on a chat message.",
    parameters: Type.Object({
      chat: Type.String({ description: "Parent chat ID" }),
      on: Type.String({ description: "Message or delivery ID" }),
      title: Type.String({ description: "Subject" }),
      with: Type.Optional(
        Type.Array(Type.String(), {
          description: "Agent names",
        }),
      ),
    }),
    async execute(_id, args, signal) {
      if (signal?.aborted) throw new Error("Thread cancelled before opening");
      const thread = await linkOf(args.chat).openThread(
        args.chat,
        args.on,
        args.title,
        args.with ?? [],
      );
      return {
        content: [
          {
            type: "text",
            text: `${thread.created ? "Opened" : "Joined"} the thread ${JSON.stringify(thread.title)}: write in it with zerolux_send, chat ${JSON.stringify(thread.id)}.`,
          },
        ],
        details: undefined,
      };
    },
  });
  pi.registerTool({
    name: "zerolux_close_thread",
    label: "Close ZeroLux thread",
    description: "Close a ZeroLux thread you participate in.",
    executionMode: "sequential",
    parameters: Type.Object({
      chat: Type.String({
        description: "Thread chat ID",
      }),
    }),
    async execute(_id, args, signal) {
      if (signal?.aborted)
        throw new Error("Thread closure cancelled before sending");
      const thread = await linkOf(args.chat).closeThread(args.chat);
      return {
        content: [
          {
            type: "text",
            text: `Closed the thread ${JSON.stringify(thread.title)}.`,
          },
        ],
        details: undefined,
      };
    },
  });
  // Sessions this one starts, follows and steers to delegate work, through its agent's link.
  const delegating = () => {
    const linked = bridges().filter(
      (bridge) => bridge.connected && bridge.agent,
    );
    if (linked.length !== 1)
      throw new Error(
        linked.length
          ? "Several ZeroLux workspaces are linked; delegate from one"
          : "No ZeroLux chat is connected",
      );
    const bridge = linked[0]!;
    return <T>(path: string, body?: unknown) => bridge.call<T>(path, body);
  };
  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: undefined,
  });
  pi.registerTool({
    name: "zerolux_session_start",
    label: "ZeroLux session",
    description: "Start a session to delegate work to.",
    parameters: Type.Object({
      harness: Type.Union(
        [
          Type.Literal("claude-code"),
          Type.Literal("codex"),
          Type.Literal("pi"),
        ],
        { description: "Harness" },
      ),
      prompt: Type.String({ description: "The work, as its first input" }),
      workspace: Type.Optional(
        Type.String({ description: "Absolute folder; yours by default" }),
      ),
      model: Type.Optional(Type.String({ description: "Model" })),
      effort: Type.Optional(Type.String({ description: "Effort" })),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      const session = await startSession(delegating(), {
        ...args,
        workspace: args.workspace ?? ctx.cwd,
      });
      return result({ id: session.id, title: session.title });
    },
  });
  pi.registerTool({
    name: "zerolux_session_read",
    label: "ZeroLux session",
    description: "Read a delegated session: its state and last answer.",
    parameters: Type.Object({
      id: Type.String({ description: "Session ID" }),
    }),
    async execute(_id, args) {
      return result(await readSession(delegating(), args.id));
    },
  });
  pi.registerTool({
    name: "zerolux_session_send",
    label: "ZeroLux session",
    description: "Write to a delegated session.",
    parameters: Type.Object({
      id: Type.String({ description: "Session ID" }),
      text: Type.String({ description: "Message" }),
      mode: Type.Optional(
        Type.Union(
          [
            Type.Literal("steer"),
            Type.Literal("queue"),
            Type.Literal("interrupt"),
          ],
          {
            description: "While it works: into its turn, after it, or instead",
          },
        ),
      ),
    }),
    async execute(_id, args) {
      await sendSession(delegating(), args.id, args.text, args.mode);
      return result({ sent: true });
    },
  });
  pi.registerTool({
    name: "zerolux_session_stop",
    label: "ZeroLux session",
    description: "Stop a delegated session.",
    parameters: Type.Object({
      id: Type.String({ description: "Session ID" }),
    }),
    async execute(_id, args) {
      await stopSession(delegating(), args.id);
      return result({ stopped: true });
    },
  });
  // Commands this session runs in the background, through its own link.
  const own = () => {
    const linked = bridges().filter((bridge) => bridge.connected);
    if (linked.length !== 1 || !linked[0]!.sessionId)
      throw new Error(
        linked.length
          ? "Several ZeroLux workspaces are linked; run tasks from one"
          : "No ZeroLux link is connected",
      );
    const bridge = linked[0]!;
    return {
      session: bridge.sessionId!,
      call: <T>(path: string, body?: unknown) => bridge.call<T>(path, body),
    };
  };
  pi.registerTool({
    name: "zerolux_task_start",
    label: "ZeroLux task",
    description:
      "Run a command in the background, in your folder. Returns at once; when it ends, its exit code and the end of its output arrive as a message.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command" }),
    }),
    async execute(_id, args) {
      const { session, call } = own();
      const task = await startTask(call, session, args.command);
      return result({ id: task.id, status: task.status });
    },
  });
  pi.registerTool({
    name: "zerolux_task_read",
    label: "ZeroLux task",
    description:
      "A background task's status and output: from `after`, or its end.",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID" }),
      after: Type.Optional(Type.Number({ description: "Byte offset" })),
    }),
    async execute(_id, args) {
      return result(await readTask(own().call, args.id, args.after));
    },
  });
  pi.registerTool({
    name: "zerolux_task_stop",
    label: "ZeroLux task",
    description: "Stop a background task.",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID" }),
    }),
    async execute(_id, args) {
      const task = await stopTask(own().call, args.id);
      return result({ id: task.id, status: task.status });
    },
  });
  pi.registerTool({
    name: "zerolux_tasks",
    label: "ZeroLux task",
    description: "Your background tasks, newest first.",
    parameters: Type.Object({}),
    async execute() {
      const { session, call } = own();
      const tasks = await listTasks(call, session);
      return result(
        tasks.map(({ id, command, status, exit_code }) => ({
          id,
          command,
          status,
          exit_code,
        })),
      );
    },
  });
  pi.registerTool({
    name: "zerolux_reload",
    label: "Reload pi",
    description:
      "Reload pi's extensions, skills and context files once your current turn ends, e.g. to load new ZeroLux extension code. The ZeroLux chat reconnects by itself within seconds. After the reload you are woken up automatically with your `then` note, so nobody has to write to you: say there what you were doing and what to do next.",
    parameters: Type.Object({
      then: Type.Optional(
        Type.String({
          description:
            "Note to yourself, delivered as a message once pi is back, e.g. 'Run the web search on pi with sonnet in research mode'",
        }),
      ),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      await leaveWake(ctx.sessionManager.getSessionId(), args.then);
      // Tools cannot reload; the command does, once pi is idle.
      runCommand(pi, "reload");
      return {
        content: [
          {
            type: "text",
            text: "pi will reload when this turn ends, then wake you up with your note. End your turn now.",
          },
        ],
        details: undefined,
      };
    },
  });
  pi.registerCommand("zerolux-chat", {
    description:
      "ZeroLux chat: status | off | reload (pair from the ZeroLux Team page)",
    handler: async (args, ctx) => {
      if (args.trim() === "off") {
        await stop();
        return;
      }
      if (args.trim() === "auto-reload") {
        const update = pendingUpdate;
        if (!update) return;
        try {
          await ctx.waitForIdle();
          await Promise.all(bridges().map((bridge) => bridge.pauseInput()));
          const link = [...links.values()].find(
            (link) => link.bridge.sessionId === update.linkId,
          );
          if (!link?.bridge.connected || pendingUpdate !== update) return;
          const { session } = await link.transport.request<{
            session: { id: string; status: string };
          }>("/chat/inbox");
          if (
            session.id !== update.linkId ||
            session.status === "stopped" ||
            installedCode?.current() !== update.revision
          ) {
            cancelUpdate();
            return;
          }
          if (!updateIdle()) return;
          // No pending native input, receipts, replies or dialogs are discarded.
          // Detach quietly: this is not an owner's Stop and must not resume admission.
          pendingUpdate = undefined;
          const ending = [...links.values()];
          links.clear();
          const children = ending.map((link) => {
            link.bridge.handOff();
            link.transport.close();
            return link.child?.stop();
          });
          // Invoke reload before yielding to new private input; clean old subscribers
          // afterwards without touching the now-stale extension context.
          await ctx.reload();
          await Promise.allSettled(children);
        } catch {
          if (!disposed) cancelUpdate();
        } finally {
          updateQueued = false;
        }
        return;
      }
      if (args.trim() === "reload") {
        // pi refuses to reload during a turn. Closing the link first keeps a chat
        // message from starting one; the kernel relinks the reloaded extension.
        await ctx.waitForIdle();
        await stop();
        await ctx.reload();
        return; // The old runtime and ctx are stale from here.
      }
      ctx.ui.notify(
        active()
          ? "ZeroLux chat connected"
          : "Choose this session on the ZeroLux Team page to connect",
        "info",
      );
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    dialogShared = !ctx.isIdle() || ctx.hasPendingMessages();
    if (disposed) return;
    const workspace = await realpath(ctx.cwd);
    const settings = new PiSettings(pi, ctx);
    let settingOps: Promise<unknown> = Promise.resolve();
    const current = new ChatControl(join(getAgentDir(), "zerolux-links"), {
      describe: () => ({
        ...metadata,
        ...settings.values(),
        capabilities: [
          "agent-settings-v1",
          "interrupt-v1",
          "input-v1",
          "input-v2",
          "commands-v1",
          "images-v1",
          "compact-v1",
          ...(installedCode ? ["integration-update-v1"] : []),
        ],
        integration_revision: installedCode?.revision,
        native_session_id: ctx.sessionManager.getSessionId(),
        workspace,
        title:
          ctx.sessionManager.getSessionName() || `pi — ${basename(workspace)}`,
        busy:
          !settled ||
          uiPrompts > 0 ||
          !ctx.isIdle() ||
          ctx.hasPendingMessages(),
        paired: active(),
        links: [...links.values()]
          .filter((link) => link.bridge.connected && link.bridge.sessionId)
          .map((link) => link.bridge.sessionId!),
        // Several workspaces may link this session, each with its own kernel.
        multi_workspace: true,
        takeover: !managed && ctx.mode === "tui" ? 1 : undefined,
        taking_over: takingOver,
      }),
      turn: () => {
        if (settled || dialogShared || takingOver || links.size !== 1)
          return { delivery: null };
        const link = links.values().next().value;
        const turn = link?.bridge.connected ? link.bridge.turn() : null;
        return turn
          ? { ...turn, link_id: link!.bridge.sessionId }
          : { delivery: null };
      },
      settings: (id, values, check) => {
        const operation = settingOps
          .catch(() => {})
          .then(async () => {
            if (disposed || takingOver || stopping)
              throw new Error("The native session is changing");
            if (values === undefined) return settings.read();
            if (
              !id ||
              ![...links.values()].some(
                (link) => link.bridge.connected && link.bridge.sessionId === id,
              )
            )
              throw new Error("Unknown or disconnected link");
            return settings.apply(values, check);
          });
        settingOps = operation;
        return operation;
      },
      update: async (linkId, revision) => {
        const link = [...links.values()].find(
          (link) => link.bridge.sessionId === linkId,
        );
        if (
          !installedCode ||
          disposed ||
          takingOver ||
          stopping ||
          !link?.bridge.connected
        )
          throw new Error("Unknown or disconnected link");
        try {
          if (
            installedCode.revision === revision ||
            installedCode.current() !== revision
          ) {
            cancelUpdate();
            return { pending: false };
          }
          if (
            pendingUpdate?.linkId !== linkId ||
            pendingUpdate.revision !== revision
          )
            pendingUpdate = { linkId, revision };
          await Promise.all(bridges().map((bridge) => bridge.pauseInput()));
          scheduleUpdate();
          return { pending: true };
        } catch (error) {
          cancelUpdate();
          throw error;
        }
      },
      input: async (linkId, text, mode, images) => {
        if (
          ![...links.values()].some(
            (link) => link.bridge.connected && link.bridge.sessionId === linkId,
          )
        )
          throw new Error("Unknown or disconnected link");
        // Read before anything is stopped: an image that cannot be read sends nothing.
        const attached = await Promise.all(
          images.map(async (image) => ({
            type: "image" as const,
            data: Buffer.from(await readFile(image.path)).toString("base64"),
            mimeType: image.media_type,
          })),
        );
        const content = attached.length
          ? [
              ...(text.trim() ? [{ type: "text" as const, text }] : []),
              ...attached,
            ]
          : text;
        // Interrupting: the running turn stops first, then the input starts the next one.
        if (mode === "interrupt" && !ctx.isIdle()) {
          ctx.abort();
          for (let waited = 0; waited < 10_000 && !ctx.isIdle(); waited += 50)
            await new Promise((resolve) => setTimeout(resolve, 50));
          if (!ctx.isIdle())
            throw new Error("pi did not stop its turn; the input was not sent");
        }
        // The owner's words, as if typed here, commands included: a new turn when idle,
        // steering or queued after the turn while working. pi applies "steer" only while a
        // run is active; choosing from isIdle() first races with a run that starts or ends
        // meanwhile, and pi then drops the input with an error no one sees. Accepted means
        // seen entering the context, or queued for the running turn; anything else is
        // reported, never sent again.
        const command = text.startsWith("/")
          ? pi
              .getCommands()
              .find(
                (known) =>
                  text === `/${known.name}` ||
                  text.startsWith(`/${known.name} `),
              )
          : undefined;
        const options = {
          deliverAs:
            mode === "queue" ? ("followUp" as const) : ("steer" as const),
          expandPromptTemplates: true,
        };
        // An extension's command runs at once, without a turn of its own.
        if (command?.source === "extension" && !attached.length) {
          pi.sendUserMessage(text, options);
          return;
        }
        let seen = false;
        // A skill or a prompt template enters the context expanded, not as typed.
        const waiter = {
          text,
          expanded: command !== undefined,
          seen: () => (seen = true),
        };
        ownerInputs.add(waiter);
        try {
          pi.sendUserMessage(content, options);
          for (let waited = 0; waited < 3000 && !seen; waited += 50) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            if (!seen && !ctx.isIdle() && ctx.hasPendingMessages()) {
              // Waiting in pi's queue: shown as such until it enters the context.
              ownerQueue.push({
                id: randomUUID(),
                text: text.trim() || "[image]",
                expanded: waiter.expanded,
              });
              reportQueue();
              return;
            }
          }
          if (!seen)
            throw new Error(
              "pi did not accept the input; it was not sent again",
            );
        } finally {
          ownerInputs.delete(waiter);
        }
      },
      commands: async (linkId) => {
        if (
          ![...links.values()].some(
            (link) => link.bridge.connected && link.bridge.sessionId === linkId,
          )
        )
          throw new Error("Unknown or disconnected link");
        return pi.getCommands().map((command) => ({
          name: command.name,
          description: command.description ?? "",
          argument_hint: null,
          invoke: `/${command.name}`,
        }));
      },
      compact: async (linkId, instructions) => {
        if (
          ![...links.values()].some(
            (link) => link.bridge.connected && link.bridge.sessionId === linkId,
          )
        )
          throw new Error("Unknown or disconnected link");
        // pi's compaction aborts a running turn first; stopping it is Interrupt's choice.
        if (!ctx.isIdle() || ctx.hasPendingMessages())
          throw new Error(
            "pi is working: wait for the turn to end or interrupt it",
          );
        // Started is the answer: the summary, or why it failed, lands in the session.
        ctx.compact({ customInstructions: instructions });
      },
      interrupt: async (linkId) => {
        if (
          ![...links.values()].some(
            (link) => link.bridge.connected && link.bridge.sessionId === linkId,
          )
        )
          throw new Error("Unknown or disconnected link");
        if (ctx.isIdle()) return { interrupted: false };
        ctx.abort();
        return { interrupted: true };
      },
      // The kernel asks a live pi for the session list: pi's own SDK, in this process.
      sessions: () => listMetadata(process.env.PI_CODING_AGENT_SESSION_DIR),
      pair: (init) => pair(init, ctx, workspace),
      takeover: async (request) => {
        const key = request.workspace_id;
        const link = links.get(key);
        const idle = () =>
          !managed &&
          !disposed &&
          !pairing &&
          !stopping &&
          links.size === 1 &&
          links.get(key) === link &&
          link?.bridge.sessionId === request.session_id &&
          link.bridge.connected &&
          !link.bridge.busy &&
          link.bridge.syncing === false &&
          metadata.session_file === request.session_file &&
          settled &&
          uiPrompts === 0 &&
          ctx.isIdle() &&
          !ctx.hasPendingMessages();
        if (takingOver || !idle()) return { accepted: false };
        let closing = false;
        let paused = false;
        try {
          await checkTerminalTakeover(pi, ctx, metadata);
          if (takingOver || !idle()) return { accepted: false };
          if (request.check) return { accepted: true };
          takingOver = true;
          paused = true;
          // The kernel must durably request recovery before the old writer exits.
          // Its authenticated inbox also rechecks owner Stop and a concurrent relink.
          const inbox = await link!.transport.request<{
            session: { id: string; status: string; native_session_id: string };
            workspace: { id: string };
            deliveries: { status: string }[];
          }>("/chat/inbox");
          if (
            !idle() ||
            inbox.session.id !== request.session_id ||
            inbox.session.native_session_id !==
              ctx.sessionManager.getSessionId() ||
            inbox.session.status !== "attention" ||
            inbox.workspace.id !== key ||
            inbox.deliveries.some((delivery) => delivery.status === "stored")
          )
            return { accepted: false };
          await stop(key);
          // Native private input may have arrived during asynchronous cleanup. Never
          // close a now-busy terminal, migrate it, or substitute another saved context.
          await checkTerminalTakeover(pi, ctx, metadata);
          if (uiPrompts > 0) return { accepted: false };
          ctx.shutdown();
          closing = true;
          return { accepted: true };
        } catch {
          // Do not expose history/profile parse errors or any native conversation text.
          return { accepted: false };
        } finally {
          // A check must not trigger dispatch, nor release another request's pause.
          if (paused && !closing) {
            takingOver = false;
            refresh();
          }
        }
      },
      stop: async (id) => {
        let matched = false;
        for (const [key, link] of links)
          if (link.linkId === id) {
            matched = true;
            await stop(key);
          }
        await reportManagedLinks(
          managed,
          bridges().flatMap((bridge) =>
            bridge.sessionId ? [bridge.sessionId] : [],
          ),
          join(getAgentDir(), "zerolux-links", `${current.instanceId}.json`),
        ).catch(() => {});
        if (matched && managed && links.size === 0)
          setTimeout(() => ctx.shutdown(), 0);
      },
    });
    control = current;
    try {
      await current.start();
    } catch {
      if (!disposed)
        ctx.ui.notify(
          "ZeroLux could not advertise this session for hiring",
          "warning",
        );
    }
  });
  /** How full the context is, and what the session has cost, as pi counts them. */
  const reportUsage = () => {
    // Reading pi's counts never gets in the way of the turn's end.
    try {
      const usage = context?.getContextUsage();
      let cost = 0;
      let tokens = 0;
      for (const entry of context?.sessionManager.getEntries() ?? []) {
        const message = (entry as { message?: { role?: string; usage?: any } })
          .message;
        if (message?.role !== "assistant") continue;
        cost += Number(message.usage?.cost?.total) || 0;
        tokens += Number(message.usage?.totalTokens) || 0;
      }
      live({
        type: "usage",
        context_tokens: usage?.tokens ?? null,
        context_window: usage?.contextWindow ?? null,
        total_tokens: tokens || null,
        cost_usd: cost || null,
      });
    } catch {
      /* Without pi's counts there is nothing to show. */
    }
  };
  /** The owner's inputs waiting in pi's queue, oldest first. */
  const ownerQueue: { id: string; text: string; expanded: boolean }[] = [];
  let queueReported = false;
  const reportQueue = () =>
    live({
      type: "queue",
      items: ownerQueue.map(({ id, text }) => ({ id, text })),
    });
  // What the session produces streams to every linked workspace while it runs: its words
  // and reasoning as they come, a tool's output as it grows. The record has them after.
  const live = (change: LiveChange) => {
    for (const bridge of bridges()) bridge.live(change);
  };
  const streamPrefix = randomUUID().slice(0, 8);
  let streamed = 0;
  let streaming: string | undefined;
  const toolOutput = new Map<string, string>();
  pi.on("message_update", (event) => {
    const update = event.assistantMessageEvent;
    // Each assistant message starts its own items.
    if (update.type === "start" || !streaming)
      streaming = `${streamPrefix}-${++streamed}`;
    if (!("contentIndex" in update)) return;
    const item = `${streaming}:${update.contentIndex}`;
    if (update.type === "text_delta")
      live({ type: "append", item, kind: "text", text: update.delta });
    else if (update.type === "thinking_delta")
      live({ type: "append", item, kind: "thinking", text: update.delta });
    else if (update.type === "text_end" || update.type === "thinking_end")
      live({ type: "done", item });
  });
  pi.on("tool_execution_update", (event) => {
    const parts = (event.partialResult as { content?: unknown } | undefined)
      ?.content;
    const text = (Array.isArray(parts) ? parts : [])
      .filter(
        (part): part is { type: "text"; text: string } =>
          part?.type === "text" && typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("");
    const shown = toolOutput.get(event.toolCallId) ?? "";
    if (text === shown) return;
    live(
      text.startsWith(shown)
        ? {
            type: "append",
            item: event.toolCallId,
            kind: "output",
            text: text.slice(shown.length),
          }
        : { type: "set", item: event.toolCallId, kind: "output", text },
    );
    toolOutput.set(event.toolCallId, text);
  });
  pi.on("tool_execution_end", (event) => {
    if (toolOutput.delete(event.toolCallId))
      live({ type: "done", item: event.toolCallId });
  });
  // Every link follows pi's turns; each one only acts on its own deliveries.
  pi.on("agent_start", () => {
    dialogShared ||= links.size !== 1;
    settled = false;
    for (const bridge of bridges()) bridge.agentStarted();
  });
  // pi tells only its extensions why a compaction failed; the session's record keeps it.
  pi.on("session_compact_failed", (event) => {
    if (event.aborted) return;
    pi.appendEntry("zerolux-compaction-failed", {
      error: event.errorMessage ?? "Compaction failed",
      reason: event.reason,
    });
  });
  pi.on("input", (event) => {
    if (event.source !== "extension")
      for (const bridge of bridges()) bridge.privateInput();
  });
  // Receipts go out in the background: pi's turn never waits on ZeroLux.
  pi.on("message_start", (event) => {
    const message = event.message as {
      role?: string;
      content?: string | { type: string; text?: string }[];
    };
    if (message?.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : (message.content ?? [])
              .filter((part) => part.type === "text")
              .map((part) => part.text ?? "")
              .join("\n");
      for (const waiter of ownerInputs)
        if (waiter.expanded || waiter.text === text) waiter.seen();
      // Inputs pi joined into one message, as after an interrupt, leave the queue with it;
      // with nothing left in pi's queue, nothing of the owner's waits there.
      const before = ownerQueue.length;
      const taken = ownerQueue.findIndex(
        (queued) => queued.expanded || queued.text === text.trim(),
      );
      if (taken >= 0) ownerQueue.splice(taken, 1);
      for (let index = ownerQueue.length - 1; index >= 0; index--)
        if (
          !ownerQueue[index]!.expanded &&
          text.includes(ownerQueue[index]!.text)
        )
          ownerQueue.splice(index, 1);
      if (ownerQueue.length && !context?.hasPendingMessages())
        ownerQueue.length = 0;
      if (ownerQueue.length !== before) reportQueue();
    }
    void messageStarted(bridges(), event.message, queuedInputs);
  });
  pi.on("agent_settled", async () => {
    streaming = undefined;
    toolOutput.clear();
    live({ type: "clear" });
    reportUsage();
    // Nothing waits once pi has settled with an empty queue; the first settle after this
    // extension loads also clears what an earlier load left reported.
    if (
      (ownerQueue.length || !queueReported) &&
      !context?.hasPendingMessages()
    ) {
      ownerQueue.length = 0;
      reportQueue();
      queueReported = true;
    }
    settled = true;
    dialogShared = false;
    await Promise.all(bridges().map((bridge) => bridge.settled()));
    // Native reload/dispatch must happen after this notification-only callback returns.
    if (!disposed && links.size > 0)
      refreshTimer = setTimeout(() => {
        scheduleUpdate();
        refresh();
      }, 0);
  });
  pi.on("ui_prompt_start", () => {
    uiPrompts++;
    if (managed?.dialogs) return; // The host reports questions it cannot safely route.
    for (const bridge of bridges())
      if (bridge.busy)
        void bridge.attention(
          "A native pi extension is awaiting a dialog in pi. ZeroLux cannot answer that TUI dialog; native permissions are unchanged.",
        );
  });
  pi.on("ui_prompt_end", () => {
    uiPrompts = Math.max(0, uiPrompts - 1);
    if (pendingUpdate) setTimeout(scheduleUpdate, 0);
    for (const bridge of bridges())
      if (bridge.busy) void bridge.ready().catch(() => {});
  });
  const guard = (_event: unknown, ctx: ExtensionContext) => {
    if (active()) {
      ctx.ui.notify(
        "Stop this agent in ZeroLux before changing its session or branch",
        "warning",
      );
      return { cancel: true };
    }
  };
  pi.on("session_before_switch", guard);
  pi.on("session_before_fork", guard);
  pi.on("session_before_tree", guard);
  pi.on("session_shutdown", async () => {
    disposed = true;
    unsubscribe();
    await stop();
    await control?.close();
    context = undefined;
  });
}
