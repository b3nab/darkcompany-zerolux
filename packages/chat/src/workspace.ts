import type { Actor } from "./client";

/** The company as the kernel shares it with every client: actors, projects, tasks, workers. */
export interface Workspace {
  actors: Actor[];
  projects: Project[];
  tasks: Task[];
  connections: AgentConnection[];
  onboarding_required: boolean;
  // TODO: kernel: the workspace's name and creation time (the company's day 1).
  name?: string;
  created_at?: number;
}
export const taskStatuses = [
  "draft",
  "queued",
  "running",
  "review",
  "done",
  "failed",
] as const;
export type TaskStatus = (typeof taskStatuses)[number];
export type TaskAction = "queue" | "approve" | "request_changes";
export interface Project {
  id: string;
  name: string;
  description: string;
  created_at: number;
}
export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  assignee_id: string;
  status: TaskStatus;
  review_note: string;
  created_at: number;
  updated_at: number;
}
export interface Run {
  id: string;
  task_id: string;
  status: "running" | "succeeded" | "failed";
  stdout: string;
  stderr: string;
  exit_code: number | null;
  failure_reason: string | null;
  started_at: number;
  finished_at: number | null;
  lease_expires_at: number;
  connection_id: string | null;
  actor_id: string | null;
}
export interface AgentConnection {
  id: string;
  actor_id: string;
  project_id: string;
  mode: "process" | "pi_session";
  workspace: string;
  session_id: string | null;
  connected_at: number;
  lease_expires_at: number;
  disconnected_at: number | null;
}

export const taskLabels: Record<TaskStatus, string> = {
  draft: "Draft",
  queued: "Queued",
  running: "Running",
  review: "Human review",
  done: "Done",
  failed: "Failed",
};
/** What the owner can do with a task in this status. */
export function taskActions(status: TaskStatus): TaskAction[] {
  if (status === "draft" || status === "failed") return ["queue"];
  if (status === "review") return ["approve", "request_changes"];
  return [];
}
export function liveConnection(
  connections: AgentConnection[],
  actorId: string,
  now = Date.now(),
): AgentConnection | undefined {
  return connections.find(
    (c) =>
      c.actor_id === actorId &&
      c.disconnected_at === null &&
      c.lease_expires_at > now,
  );
}
export function activeActors(actors: Actor[]): Actor[] {
  return actors.filter((actor) => !actor.archived);
}
export function actorLabel(actor?: Actor): string {
  if (!actor) return "Unknown agent";
  return actor.archived ? "Retired agent" : actor.name;
}
