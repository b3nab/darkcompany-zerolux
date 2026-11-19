import { useEffect, useState } from "react";
import { errorMessage, kernelUrl, request } from "./client";
import type { ToolBlock } from "./session-events";
import { toolOutcome, toolView } from "./tool-view";

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
  /** Where Codex places it among its agents, as its calls name it: `/root/logs`. */
  path?: string | null;
  updated_at: number | null;
}

/** How a subagent goes by: its name, its role, what it was asked, or plainly. */
export const subagentName = (subagent: Subagent) =>
  subagent.name ?? subagent.kind ?? subagent.description ?? "Subagent";

/**
 * The subagent a call names as `target`: by its Codex path or ID, else by a path under the
 * caller's (Codex's relative ones) or its name.
 */
export const subagentAt = (subagents: Subagent[], target: string) =>
  subagents.find((s) => s.path === target || s.id === target) ??
  subagents.find((s) => s.path?.endsWith(`/${target}`) || s.name === target);

/**
 * The subagent a call started: by the call itself where the harness records it (Claude Code),
 * else by the name the call gave it (Codex: its path once the call answered, the name it
 * asked for until then).
 */
export function subagentStarted(subagents: Subagent[], tool: ToolBlock) {
  const recorded = subagents.find((s) => s.tool_call_id === tool.id);
  if (recorded) return recorded;
  const view = toolView(tool.name, tool.input);
  if (view.kind !== "agent" || view.action !== "start") return;
  const named = (value: unknown) =>
    value && typeof value === "object" && "task_name" in value
      ? String(value.task_name)
      : "";
  let path = "";
  try {
    path = named(JSON.parse(toolOutcome(tool.result?.output).text));
  } catch {
    // It has not answered, or not with its path.
  }
  const asked = named(tool.input);
  return path
    ? subagents.find((s) => s.path === path)
    : asked
      ? subagentAt(subagents, asked)
      : undefined;
}

/** Whom calls name, by the session's subagents: their names, for `toolPhrase`. */
export const agentNames =
  (subagents: Subagent[]) =>
  (target: string): string | undefined => {
    const found = subagentAt(subagents, target);
    return found && subagentName(found);
  };

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
