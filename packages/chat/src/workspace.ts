import { kernelUrl, request } from "./client";
import type { Actor } from "./client";
import type { CreationDate } from "./dates";

export function ownerNameError(value: string): string | undefined {
  const name = value.trim();
  if (!name) return "Enter your name to continue.";
  if (name.toLowerCase() === "local owner") return "Use your own name.";
  if (new TextEncoder().encode(name).length > 200)
    return "Your name must be at most 200 UTF-8 bytes.";
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(name))
    return "Your name cannot contain control characters.";
}

export interface WorkspaceInfo extends CreationDate {
  id: string;
  name: string;
}

export async function renameWorkspace(
  name: string,
  kernel = kernelUrl(),
): Promise<WorkspaceInfo> {
  const result = await request<{ workspace: WorkspaceInfo }>(
    kernel,
    "/workspace",
    {
      name: name.trim(),
    },
  );
  return result.workspace;
}

/** The company as the kernel shares it with every client. */
export interface Workspace {
  workspace: WorkspaceInfo;
  actors: Actor[];
  onboarding_required: boolean;
}
export function activeActors(actors: Actor[]): Actor[] {
  return actors.filter((actor) => !actor.archived);
}
export function actorLabel(actor?: Actor): string {
  if (!actor) return "Unknown agent";
  return actor.archived ? "Retired agent" : actor.name;
}
