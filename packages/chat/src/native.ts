import { useEffect, useRef } from "react";
import type { DiscoveredSession, Discovery } from "./chat";
import { ApiError, kernelUrl, request } from "./client";
import { sharedRead, useSharedRead } from "./shared-read";

/** The latest active first. */
export const byActivity = (sessions: DiscoveredSession[]) =>
  [...sessions].sort(
    (a, b) => (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0),
  );

const readNative = (kernel: string) =>
  request<Discovery>(kernel, "/sessions/native").then(
    ({ sessions }) => byActivity(sessions),
    (error: unknown) => {
      // A kernel without them, or a person who may not use its computer's sessions, has none.
      if (
        error instanceof ApiError &&
        (error.status === 403 || error.status === 404)
      )
        return [];
      throw error;
    },
  );

/**
 * The harnesses' own sessions in the workspace's project folder, running or saved, not in the
 * workspace yet, the latest active first: read while `enabled`, every 15 s, and again when
 * `changed` changes (attaching one takes it out). One read at a time for every screen, however
 * slow: a change during it reads once more after it.
 */
export function useNativeSessions(
  enabled: boolean,
  changed?: unknown,
  kernel = kernelUrl(),
) {
  const { read, reload } = useSharedRead(readNative, kernel, enabled);
  useEffect(() => {
    if (!enabled) return;
    const join = () => void sharedRead(readNative, kernel, true);
    join();
    const timer = setInterval(join, 15_000);
    return () => clearInterval(timer);
  }, [enabled, kernel]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    void reload();
    // `changed` alone says when to read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changed]);
  return {
    sessions: read?.items ?? [],
    error: read?.error ?? "",
    reload,
  };
}
