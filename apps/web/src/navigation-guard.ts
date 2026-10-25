import { useLayoutEffect, useRef } from "react";
import { voiceInputProcessing } from "@zerolux/chat";

type Guard = () => string | undefined;
const guards = new Set<Guard>();

/** A reason this view cannot be replaced; text drafts already have their own storage. */
export function navigationBlock() {
  if (voiceInputProcessing()) return "Voice input is still processing.";
  for (const guard of guards) {
    const reason = guard();
    if (reason) return reason;
  }
}

export function guardNavigation(guard: Guard) {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

export function useNavigationGuard(guard: Guard) {
  const latest = useRef(guard);
  latest.current = guard;
  useLayoutEffect(() => guardNavigation(() => latest.current()), []);
}
