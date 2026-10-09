export interface ParsedToolSearchQuery {
  /** `select:a,b` explicit tool names (case-sensitive match). */
  selected: string[];
  /** Tokens that must all appear in the searchable text. */
  required: string[];
  /** Free-text terms (BM25). */
  terms: string[];
  /** When the whole query is one token, treat as MCP server name filter. */
  serverName?: string;
}

const SELECT_PREFIX = /^select:\s*/i;

export function parseToolSearchQuery(raw: string): ParsedToolSearchQuery {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { selected: [], required: [], terms: [] };
  }

  if (SELECT_PREFIX.test(trimmed)) {
    const names = trimmed.replace(SELECT_PREFIX, "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    return { selected: names, required: [], terms: [] };
  }

  const parts = trimmed.split(/\s+/).filter(Boolean);
  const required: string[] = [];
  const terms: string[] = [];
  for (const part of parts) {
    if (part.startsWith("+") && part.length > 1) required.push(part.slice(1).toLowerCase());
    else terms.push(part.toLowerCase());
  }

  const serverName = parts.length === 1 && !parts[0].startsWith("+") ? parts[0] : undefined;
  return { selected: [], required, terms, serverName };
}

export function matchesRequiredTerms(haystack: string, required: string[]): boolean {
  if (required.length === 0) return true;
  const lower = haystack.toLowerCase();
  return required.every((term) => lower.includes(term));
}
