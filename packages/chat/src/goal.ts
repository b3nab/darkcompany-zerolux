import { kernelUrl, request } from "./client";

/**
 * A Codex session's goal: the objective it works toward on its own, and what it has spent.
 * Its person, or who works in it, sets it active, paused or complete; Codex sets the rest.
 */
export interface SessionGoal {
  objective: string;
  status: GoalStatus;
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
}
export type GoalStatus =
  | "active"
  | "paused"
  | "complete"
  | "blocked"
  | "usage_limited"
  | "budget_limited";

export const goalStatusLabels: Record<GoalStatus, string> = {
  active: "Working toward it",
  paused: "Paused",
  complete: "Done",
  blocked: "Blocked",
  usage_limited: "Stopped at a usage limit",
  budget_limited: "Stopped at its token budget",
};

/** What the owner changes of a goal: what is left out stays. */
export type GoalChange = {
  objective?: string;
  status?: "active" | "paused" | "complete";
  token_budget?: number | null;
};

const path = (sessionId: string) =>
  `/sessions/${encodeURIComponent(sessionId)}/goal`;

/** Sets the goal, or changes it; only Codex sessions have one. */
export const setSessionGoal = (
  sessionId: string,
  change: GoalChange,
  kernel = kernelUrl(),
) =>
  request<{ goal: SessionGoal }>(
    kernel,
    path(sessionId),
    change,
    undefined,
    "PUT",
  ).then(({ goal }) => goal);

export const clearSessionGoal = (sessionId: string, kernel = kernelUrl()) =>
  request<unknown>(kernel, path(sessionId), undefined, undefined, "DELETE");
