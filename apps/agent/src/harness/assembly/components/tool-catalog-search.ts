import type { Tool } from "@earendil-works/pi-ai";
import { createBm25Index } from "../primitives/bm25";
import {
  matchesRequiredTerms,
  parseToolSearchQuery,
} from "../primitives/tool-search-query";
import type { ToolCatalogEntry, ToolSearchComponent, ToolSearchOptions } from "../types";

function catalogText(entry: ToolCatalogEntry): string {
  return [
    entry.name,
    entry.description,
    entry.serverName ?? "",
    entry.parametersText ?? "",
  ].join("\n");
}

export function createToolCatalogSearch(): ToolSearchComponent {
  return {
    search(catalog, { query, limit }) {
      const parsed = parseToolSearchQuery(query);
      const byName = new Map(catalog.map((entry) => [entry.name, entry]));

      if (parsed.selected.length > 0) {
        const entries = parsed.selected
          .map((name) => byName.get(name))
          .filter((entry): entry is ToolCatalogEntry => entry !== undefined);
        return { entries: entries.slice(0, limit), tools: [] };
      }

      let pool = catalog;
      if (parsed.serverName) {
        pool = pool.filter(
          (entry) => entry.serverName?.toLowerCase() === parsed.serverName!.toLowerCase(),
        );
      }

      pool = pool.filter((entry) => matchesRequiredTerms(catalogText(entry), parsed.required));

      const index = createBm25Index(
        pool.map((entry) => ({ id: entry.name, text: catalogText(entry) })),
      );
      const queryText = parsed.terms.join(" ");
      const ranked = queryText.trim()
        ? index.search(queryText, limit)
        : pool.slice(0, limit).map((entry) => entry.name);

      const entries = ranked
        .map((name) => byName.get(name))
        .filter((entry): entry is ToolCatalogEntry => entry !== undefined);

      return { entries, tools: [] as Tool[] };
    },
  };
}
