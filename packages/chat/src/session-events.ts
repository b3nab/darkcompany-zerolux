import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, errorMessage } from "./client";
import type { Approval } from "./chat";
import {
  changeCount,
  isSubagent,
  patchCount,
  toolPhrase,
  toolView,
} from "./tool-view";

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
  /** Where the page starts: pass as `before` for earlier events; 0 at the record's start. */
  first: number;
  /** Where the page ends: pass as `after` for later events. */
  next: number;
  /** The native record's size when read: `next < end` means there is more. */
  end: number;
}

/**
 * A session's work as it is drawn: a tool call carries its result once there is one. `key` names
 * the event it comes from (a tool's call) by its record and place in it, so it holds as earlier
 * work arrives: a record can hold several events, and a page never splits one.
 */
export type SessionBlock = {
  key: string;
  /** When its event was recorded, as the harness wrote it. */
  time: string | null;
} & (
  | {
      kind: "input";
      text: string;
      chat: string | null;
      /** Its offset in `/events`: a fork or a rewind before it names it. */
      at: number;
    }
  | { kind: "text"; text: string }
  | {
      kind: "thinking";
      text: string;
      /** When the next event came: how long the reasoning took. */
      until?: string | null;
    }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      /** Absent while the tool still runs. */
      result?: { output: unknown; error: boolean; time: string | null };
      /** The turn ended before the tool gave anything back. */
      stopped?: boolean;
    }
  | {
      kind: "turn";
      status: string;
      /** When the turn's first event was recorded: with `time`, how long it worked. */
      since: string | null;
    }
  | { kind: "error"; message: string }
  | { kind: "compacted"; summary: string | null }
);
export type ToolBlock = Extract<SessionBlock, { kind: "tool" }>;

/** The blocks of a session, in order: each tool result joins its call; a turn's start draws nothing. */
export function sessionBlocks(events: SessionEvent[]): SessionBlock[] {
  const blocks: SessionBlock[] = [];
  const calls = new Map<string, ToolBlock>();
  let record = -1;
  let place = 0;
  let since: string | null = null;
  let thought: Extract<SessionBlock, { kind: "thinking" }> | undefined;
  for (const event of events) {
    place = event.at === record ? place + 1 : 0;
    record = event.at;
    const key = `${event.at}.${place}`;
    const { time } = event;
    since ??= time;
    if (thought) {
      thought.until = time;
      thought = undefined;
    }
    switch (event.type) {
      case "input":
        blocks.push({
          key,
          time,
          kind: "input",
          text: event.text,
          chat: event.chat,
          at: event.at,
        });
        break;
      case "text":
        blocks.push({ key, time, kind: "text", text: event.text });
        break;
      case "thinking":
        thought = { key, time, kind: "thinking", text: event.text };
        blocks.push(thought);
        break;
      case "tool_call": {
        const call: ToolBlock = {
          key,
          time,
          kind: "tool",
          id: event.id,
          name: event.name,
          input: event.input,
        };
        calls.set(event.id, call);
        blocks.push(call);
        break;
      }
      case "tool_result": {
        const result = { output: event.output, error: event.error, time };
        const call = calls.get(event.id);
        if (call) call.result = result;
        else
          blocks.push({
            key,
            time,
            kind: "tool",
            id: event.id,
            name: "Tool",
            input: null,
            result,
          });
        break;
      }
      case "turn_ended":
        for (const call of calls.values())
          if (!call.result) call.stopped = true;
        calls.clear();
        blocks.push({ key, time, kind: "turn", status: event.status, since });
        since = null;
        break;
      case "error":
        blocks.push({ key, time, kind: "error", message: event.message });
        break;
      case "compacted":
        blocks.push({ key, time, kind: "compacted", summary: event.summary });
        break;
    }
  }
  return blocks;
}

/** A request of the session, placed in its stream where it was made. */
export interface ApprovalItem {
  kind: "approval";
  key: string;
  approval: Approval;
}

/**
 * Blocks as they are listed: tools run one after another make one list, keyed by the first.
 * A subagent and a request each stand on their own.
 */
export interface ToolsRun {
  kind: "tools";
  key: string;
  tools: ToolBlock[];
}
export type BlockRun<T extends SessionBlock | ApprovalItem = SessionBlock> =
  | T
  | ToolsRun;

