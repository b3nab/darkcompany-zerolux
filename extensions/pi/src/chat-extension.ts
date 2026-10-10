import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
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
  type ChatHost,
} from "@zerolux/bridge";
import { ChatControl, type PairRequest } from "./chat-control.ts";
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
  const taskBusy = () => {
    let busy = false;
    pi.events.emit("zerolux:query-task-bridge", {
      reply: (value: boolean) => {
        busy = value;
      },
    });
    return busy;
  };
  const status = () => {
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
  /** Ends one link (its workspace) or all of them. Never Stops the agent. */
  const stop = (key?: string): Promise<void> => {
    // Wait for cleanup, then apply this request too: it may name another workspace.
    if (stopping) return stopping.then(() => stop(key));
    const ending =
      key === undefined
        ? [...links.entries()]
        : [...links.entries()].filter(([k]) => k === key);
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
    tools: { send: "zerolux_send", thread: "zerolux_thread" },
    idle: () =>
      settled && ctx.isIdle() && !ctx.hasPendingMessages() && !taskBusy(),
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
    // (e.g. right after a reload), and chat messages join a running turn anyway. Only the
    // task bridge excludes the chat.
    if (
      !previous &&
      (disposed || stopping || pairing || existing || taskBusy())
    )
      throw new Error(
        "Pi's chat is already connecting, or its task bridge is connected",
      );
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
      if (
        disposed ||
        mine()?.bridge !== (previous ?? next) ||
        !next.connected ||
        (!previous && taskBusy())
      )
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
    description:
      "Write in a ZeroLux chat or thread you belong to, when you have something useful to say. Everyone in that chat reads it. To answer a message, pass the chat and reply_to from its [ZeroLux] envelope; in a thread, reply_to is not needed. Never use for private terminal work.",
    parameters: Type.Object({
      chat: Type.String({ description: "The chat ID from the envelope" }),
      text: Type.String({ description: "The message, as the chat shows it" }),
      reply_to: Type.Optional(
        Type.String({
          description: "The message ID you answer, from the envelope",
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
    description:
      "Open the agents' thread on a message of a ZeroLux chat, or join the one open there (one per message), to coordinate without filling the chat. Then write in it with zerolux_send and the thread's chat ID. Answer in the chat itself only when asked or when the thread agreed you would.",
    parameters: Type.Object({
      chat: Type.String({ description: "The chat ID from the envelope" }),
      on: Type.String({
        description:
          "The message the thread is about: reply_to from the envelope",
      }),
      title: Type.String({ description: "A short subject" }),
      with: Type.Optional(
        Type.Array(Type.String(), {
          description: "Other agents of the chat to take part, by name",
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
      pi.sendUserMessage("/zerolux-chat reload", {
        expandPromptTemplates: true,
      });
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
    const current = new ChatControl(join(getAgentDir(), "zerolux-links"), {
      describe: () => ({
        ...metadata,
        native_session_id: ctx.sessionManager.getSessionId(),
        workspace,
        title:
          ctx.sessionManager.getSessionName() || `pi — ${basename(workspace)}`,
        busy:
          !settled ||
          uiPrompts > 0 ||
          !ctx.isIdle() ||
          ctx.hasPendingMessages() ||
          taskBusy(),
        paired: active(),
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
          !ctx.hasPendingMessages() &&
          !taskBusy();
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
  // Every link follows pi's turns; each one only acts on its own deliveries.
  pi.on("agent_start", () => {
    dialogShared ||= links.size !== 1;
    settled = false;
    for (const bridge of bridges()) bridge.agentStarted();
  });
  pi.on("input", (event) => {
    if (event.source !== "extension")
      for (const bridge of bridges()) bridge.privateInput();
  });
  // Receipts go out in the background: pi's turn never waits on ZeroLux.
  pi.on(
    "message_start",
    (event) => void messageStarted(bridges(), event.message, queuedInputs),
  );
  pi.on("agent_settled", async () => {
    settled = true;
    dialogShared = false;
    await Promise.all(bridges().map((bridge) => bridge.settled()));
    // agent_settled is notification-only. Dispatch another delivery on a later event-loop tick.
    if (!disposed && links.size > 0) refreshTimer = setTimeout(refresh, 0);
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
