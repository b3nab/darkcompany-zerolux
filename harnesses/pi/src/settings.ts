import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  checkModelChoice,
  confirmSettings,
  settingsPatch,
  type NativeSettingsSnapshot,
} from "@zerolux/bridge";

/** Native session controls: no prompts, reloads, global preferences, or model requests. */
export class PiSettings {
  constructor(
    private readonly pi: Pick<
      ExtensionAPI,
      "setModel" | "getThinkingLevel" | "setThinkingLevel"
    >,
    private readonly context: Pick<ExtensionContext, "model" | "modelRegistry">,
  ) {}

  values() {
    const model = this.context.model;
    return {
      model: model ? `${model.provider}/${model.id}` : null,
      effort: this.pi.getThinkingLevel(),
    };
  }

  read(): NativeSettingsSnapshot {
    return {
      values: this.values(),
      models: this.context.modelRegistry.getAvailable().map((model) => ({
        value: `${model.provider}/${model.id}`,
        label: `${model.name} (${model.provider})`,
        efforts: getSupportedThinkingLevels(model),
      })),
      editable: ["model", "effort"],
    };
  }

  async apply(input: unknown, check = false) {
    const before = this.read();
    const patch = settingsPatch(input, before.editable);
    checkModelChoice(before, patch);
    if (check) return before;
    if (patch.model !== undefined && patch.model !== before.values.model) {
      const model = this.context.modelRegistry
        .getAvailable()
        .find(
          (candidate) =>
            `${candidate.provider}/${candidate.id}` === patch.model,
        );
      if (!model || !(await this.pi.setModel(model)))
        throw new Error("The native session did not accept the model");
    }
    if (patch.effort !== undefined) {
      const model = this.context.model;
      const level =
        model &&
        getSupportedThinkingLevels(model).find(
          (level) => level === patch.effort,
        );
      if (!level)
        throw new Error("The native model changed before effort was applied");
      this.pi.setThinkingLevel(level);
    }
    const confirmed = this.read();
    confirmSettings(confirmed, patch);
    return confirmed;
  }
}
