import { useCallback, useEffect, useSyncExternalStore } from "react";

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

export type LiveChange =
  | { type: "append" | "set"; item: string; kind: LiveKind; text: string }
  | { type: "done"; item: string }
  | { type: "clear" };

/** What is in progress, and the number of the last change it includes. */
export interface LiveState {
  seq: number;
  items: LiveItem[];
}

/** The kernel's notice of a session's changes, numbered from `first`. */
export interface LiveNotice {
  type: "session.live";
  session_id: string;
  first: number;
  changes: LiveChange[];
}

export const noLive: LiveState = { seq: 0, items: [] };

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
  notice.changes.forEach((change, n) => {
    if (notice.first + n <= state.seq) return;
    if (change.type === "clear") items = [];
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
  };
}

type Read = (sessionId: string) => Promise<LiveState>;
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
