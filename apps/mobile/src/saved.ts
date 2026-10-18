import { useSyncExternalStore } from "react";
import { File, Paths } from "expo-file-system";
import { keepSeenIn } from "@zerolux/chat";

/**
 * What this phone keeps for you between launches, as small JSON files in the app's own
 * documents: which sessions you have seen, how much of their work you want drawn.
 */
const file = (name: string) => new File(Paths.document, `${name}.json`);

export async function readSaved(name: string): Promise<unknown> {
  try {
    const saved = file(name);
    return saved.exists ? JSON.parse(await saved.text()) : undefined;
  } catch {
    return undefined;
  }
}

export function writeSaved(name: string, value: unknown) {
  try {
    const saved = file(name);
    if (!saved.exists) saved.create();
    saved.writeSync(JSON.stringify(value));
  } catch {
    // Not kept: it lasts until the app closes.
  }
}

/**
 * A preference this phone keeps: shared by every view that uses it, saved on each change.
 * It is `fallback` until `restore` reads the saved one at launch.
 */
export function preference<T>(
  name: string,
  fallback: T,
  valid: (value: unknown) => value is T,
) {
  let value = fallback;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const current = () => value;
  const change = (next: T) => {
    value = next;
    listeners.forEach((listener) => listener());
  };
  return {
    current,
    use: () => useSyncExternalStore(subscribe, current, current),
    set(next: T) {
      change(next);
      writeSaved(name, next);
    },
    async restore() {
      const saved = await readSaved(name);
      if (valid(saved)) change(saved);
    },
  };
}

/** The sessions you have seen, as this phone remembers them. */
export async function restoreSeen() {
  const saved = await readSaved("seen");
  keepSeenIn(
    saved && typeof saved === "object"
      ? (saved as Record<string, unknown>)
      : {},
    (all) => writeSaved("seen", all),
  );
}
