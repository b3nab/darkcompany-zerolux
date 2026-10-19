import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AgentLinkChild, chatRequest } from "@zerolux/bridge";
import { launch, type Runner } from "../runner.ts";

/**
 * The real runner with a scripted model instead of Claude, for the kernel's end-to-end tests.
 * Same environment as the runner. An owner message: a turn that asks for `fixture_operation`
 * and, once allowed, answers it in its chat. Another agent's message: a turn that reads it. Every step goes
 * to `<workspace>/runner-trace.jsonl`, with IDs only, never message text.
 */
const workspace = process.env.ZEROLUX_WORKSPACE ?? ".";
const tracePath = join(workspace, "runner-trace.jsonl");
// The isolated terminal fixture's native transcript, not a ZeroLux sidecar.
const terminalHistory = (id: string) =>
  join(process.env.HOME!, ".claude/projects/terminal-fixture", `${id}.jsonl`);
const trace = (event: string, fields: Record<string, unknown> = {}) =>
  appendFileSync(
    tracePath,
    `${JSON.stringify({ event, pid: process.pid, at: Date.now(), ...fields })}\n`,
  );
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

let runner!: Runner;

function scripted(
  prompt: AsyncIterable<SDKUserMessage>,
  options: Options,
): Query {
  const sessionId = options.resume ?? options.sessionId ?? "";
  let model = options.model ?? "native-default";
  let effort = options.effort ?? "high";
  let permissionMode = options.permissionMode ?? "default";
  // The model remains scripted in this fixture. A real, isolated child exercises the
  // SDK spawn contract/lease, with no Claude binary, credentials or model requests.
  const native = options.spawnClaudeCodeProcess?.({
    command: process.execPath,
    args: [
      "-e",
      existsSync(join(workspace, "keep-native"))
        ? 'process.stdin.resume(); setInterval(() => {}, 1000); await Bun.write("native-ready", String(process.pid))'
        : "process.stdin.resume()",
    ],
    cwd: workspace,
    env: {
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      PATH: process.env.PATH,
    },
    signal: new AbortController().signal,
  });
  native?.stdout.resume();
  const out: SDKMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  // Model the SDK's stream ending when its native child dies.
  native?.on("exit", () => {
    closed = true;
    wake?.();
  });
  let abort = new AbortController();
  const emit = (message: unknown) => {
    out.push(message as SDKMessage);
    wake?.();
  };
  const state = (to: "running" | "idle") =>
    emit({
      type: "system",
      subtype: "session_state_changed",
      state: to,
      uuid: randomUUID(),
      session_id: sessionId,
    });
  trace("start", {
    resume: Boolean(options.resume),
    mode: options.permissionMode,
    session: sessionId,
    model: options.model ?? null,
    effort: options.effort ?? null,
    system_prompt: options.systemPrompt ?? null,
    hooks: Boolean(options.hooks),
    history:
      options.resume && existsSync(terminalHistory(sessionId))
        ? createHash("sha256")
            .update(readFileSync(terminalHistory(sessionId)))
            .digest("hex")
        : null,
  });

  emit({
    type: "system",
    subtype: "init",
    model,
    effort,
    permissionMode,
    session_id: sessionId,
    uuid: randomUUID(),
  });
  void (async () => {
    for await (const input of prompt) {
      if (closed) return;
      const uuid = String(input.uuid);
      const text = String(input.message.content);
      // Another agent's message: its envelope marks the author a peer.
      const owner = !text.includes('" (peer)');
      trace("input", { kind: owner ? "owner" : "peer", uuid });
      state("running");
      emit({
        type: "assistant",
        uuid: randomUUID(),
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { role: "assistant", content: [] },
        user_message_uuid: uuid,
        user_message_uuids: [uuid],
      });
      await settle(); // The runner reads the echo before the tool call.
      if (owner) {
        const result = await options.canUseTool!(
          "fixture_operation",
          { operation: "fixture" },
          {
            signal: abort.signal,
            toolUseID: randomUUID(),
            requestId: randomUUID(),
          },
        );
        trace("permission", { behavior: result?.behavior });
        const [, chat, replyTo] =
          /^Chat: (\S+); delivery: (\S+)$/m.exec(text) ?? [];
        if (result?.behavior === "allow" && chat) {
          const outcome = await runner.agent.bridge.post(
            chat,
            "Fixture operation done.",
            replyTo,
          );
          trace("reply", { chat, reply_to: replyTo, outcome });
        }
      } else trace("peer", { batches: text.split("[ZeroLux]").length - 1 });
      emit({
        type: "result",
        subtype: "success",
        uuid: randomUUID(),
        session_id: sessionId,
        user_message_uuid: uuid,
        user_message_uuids: [uuid],
      });
      state("idle");
    }
  })();

  async function* stream() {
    for (;;) {
      const next = out.shift();
      if (next) yield next;
      else if (closed) return;
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return Object.assign(stream(), {
    initializationResult: async () => ({}),
    getSettings: async () => ({
      applied: { model, effort },
      effective: { env: { PRIVATE_FIXTURE_VALUE: "must-not-be-published" } },
    }),
    supportedModels: async () => [
      {
        value: "native-default",
        displayName: "Native default",
        supportedEffortLevels: ["low", "high"],
      },
      {
        value: "native-alternate",
        displayName: "Native alternate",
        supportedEffortLevels: ["medium", "high"],
      },
    ],
    applyFlagSettings: async (settings: {
      model?: string;
      effortLevel?: Options["effort"];
    }) => {
      if (settings.model) model = settings.model;
      if (settings.effortLevel) effort = settings.effortLevel;
      trace("settings", { model, effort });
    },
    setPermissionMode: async (mode: NonNullable<Options["permissionMode"]>) => {
      permissionMode = mode;
      trace("settings", { permissionMode });
      emit({
        type: "system",
        subtype: "status",
        permissionMode,
        session_id: sessionId,
        uuid: randomUUID(),
      });
    },
    interrupt: async () => {
      trace("interrupt");
      abort.abort();
      abort = new AbortController();
      return undefined;
    },
    close: () => {
      trace("close");
      closed = true;
      native?.stdin.end();
      wake?.();
    },
  }) as unknown as Query;
}

// Claude Code's own fork of a saved session, as the runner's `fork` answers: a new ID.
if (process.argv[2] === "fork") {
  trace("fork", { session: process.argv[3], up_to: process.argv[4] ?? null });
  console.log(JSON.stringify({ session_id: randomUUID() }));
  process.exit(0);
}

launch(
  {
    start: ({ prompt, options }) => scripted(prompt, options),
    subscriber: (invalidate, lost) => new AgentLinkChild(invalidate, lost),
    connect: chatRequest,
    // Both sessions created by this fixture and its independently started terminal.
    saved: async (id, dir) => {
      if (existsSync(tracePath)) return true;
      if (!existsSync(terminalHistory(id))) return false;
      const first = JSON.parse(
        readFileSync(terminalHistory(id), "utf8").split("\n")[0]!,
      );
      return first.sessionId === id && first.cwd === dir;
    },
  },
  (created) => {
    runner = created;
    const describe = created.describe.bind(created);
    created.describe = () => {
      const state = describe();
      if (existsSync(join(workspace, "legacy-description")))
        for (const key of [
          "started",
          "native_guard",
          "native_phase",
          "native_pid",
        ])
          Reflect.deleteProperty(state, key);
      return state;
    };
  },
).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : "Fixture failed");
    process.exit(1);
  },
);
