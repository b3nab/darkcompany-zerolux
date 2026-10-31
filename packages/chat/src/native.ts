import { useCallback, useEffect, useState } from "react";
import type { DiscoveredSession, Discovery } from "./chat";
import { ApiError, errorMessage, kernelUrl, request } from "./client";

/** The latest active first. */
export const byActivity = (sessions: DiscoveredSession[]) =>
  [...sessions].sort(
    (a, b) => (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0),
  );

/**
 * The harnesses' own sessions in the workspace's project folder, running or saved, not in the
 * workspace yet, the latest active first: read while `enabled`, every 15 s, and again when
 * `changed` changes (attaching one takes it out). A kernel without them, or a person who
 * may not use its computer's sessions, has none.
 */
export function useNativeSessions(
  enabled: boolean,
  changed?: unknown,
  kernel = kernelUrl(),
) {
  const [read, setRead] = useState<{
    kernel: string;
    sessions: DiscoveredSession[];
    error: string;
  }>();
  const reload = useCallback(
    () =>
      request<Discovery>(kernel, "/sessions/native").then(
        ({ sessions }) =>
          setRead({ kernel, sessions: byActivity(sessions), error: "" }),
        (error: unknown) => {
          const none =
            error instanceof ApiError &&
            (error.status === 403 || error.status === 404);
          // Out of reach a moment, the sessions last read stay.
          setRead((was) => ({
            kernel,
            sessions: !none && was?.kernel === kernel ? was.sessions : [],
            error: none ? "" : errorMessage(error),
          }));
        },
      ),
    [kernel],
  );
  useEffect(() => {
    if (!enabled) return;
    void reload();
    const timer = setInterval(() => void reload(), 15_000);
    return () => clearInterval(timer);
  }, [enabled, reload, changed]);
  const current = read?.kernel === kernel ? read : undefined;
  return {
    sessions: current?.sessions ?? [],
    error: current?.error ?? "",
    reload,
  };
}
