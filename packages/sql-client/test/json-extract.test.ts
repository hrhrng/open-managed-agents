import { describe, expect, it } from "vitest";
import { rewriteJsonExtract } from "../src/json-extract";

const listSql = `SELECT id FROM managed_sessions
 WHERE workspace_id = ? AND json_extract(document, ?) = ?
 ORDER BY created_at DESC`;

describe("rewriteJsonExtract", () => {
  it("leaves SQLite-shaped SQL unchanged when there is no json_extract call", () => {
    const sql = "SELECT id FROM managed_sessions WHERE workspace_id = ? AND status = ?";
    expect(rewriteJsonExtract(sql, "mysql")).toBe(sql);
    expect(rewriteJsonExtract(sql, "postgres")).toBe(sql);
  });

  it("rewrites one json_extract call without adding placeholders", () => {
    expect(rewriteJsonExtract(listSql, "mysql")).toBe(
      `SELECT id FROM managed_sessions
 WHERE workspace_id = ? AND JSON_UNQUOTE(JSON_EXTRACT(document, ?)) = ?
 ORDER BY created_at DESC`,
    );
    expect(rewriteJsonExtract(listSql, "postgres")).toBe(
      `SELECT id FROM managed_sessions
 WHERE workspace_id = ? AND (jsonb_path_query_first((document)::jsonb, (?)::jsonpath) #>> '{}') = ?
 ORDER BY created_at DESC`,
    );
  });

  it("does not rewrite json_extract text inside strings or comments", () => {
    const sql = "SELECT 'json_extract(document, ?)' -- json_extract(document, ?)\n FROM t";
    expect(rewriteJsonExtract(sql, "mysql")).toBe(sql);
  });
});
