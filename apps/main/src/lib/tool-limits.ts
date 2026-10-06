import type { Services } from "@open-managed-agents/services";

export const PROVIDER_TOOL_LIMITS: Record<string, number | null> = {
  // Generic / GPT-family mappings
  "gpt-4": 128,
  "gpt-4-turbo": 128,
  "gpt-4o": 128,
  "gpt-4o-mini": 128,
  "gpt-5": 128,
  "o1": 128,
  "o1-mini": 128,
  "o3": 128,
  "openai": 128,
  // Anthropic / Claude
  "claude": null,
  "anthropic": null,
};

export function getProviderToolLimit(modelId: string | null | undefined): number | null {
  if (!modelId) return null;
  const lower = modelId.toLowerCase();
  
  if (lower.includes("claude") || lower.includes("anthropic")) {
    return null;
  }
  
  if (lower.includes("gpt") || lower.includes("o1") || lower.includes("o3") || lower.includes("openai")) {
    return 128; // gpt-5 family
  }
  
  return null;
}

export async function getMcpServerToolCountCached(
  services: Services,
  tenantId: string,
  serverId: string
): Promise<number> {
  // Mocked for DB integration later
  // We can fetch from stats or a stored field.
  return 0;
}

export type ToolLimitsValidationResult = 
  | { ok: true }
  | { 
      ok: false; 
      error: {
        error: string;
        message: string;
        total_tools: number;
        limit: number;
        breakdown: {
          builtins: number;
          skills: number;
          mcp_servers: number;
        };
      }
    };

export async function validateTotalToolLimits(
  services: Services,
  tenantId: string,
  body: any
): Promise<ToolLimitsValidationResult> {
  // Resolve the model name. Can be string or { id: string } depending on structure.
  let modelId = null;
  if (body?.model) {
    if (typeof body.model === "string") {
      modelId = body.model;
    } else if (typeof body.model === "object") {
      modelId = body.model.id;
    }
  }

  const limit = getProviderToolLimit(modelId);
  if (limit === null) return { ok: true };

  let builtinsCount = 0;
  if (Array.isArray(body.tools)) {
    builtinsCount = body.tools.length;
  }

  let skillsCount = 0;
  if (Array.isArray(body.skills)) {
    skillsCount = body.skills.length;
  }

  let mcpServersCount = 0;
  if (Array.isArray(body.mcp_servers)) {
    for (const server of body.mcp_servers) {
      const id = typeof server === "string" ? server : server?.id;
      if (typeof id === "string") {
        mcpServersCount += await getMcpServerToolCountCached(services, tenantId, id);
      }
    }
  }

  const total = builtinsCount + skillsCount + mcpServersCount;

  if (total > limit) {
    return {
      ok: false,
      error: {
        error: "TooManyTools",
        message: `Total tool count (${total}) exceeds model provider limit of ${limit}.`,
        total_tools: total,
        limit,
        breakdown: {
          builtins: builtinsCount,
          skills: skillsCount,
          mcp_servers: mcpServersCount,
        },
      },
    };
  }

  return { ok: true };
}
