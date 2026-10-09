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

const CLAUDE_CODE_DEFERRED_CAP = 512;

/** Claude Code–style user-turn reminder listing deferred tool names. */
export function formatClaudeCodeDeferredReminder(deferredNames: string[]): string {
  if (deferredNames.length === 0) return "";
  const capped = deferredNames.slice(0, CLAUDE_CODE_DEFERRED_CAP);
  const omitted = deferredNames.length - capped.length;
  const lines = [
    "<system-reminder>",
    "The following deferred tools are now available via tool_search. Their schemas are NOT loaded — "
      + "calling them directly will fail. Use tool_search with query \"select:<name>[,<name>...]\" "
      + "to load tool schemas before calling them:",
    ...capped,
  ];
  if (omitted > 0) {
    lines.push(`… and ${omitted} more (use tool_search to find them).`);
  }
  lines.push("</system-reminder>");
  return lines.join("\n");
}

export function formatIncrementalDeferredChangeReminder(remainingCount: number): string {
  return `<system-reminder>Deferred tools changed (${remainingCount} still unloaded). Use tool_search to load more.</system-reminder>`;
}
