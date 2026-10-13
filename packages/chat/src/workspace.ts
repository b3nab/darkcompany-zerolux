import {
  claudeModes,
  codexApprovalPolicies,
  codexSandboxes,
  kernelUrl,
  request,
} from "./client";
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

/** Missing fields stay unchanged; an empty string clears an agent's saved choice. */
export interface AgentSettings {
  model?: string;
  effort?: string;
  permission_mode?: string;
  approval_policy?: string;
  sandbox?: string;
}

export interface AgentSettingField {
  key: keyof AgentSettings;
  label: string;
  options?: Record<string, string>;
}

/** Both clients show only settings belonging to this agent's harness. */
export function agentSettingFields(
  harness: Actor["harness"],
): AgentSettingField[] {
  return [
    { key: "model", label: "Model" },
    { key: "effort", label: "Effort" },
    ...(harness === "claude-code"
      ? [
          {
            key: "permission_mode" as const,
            label: "Permissions",
            options: claudeModes,
          },
        ]
      : harness === "codex"
        ? [
            {
              key: "approval_policy" as const,
              label: "Approvals",
              options: codexApprovalPolicies,
            },
            {
              key: "sandbox" as const,
              label: "Sandbox",
              options: codexSandboxes,
            },
          ]
        : []),
  ];
}

export async function setAgentSettings(
  id: string,
  settings: AgentSettings,
  kernel = kernelUrl(),
): Promise<Actor> {
  const { actor } = await request<{ actor: Actor }>(
    kernel,
    `/actors/${encodeURIComponent(id)}/settings`,
    Object.fromEntries(
      Object.entries(settings)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, value.trim()]),
    ),
  );
  return actor;
}

/** Optional launch overrides: blank inputs leave the saved/native choice alone. */
export function agentLaunchSettings(model: string, effort: string) {
  return {
    ...(model.trim() ? { model: model.trim() } : {}),
    ...(effort.trim() ? { effort: effort.trim() } : {}),
  };
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
