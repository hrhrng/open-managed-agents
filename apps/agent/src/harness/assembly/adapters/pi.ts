import { Type } from "@earendil-works/pi-ai";
import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import type { HarnessContext } from "../../interface";
import { toolsToPi } from "../../pi-loop-tools";
import { createToolCatalogSearch } from "../components/tool-catalog-search";
import { createToolExposureStrategy } from "../strategies/exposure";
import { buildToolCatalog } from "../catalog";
import { resolveToolAssemblyConfig } from "../config";
import { appendDeferredIndex } from "../deferred-prompt";
import {
  broadcastLoadedToolNames,
  restoreLoadedToolNames,
} from "../loaded-tools-state";
import type { AssemblyState, ToolCatalogEntry } from "../types";

const TOOL_SEARCH_NAME = "tool_search";

export interface PiToolAssembly {
  initialTools: AgentTool[];
  systemPrompt: string;
  attach(agent: Agent): void;
  getState(): AssemblyState;
}

function formatSearchResult(entries: ToolCatalogEntry[], tools: AgentTool[]): string {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const lines: string[] = [];
  for (const entry of entries) {
    const tool = byName.get(entry.name);
    lines.push(`## ${entry.name}`);
    lines.push(entry.description);
    if (tool) {
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(tool.parameters, null, 2));
      lines.push("```");
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function createPiToolAssembly(ctx: HarnessContext): PiToolAssembly {
  const config = resolveToolAssemblyConfig(ctx.agent);
  const exposure = createToolExposureStrategy();
  const search = createToolCatalogSearch();
  const allTools = toolsToPi(ctx);
  const catalog = buildToolCatalog(allTools);
  const loaded = restoreLoadedToolNames(ctx.runtime.history.getEvents());
  const baseSystemPrompt = ctx.systemPrompt;
  const model = ctx.pi!.model;

  const toolSearchPiTool: AgentTool = {
    name: TOOL_SEARCH_NAME,
    label: TOOL_SEARCH_NAME,
    description:
      "Search deferred MCP tools by keyword, server name, +required terms, or select:name1,name2. "
      + "Loaded tools become available on the next model turn.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default from agent config)" })),
    }),
    execute: async (_toolCallId, params) => {
      const record = params as { query?: string; limit?: number };
      const query = typeof record.query === "string" ? record.query : "";
      const limit = typeof record.limit === "number"
        ? Math.max(1, Math.min(32, Math.floor(record.limit)))
        : config.searchLimit;
      const result = search.search(catalog, { query, limit });
      const newlyLoaded = result.entries.map((e) => e.name);
      for (const name of newlyLoaded) loaded.add(name);
      if (newlyLoaded.length > 0) {
        broadcastLoadedToolNames(ctx.runtime.broadcast.bind(ctx.runtime), newlyLoaded);
      }
      const text = result.entries.length === 0
        ? "No tools matched. Try different keywords or select:tool_name."
        : `Loaded ${result.entries.length} tool(s) for the next turn:\n\n${formatSearchResult(result.entries, allTools)}`;
      return {
        content: [{ type: "text", text }],
        details: { loadedToolNames: newlyLoaded },
      };
    },
  };

  const toolsWithSearch = [...allTools.filter((t) => t.name !== TOOL_SEARCH_NAME), toolSearchPiTool];

  function planTools() {
    return exposure.plan({
      allTools: toolsWithSearch,
      loadedToolNames: loaded,
      config,
      model,
    });
  }

  const initialPlan = planTools();
  let lastDeferredHintKey = initialPlan.toolSearchEnabled && initialPlan.deferredNames.length > 0
    ? initialPlan.deferredNames.slice().sort().join("\0")
    : "";

  return {
    initialTools: initialPlan.exposed,
    systemPrompt: initialPlan.toolSearchEnabled
      ? appendDeferredIndex(baseSystemPrompt, initialPlan.deferredNames)
      : baseSystemPrompt,
    getState: () => ({
      loadedToolNames: [...loaded],
      loadedSkillIds: [],
    }),
    attach(agent: Agent) {
      agent.prepareRequest = async ({ context }) => {
        const plan = planTools();
        return { context: { ...context, tools: plan.exposed } };
      };

      agent.prepareNextTurnWithContext = async (turnContext) => {
        const plan = planTools();
        const baseContext = {
          ...turnContext.context,
          tools: plan.exposed,
        };
        if (!plan.toolSearchEnabled || plan.deferredNames.length === 0) {
          return { context: baseContext };
        }
        const hintKey = plan.deferredNames.slice().sort().join("\0");
        if (hintKey === lastDeferredHintKey) {
          return { context: baseContext };
        }
        lastDeferredHintKey = hintKey;
        return {
          context: baseContext,
          messages: [{
            role: "user",
            content: `<system-reminder>Deferred tools changed (${plan.deferredNames.length} still unloaded). Use tool_search to load more.</system-reminder>`,
            timestamp: Date.now(),
          }],
        };
      };
    },
  };
}
