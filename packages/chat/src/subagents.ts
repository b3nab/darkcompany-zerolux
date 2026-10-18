import { useEffect, useState } from "react";
import { errorMessage, kernelUrl, request } from "./client";

/**
 * A subagent a session started: Claude Code's from its Task calls, Codex's threads born from
 * the session's thread at any depth. Its work reads like a session's, from its own events.
 */
export interface Subagent {
  id: string;
  /** Its name or nickname, when the harness gives one. */
  name: string | null;
  /** What it was asked to do, in a few words. */
  description: string | null;
  /** Its type or role. */
  kind: string | null;
  /** The session's tool call that started it, as in its events. */
  tool_call_id: string | null;
  /** The subagent that started it, for one started by another. */
  parent_id: string | null;
  updated_at: number | null;
}

/** How a subagent goes by: its name, its role, what it was asked, or plainly. */
export const subagentName = (subagent: Subagent) =>
  subagent.name ?? subagent.kind ?? subagent.description ?? "Subagent";

/**
 * A session's subagents, the latest first, read again when `revision` changes (as when its
 * record grows). None for a harness without them.
 */
export function useSessionSubagents(
  sessionId: string,
  revision: unknown,
  kernel = kernelUrl(),
) {
  const [read, setRead] = useState<{
    key: string;
    subagents?: Subagent[];
    error?: string;
  }>();
  const key = `${kernel}\n${sessionId}`;
  useEffect(() => {
    const controller = new AbortController();
    request<{ subagents: Subagent[] }>(
      kernel,
      `/sessions/${encodeURIComponent(sessionId)}/subagents`,
      undefined,
      controller.signal,
    ).then(
      ({ subagents }) => setRead({ key, subagents }),
      (error: unknown) => {
        if (!controller.signal.aborted)
          setRead({ key, error: errorMessage(error) });
      },
    );
    return () => controller.abort();
  }, [kernel, sessionId, key, revision]);
  const current = read?.key === key ? read : undefined;
  return { subagents: current?.subagents, error: current?.error ?? "" };
}
