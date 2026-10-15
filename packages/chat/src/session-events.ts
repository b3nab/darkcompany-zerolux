import { useEffect, useRef, useState } from "react";
import { ApiError, api, errorMessage } from "./client";

/** What an agent's session did, in one model for pi, Claude Code and Codex (`/events`). */
export type SessionEvent = {
  /** Byte offset of the native record the event comes from. */
  at: number;
  /** The record's own timestamp, as the harness wrote it. */
  time: string | null;
} & (
  | {
      type: "input";
      text: string;
      /** The chat and delivery a ZeroLux envelope names: the turn belongs to that chat. */
      chat: string | null;
      delivery: string | null;
    }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: unknown; error: boolean }
  | { type: "turn_started" }
  | { type: "turn_ended"; status: string }
  | { type: "error"; message: string }
  | { type: "compacted"; summary: string | null }
);

export interface SessionEventPage {
  session_id: string;
  harness: string;
  events: SessionEvent[];
  /** Pass as `after` to continue. */
  next: number;
  /** The native record's size when read: `next < end` means there is more. */
  end: number;
}

/** A session's work as it is drawn: a tool call carries its result once there is one. */
export type SessionBlock =
  | { kind: "input"; text: string; chat: string | null }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      /** Absent while the tool still runs. */
      result?: { output: unknown; error: boolean };
    }
  | { kind: "turn"; status: string }
  | { kind: "error"; message: string }
  | { kind: "compacted"; summary: string | null };

/** The blocks of a session, in order: each tool result joins its call; a turn's start draws nothing. */
export function sessionBlocks(events: SessionEvent[]): SessionBlock[] {
  const blocks: SessionBlock[] = [];
  const calls = new Map<string, Extract<SessionBlock, { kind: "tool" }>>();
  for (const event of events) {
    switch (event.type) {
      case "input":
        blocks.push({ kind: "input", text: event.text, chat: event.chat });
        break;
      case "text":
      case "thinking":
        blocks.push({ kind: event.type, text: event.text });
        break;
      case "tool_call": {
        const call = {
          kind: "tool" as const,
          id: event.id,
          name: event.name,
          input: event.input,
        };
        calls.set(event.id, call);
        blocks.push(call);
        break;
      }
      case "tool_result": {
        const result = { output: event.output, error: event.error };
        const call = calls.get(event.id);
        if (call) call.result = result;
        else
          blocks.push({
            kind: "tool",
            id: event.id,
            name: "Tool",
            input: null,
            result,
          });
        break;
      }
      case "turn_ended":
        blocks.push({ kind: "turn", status: event.status });
        break;
      case "error":
        blocks.push({ kind: "error", message: event.message });
        break;
      case "compacted":
        blocks.push({ kind: "compacted", summary: event.summary });
        break;
    }
  }
  return blocks;
}

/** A short line for what a tool was given: its command, path, pattern, query or first text. */
export function toolLine(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const fields = input as Record<string, unknown>;
  const first =
    fields.command ??
    fields.file_path ??
    fields.path ??
    fields.pattern ??
    fields.query ??
    Object.values(fields).find((value) => typeof value === "string");
  return typeof first === "string" ? first : "";
}

/** A tool's input or output as text: a string as it is, anything else as indented JSON. */
export const toolText = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);

/**
 * A session's events from the start of its native record, read again from where they stopped
 * whenever `grown` changes: pass the `end` of its latest `session.output` notice.
 */
export function useSessionEvents(sessionId: string, grown?: number) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [error, setError] = useState("");
  const next = useRef(0);
  useEffect(() => {
    setEvents([]);
    setError("");
    next.current = 0;
  }, [sessionId]);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        for (;;) {
          const page = await api<SessionEventPage>(
            `/chat/sessions/${encodeURIComponent(sessionId)}/events?after=${next.current}`,
          );
          // A newer read owns the record from here.
          if (!live) return;
          next.current = page.next;
          if (page.events.length) setEvents((all) => [...all, ...page.events]);
          setError("");
          if (page.next >= page.end) return;
        }
      } catch (error) {
        if (!live) return;
        setError(
          error instanceof ApiError && error.status === 404
            ? "This kernel does not show session events yet: it needs an update."
            : errorMessage(error),
        );
      }
    })();
    return () => {
      live = false;
    };
  }, [sessionId, grown]);
  return { events, error };
}
