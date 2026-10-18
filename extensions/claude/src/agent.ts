import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createSdkMcpServer,
  tool,
  type CanUseTool,
  type ElicitationResult,
  type OnElicitation,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ChatBridge,
  ChatHttpError,
  type Batch,
  type ChatRequest,
} from "@zerolux/bridge";
import { z } from "zod";
import { ClaudeSettings } from "./settings.ts";

export type StartQuery = (input: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => Query;

/** Wakes the agent for other agents' messages: fixed text, never theirs. */
const MAX_DETAILS = 16 * 1024;
/** The chat tools ZeroLux gives an agent's session. */
const CHAT_TOOLS = [
  "mcp__zerolux__send",
  "mcp__zerolux__thread",
  "mcp__zerolux__close_thread",
];

interface Approval {
  id: string;
  status: string;
  decision: string | null;
  /** How far an allowed permission goes: "once", "session" or "always". */
  scope?: string | null;
  /** Why the owner denied it. */
  reason?: string | null;
  answer?: unknown;
}

/** Why a request to the owner has no answer. */
const UNANSWERED = {
  unreachable: "ZeroLux is unreachable, so the owner cannot be asked now.",
  withdrawn: "The request was withdrawn.",
  used: "The decision was already used.",
};
type Unanswered = keyof typeof UNANSWERED;

interface AskedQuestion {
  question: string;
  header?: string;
  options?: { label: string; description?: string; preview?: string }[];
  multiSelect?: boolean;
}

/** The session's input: what the runner writes reaches Claude Code in order. */
class Input implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;
  get empty() {
    return this.queue.length === 0;
  }
  push(message: SDKUserMessage) {
    this.queue.push(message);
    this.wake?.();
  }
  close() {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      const next = this.queue.shift();
      if (next) yield next;
      else if (this.closed) return;
      else await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

/**
 * A Claude Code session ZeroLux runs. The owner's messages are user turns; other agents'
 * wait in the `inbox` tool. One chat per turn, so its approvals go to that chat.
 */
export class ClaudeAgent {
  readonly bridge: ChatBridge;
  private readonly input = new Input();
  private query?: Query;
  private dispatchEnabled = true;
  readonly settings = new ClaudeSettings(() => this.query);
  private state: "idle" | "running" | "requires_action" = "idle";
  /** The batch of that chat the turn read first: its permission requests belong to it. */
  private turnDelivery?: string;
  /**
   * The chat messages the runner wrote and no turn has consumed yet, in order. The session
   * takes input in order, so an echoed ID settles everything before it.
   */
  private written: { id: string; batch: boolean }[] = [];
  /** Approvals awaiting the owner's decision, by ID. */
  private waiting = new Map<string, (approval: Approval) => void>();
  /** Approval receipts ZeroLux has not confirmed: sent again at every sync, never dropped. */
  private approvalReceipts = new Map<string, "delivered" | "resolved">();

  constructor(
    private readonly session: { nativeSessionId: string; workspace: string },
    private readonly request: ChatRequest,
  ) {
    this.bridge = new ChatBridge(
      {
        harness: "claude-code",
        nativeSessionId: session.nativeSessionId,
        workspace: session.workspace,
        idle: () => this.state === "idle" && this.input.empty,
        send: (batches) => this.send(batches),
        abort: () => void this.query?.interrupt(),
        notify: (text) => console.error(`[zerolux] ${text}`),
      },
      request,
    );
  }

  /**
   * Runs the session until its input closes. `resume` continues its saved transcript; `chat`
   * gives an agent's session its chat tools.
   */
  async run(start: StartQuery, options: Options, resume: boolean, chat = true) {
    this.query = start({
      prompt: this.input,
      options: {
        ...options,
        cwd: this.session.workspace,
        ...(resume
          ? { resume: this.session.nativeSessionId }
          : { sessionId: this.session.nativeSessionId }),
        canUseTool: this.canUseTool,
        onElicitation: this.onElicitation,
        includePartialMessages: true,
        // A checkpoint of the files before each of the owner's messages, to rewind them.
        enableFileCheckpointing: true,
        ...(chat
          ? {
              mcpServers: { zerolux: this.tools() },
              // The agent's own chat tools, ZeroLux's: never held for a permission check.
              allowedTools: [...(options.allowedTools ?? []), ...CHAT_TOOLS],
            }
          : {}),
      },
    });
    for await (const message of this.query) this.handle(message);
  }

  /** Working on a turn, or input still waiting for one. */
  get busy() {
    return (
      this.state !== "idle" || !this.input.empty || this.written.length > 0
    );
  }

  /** Accepted input, unread messages and unconfirmed output must survive an update. */
  get updateReady() {
    return (
      !this.busy &&
      !this.bridge.busy &&
      !this.bridge.syncing &&
      this.waiting.size === 0 &&
      this.approvalReceipts.size === 0
    );
  }

  /** Pause only new deliveries. Already accepted work and its approvals keep running. */
  async prepareUpdate() {
    await this.bridge.pauseInput();
    // Flush replies and receipts even when no new LiveKit event arrives.
    await this.refresh();
    return this.updateReady;
  }

  /** Startup configuration must be confirmed before any queued owner input is admitted. */
  setDispatchEnabled(enabled: boolean) {
    this.dispatchEnabled = enabled;
  }

  /** ZeroLux changed: new messages, an approval decided, the link stopped. */
  async refresh() {
    if (!this.dispatchEnabled) return;
    await Promise.all([
      this.bridge.invalidate(),
      this.decisions(),
      this.sendApprovalReceipts(),
    ]);
  }

  close() {
    this.input.close();
    this.query?.close();
    for (const resolve of this.waiting.values())
      resolve({ id: "", status: "resolved", decision: null });
    this.waiting.clear();
  }

  /** Every message reaches the session at once, its envelope naming its author and chat. */
  private send(batches: Batch[]) {
    for (const { content, id } of batches) this.write(content, id, true);
  }

  private write(content: string, uuid: string, batch: boolean) {
    this.written.push({ id: uuid, batch });
    this.input.push({
      type: "user",
      // The ID comes back on the turn that consumed it: then the batch is read.
      uuid: uuid as SDKUserMessage["uuid"],
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content },
      // A leading "/" or "@" in a chat message is text, never a command or a file.
      client_composed: true,
      // While the session works, it joins the turn after the tools in progress.
      priority: "next",
    });
  }

  /**
   * The owner's own input, typed into this session from ZeroLux: native user input, with its
   * commands and file mentions, as in the terminal. Steered, it joins the running turn after
   * the tools in progress; queued, it waits for the turn to end; interrupting, it follows the
   * turn it stops.
   */
  async say(
    text: string,
    mode: "steer" | "queue" | "interrupt" = "steer",
    images: { path: string; media_type: string }[] = [],
  ) {
    // Read before anything is stopped: an image that cannot be read sends nothing.
    const attached = await Promise.all(
      images.map(async (image) => ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: image.media_type as
            | "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp",
          data: Buffer.from(await readFile(image.path)).toString("base64"),
        },
      })),
    );
    if (mode === "interrupt") await this.interrupt();
    const uuid = randomUUID();
    this.ownerQueue.push({
      id: uuid,
      text: text.trim() || attached.map(() => "[image]").join(" "),
    });
    this.reportQueue();
    this.input.push({
      type: "user",
      uuid: uuid as SDKUserMessage["uuid"],
      session_id: "",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: attached.length
          ? [
              ...attached,
              ...(text.trim() ? [{ type: "text" as const, text }] : []),
            ]
          : text,
      },
      priority: mode === "queue" ? "later" : "next",
    });
  }

  /** The files as they were before one of the session's user messages; `dryRun` only says. */
  async rewindFiles(messageId: string, dryRun: boolean) {
    if (!this.query) throw new Error("The session is not running");
    return this.query.rewindFiles(messageId, { dryRun });
  }

  /** Claude Code's commands and skills, as the owner types them. */
  async commands() {
    if (!this.query) return [];
    return (await this.query.supportedCommands()).map((command) => ({
      name: command.name,
      description: command.description,
      argument_hint: command.argumentHint || null,
      invoke: `/${command.name}`,
    }));
  }

  /** Stops the turn in progress, whoever started it; the session and its context stay. */
  async interrupt() {
    if (this.state === "idle" || !this.query) return false;
    await this.query.interrupt();
    return true;
  }

  /** What the session has cost so far, as its last result said. */
  private cost?: number;

  /** How full the context is now, and the cost so far. */
  private async reportUsage() {
    // Reading Claude Code's counts never gets in the way of the turn's end.
    const usage = await Promise.resolve()
      .then(() => this.query?.getContextUsage({ detail: "summary" }))
      .catch(() => undefined);
    if (!usage && this.cost === undefined) return;
    this.bridge.live({
      type: "usage",
      context_tokens: usage?.totalTokens ?? null,
      context_window: usage?.maxTokens ?? null,
      cost_usd: this.cost ?? null,
    });
  }

  /** The owner's inputs the session has not taken yet, oldest first. */
  private ownerQueue: { id: string; text: string }[] = [];

  private reportQueue() {
    this.bridge.live({ type: "queue", items: [...this.ownerQueue] });
  }

  /** The message being streamed, and the kind of each of its blocks. */
  private streaming?: { id: string; kinds: Map<number, "text" | "thinking"> };

  /** The session's own text and reasoning as they stream; a subagent's stay in its card. */
  private stream(message: SDKMessage) {
    if (message.type !== "stream_event" || message.parent_tool_use_id) return;
    const event = message.event;
    if (event.type === "message_start")
      this.streaming = { id: event.message.id, kinds: new Map() };
    if (!this.streaming) return;
    const item = (index: number) => `${this.streaming!.id}:${index}`;
    if (event.type === "content_block_start") {
      const type = event.content_block.type;
      if (type === "text" || type === "thinking")
        this.streaming.kinds.set(event.index, type);
    } else if (event.type === "content_block_delta") {
      const kind = this.streaming.kinds.get(event.index);
      const text =
        event.delta.type === "text_delta"
          ? event.delta.text
          : event.delta.type === "thinking_delta"
            ? event.delta.thinking
            : undefined;
      if (kind && text)
        this.bridge.live({
          type: "append",
          item: item(event.index),
          kind,
          text,
        });
    } else if (event.type === "content_block_stop") {
      if (this.streaming.kinds.delete(event.index))
        this.bridge.live({ type: "done", item: item(event.index) });
    }
  }

  private handle(message: SDKMessage) {
    this.settings.observe(message);
    this.stream(message);
    if (message.type === "result") this.cost = message.total_cost_usd;
    if (
      message.type === "system" &&
      message.subtype === "session_state_changed"
    ) {
      const was = this.state;
      this.state = message.state;
      if (was === "idle" && message.state !== "idle")
        this.bridge.agentStarted();
      if (message.state === "idle") {
        this.streaming = undefined;
        this.bridge.live({ type: "clear" });
        void this.reportUsage();
        this.turnDelivery = undefined; // The next turn asks about its own message.
        // Input written and not taken yet runs next. The session drops queued input only when
        // it ends, and so does this run.
        if (this.written.length || !this.input.empty) return;
        void this.bridge.settled().then(() => this.refresh());
      }
      return;
    }
    const consumed =
      "user_message_uuids" in message ? message.user_message_uuids : undefined;
    const taken = this.ownerQueue.filter((queued) =>
      consumed?.includes(queued.id),
    );
    if (taken.length) {
      this.ownerQueue = this.ownerQueue.filter(
        (queued) => !taken.includes(queued),
      );
      this.reportQueue();
    }
    for (const id of consumed ?? []) {
      // The echo lists at most 64 IDs: everything written before one was consumed too.
      const at = this.written.findIndex((w) => w.id === id);
      for (const w of at < 0 ? [] : this.written.splice(0, at + 1))
        if (w.batch) {
          this.turnDelivery ??= w.id;
          void this.bridge.read(w.id);
        }
    }
  }

  private tools() {
    return createSdkMcpServer({
      name: "zerolux",
      tools: [
        tool(
          "send",
          "Post to a ZeroLux chat or thread.",
          {
            chat: z.string().describe("Chat ID"),
            text: z.string().describe("Message"),
            reply_to: z.string().optional().describe("Delivery ID answered"),
          },
          async ({ chat, text, reply_to }) => {
            const outcome = await this.bridge.post(chat, text, reply_to);
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
            };
          },
        ),
        tool(
          "thread",
          "Open or join the agents' thread on a chat message.",
          {
            chat: z.string().describe("Parent chat ID"),
            on: z.string().describe("Message or delivery ID"),
            title: z.string().describe("Subject"),
            with: z.array(z.string()).optional().describe("Agent names"),
          },
          async (args) => {
            const thread = await this.bridge.openThread(
              args.chat,
              args.on,
              args.title,
              args.with ?? [],
            );
            return {
              content: [
                {
                  type: "text",
                  text: `${thread.created ? "Opened" : "Joined"} the thread ${JSON.stringify(thread.title)}: write in it with mcp__zerolux__send, chat ${JSON.stringify(thread.id)}.`,
                },
              ],
            };
          },
        ),
        tool(
          "close_thread",
          "Close a ZeroLux thread you participate in.",
          {
            chat: z.string().describe("Thread chat ID"),
          },
          async ({ chat }) => {
            const thread = await this.bridge.closeThread(chat);
            return {
              content: [
                {
                  type: "text",
                  text: `Closed the thread ${JSON.stringify(thread.title)}.`,
                },
              ],
            };
          },
        ),
      ],
    });
  }

  /**
   * Claude Code asks before a tool runs: the owner decides in ZeroLux, whatever started the
   * turn. Nothing runs until then; a cancelled call withdraws the request.
   */
  private canUseTool: CanUseTool = async (
    toolName,
    input,
    { signal, toolUseID, decisionReason, suggestions },
  ): Promise<PermissionResult> => {
    if (toolName === "AskUserQuestion")
      return this.askQuestions(input, toolUseID, signal);
    // Claude Code suggests the rules that would let this through again: for the session,
    // or kept in its settings.
    const rules = suggestions ?? [];
    const details = JSON.stringify(input);
    const decided = await this.ask(
      "permission",
      toolUseID,
      `Claude Code wants to use ${toolName}`,
      {
        tool: toolName,
        input:
          details.length > MAX_DETAILS
            ? `${details.slice(0, MAX_DETAILS)}…`
            : input,
        ...(decisionReason ? { reason: decisionReason } : {}),
        scopes: rules.length ? ["once", "session", "always"] : ["once"],
      },
      signal,
    );
    if (typeof decided === "string")
      return { behavior: "deny", message: UNANSWERED[decided] };
    if (decided.decision !== "allow")
      return {
        behavior: "deny",
        message: decided.reason || "The owner denied this in ZeroLux.",
      };
    const updatedPermissions =
      decided.scope === "session"
        ? rules.map((rule) => ({ ...rule, destination: "session" as const }))
        : decided.scope === "always"
          ? rules.map((rule) =>
              rule.destination === "session"
                ? { ...rule, destination: "localSettings" as const }
                : rule,
            )
          : undefined;
    return {
      behavior: "allow",
      updatedInput: input,
      ...(updatedPermissions ? { updatedPermissions } : {}),
    };
  };

  /** Claude Code's questions go to the owner as they are; the answers come back as its own. */
  private async askQuestions(
    input: Record<string, unknown>,
    toolUseID: string,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const asked = (input.questions ?? []) as AskedQuestion[];
    const decided = await this.ask(
      "question",
      toolUseID,
      (asked.length === 1 ? asked[0]!.question : "Claude Code asks you").slice(
        0,
        1000,
      ),
      {
        questions: asked.map((q) => ({
          id: q.question,
          header: q.header ?? null,
          question: q.question,
          options: (q.options ?? []).map((o) => ({
            label: o.label,
            description: o.description ?? null,
            preview: o.preview ?? null,
          })),
          multiple: q.multiSelect === true,
          // Claude Code always offers its own free answer besides the options.
          other: true,
        })),
      },
      signal,
    );
    if (typeof decided === "string")
      return { behavior: "deny", message: UNANSWERED[decided] };
    const answers = (decided.answer as { answers?: Record<string, string[]> })
      ?.answers;
    if (!answers)
      return { behavior: "deny", message: "The owner declined to answer." };
    return {
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: Object.fromEntries(
          Object.entries(answers).map(([q, values]) => [q, values.join(", ")]),
        ),
      },
    };
  }

  /** An MCP server's form or link goes to the owner; the reply is the owner's answer. */
  private onElicitation: OnElicitation = async (
    request,
    { signal, requestId },
  ): Promise<ElicitationResult> => {
    const decided = await this.ask(
      "form",
      `elicitation:${requestId}`,
      `${request.serverName} asks: ${request.message}`.slice(0, 1000),
      {
        server: request.serverName,
        message: request.message,
        mode: request.mode ?? "form",
        ...(request.requestedSchema ? { schema: request.requestedSchema } : {}),
        ...(request.url ? { url: request.url } : {}),
      },
      signal,
    );
    if (typeof decided === "string") return { action: "cancel" };
    return decided.answer as ElicitationResult;
  };

  /**
   * One request to the owner: the decided request, dispatched once, or why there is none.
   * A restarted runner asking again gets the same request back.
   */
  private async ask(
    kind: "permission" | "question" | "form",
    nativeRequestId: string,
    summary: string,
    details: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Approval | Unanswered> {
    if (signal.aborted) return "withdrawn";
    const created = await this.request<{ approval: Approval }>(
      "/chat/approvals",
      {
        id: randomUUID(),
        // The chat message that started the turn, if one did.
        delivery_id: this.turnDelivery ?? null,
        native_request_id: nativeRequestId,
        kind,
        summary,
        details,
      },
    ).catch(() => undefined);
    if (!created) return "unreachable";
    const decided = await this.decision(created.approval, signal);
    if (decided.status !== "decided") {
      await this.receipt(created.approval.id, "resolved");
      return "withdrawn";
    }
    try {
      await this.request(
        `/chat/approvals/${encodeURIComponent(decided.id)}/dispatch`,
        {},
      );
    } catch (error) {
      // Someone else applied it: never twice.
      if (error instanceof ChatHttpError && error.status === 409) return "used";
      throw error;
    }
    // Returning it applies it: Claude Code receives it with this call's result.
    void this.receipt(decided.id, "delivered");
    return decided;
  }

  private decision(approval: Approval, signal: AbortSignal) {
    if (approval.status !== "pending") return Promise.resolve(approval);
    // Cancelled while the request was being created: no listener would ever hear it.
    if (signal.aborted)
      return Promise.resolve({ ...approval, status: "withdrawn" });
    return new Promise<Approval>((resolve) => {
      const done = (value: Approval) => {
        this.waiting.delete(approval.id);
        signal.removeEventListener("abort", abort);
        resolve(value);
      };
      const abort = () => done({ ...approval, status: "withdrawn" });
      signal.addEventListener("abort", abort, { once: true });
      this.waiting.set(approval.id, done);
      void this.decisions();
    });
  }

  /** The owner's decisions on this session's pending requests. */
  private async decisions() {
    if (!this.waiting.size) return;
    const { approvals } = await this.request<{ approvals: Approval[] }>(
      "/chat/approvals",
    ).catch(() => ({ approvals: [] as Approval[] }));
    for (const approval of approvals)
      if (approval.status !== "pending")
        this.waiting.get(approval.id)?.(approval);
  }

  private receipt(id: string, status: "delivered" | "resolved") {
    this.approvalReceipts.set(id, status);
    return this.sendApprovalReceipts();
  }

  private async sendApprovalReceipts() {
    for (const [id, status] of [...this.approvalReceipts]) {
      try {
        await this.request(
          `/chat/approvals/${encodeURIComponent(id)}/receipt`,
          { status },
        );
      } catch (error) {
        // Unreachable or being rebound: kept for the next sync. A refusal is final.
        if (!(error instanceof ChatHttpError) || error.status >= 500) return;
      }
      if (this.approvalReceipts.get(id) === status)
        this.approvalReceipts.delete(id);
    }
  }
}
