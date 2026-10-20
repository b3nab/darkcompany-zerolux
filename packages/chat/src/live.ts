import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { SessionGoal } from "./goal";

/** What a session is producing right now, before its harness writes it to the native record. */
export type LiveKind = "text" | "thinking" | "output";

/** An item of the step in progress: the agent's words, its reasoning or a tool's output. */
export interface LiveItem {
  id: string;
  kind: LiveKind;
  text: string;
  /** Complete: the native record has it, and it goes once the record shown has it too. */
  done?: boolean;
}

/** An input of the owner's, waiting in the harness's queue for the turn to end. */
export interface QueuedInput {
  id: string;
  text: string;
  /** Whether it can still be rewritten or taken back: only where its harness allows it. */
  changeable: boolean;
}

/** How full a session's context is and what it has used, as its harness counts them; null when it does not say. */
export interface SessionUsage {
  context_tokens: number | null;
  context_window: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
}

export type LiveChange =
  | { type: "append" | "set"; item: string; kind: LiveKind; text: string }
  | { type: "done"; item: string }
  | { type: "clear" }
  /** The whole queue as it is now. */
  | { type: "queue"; items: QueuedInput[] }
  /** The latest usage, in place of the one before. */
  | ({ type: "usage" } & Partial<SessionUsage>)
  /** The goal as it is now; null once cleared. */
  | { type: "goal"; goal: SessionGoal | null };

/** What is in progress and what waits, and the number of the last change it includes. */
export interface LiveState {
  seq: number;
  items: LiveItem[];
  queue: QueuedInput[];
  usage: SessionUsage | null;
  /** What it works toward on its own: Codex's goal. */
  goal: SessionGoal | null;
}

/** The kernel's notice of a session's changes, numbered from `first`. */
export interface LiveNotice {
  type: "session.live";
  session_id: string;
  first: number;
  changes: LiveChange[];
}

export const noLive: LiveState = {
  seq: 0,
  items: [],
  queue: [],
  usage: null,
  goal: null,
};

/** What the kernel sends of a usage: what is missing is unknown. */
const usageOf = (usage: Partial<SessionUsage>): SessionUsage => ({
  context_tokens: usage.context_tokens ?? null,
  context_window: usage.context_window ?? null,
  total_tokens: usage.total_tokens ?? null,
  cost_usd: usage.cost_usd ?? null,
});

/** How full the context is, from 0 to 1, when the harness says both how much and of what. */
export function contextShare(usage: SessionUsage | null): number | undefined {
  if (!usage?.context_tokens || !usage.context_window) return undefined;
  return Math.min(1, usage.context_tokens / usage.context_window);
}

/** How long a complete item stays, at most, while the record shown catches up. */
export const SETTLE_MS = 2000;

/**
 * The state after a notice, its changes applied in order after `seq`; those already in it are
 * skipped. Undefined when a change before them is missing: the state is read again.
 */
export function applyLive(
  state: LiveState,
  notice: Pick<LiveNotice, "first" | "changes">,
): LiveState | undefined {
  if (notice.first > state.seq + 1) return undefined;
  let items = state.items;
  let queue = state.queue;
  let usage = state.usage;
  let goal = state.goal;
  notice.changes.forEach((change, n) => {
    if (notice.first + n <= state.seq) return;
    // The turn's end leaves the queue: what waits starts the next one.
    if (change.type === "clear") items = [];
    else if (change.type === "queue") queue = change.items;
    else if (change.type === "usage") usage = usageOf(change);
    else if (change.type === "goal") goal = change.goal;
    else if (change.type === "done")
      items = items.map((open) =>
        open.id === change.item ? { ...open, done: true } : open,
      );
    else if (items.some((open) => open.id === change.item))
      items = items.map((open) =>
        open.id === change.item
          ? {
              ...open,
              text:
                change.type === "set" ? change.text : open.text + change.text,
            }
          : open,
      );
    else
      items = [
        ...items,
        { id: change.item, kind: change.kind, text: change.text },
      ];
  });
  return {
    seq: Math.max(state.seq, notice.first + notice.changes.length - 1),
    items,
    queue,
    usage,
    goal,
  };
}

/** The kernel's `/sessions/{id}/live`: a kernel without a queue leaves it out. */
export type LiveRead = Pick<LiveState, "seq" | "items"> & Partial<LiveState>;
type Read = (sessionId: string) => Promise<LiveRead>;
interface Watched {
  state: LiveState;
  read: Read;
  /** Notices that came while the state was being read again; applied after it. */
  waiting?: LiveNotice[];
  listeners: Set<() => void>;
}
const watched = new Map<string, Watched>();

