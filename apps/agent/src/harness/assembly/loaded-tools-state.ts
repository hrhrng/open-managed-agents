import type { SessionEvent } from "@open-managed-agents/shared";
import { mcpServerNameFromToolName } from "./catalog";

export const TOOL_ASSEMBLY_WARNING_SOURCE = "oma.tool_assembly";

export function broadcastLoadedToolNames(
  broadcast: (event: SessionEvent) => void,
  loadedToolNames: string[],
): void {
  if (loadedToolNames.length === 0) return;
  broadcast({
    type: "session.warning",
    source: TOOL_ASSEMBLY_WARNING_SOURCE,
    message: `Tool assembly loaded ${loadedToolNames.length} deferred tool(s)`,
    details: { loadedToolNames },
  });
}

function namesFromToolSearchResultContent(content: string | unknown): string[] {
  if (typeof content !== "string") return [];
  const names: string[] = [];
  for (const line of content.split("\n")) {
    const match = /^##\s+(\S+)/.exec(line.trim());
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

/**
 * Rebuild the set of MCP tools loaded via `tool_search` from the session event log.
 */
export function restoreLoadedToolNames(events: readonly SessionEvent[]): Set<string> {
  const loaded = new Set<string>();
  const pendingSearch = new Map<string, string>();

  for (const event of events) {
    if (event.type === "session.warning" && event.source === TOOL_ASSEMBLY_WARNING_SOURCE) {
      const details = event.details as { loadedToolNames?: unknown } | undefined;
      if (Array.isArray(details?.loadedToolNames)) {
        for (const name of details.loadedToolNames) {
          if (typeof name === "string" && name.length > 0) loaded.add(name);
        }
      }
      continue;
    }

    if (event.type === "agent.tool_use" && event.name === "tool_search" && event.id) {
      pendingSearch.set(event.id, event.id);
      continue;
    }

    if (event.type === "agent.tool_result" && event.tool_use_id) {
      const toolUseId = event.tool_use_id;
      if (!pendingSearch.has(toolUseId)) continue;
      pendingSearch.delete(toolUseId);
      for (const name of namesFromToolSearchResultContent(event.content)) {
        loaded.add(name);
      }
    }
  }

  return loaded;
}

export function groupDeferredNamesByServer(names: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const server = mcpServerNameFromToolName(name) ?? "other";
    const list = groups.get(server) ?? [];
    list.push(name);
    groups.set(server, list);
  }
  return groups;
}
