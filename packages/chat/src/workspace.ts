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

/**
 * Native choices: an agent's defaults for its new sessions, or a session's own. Missing fields
 * stay unchanged.
 */
export interface AgentSettings {
  model?: string;
  effort?: string;
  permission_mode?: string;
  approval_policy?: string;
  sandbox?: string;
  /** Codex's way of working: `plan` plans before changing anything, `default` works. */
  collaboration_mode?: string;
}

export interface AgentModelOption {
  value: string;
  label: string;
  resolved_model?: string;
  efforts: string[];
}

export interface AgentSettingsView {
  actor: Actor;
  models: AgentModelOption[];
  editable: (keyof AgentSettings)[];
}

/** A session's own settings, as its harness reports them, with the choices it offers now. */
export interface SessionSettingsView {
  values: Partial<Record<keyof AgentSettings, string | null>>;
  models: AgentModelOption[];
  editable: (keyof AgentSettings)[];
}

export function agentModelOption(
  models: AgentModelOption[],
  value: string | null | undefined,
) {
  return models.find(
    (model) => model.value === value || model.resolved_model === value,
  );
}

/** What the selectors set: plan mode is a switch of its own, for a session only. */
export interface AgentSettingField {
  key: Exclude<keyof AgentSettings, "collaboration_mode">;
  label: string;
  options: Record<string, string>;
}

/** Both clients show only settings belonging to this agent's harness. */
export function agentSettingFields(
  harness: Actor["harness"],
  models: AgentModelOption[] = [],
  model?: string | null,
): AgentSettingField[] {
  return [
    {
      key: "model",
      label: "Model",
      options: Object.fromEntries(
        models.map((model) => [model.value, model.label]),
      ),
    },
    {
      key: "effort",
      label: "Effort",
      options: Object.fromEntries(
        (agentModelOption(models, model)?.efforts ?? []).map((effort) => [
          effort,
          effort,
        ]),
      ),
    },
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

/**
 * A session's plan mode, where its harness has one and lets it change now: whether it is on,
 * and the change that turns it on or off. Codex has a collaboration mode of its own; Claude
 * Code plans as a permission mode, and leaves it for `default`, as Shift+Tab does. pi has none.
 */
export function planMode(
  harness: Actor["harness"],
  values: SessionSettingsView["values"],
  editable: (keyof AgentSettings)[],
) {
  const key =
    harness === "codex"
      ? "collaboration_mode"
      : harness === "claude-code"
        ? "permission_mode"
        : undefined;
  if (!key || !editable.includes(key)) return undefined;
  return {
    on: values[key] === "plan",
    change: (plan: boolean): AgentSettings => ({
      [key]: plan ? "plan" : "default",
    }),
  };
}

/** A retained draft cannot be applied after its choices or live capabilities disappear. */
export function canApplyAgentSettings(
  changes: AgentSettings,
  fields: AgentSettingField[],
  editable: (keyof AgentSettings)[],
) {
  const entries = Object.entries(changes);
  return (
    entries.length > 0 &&
    entries.every(([key, value]) =>
      fields.some(
        (field) =>
          field.key === key &&
          editable.includes(field.key) &&
          typeof value === "string" &&
          Object.hasOwn(field.options, value),
      ),
    )
  );
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
