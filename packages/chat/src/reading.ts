/**
 * Whether the person is looking at the app: only then is what arrives read. Each client says
 * how it knows, a browser by its tab's visibility, a phone by the app being active.
 */
let looking = () => true;
const listeners = new Set<() => void>();

/** How this client knows, and how it hears that it changed. */
export function lookWith(
  isLooking: () => boolean,
  subscribe: (changed: () => void) => void,
) {
  looking = isLooking;
  subscribe(() => listeners.forEach((listener) => listener()));
}

export const isLooking = () => looking();

/** Hears each change; returns how to stop. */
export function whenLooking(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * Read positions on their way to the kernel, by where each goes: one request at a time for
 * each, the furthest wanted sent last, and none behind what the kernel already has.
 */
export function readPositions(
  send: (path: string, position: number) => Promise<unknown>,
) {
  const furthest = new Map<string, number>();
  const wanted = new Map<string, number>();
  const sending = new Set<string>();
  async function drain(path: string) {
    sending.add(path);
    for (let at = wanted.get(path); at !== undefined; at = wanted.get(path)) {
      wanted.delete(path);
      // One that fails is sent again with the next move, unless a further one follows.
      await send(path, at).catch(() => {
        if (furthest.get(path) === at) furthest.delete(path);
      });
    }
    sending.delete(path);
  }
  return {
    /** Moves it forward, and sends it; false when it is no further than known. */
    move(path: string, position: number) {
      if (position <= (furthest.get(path) ?? 0)) return false;
      furthest.set(path, position);
      wanted.set(path, position);
      if (!sending.has(path)) void drain(path);
      return true;
    },
    /** Where the kernel says it is. */
    heard(path: string, position: number) {
      if (position > (furthest.get(path) ?? 0)) furthest.set(path, position);
    },
  };
}
