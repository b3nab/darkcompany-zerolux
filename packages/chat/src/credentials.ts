// In-memory request credentials only. Persistence belongs to each native client's secure store.
export interface RequestCredential {
  token: string | null;
  native: boolean; // native clients never fall back to a browser cookie
}
const credentials = new Map<string, RequestCredential>();
const listeners = new Map<string, Set<() => void>>();
const changes = new Map<string, Set<() => void>>();
/** A native listener uses precisely the sign-in currently bound to this origin. */
export function credentialChanged(kernel: string, hear: () => void) {
  const origin = kernelOrigin(kernel),
    list = changes.get(origin) ?? new Set();
  list.add(hear);
  changes.set(origin, list);
  return () => {
    list.delete(hear);
    if (!list.size) changes.delete(origin);
  };
}
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
  const origin = kernelOrigin(kernel),
    previous = credentials.get(origin)?.token ?? null;
  credentials.set(origin, value);
  if (previous !== token) changes.get(origin)?.forEach((hear) => hear());
  return value;
}
export function clearCredential(kernel: string, expected?: RequestCredential) {
  const origin = kernelOrigin(kernel);
  // A late 401 from an older login must not clear a newer login.
  if (expected && credentials.get(origin) !== expected) return;
  const previous = credentials.get(origin)?.token;
  credentials.delete(origin);
  if (previous) changes.get(origin)?.forEach((hear) => hear());
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
