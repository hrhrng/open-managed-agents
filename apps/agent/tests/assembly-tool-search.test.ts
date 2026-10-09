import { describe, expect, it } from "vitest";
import { createToolCatalogSearch } from "../src/harness/assembly/components/tool-catalog-search";
import { parseToolSearchQuery } from "../src/harness/assembly/primitives/tool-search-query";
import type { ToolCatalogEntry } from "../src/harness/assembly/types";

const catalog: ToolCatalogEntry[] = [
  { name: "read_file", description: "Read a file from disk", serverName: "builtin" },
  { name: "mcp__github__search", description: "Search GitHub repos", serverName: "github" },
  { name: "mcp__github__create_issue", description: "Open a GitHub issue", serverName: "github" },
  { name: "mcp__docs__lookup", description: "Lookup API documentation", serverName: "docs" },
];

describe("tool_search query parser", () => {
  it("parses select syntax", () => {
    expect(parseToolSearchQuery("select:read_file,mcp__github__search")).toEqual({
      selected: ["read_file", "mcp__github__search"],
      required: [],
      terms: [],
      serverName: undefined,
    });
  });

  it("parses required terms and free text", () => {
    expect(parseToolSearchQuery("github +issue")).toEqual({
      selected: [],
      required: ["issue"],
      terms: ["github"],
      serverName: undefined,
    });
  });
});

describe("tool catalog search", () => {
  const search = createToolCatalogSearch();

  it("returns explicit selections", () => {
    const result = search.search(catalog, { query: "select:mcp__docs__lookup", limit: 8 });
    expect(result.entries.map((e) => e.name)).toEqual(["mcp__docs__lookup"]);
  });

  it("filters by server name for single-token queries", () => {
    const result = search.search(catalog, { query: "github", limit: 8 });
    expect(result.entries.map((e) => e.name)).toEqual([
      "mcp__github__search",
      "mcp__github__create_issue",
    ]);
  });

  it("ranks by BM25 and enforces +required terms", () => {
    const result = search.search(catalog, { query: "documentation +lookup", limit: 4 });
    expect(result.entries[0]?.name).toBe("mcp__docs__lookup");
  });
});
