/** Deterministic native-host fixture. Never constructs AgentSession or contacts a model. */
import chatExtension from "../chat-extension.ts";
import { appendFileSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

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
  on: (name: string, handler: Handler) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  },
  registerTool(tool: typeof send & { name: string }) {
    if (tool.name === "zerolux_send") send = tool;
  },
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
        const [, chat, replyTo] =
          /with chat ("[^"]*") and reply_to ("[^"]*")/.exec(content)!;
        await send.execute("fixture-call", {
          chat: JSON.parse(chat!),
          reply_to: JSON.parse(replyTo!),
          text: "Deterministic pi response; no model was called.",
        });
        await emit("agent_before_settle", { outcome: "completed" });
        idle = true;
        await emit("agent_settled", { type: "agent_settled" });
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
  void stopped;
});
process.on("SIGTERM", () => {
  void close();
});
process.on("SIGINT", () => {
  void close();
});
await emit("session_start", {});
process.stdout.write("READY\n");
