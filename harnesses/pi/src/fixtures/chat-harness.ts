/** Deterministic native-host fixture. Never constructs AgentSession or contacts a model. */
import chatExtension from "../chat-extension.ts";
import { appendFileSync } from "node:fs";
import { Transport } from "@zerolux/bridge";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// Force a published reply's HTTP result to reach the tool only after native off.
// The message is already visible to the GUI while its native call is still in flight.
let releaseReply: (() => void) | undefined;
if (process.env.ZEROLUX_FIXTURE_REPLY_AFTER_OFF) {
  const reply = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  const bind = Transport.prototype.bind;
  Transport.prototype.bind = function (request) {
    bind.call(this, async <T>(path: string, body?: unknown): Promise<T> => {
      const result = await request<T>(path, body);
      if (body && /^\/conversations\/[^/]+\/messages$/.test(path)) await reply;
      return result;
    });
  };
}

type Handler = (event: any, ctx: ExtensionContext) => unknown;
const handlers = new Map<string, Handler>();
const events = new Map<string, (value: unknown) => void>();
// A pi in the middle of a turn, e.g. right after reloading its extensions.
let idle = !process.env.ZEROLUX_FIXTURE_BUSY;
let send: {
  execute(
    id: string,
    args: { chat: string; text: string; reply_to?: string },
  ): Promise<unknown>;
};
let command: { handler(args: string, ctx: ExtensionContext): Promise<void> };
const context = {
  cwd: process.cwd(),
  mode: "tui",
  hasUI: true,
  modelRegistry: { getAvailable: () => [] },
  sessionManager: {
    getSessionId: () => "11111111-1111-4111-8111-111111111111",
    getSessionName: () => "Deterministic pi fixture",
  },
  isIdle: () => idle,
  hasPendingMessages: () => false,
  abort: () => {
    idle = true;
  },
  ui: {
    setStatus(_key: string, value: string | undefined) {
      if (process.env.ZEROLUX_FIXTURE_UI_LOG)
        appendFileSync(
          process.env.ZEROLUX_FIXTURE_UI_LOG,
          JSON.stringify(value ?? null) + "\n",
        );
    },
    notify() {},
  },
} as unknown as ExtensionContext;
const emit = async (name: string, event: unknown) => {
  await handlers.get(name)?.(event, context);
};
chatExtension({
  getThinkingLevel: () => "off",
  setThinkingLevel: () => {},
  setModel: async () => false,
  on: (name: string, handler: Handler) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  },
  registerTool(tool: typeof send & { name: string }) {
    if (tool.name === "zerolux_send") send = tool;
  },
  getActiveTools: () => [],
  setActiveTools() {},
  registerCommand(_name: string, value: typeof command) {
    command = value;
  },
  events: {
    on: (name: string, callback: (value: unknown) => void) => {
      events.set(name, callback);
      return () => events.delete(name);
    },
    emit: (name: string, value: unknown) => {
      events.get(name)?.(value);
    },
  },
  sendUserMessage: (content: string) => {
    idle = false;
    // Native-style lifecycle, but a fixed response instead of inference.
    setTimeout(() => {
      void (async () => {
        await emit("agent_start", { type: "agent_start" });
        await emit("message_start", {
          message: { role: "user", content },
        });
        await emit("message_end", {
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [
              { type: "thinking", thinking: "FIXTURE_PRIVATE_THINKING" },
              {
                type: "text",
                text: "Deterministic pi response; no model was called.",
              },
            ],
          },
        });
        // Answer as a model would: with the chat and message named in the envelope.
        const [, chat, replyTo] = /^Chat: (\S+); delivery: (\S+)$/m.exec(
          content,
        )!;
        let toolError = false;
        let toolResult: unknown;
        try {
          toolResult = await send.execute("fixture-call", {
            chat: chat!,
            reply_to: replyTo!,
            text: "Deterministic pi response; no model was called.",
          });
        } catch (error) {
          // pi turns a rejected execute() into a failed tool result, not a host crash.
          toolError = true;
          toolResult = {
            content: [{ type: "text", text: String(error) }],
            details: undefined,
          };
        }
        await emit("tool_execution_end", {
          type: "tool_execution_end",
          toolCallId: "fixture-call",
          toolName: "zerolux_send",
          result: toolResult,
          isError: toolError,
        });
        await emit("agent_before_settle", { outcome: "completed" });
        idle = true;
        await emit("agent_settled", { type: "agent_settled" });
        if (releaseReply)
          process.stdout.write(
            JSON.stringify({ type: "turn_settled", tool_error: toolError }) +
              "\n",
          );
      })();
    }, 20);
  },
} as unknown as ExtensionAPI);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await emit("session_shutdown", {});
  process.exit(0);
}
process.on("SIGUSR1", () => {
  const stopped = command.handler("off", context);
  if (process.env.ZEROLUX_FIXTURE_UI_LOG)
    appendFileSync(process.env.ZEROLUX_FIXTURE_UI_LOG, "OFF_REQUESTED\n");
  void stopped.then(() => releaseReply?.());
});
process.on("SIGTERM", () => {
  void close();
});
process.on("SIGINT", () => {
  void close();
});
await emit("session_start", {});
process.stdout.write("READY\n");
