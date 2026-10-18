import { useSyncExternalStore } from "react";

/**
 * A preference this browser keeps: read once, shared by every view that uses it, saved on
 * each change. Without storage it starts from `fallback` and lasts until the page reloads.
 */
export function stored<T>(
  key: string,
  fallback: T,
  valid: (value: unknown) => value is T,
) {
  let value = fallback;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (valid(saved)) value = saved;
  } catch {
    // Unreadable or no storage: the fallback.
  }
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const current = () => value;
  return {
    current,
    use: () => useSyncExternalStore(subscribe, current, current),
    set(next: T) {
      value = next;
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Kept until the page reloads.
      }
      listeners.forEach((listener) => listener());
    },
  };
}
