/** Fallback when the model id is absent from the static catalog (pi-ai default). */
const UNKNOWN_MODEL_CONTEXT_WINDOW = 256_000;

/** Mirrors pi-ai catalog aliases used at harness request time. */
const MODEL_ID_ALIASES: Record<string, string> = {
  "deepseek-v4-flash": "deepseek-flash",
};

/**
 * Static context-window hints for agent save-time capacity warnings.
 * Kept in-application (no pi-ai import) so the application boundary stays closed.
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-5": 200_000,
  "claude-sonnet-5": 200_000,
  "claude-haiku-5": 200_000,
  "gpt-5": 256_000,
  "deepseek-flash": 128_000,
};

export function resolveAgentModelContextWindow(modelId: string): number {
  const catalogId = MODEL_ID_ALIASES[modelId] ?? modelId;
  return MODEL_CONTEXT_WINDOWS[catalogId]
    ?? MODEL_CONTEXT_WINDOWS[modelId]
    ?? UNKNOWN_MODEL_CONTEXT_WINDOW;
}
