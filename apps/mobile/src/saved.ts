import { useSyncExternalStore } from "react";
import { File, Paths } from "expo-file-system";
import { keepDraftsIn } from "@zerolux/chat";

/**
 * What this phone keeps for you between launches, as small JSON files in the app's own
 * documents: what you were writing, which sessions you have seen, how much of their work you
 * want drawn.
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

/**
 * What you were writing in each chat and session, kept as you type: an update or a restart
 * of the app finds it where you left it. Read at once, before any screen shows a box.
 */
export function restoreDrafts() {
  let saved: unknown;
  try {
    const drafts = file("drafts");
    saved = drafts.exists ? JSON.parse(drafts.textSync()) : undefined;
  } catch {
    saved = undefined;
  }
  keepDraftsIn(
    saved && typeof saved === "object"
      ? (saved as Record<string, unknown>)
      : {},
    (all) => writeSaved("drafts", all),
  );
}
