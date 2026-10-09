import { Type } from "@earendil-works/pi-ai";
import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import type { HarnessContext } from "../../interface";
import { toolsToPi } from "../../pi-loop-tools";
import { createToolCatalogSearch } from "../components/tool-catalog-search";
import { createToolExposureStrategy } from "../strategies/exposure";
import { buildToolCatalog } from "../catalog";
import { resolveToolAssemblyConfig } from "../config";
import {
  broadcastLoadedToolNames,
  restoreLoadedToolNames,
} from "../loaded-tools-state";
import { createDeferredHintCoordinator } from "../strategies/deferred-hints";
import type { DeferredHintBootstrapMessage } from "../strategies/deferred-hints";
import type { AssemblyState, ToolCatalogEntry } from "../types";

const TOOL_SEARCH_NAME = "tool_search";

export interface PiToolAssembly {
  initialTools: AgentTool[];
  systemPrompt: string;
  /** User messages to prepend before the first model turn (strategy-specific). */
  bootstrapTurnMessages: DeferredHintBootstrapMessage[];
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
  const deferredHints = createDeferredHintCoordinator(config.deferredHintStrategy);
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
  let lastDeferredHintKey = deferredHints.initialDeferredHintKey(initialPlan);
  const bootstrapTurnMessages = deferredHints.bootstrapTurnMessages(initialPlan);

  return {
    initialTools: initialPlan.exposed,
    systemPrompt: deferredHints.augmentSystemPrompt(baseSystemPrompt, initialPlan),
    bootstrapTurnMessages,
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
        const turnHints = deferredHints.prepareNextTurn(plan, lastDeferredHintKey);
        lastDeferredHintKey = turnHints.nextDeferredHintKey;
        if (!turnHints.messages || turnHints.messages.length === 0) {
          return { context: baseContext };
        }
        return {
          context: baseContext,
          messages: turnHints.messages,
        };
      };
    },
  };
}
