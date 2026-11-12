import {
  createAgentSessionServices,
  getAgentDir,
  ProjectTrustStore,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { NativeModelOption } from "@zerolux/bridge";

/** pi's model/auth services, without an AgentSession, history or model request. */
export async function modelCatalog(cwd: string): Promise<NativeModelOption[]> {
  const agentDir = getAgentDir();
  const settings = SettingsManager.create(cwd, agentDir, {
    projectTrusted: false,
  });
  const decision = new ProjectTrustStore(agentDir).get(cwd);
  const trusted = decision ?? settings.getDefaultProjectTrust() === "always";
  settings.setProjectTrusted(trusted);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager: settings,
    modelRuntimeSignal: AbortSignal.timeout(20_000),
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    },
    resourceLoaderReloadOptions: { resolveProjectTrust: async () => trusted },
  });
  try {
    if (services.diagnostics.some((diagnostic) => diagnostic.type === "error"))
      throw new Error("pi could not load its configured model providers");
    const models = await services.modelRuntime.getAvailable(undefined, {
      signal: AbortSignal.timeout(20_000),
    });
    return models.map((model) => ({
      value: `${model.provider}/${model.id}`,
      label: `${model.name} (${model.provider})`,
      efforts: getSupportedThinkingLevels(model),
    }));
  } finally {
    services.resourceLoader.getExtensions().runtime.invalidate();
  }
}

/** Loaded by the installed pi, which supplies its own SDK and provider registry. */
export default async function catalog() {
  const models = await modelCatalog(process.cwd());
  console.log(`ZEROLUX_MODEL_CATALOG=${JSON.stringify(models)}`);
}
