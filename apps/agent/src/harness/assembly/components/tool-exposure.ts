import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import type { ToolAssemblyConfig } from "../config";
import { estimateToolDefinitionsChars, isMcpToolName } from "../catalog";

export interface ToolExposurePlan {
  /** Whether deferred MCP tools are hidden behind `tool_search`. */
  toolSearchEnabled: boolean;
  /** Tools passed to the model for this request. */
  exposed: AgentTool[];
  /** MCP tools not yet loaded (names only when search is on). */
  deferredNames: string[];
}

export interface ToolExposureComponent {
  plan(input: {
    allTools: AgentTool[];
    loadedToolNames: ReadonlySet<string>;
    config: ToolAssemblyConfig;
    model: Model<Api>;
  }): ToolExposurePlan;
}

function isResidentTool(name: string, alwaysLoad: ReadonlySet<string>): boolean {
  if (name === "tool_search") return false;
  if (!isMcpToolName(name)) return true;
  return alwaysLoad.has(name);
}

export function createToolExposureComponent(): ToolExposureComponent {
  return {
    plan({ allTools, loadedToolNames, config, model }) {
      const byName = new Map(allTools.map((tool) => [tool.name, tool]));
      const mcpTools = allTools.filter((tool) => isMcpToolName(tool.name));
      const deferredCandidates = mcpTools.filter(
        (tool) => !isResidentTool(tool.name, config.alwaysLoad),
      );

      let toolSearchEnabled = false;
      if (config.mode === "on") {
        toolSearchEnabled = deferredCandidates.length > 0;
      } else if (config.mode === "auto" && deferredCandidates.length > 0) {
        const budget = model.contextWindow * config.autoThresholdFraction;
        toolSearchEnabled = estimateToolDefinitionsChars(deferredCandidates) > budget;
      }

      if (!toolSearchEnabled) {
        return {
          toolSearchEnabled: false,
          exposed: allTools.filter((t) => t.name !== "tool_search"),
          deferredNames: [],
        };
      }

      const exposed: AgentTool[] = [];
      for (const tool of allTools) {
        if (tool.name === "tool_search") continue;
        if (isResidentTool(tool.name, config.alwaysLoad)) {
          exposed.push(tool);
          continue;
        }
        if (loadedToolNames.has(tool.name)) {
          exposed.push(tool);
        }
      }

      const deferredNames = deferredCandidates
        .map((tool) => tool.name)
        .filter((name) => !loadedToolNames.has(name));

      const searchTool = byName.get("tool_search");
      if (searchTool) exposed.push(searchTool);

      return { toolSearchEnabled: true, exposed, deferredNames };
    },
  };
}
