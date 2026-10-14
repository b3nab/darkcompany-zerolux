/** Only public configuration, never provider credentials or raw harness settings. */
export interface NativeAgentSettings {
  model: string | null;
  effort: string | null;
  permission_mode?: string | null;
  approval_policy?: string | null;
  sandbox?: string | null;
}

export type NativeSettingsPatch = Partial<
  Record<keyof NativeAgentSettings, string>
>;

/** Model and effort choices are supplied by the running harness. */
export interface NativeModelOption {
  value: string;
  label: string;
  resolved_model?: string;
  efforts: string[];
}

export interface NativeSettingsSnapshot {
  values: NativeAgentSettings;
  models: NativeModelOption[];
  editable: (keyof NativeAgentSettings)[];
}

/** Validate the entire change before making any native control request. */
export function settingsPatch(
  input: unknown,
  editable: readonly (keyof NativeAgentSettings)[],
): NativeSettingsPatch {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid settings change");
  const result: NativeSettingsPatch = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!editable.includes(key as keyof NativeAgentSettings))
      throw new Error("This setting cannot be changed in this session");
    if (
      typeof raw !== "string" ||
      !raw.trim() ||
      new TextEncoder().encode(raw.trim()).length > 200 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(raw)
    )
      throw new Error("Choose a value provided by the harness");
    result[key as keyof NativeAgentSettings] = raw.trim();
  }
  return result;
}

/** A successful control reply must describe the requested effective values, not just echo it. */
export function confirmSettings(
  snapshot: NativeSettingsSnapshot,
  patch: NativeSettingsPatch,
) {
  for (const [key, value] of Object.entries(patch)) {
    const field = key as keyof NativeAgentSettings;
    if (field === "model") {
      const option = snapshot.models.find(
        (model) => model.value === value || model.resolved_model === value,
      );
      if (
        snapshot.values.model === value ||
        (option &&
          (snapshot.values.model === option.value ||
            snapshot.values.model === option.resolved_model))
      )
        continue;
    } else if (snapshot.values[field] === value) continue;
    throw new Error(
      `The harness did not confirm the requested ${field}; refresh before making another change`,
    );
  }
}

export function checkModelChoice(
  snapshot: NativeSettingsSnapshot,
  patch: NativeSettingsPatch,
) {
  if (patch.model === undefined && patch.effort === undefined) return;
  const value = patch.model ?? snapshot.values.model;
  const model = snapshot.models.find(
    (option) => option.value === value || option.resolved_model === value,
  );
  if (!model) throw new Error("The harness does not offer this model");
  if (patch.effort !== undefined && !model.efforts.includes(patch.effort))
    throw new Error("The harness does not offer this effort for this model");
}