export function blockRuns<T extends SessionBlock | ApprovalItem>(
  blocks: T[],
): BlockRun<T>[] {
  const runs: BlockRun<T>[] = [];
  for (const block of blocks) {
    const last = runs.at(-1);
    if (block.kind !== "tool" || isSubagent(block)) runs.push(block);
    else if (last?.kind === "tools") last.tools.push(block);
    else runs.push({ kind: "tools", key: block.key, tools: [block] });
  }
  return runs;
}

/**
 * A session's requests in its stream, each after the last block recorded before it was made;
 * one made after everything read stands at the end.
 */
export function placeApprovals(
  blocks: SessionBlock[],
  approvals: Approval[],
): (SessionBlock | ApprovalItem)[] {
  const items: (SessionBlock | ApprovalItem)[] = [...blocks];
  const sorted = [...approvals].sort((a, b) => a.created_at - b.created_at);
  for (const approval of sorted) {
    const item: ApprovalItem = { kind: "approval", key: approval.id, approval };
    let at = items.length;
    while (at > 0) {
      const before = items[at - 1]!;
      const time =
        before.kind === "approval"
          ? before.approval.created_at
          : before.time
            ? Date.parse(before.time)
            : NaN;
      if (Number.isNaN(time) || time <= approval.created_at) break;
      at--;
    }
    items.splice(at, 0, item);
  }
  return items;
}

/** How much of a session's work is drawn: the outcome, the usual lines, or every step open. */
export type Density = "compact" | "normal" | "detailed";
export const densityLabels: Record<Density, string> = {
  compact: "Compact",
  normal: "Normal",
  detailed: "Detailed",
};

/** The work an agent did for a chat, from the input whose envelope named the delivery. */
export interface ChatTurn {
  delivery: string;
  /** When the input arrived, as the harness wrote it. */
  time: string | null;
  events: SessionEvent[];
  /** The turn ended, or a later input took it over; until then it is still running. */
  ended: boolean;
}

/**
 * A chat's turns in a session's events, in order: each starts at an input naming that chat
 * and runs until the turn ends or another input arrives.
 */
export function chatTurns(events: SessionEvent[], chatId: string): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let current: ChatTurn | undefined;
  for (const event of events) {
    if (event.type === "input") {
      if (current) current.ended = true;
      current =
        event.chat === chatId && event.delivery
          ? {
              delivery: event.delivery,
              time: event.time,
              events: [],
              ended: false,
            }
          : undefined;
      if (current) turns.push(current);
    } else if (current && event.type !== "turn_started") {
      current.events.push(event);
      if (event.type === "turn_ended") {
        current.ended = true;
        current = undefined;
      }
    }
  }
  return turns;
}

/** How long a turn took, from its input to its last event with a time. */
export function turnTime(turn: ChatTurn): number | undefined {
  const last = [...turn.events].reverse().find((e) => e.time)?.time;
  if (!turn.time || !last) return undefined;
  return Date.parse(last) - Date.parse(turn.time);
}

/** A span of time, short: 45s, 12m, 2h 5m. */
export function spanLabel(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}

/** How long work went and how it ended: "worked for 3m", "was interrupted after 1m". */
export function workPhrase(ms: number | undefined, status?: string) {
  const span = ms === undefined || Number.isNaN(ms) ? "" : spanLabel(ms);
  return status === "interrupted"
    ? `was interrupted${span && ` after ${span}`}`
    : status === "error"
      ? `stopped on an error${span && ` after ${span}`}`
      : `worked${span && ` for ${span}`}`;
}

/** A turn's end as a divider says it: "Worked for 2m 13s", "Was interrupted after 1m". */
export function turnLabel(block: Extract<SessionBlock, { kind: "turn" }>) {
  const phrase = workPhrase(
    block.since && block.time
      ? Date.parse(block.time) - Date.parse(block.since)
      : undefined,
    block.status,
  );
  return phrase[0]!.toUpperCase() + phrase.slice(1);
}

/** "Thought for 4s" once the next step came; until then, still thinking. */
export function thoughtLabel(
  block: Extract<SessionBlock, { kind: "thinking" }>,
) {
  const ms =
    block.time && block.until
      ? Date.parse(block.until) - Date.parse(block.time)
      : NaN;
  return ms >= 1000 ? `Thought for ${spanLabel(ms)}` : "Thinking";
}

/**
 * The blocks that arrived after the last one shown, for a list to animate them in: what loads
 * first, or earlier above, is simply there.
 */