function publish(entry: Watched, state: LiveState) {
  entry.state = state;
  entry.listeners.forEach((listener) => listener());
}

function reread(sessionId: string) {
  const entry = watched.get(sessionId);
  if (!entry || entry.waiting) return;
  entry.waiting = [];
  entry.read(sessionId).then(
    (read) => {
      const waiting = entry.waiting ?? [];
      entry.waiting = undefined;
      let state: LiveState | undefined = {
        seq: read.seq,
        items: read.items.map(({ id, kind, text }) => ({ id, kind, text })),
        queue: read.queue ?? [],
        usage: read.usage ? usageOf(read.usage) : null,
        goal: read.goal ?? null,
      };
      for (const notice of waiting) state = state && applyLive(state, notice);
      if (state) publish(entry, state);
      else reread(sessionId);
    },
    () => {
      // Kept as it was; the next notice or reconnection reads it again.
      entry.waiting = undefined;
    },
  );
}

/** Complete items go: the record shown has them, or has had the time to. */
function settle(sessionId: string) {
  const entry = watched.get(sessionId);
  if (entry?.state.items.some((item) => item.done))
    publish(entry, {
      ...entry.state,
      items: entry.state.items.filter((item) => !item.done),
    });
}

/** A session's live notice, for whoever is following that session. */
export function liveNotice(notice: LiveNotice) {
  const entry = watched.get(notice.session_id);
  if (!entry) return;
  if (entry.waiting) return void entry.waiting.push(notice);
  const state = applyLive(entry.state, notice);
  if (!state) return reread(notice.session_id);
  publish(entry, state);
  if (notice.changes.some((change) => change.type === "done"))
    setTimeout(() => settle(notice.session_id), SETTLE_MS);
}

/** After a reconnection, every followed session is read again: notices may have been missed. */
export function liveResync() {
  watched.forEach((_, sessionId) => reread(sessionId));
}

/** Follows a session's live state from the kernel; the last one to stop forgets it. */
export function watchLive(sessionId: string, read: Read, listener: () => void) {
  let entry = watched.get(sessionId);
  if (!entry) {
    entry = { state: noLive, read, listeners: new Set() };
    watched.set(sessionId, entry);
  }
  const followed = entry;
  followed.listeners.add(listener);
  if (followed.listeners.size === 1) reread(sessionId);
  return () => {
    followed.listeners.delete(listener);
    if (!followed.listeners.size && watched.get(sessionId) === followed)
      watched.delete(sessionId);
  };
}

export const liveState = (sessionId: string) =>
  watched.get(sessionId)?.state ?? noLive;

/**
 * What the session is producing right now, to show at the end of its stream after the
 * record's events. `read` gets `/sessions/{id}/live`; `record` changes whenever the record
 * shown grows, and then complete items give way to their events.
 */
export function useSessionLive(
  sessionId: string,
  read: Read,
  record: unknown,
): LiveItem[] {
  const subscribe = useCallback(
    (listener: () => void) => watchLive(sessionId, read, listener),
    // The reader stays the same for a session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId],
  );
  const snapshot = () => liveState(sessionId);
  useEffect(() => settle(sessionId), [sessionId, record]);
  return useSyncExternalStore(subscribe, snapshot, snapshot).items;
}

/** The owner's inputs waiting in the session's queue, in order, to show above the box. */
export function useSessionQueue(sessionId: string, read: Read): QueuedInput[] {
  const subscribe = useCallback(
    (listener: () => void) => watchLive(sessionId, read, listener),
    // The reader stays the same for a session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId],
  );
  const snapshot = () => liveState(sessionId);
  return useSyncExternalStore(subscribe, snapshot, snapshot).queue;
}

/** How full the session's context is and what it has used, as its harness last reported. */
export function useSessionUsage(
  sessionId: string,
  read: Read,
): SessionUsage | null {
  const subscribe = useCallback(
    (listener: () => void) => watchLive(sessionId, read, listener),
    // The reader stays the same for a session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId],
  );
  const snapshot = () => liveState(sessionId);
  return useSyncExternalStore(subscribe, snapshot, snapshot).usage;
}

/** The goal the session works toward on its own, as its harness last reported. */
export function useSessionGoal(
  sessionId: string,
  read: Read,
): SessionGoal | null {
  const subscribe = useCallback(
    (listener: () => void) => watchLive(sessionId, read, listener),
    // The reader stays the same for a session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId],
  );
  const snapshot = () => liveState(sessionId);
  return useSyncExternalStore(subscribe, snapshot, snapshot).goal;
}
