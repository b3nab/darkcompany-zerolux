// Stock-pi-shaped fixture: actual extension/control/bridge, deterministic native execution.
// Only used with a temporary HOME and a session allocated by the test kernel. No model/API.
import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import {
  SessionManager,
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import chatExtension from "../chat-extension.ts";
if (process.argv.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}
const root = realpathSync(process.env.HOME!);
const value = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const file = realpathSync(value("--session")!);
if (!file.startsWith(root + "/"))
  throw new Error("Fixture refuses a session outside its temporary HOME");
const manager = SessionManager.open(file);
const models = ["native-model", "native-alternate"].map((id) => ({
  provider: "fixture",
  id,
  name: `Fixture ${id}`,
  reasoning: true,
}));
const saved = manager.buildSessionContext();
const selected = value("--model") ?? saved.model?.modelId ?? "native-model";
const separator = selected.indexOf("/");
const provider =
  separator < 0
    ? (value("--provider") ?? saved.model?.provider ?? "fixture")
    : selected.slice(0, separator);
const modelId = separator < 0 ? selected : selected.slice(separator + 1);
let model = models.find(
  (model) => model.provider === provider && model.id === modelId,
)!;
if (!model) throw new Error("Unavailable fixture model");
let thinking = (value("--thinking") ??
  (saved.model ? saved.thinkingLevel : "high")) as ReturnType<
  ExtensionAPI["getThinkingLevel"]
>;
if (!manager.buildSessionContext().model) {
  manager.appendModelChange(model.provider, model.id);
  manager.appendThinkingLevelChange(thinking as "high");
}
appendFileSync(
  join(root, "native-starts.jsonl"),
  JSON.stringify({
    pid: process.pid,
    parent: process.ppid,
    native: manager.getSessionId(),
    file,
    explicit_model: Boolean(value("--model")),
    model: `${model.provider}/${model.id}`,
    effort: thinking,
  }) + "\n",
);
const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
const tools = new Map<string, any>();
const events = new EventEmitter();
let idle = true,
  closing = false;
const ctx = {
  mode: value("--mode") === "rpc" ? "rpc" : "tui",
  cwd: process.cwd(),
  sessionManager: manager,
  get model() {
    return model;
  },
  modelRegistry: {
    getAvailable: () => models,
    hasConfiguredAuth: () => !existsSync(join(root, "no-auth")),
  },
  isIdle: () => idle,
  hasPendingMessages: () => false,
  abort: () => {
    idle = true;
  },
  shutdown: () => {
    void close();
  },
  ui: { setStatus() {}, notify() {}, getEditorText: () => "" },
} as unknown as ExtensionContext;
async function emit(name: string, event: unknown = {}) {
  for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
}
const pi = {
  on(name: string, handler: (event: any, ctx: any) => any) {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
  },
  registerTool(tool: any) {
    tools.set(tool.name, tool);
  },
  registerCommand() {},
  getThinkingLevel: () => thinking,
  setModel: async (next: typeof model) => {
    if (existsSync(join(root, "no-auth"))) return false;
    model = next;
    manager.appendModelChange(model.provider, model.id);
    await emit("model_select");
    return true;
  },
  setThinkingLevel: (next: typeof thinking) => {
    thinking = next;
    manager.appendThinkingLevelChange(next);
  },
  events: {
    on(name: string, handler: (...args: any[]) => void) {
      events.on(name, handler);
      return () => events.off(name, handler);
    },
    emit(name: string, data: unknown) {
      events.emit(name, data);
    },
  },
  sendUserMessage(content: string) {
    idle = false;
    setTimeout(() => {
      void (async () => {
        const [_, chat, reply] =
          /with chat ("[^"]*") and reply_to ("[^"]*")/.exec(content)!;
        appendFileSync(
          join(root, "native-inputs.jsonl"),
          JSON.stringify({ reply: JSON.parse(reply!) }) + "\n",
        );
        await emit("agent_start");
        manager.appendMessage({ role: "user", content, timestamp: Date.now() });
        await emit("message_start", { message: { role: "user", content } });
        await tools.get("zerolux_send").execute("fixture", {
          chat: JSON.parse(chat!),
          reply_to: JSON.parse(reply!),
          text: "Fixture pi response; no model",
        });
        idle = true;
        await emit("agent_settled");
      })().catch((error) => {
        console.error(error);
        process.exit(7);
      });
    }, 10);
  },
} as unknown as ExtensionAPI;
chatExtension(pi);
chatExtension(pi); // Explicit companion plus project installation must not duplicate controllers.
await emit("session_start", { reason: "startup" });
let buffer = "";
process.stdin.on("data", (bytes) => {
  buffer += bytes;
  let end: number;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (request.type !== "get_state")
      throw new Error("Fixture refuses native prompt commands");
    console.log(
      JSON.stringify({
        type: "response",
        id: request.id,
        success: true,
        data: {
          sessionId: manager.getSessionId(),
          sessionFile: file,
          model,
          thinkingLevel: thinking,
        },
      }),
    );
  }
});
async function close() {
  if (closing) return;
  closing = true;
  await emit("session_shutdown", { reason: "quit" });
  process.exit(0);
}
process.stdin.on("end", () => {
  void close();
});
process.on("SIGTERM", () => {
  void close();
});