export function useArrivals(blocks: { key: string }[]): Set<string> {
  const shown = useRef<{ keys: Set<string>; last?: string }>({
    keys: new Set(),
  });
  const { keys, last } = shown.current;
  const after =
    last === undefined ? -1 : blocks.findIndex((b) => b.key === last);
  const fresh = new Set(
    after < 0
      ? []
      : blocks
          .slice(after + 1)
          .filter((b) => !keys.has(b.key))
          .map((b) => b.key),
  );
  useEffect(() => {
    shown.current = {
      keys: new Set(blocks.map((b) => b.key)),
      last: blocks.at(-1)?.key,
    };
  });
  return fresh;
}

/** A finished turn in a few words, after the agent's name: how it went, what it changed and ran. */
export function turnLine(turn: ChatTurn, blocks: SessionBlock[]): string {
  const last = blocks.at(-1);
  const { tools, reasoned, files, added, removed } = turnSummary(blocks);
  return [
    workPhrase(turnTime(turn), last?.kind === "turn" ? last.status : undefined),
    files && `${files} ${files === 1 ? "file" : "files"} +${added} −${removed}`,
    tools && `${tools} ${tools === 1 ? "tool" : "tools"}`,
    reasoned && "reasoned",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A turn's work in numbers: its tools, the files it changed and their lines, whether it reasoned. */
export function turnSummary(blocks: SessionBlock[]) {
  const tools = blocks.filter((b): b is ToolBlock => b.kind === "tool");
  const changed = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const tool of tools) {
    if (tool.result?.error) continue;
    const view = toolView(tool.name, tool.input);
    const change =
      view.kind === "edit"
        ? { paths: [view.path], ...changeCount(view.changes) }
        : view.kind === "write"
          ? {
              paths: [view.path],
              ...changeCount([{ before: "", after: view.text }]),
            }
          : view.kind === "patch"
            ? { paths: view.files, ...patchCount(view.patch) }
            : undefined;
    if (!change) continue;
    for (const path of change.paths) changed.add(path);
    added += change.added;
    removed += change.removed;
  }
  return {
    tools: tools.length,
    reasoned: blocks.some((b) => b.kind === "thinking"),
    files: changed.size,
    added,
    removed,
  };
}

/** What a running turn is doing now: its running tool, its reasoning or its writing. */
export function currentStep(blocks: SessionBlock[]): string | undefined {
  const last = blocks.at(-1);
  if (!last) return undefined;
  if (last.kind === "tool" && !last.result && !last.stopped) {
    const { verb, subject } = toolPhrase(toolView(last.name, last.input), true);
    return subject ? `${verb} ${subject}` : verb;
  }
  // A reasoning summary that opens with a bold heading says what it is about.
  if (last.kind === "thinking")
    return /^\s*\*\*(.+?)\*\*/.exec(last.text)?.[1] ?? "Thinking";
  if (last.kind === "text") return "Writing";
  return undefined;
}

/** A tool's name as read: an MCP tool as its server and tool, `mcp__zerolux__send` as `zerolux · send`. */
export function toolName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name;
}

/** A tool's input or output as text: a string as it is, anything else as indented JSON. */
export const toolText = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);

const UPDATE =
  "This kernel does not show agents' work yet: it needs an update.";
/** Past the end of any record: a read back from here starts at the end. */
const LATEST = Number.MAX_SAFE_INTEGER;

/** What has been read of a session's events: a stretch of its record, up to the latest. */
export interface SessionRecord {
  events: SessionEvent[];
  /** Where the events read start; 0 at the record's start; absent before the first read. */
  first?: number;
  /** Where they end: later events are read from here. */
  next: number;
  error: string;
}

/**
 * Reads a session's events back from the end, and forward as the record grows: all its
 * work, or with `chat` only the turns that chat's messages opened. One read at a time.
 */
