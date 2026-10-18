import { useCallback, useEffect, useState } from "react";
import { errorMessage, kernelUrl, request } from "./client";

/**
 * What a session waits for, to hear it as its input after the turn in progress. `ci`: the CI
 * runs of its folder's current commit have all ended; with `failures_only`, only when one
 * failed. The words heard name the commit and each run, then the prompt.
 */
export interface SessionTrigger {
  id: string;
  session_id: string;
  event: "ci";
  failures_only: boolean;
  prompt: string;
  enabled: boolean;
  last_run_at: number | null;
  /** Why the last check did not work, as when `gh` did not answer. */
  last_error: string | null;
  created_at: number;
}

export interface TriggerChange {
  failures_only?: boolean;
  prompt?: string;
  enabled?: boolean;
}

const sessionPath = (sessionId: string) =>
  `/sessions/${encodeURIComponent(sessionId)}/triggers`;
const path = (id: string) => `/triggers/${encodeURIComponent(id)}`;

/**
 * A session's triggers, read again when `revision` changes (as when its record grows, which a
 * trigger heard does), and the changes of who works in it, each answered with the list as it
 * is then. Nothing is read without a session.
 */
export function useSessionTriggers(
  sessionId: string | undefined,
  revision: unknown,
  kernel = kernelUrl(),
) {
  const [read, setRead] = useState<{
    session: string;
    triggers?: SessionTrigger[];
    error?: string;
  }>();
  const session = `${kernel}\n${sessionId}`;
  const reload = useCallback(
    async () =>
      sessionId === undefined
        ? undefined
        : request<{ triggers: SessionTrigger[] }>(
            kernel,
            sessionPath(sessionId),
          ).then(
            ({ triggers }) => setRead({ session, triggers }),
            (error: unknown) =>
              setRead((was) => ({
                ...(was?.session === session ? was : { session }),
                error: errorMessage(error),
              })),
          ),
    [kernel, sessionId, session],
  );
  useEffect(() => void reload(), [reload, revision]);
  const current = read?.session === session ? read : undefined;
  const andReload = <T>(work: Promise<T>) => work.then(() => reload());
  return {
    triggers: current?.triggers,
    error: current?.error ?? "",
    reload,
    /** Waits for the CI of its commit; by default only failures are heard. */
    create: (change: Omit<TriggerChange, "enabled"> = {}) =>
      andReload(
        request(kernel, sessionPath(sessionId!), { event: "ci", ...change }),
      ),
    change: (id: string, change: TriggerChange) =>
      andReload(request(kernel, path(id), change, undefined, "PATCH")),
    remove: (id: string) =>
      andReload(request(kernel, path(id), undefined, undefined, "DELETE")),
  };
}
