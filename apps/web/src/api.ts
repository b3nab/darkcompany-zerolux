import type { Actor } from "@zerolux/chat";

export {
  ApiError,
  api,
  errorMessage,
  harnessLabels,
  activeActors,
  actorLabel,
  liveConnection,
  taskActions as actionsFor,
  taskLabels as labels,
  taskStatuses as statuses,
} from "@zerolux/chat";
export type {
  Actor,
  AgentConnection,
  Harness,
  Project,
  Run,
  Task,
  TaskAction as Action,
  TaskStatus as Status,
  Workspace,
} from "@zerolux/chat";
export function workerCommand(projectId: string, actor: Actor): string {
  const command = actor.harness
    ? `--harness ${actor.harness}`
    : "-- <harness> <args>";
  return `cargo run -- worker --project ${projectId} --actor ${actor.id} --workspace /absolute/path/to/worktree ${command}`;
}