export function sessionReader(
  sessionId: string,
  chat: string | undefined,
  changed: (record: SessionRecord) => void,
  /** One of its subagents, whose events come in the same pages. */
  subagent?: string,
) {
  const record: SessionRecord = { events: [], next: 0, error: "" };
  let closed = false;
  let queue = Promise.resolve();
  const page = (cursor: string) =>
    api<SessionEventPage>(
      `/sessions/${encodeURIComponent(sessionId)}${subagent ? `/subagents/${encodeURIComponent(subagent)}` : ""}/events?${cursor}${chat ? `&chat=${encodeURIComponent(chat)}` : ""}`,
    );
  // Drawn once per read, when it is over and changed something: never page by page.
  let shown = "";
  const show = () => {
    // Where reading stands is not on screen: only what was read, and whether there is more.
    const now = `${record.first}:${record.events.length}:${record.error}`;
    if (closed || now === shown) return;
    shown = now;
    changed({ ...record });
  };
  const run = (step: () => Promise<void>) =>
    (queue = queue.then(async () => {
      if (closed) return;
      try {
        await step();
        record.error = "";
      } catch (error) {
        record.error =
          error instanceof ApiError && error.status === 404
            ? UPDATE
            : errorMessage(error);
      }
      show();
    }));
  return {
    /** Earlier events: one page, or with `since` (ms) back to an event at or before it. */
    earlier: (since?: number) =>
      run(async () => {
        do {
          if (record.first === 0 || closed) return;
          const read = await page(`before=${record.first ?? LATEST}`);
          // A kernel that reads only forward has no `first`.
          if (read.first === undefined) throw new Error(UPDATE);
          if (record.first === undefined) record.next = read.next;
          record.first = read.first;
          if (read.events.length)
            record.events = [...read.events, ...record.events];
        } while (since !== undefined && !reached(record.events, since));
      }),
    /** Later events, up to `end`: the record's size its latest notice gave. */
    grow: (end: number) =>
      run(async () => {
        while (record.first !== undefined && record.next < end && !closed) {
          const from = record.next;
          const read = await page(`after=${from}`);
          if (read.events.length)
            record.events = [...record.events, ...read.events];
          record.next = read.next;
          // A record still being written stops at its last whole line.
          if (read.next >= read.end || read.next === from) return;
        }
      }),
    close: () => {
      closed = true;
    },
  };
}
type SessionReader = ReturnType<typeof sessionReader>;

/** The earliest event read is at or before `since`: everything after it is read. */
const reached = (events: SessionEvent[], since: number) => {
  const time = events.find((e) => e.time)?.time;
  return !!time && Date.parse(time) <= since;
};

const unread: SessionRecord = { events: [], next: 0, error: "" };

/**
 * A session's work, the latest first: earlier pages on request, later events whenever `grown`
 * changes (the `end` of its latest `session.output` notice). With `subagent`, that subagent's
 * work instead, read to its end whenever the session's record grows.
 */
export function useSessionEvents(
  sessionId: string,
  grown?: number,
  subagent?: string,
) {
  const [record, setRecord] = useState(unread);
  const reader = useRef<SessionReader>(undefined);
  useEffect(() => {
    const opened = sessionReader(sessionId, undefined, setRecord, subagent);
    reader.current = opened;
    setRecord(unread);
    void opened.earlier();
    return opened.close;
  }, [sessionId, subagent]);
  useEffect(() => {
    if (grown === undefined) return;
    // No notice says where a subagent's record ends: it is read to its end.
    void reader.current?.grow(subagent ? Number.MAX_SAFE_INTEGER : grown);
  }, [sessionId, grown, subagent]);
  return {
    events: record.events,
    error: record.error,
    /** There is earlier work to read. */
    more: !!record.first,
    earlier: () => void reader.current?.earlier(),
  };
}

/** One agent session's work in a chat. */
export interface ChatWork {
  sessionId: string;
  turns: ChatTurn[];
  error: string;
}

/**
 * The work each session did for a chat, turn by turn: read back to `since` (the oldest
 * message shown, in ms), then followed as each record grows.
 */
export function useChatWork(
  chat: string,
  sessionIds: string[],
  outputs: Record<string, { end: number }>,
  since: number | undefined,
): ChatWork[] {
  const [records, setRecords] = useState<Record<string, SessionRecord>>({});
  const readers = useRef(new Map<string, SessionReader>());
  const key = sessionIds.join(" ");
  useEffect(() => {
    const opened = new Map(
      (key ? key.split(" ") : []).map((id) => [
        id,
        sessionReader(id, chat, (record) =>
          setRecords((all) => ({ ...all, [id]: record })),
        ),
      ]),
    );
    readers.current = opened;
    setRecords({});
    return () => opened.forEach((reader) => reader.close());
  }, [chat, key]);
  useEffect(() => {
    const from = since ?? Date.now();
    readers.current.forEach((reader) => void reader.earlier(from));
  }, [chat, key, since]);
  useEffect(() => {
    readers.current.forEach((reader, id) => {
      const end = outputs[id]?.end;
      if (end !== undefined) void reader.grow(end);
    });
  }, [chat, key, outputs]);
  return useMemo(
    () =>
      sessionIds.map((sessionId) => ({
        sessionId,
        turns: chatTurns(records[sessionId]?.events ?? [], chat),
        error: records[sessionId]?.error ?? "",
      })),
    // The key stands for the ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [records, chat, key],
  );
}
