import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
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
 * and, once allowed, answers it in its chat. A wake: the turn reads the inbox. Every step goes
 * to `<workspace>/runner-trace.jsonl`, with IDs only, never message text.
 */
const workspace = process.env.ZEROLUX_WORKSPACE ?? ".";
const tracePath = join(workspace, "runner-trace.jsonl");
const trace = (event: string, fields: Record<string, unknown> = {}) =>
  appendFileSync(
    tracePath,
    `${JSON.stringify({ event, pid: process.pid, at: Date.now(), ...fields })}\n`,
  );
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const WAKE = "[ZeroLux] Messages from other agents";

let runner!: Runner;

function scripted(
  prompt: AsyncIterable<SDKUserMessage>,
  options: Options,
): Query {
  const sessionId = options.resume ?? options.sessionId ?? "";
  const out: SDKMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
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
  });

  void (async () => {
    for await (const input of prompt) {
      if (closed) return;
      const uuid = String(input.uuid);
      const text = String(input.message.content);
      const owner = !text.startsWith(WAKE);
      trace("input", { kind: owner ? "owner" : "wake", uuid });
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
          /with chat "([^"]+)" and reply_to "([^"]+)"/.exec(text) ?? [];
        if (result?.behavior === "allow" && chat) {
          const outcome = await runner.agent.bridge.post(
            chat,
            "Fixture operation done.",
            replyTo,
          );
          trace("reply", { chat, reply_to: replyTo, outcome });
        }
      } else {
        const inbox = runner.agent.readInbox();
        trace("inbox", { batches: inbox.split("[ZeroLux]").length - 1 });
      }
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
    interrupt: async () => {
      trace("interrupt");
      abort.abort();
      abort = new AbortController();
      return undefined;
    },
    close: () => {
      trace("close");
      closed = true;
      wake?.();
    },
  }) as unknown as Query;
}

launch(
  {
    start: ({ prompt, options }) => scripted(prompt, options),
    subscriber: (invalidate, lost) => new AgentLinkChild(invalidate, lost),
    connect: chatRequest,
    // A session this fixture already ran in this folder resumes.
    saved: async () => existsSync(tracePath),
  },
  (created) => (runner = created),
).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : "Fixture failed");
    process.exit(1);
  },
);
