// In-memory request credentials only. Persistence belongs to each native client's secure store.
export interface RequestCredential {
  token: string | null;
  native: boolean; // native clients never fall back to a browser cookie
}
const credentials = new Map<string, RequestCredential>();
const listeners = new Map<string, Set<() => void>>();
/** A kernel's origin, from any address on it: every workspace's base finds the same sign-in. */
export function kernelOrigin(address: string) {
  try {
    return new URL(address, globalThis.location?.origin).origin;
  } catch {
    return address.replace(/\/+$/, "");
  }
}

export const requestCredential = (address: string) =>
  credentials.get(kernelOrigin(address));
export function bindCredential(
  kernel: string,
  token: string | null,
  native = token !== null,
) {
  const value = { token, native };
  credentials.set(kernelOrigin(kernel), value);
  return value;
}
export function clearCredential(kernel: string, expected?: RequestCredential) {
  const origin = kernelOrigin(kernel);
  // A late 401 from an older login must not clear a newer login.
  if (expected && credentials.get(origin) !== expected) return;
  credentials.delete(origin);
  for (const listener of listeners.get(origin) ?? []) listener();
}
export function authenticationRequired(kernel: string, listener: () => void) {
  const origin = kernelOrigin(kernel);
  const all = listeners.get(origin) ?? new Set();
  all.add(listener);
  listeners.set(origin, all);
  return () => {
    all.delete(listener);
    if (!all.size) listeners.delete(origin);
  };
}
