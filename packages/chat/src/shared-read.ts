import { useCallback, useSyncExternalStore } from "react";
import { errorMessage } from "./client";

/** What a shared read answered last: its items, or why it failed, the items before kept. */
export interface SharedRead<T> {
  items?: T;
  error?: string;
}

interface Entry<T> {
  read: SharedRead<T>;
  running?: Promise<void>;
  again: boolean;
  listeners: Set<() => void>;
}

const entries = new WeakMap<object, Map<string, Entry<unknown>>>();

function entry<T>(load: (key: string) => Promise<T>, key: string) {
  let byKey = entries.get(load);
  if (!byKey) entries.set(load, (byKey = new Map()));
  let found = byKey.get(key) as Entry<T> | undefined;
  if (!found) {
    found = { read: {}, again: false, listeners: new Set() };
    byKey.set(key, found as Entry<unknown>);
  }
  return found;
}

/**
 * Reads what `load` gives for a key, a kernel or a session, one read at a time for every screen
 * that shows it, all of them given the latest answer. Asked while a read runs, it reads once
 * more after it; with `join`, it waits for that read instead, as a screen that opens does.
 */
export function sharedRead<T>(
  load: (key: string) => Promise<T>,
  key: string,
  join = false,
): Promise<void> {
  const at = entry(load, key);
  if (at.running) {
    if (!join) at.again = true;
    return at.running;
  }
  const run = async () => {
    do {
      at.again = false;
      try {
        at.read = { items: await load(key) };
      } catch (error) {
        at.read = { ...at.read, error: errorMessage(error) };
      }
      at.listeners.forEach((listener) => listener());
    } while (at.again);
  };
  at.running = run().finally(() => (at.running = undefined));
  return at.running;
}

/**
 * Reads again what a screen shows of `load`: the key's, or every key's after a reconnection,
 * when notices may have been missed.
 */
export function rereadShown<T>(
  load: (key: string) => Promise<T>,
  key?: string,
) {
  entries.get(load)?.forEach((at, each) => {
    if (at.listeners.size && (key === undefined || key === each))
      void sharedRead(load, each);
  });
}

/** The latest answer of a shared read, and `reload` to read again. Nothing while not `enabled`. */
export function useSharedRead<T>(
  load: (key: string) => Promise<T>,
  key: string,
  enabled: boolean,
) {
  const at = entry(load, key);
  const subscribe = useCallback(
    (listener: () => void) => {
      at.listeners.add(listener);
      return () => void at.listeners.delete(listener);
    },
    [at],
  );
  // The same on a server render, as the web's tests make.
  const snapshot = () => at.read;
  const read = useSyncExternalStore(subscribe, snapshot, snapshot);
  const reload = useCallback(
    () => (enabled ? sharedRead(load, key) : Promise.resolve()),
    [load, key, enabled],
  );
  return { read: enabled ? read : undefined, reload };
}
