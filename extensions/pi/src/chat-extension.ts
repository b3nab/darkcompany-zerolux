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
  chatRequest,
  localURL,
  nativeFingerprint,
  type ChatHost,
} from "@zerolux/bridge";
import { ChatControl, type PairRequest } from "./chat-control.ts";
import { listMetadata } from "./discover.ts";
import { installWake } from "./wake.ts";

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
export default function chatExtension(pi: ExtensionAPI) {
  let control: ChatControl | undefined;
  let bridge: ChatBridge | undefined;
  let child: AgentLinkChild | undefined;
  let linkId: string | undefined;
  let token: string | undefined;
  let base: string | undefined;
  let pairing = false;
  let disposed = false;
  let stopping: Promise<void> | undefined;
  let settled = true;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let context: ExtensionContext | undefined;
  const leaveWake = installWake(pi, join(getAgentDir(), "zerolux-wake"));

  const active = () => Boolean(stopping || pairing || bridge?.connected);
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
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    const current = bridge,
      subscriber = child;
    bridge = undefined;
    child = undefined;
    token = undefined;
    base = undefined;
    linkId = undefined;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
    stopping = (async () => {
      await current?.stop();
      await subscriber?.stop();
      context?.ui.setStatus("zerolux-chat", undefined);
    })().finally(() => {
      stopping = undefined;
      busyChanged();
    });
    return stopping;
  };
  const refresh = () => {
    if (disposed || !bridge) return;
    const current = bridge;
    void current
      .invalidate()
      .then(() => {
        if (bridge === current && !current.connected) return stop();
      })
      .catch(() => {});
  };

  const host = (ctx: ExtensionContext, workspace: string): ChatHost => ({
    harness: "pi",
    nativeSessionId: ctx.sessionManager.getSessionId(),
    workspace,
    tools: { send: "zerolux_send", thread: "zerolux_thread" },
    idle: () =>
      settled && ctx.isIdle() && !ctx.hasPendingMessages() && !taskBusy(),
    // Everything waiting in one message: pi steers one queued message per step.
    send: (batches) =>
      pi.sendMessage(
        {
          customType: CHAT_MESSAGE,
          content: batches.map((batch) => batch.content).join("\n\n"),
          display: true,
          details: { deliveryIds: batches.map((batch) => batch.id) },
        },
        // Idle: starts a turn. Working: joins it after the current tool call.
        { triggerTurn: true, deliverAs: "steer" },
      ),
    abort: () => {
      void ctx.abort();
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
    const origin = localURL(init.base_url);
    if (
      !pairing &&
      !stopping &&
      bridge?.connected &&
      token === init.token &&
      base === origin &&
      linkId
    )
      return linkId;
    // A new token for the live link is the kernel relinking this same session
    // (the control socket already verified it), e.g. after a restart: replace the
    // link without waiting for pi to be idle, and keep the open turn.
    const previous =
      !disposed && !pairing && !stopping && bridge?.connected
        ? bridge
        : undefined;
    // A busy pi pairs too: the kernel checks before a first hire and relinks regardless
    // (e.g. right after a reload), and chat messages join a running turn anyway. Only the
    // task bridge excludes the chat.
    if (!previous && (disposed || stopping || pairing || bridge || taskBusy()))
      throw new Error(
        "Pi's chat is already connecting, or its task bridge is connected",
      );
    pairing = true;
    busyChanged();
    const next = new ChatBridge(
      host(ctx, workspace),
      chatRequest(origin, init.token),
    );
    if (!previous) bridge = next; // An off during the identity request must close this pending pair too.
    try {
      // Check the private bearer against this exact native session before doing anything else.
      await next.connect();
      if (
        disposed ||
        bridge !== (previous ?? next) ||
        !next.connected ||
        (!previous && taskBusy())
      )
        throw new Error("Pi changed while pairing");
      if (previous) {
        next.adopt(previous.handOff());
        // From here pi's events (input, context, end of turn) reach the new link, also
        // while the old subscriber is still stopping.
        bridge = next;
        const old = child;
        child = undefined;
        await old?.stop();
        // A Stop or shutdown while the old subscriber was stopping ends this relink too.
        if (disposed || bridge !== next || !next.connected)
          throw new Error("Pairing was stopped");
      }
      const subscriber = new AgentLinkChild(refresh, () => {
        void next.attention(
          "LiveKit subscriber stopped; no prompt will be retried automatically",
        );
      });
      bridge = next;
      child = subscriber;
      token = init.token;
      base = origin;
      linkId = randomUUID();
      // The first invalidation also publishes a reply carried over from a relink.
      await subscriber.start(
        await realpath(init.executable),
        origin,
        init.token,
      );
      if (disposed || bridge !== next) throw new Error("Pairing was stopped");
      await next.ready();
      if (disposed || bridge !== next || !next.connected || !linkId)
        throw new Error("Pairing was stopped");
      ctx.ui.setStatus("zerolux-chat", "chat: connected");
      return linkId!;
    } catch (error) {
      await next.stop();
      await stop();
      throw error;
    } finally {
      pairing = false;
      busyChanged();
    }
  }

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
      if (!bridge) throw new Error("No ZeroLux chat is connected");
      const outcome = await bridge.post(args.chat, args.text, args.reply_to);
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
      if (!bridge) throw new Error("No ZeroLux chat is connected");
      const thread = await bridge.openThread(
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
    if (disposed) return;
    const workspace = await realpath(ctx.cwd);
    const current = new ChatControl(join(getAgentDir(), "zerolux-links"), {
      describe: () => ({
        native_session_id: ctx.sessionManager.getSessionId(),
        workspace,
        title:
          ctx.sessionManager.getSessionName() || `pi — ${basename(workspace)}`,
        busy:
          !settled || !ctx.isIdle() || ctx.hasPendingMessages() || taskBusy(),
        paired: active(),
      }),
      // The kernel asks a live pi for the session list: pi's own SDK, in this process.
      sessions: () => listMetadata(process.env.PI_CODING_AGENT_SESSION_DIR),
      pair: (init) => pair(init, ctx, workspace),
      stop: async (id) => {
        if (id === linkId) await stop();
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
  pi.on("agent_start", () => {
    settled = false;
    bridge?.agentStarted();
  });
  pi.on("input", (event) => {
    if (event.source !== "extension") bridge?.privateInput();
  });
  // Receipts go out in the background: pi's turn never waits on ZeroLux.
  pi.on("message_start", (event) => void messageStarted(bridge, event.message));
  pi.on("agent_settled", async () => {
    settled = true;
    await bridge?.settled();
    // agent_settled is notification-only. Dispatch another delivery on a later event-loop tick.
    if (!disposed && bridge) refreshTimer = setTimeout(refresh, 0);
  });
  pi.on("ui_prompt_start", () => {
    if (bridge?.busy)
      void bridge.attention(
        "A native pi extension is awaiting a dialog in pi. ZeroLux cannot answer that TUI dialog; native permissions are unchanged.",
      );
  });
  pi.on("ui_prompt_end", () => {
    if (bridge?.busy) void bridge.ready().catch(() => {});
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
