// In-memory request credentials only. Persistence belongs to each native client's secure store.
export interface RequestCredential {
  workspaceId: string;
  token: string | null;
  native: boolean; // native clients never fall back to a browser cookie
}
const credentials = new Map<string, RequestCredential>();
const listeners = new Map<string, Set<() => void>>();
const key = (kernel: string) => kernel.replace(/\/+$/, "");

export const requestCredential = (kernel: string) =>
  credentials.get(key(kernel));
export function bindCredential(
  kernel: string,
  workspaceId: string,
  token: string | null,
  native = token !== null,
) {
  const value = { workspaceId, token, native };
  credentials.set(key(kernel), value);
  return value;
}
export function clearCredential(kernel: string, expected?: RequestCredential) {
  const origin = key(kernel);
  // A late 401 from an older login must not clear a newer login.
  if (expected && credentials.get(origin) !== expected) return;
  credentials.delete(origin);
  for (const listener of listeners.get(origin) ?? []) listener();
}
export function authenticationRequired(kernel: string, listener: () => void) {
  const origin = key(kernel);
  const all = listeners.get(origin) ?? new Set();
  all.add(listener);
  listeners.set(origin, all);
  return () => {
    all.delete(listener);
    if (!all.size) listeners.delete(origin);
  };
}
