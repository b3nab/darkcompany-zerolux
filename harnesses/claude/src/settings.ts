import type {
  Query,
  SDKMessage,
  PermissionMode,
  EffortLevel,
  ModelInfo,
} from "@anthropic-ai/claude-agent-sdk";
import {
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
  "dontAsk",
  "bypassPermissions",
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

export class ClaudeSettings {
  private modeRevision = 0;
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
      this.modeRevision++;
      this.current.permission_mode = message.permissionMode;
      if (message.effort !== undefined) this.current.effort = message.effort;
    } else if (
      message.subtype === "status" &&
      message.permissionMode !== undefined
    ) {
      this.modeRevision++;
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
    let snapshot = await this.read();
    const patch = settingsPatch(input, ["model", "effort", "permission_mode"]);
    // Some CLI versions first emit the mode with the first user turn. Confirm an
    // explicit mode via the native control instead; never send a turn to discover it.
    if (patch.permission_mode && snapshot.values.permission_mode == null)
      snapshot = await this.apply({ permission_mode: patch.permission_mode });
    confirmSettings(snapshot, patch);
    return snapshot;
  }

  async apply(input: unknown, check = false) {
    const before = await this.read();
    const patch = settingsPatch(input, before.editable);
    // The kernel validates choices against the installed harness's fresh catalog.
    // This query's startup catalog cannot reject a newer model or its effort levels.
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
      const revision = this.modeRevision;
      await query.setPermissionMode(patch.permission_mode as PermissionMode);
      // A status delivered during the setter is the effective native mode, even
      // when it differs from the requested one. Otherwise the native ACK confirms it.
      if (revision === this.modeRevision)
        this.current.permission_mode = patch.permission_mode;
    }
    const confirmed = await this.read();
    confirmSettings(confirmed, patch);
    return confirmed;
  }
}
