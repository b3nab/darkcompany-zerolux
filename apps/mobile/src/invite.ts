import { useSyncExternalStore } from "react";

// The invitation this phone joins with, from the link pasted to connect, until it is used.
let invite: string | null = null;
const listeners = new Set<() => void>();

export function setPendingInvite(token: string | null) {
  invite = token;
  listeners.forEach((listener) => listener());
}

export const usePendingInvite = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => invite,
  );
