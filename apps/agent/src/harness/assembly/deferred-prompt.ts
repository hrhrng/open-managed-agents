import { groupDeferredNamesByServer } from "./loaded-tools-state";

const DEFERRED_TOOL_LIST_CAP = 48;

export function formatDeferredToolsBlock(deferredNames: string[]): string {
  if (deferredNames.length === 0) return "";
  const capped = deferredNames.slice(0, DEFERRED_TOOL_LIST_CAP);
  const omitted = deferredNames.length - capped.length;
  const groups = groupDeferredNamesByServer(capped);
  const lines: string[] = [
    "",
    "<deferred-tools>",
    "The following tools are not loaded yet. Call tool_search to load them for the next turn.",
  ];
  for (const [server, tools] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${server}`);
    for (const tool of tools.sort()) lines.push(`- ${tool}`);
  }
  if (omitted > 0) {
    lines.push(`… and ${omitted} more (use tool_search to find them).`);
  }
  lines.push("</deferred-tools>");
  return lines.join("\n");
}

export function appendDeferredIndex(systemPrompt: string, deferredNames: string[]): string {
  const block = formatDeferredToolsBlock(deferredNames);
  if (!block) return systemPrompt;
  return `${systemPrompt}${block}`;
}
