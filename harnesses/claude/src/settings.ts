import type {
  Query,
  SDKMessage,
  PermissionMode,
  EffortLevel,
  ModelInfo,
} from "@anthropic-ai/claude-agent-sdk";
import {
  checkModelChoice,
  confirmSettings,
  settingsPatch,
  type NativeAgentSettings,
  type NativeSettingsSnapshot,
} from "@zerolux/bridge";

export const PERMISSION_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
];

/** getSettings is implemented by the pinned SDK but omitted from its public declaration. */
type SettingsQuery = Query & { getSettings?: () => Promise<unknown> };

export function modelOptions(models: ModelInfo[]) {
  return models.map((model) => ({
    value: model.value,
    label: model.displayName,
    ...(model.resolvedModel ? { resolved_model: model.resolvedModel } : {}),
    efforts: model.supportedEffortLevels ?? [],
  }));
}

/** A native model ID can be valid before it appears in the discovery catalog. */
function checkChoice(
  snapshot: NativeSettingsSnapshot,
  patch: ReturnType<typeof settingsPatch>,
) {
  if (patch.effort !== undefined) checkModelChoice(snapshot, patch);
}

export class ClaudeSettings {
  private current: NativeAgentSettings = {
    model: null,
    effort: null,
    permission_mode: null,
  };

  constructor(private readonly query: () => SettingsQuery | undefined) {}

  values() {
    return { ...this.current };
  }

  observe(message: SDKMessage) {
    if (message.type !== "system") return;
    if (message.subtype === "init") {
      this.current.model = message.model;
      this.current.permission_mode = message.permissionMode;
      if (message.effort !== undefined) this.current.effort = message.effort;
    } else if (
      message.subtype === "status" &&
      message.permissionMode !== undefined
    ) {
      this.current.permission_mode = message.permissionMode;
    }
  }

  async read(): Promise<NativeSettingsSnapshot> {
    const query = this.query();
    if (!query || typeof query.getSettings !== "function")
      throw new Error("The native Claude session cannot report its settings");
    this.current.permission_mode ??=
      (
        (await query.initializationResult()) as {
          current_permission_mode?: PermissionMode;
        }
      ).current_permission_mode ?? null;
    const [raw, models] = await Promise.all([
      query.getSettings(),
      query.supportedModels(),
    ]);
    const applied = (
      raw as { applied?: { model?: unknown; effort?: unknown } } | null
    )?.applied;
    if (
      !applied ||
      typeof applied.model !== "string" ||
      !(applied.effort === null || typeof applied.effort === "string")
    )
      throw new Error("Claude did not report its applied settings");
    this.current.model = applied.model;
    this.current.effort = applied.effort;
    return {
      values: this.values(),
      models: modelOptions(models),
      editable: ["model", "effort", "permission_mode"],
    };
  }

  async verifyStart(input: unknown) {
    const snapshot = await this.read();
    const patch = settingsPatch(input, ["model", "effort"]);
    confirmSettings(snapshot, patch);
    return snapshot;
  }

  async apply(input: unknown, check = false) {
    const before = await this.read();
    const patch = settingsPatch(input, before.editable);
    checkChoice(before, patch);
    if (
      patch.permission_mode !== undefined &&
      !PERMISSION_MODES.includes(patch.permission_mode as PermissionMode)
    )
      throw new Error("Unknown Claude permission mode");
    if (check) return before;
    const query = this.query();
    if (!query) throw new Error("The native Claude session ended");
    if (patch.model !== undefined) await query.setModel(patch.model);
    if (patch.effort !== undefined)
      await query.applyFlagSettings({
        effortLevel: patch.effort as EffortLevel,
      });
    if (patch.permission_mode !== undefined) {
      await query.setPermissionMode(patch.permission_mode as PermissionMode);
      this.current.permission_mode = patch.permission_mode;
    }
    const confirmed = await this.read();
    confirmSettings(confirmed, patch);
    return confirmed;
  }
}
