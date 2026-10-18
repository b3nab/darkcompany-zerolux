import { useSyncExternalStore } from "react";

/**
 * When you last looked at each session's work, in its own output time: what it wrote after
 * that is new to you. Each device keeps its own; a client can keep it across restarts with
 * `keepSeenIn`.
 */
let seen: Record<string, number> = {};
const listeners = new Set<() => void>();
let save: ((all: Record<string, number>) => void) | undefined;

/** Starts from what a client saved, and saves every change through `store`. */
export function keepSeenIn(
  saved: Record<string, unknown>,
  store: (all: Record<string, number>) => void,
) {
  seen = Object.fromEntries(
    Object.entries(saved).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
  save = store;
}

/** You saw a session's work up to `at`; an earlier time changes nothing. */
export function markSeen(sessionId: string, at: number) {
  if ((seen[sessionId] ?? 0) >= at) return;
  seen = { ...seen, [sessionId]: at };
  save?.(seen);
  listeners.forEach((listener) => listener());
}

/** When you last looked at each session, as it changes. */
export const useSeen = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => seen,
    () => seen,
  );
