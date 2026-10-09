import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

const PI_UNKNOWN_MODEL_CONTEXT_WINDOW = 256_000;

const PI_CATALOG_MODEL_ID_ALIASES: Record<string, string> = {
  "deepseek-v4-flash": "deepseek-flash",
};

export function resolveAgentModelContextWindow(modelId: string): number {
  const catalogId = PI_CATALOG_MODEL_ID_ALIASES[modelId] ?? modelId;
  for (const provider of builtinProviders()) {
    const match = provider.getModels().find(
      (model) => model.id === catalogId || model.id === modelId,
    );
    if (match !== undefined) return match.contextWindow;
  }
  return PI_UNKNOWN_MODEL_CONTEXT_WINDOW;
}
