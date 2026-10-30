import { useSyncExternalStore } from "react";

/** An invitation to a workspace, by its base and its token. */
export interface PendingInvite {
  base: string;
  token: string;
}

// The invitation this phone joins with, from the link pasted to connect, until it is used.
let invite: PendingInvite | null = null;
const listeners = new Set<() => void>();

export function setPendingInvite(next: PendingInvite | null) {
  invite = next;
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
