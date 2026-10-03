export type JsonExtractDialect = "mysql" | "postgres";

function isIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/u.test(char);
}

function skipQuoted(sql: string, start: number): number {
  const quote = sql[start];
  if (quote === undefined) return start;
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === "\\" && quote !== "`") {
      index += 2;
      continue;
    }
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

function skipLineComment(sql: string, start: number): number {
  let index = start;
  while (index < sql.length && sql[index] !== "\n") index += 1;
  return index;
}

function skipBlockComment(sql: string, start: number): number {
  const end = sql.indexOf("*/", start + 2);
  return end === -1 ? sql.length : end + 2;
}

interface ParsedCall {
  args: string[];
  end: number;
}

function parseCallArgs(sql: string, open: number): ParsedCall | null {
  const args: string[] = [];
  let current = "";
  let depth = 1;
  let index = open;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'" || char === "\"" || char === "`") {
      const end = skipQuoted(sql, index);
      current += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === "(") {
      depth += 1;
      current += char;
      index += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        args.push(current.trim());
        return { args, end: index + 1 };
      }
      current += char;
      index += 1;
      continue;
    }
    if (char === "," && depth === 1) {
      args.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  return null;
}

function rewrittenCall(dialect: JsonExtractDialect, column: string, path: string): string {
  if (dialect === "mysql") {
    return `JSON_UNQUOTE(JSON_EXTRACT(${column}, ${path}))`;
  }
  return `(jsonb_path_query_first((${column})::jsonb, (${path})::jsonpath) #>> '{}')`;
}

/**
 * Repos write SQLite `json_extract(column, ?)`. MySQL and Postgres adapters
 * rewrite that call. SQLite and D1 keep it. Placeholder count stays the same.
 */
export function rewriteJsonExtract(sql: string, dialect: JsonExtractDialect): string {
  const call = "json_extract(";
  let out = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'" || char === "\"" || char === "`") {
      const end = skipQuoted(sql, index);
      out += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      const end = skipLineComment(sql, index);
      out += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const end = skipBlockComment(sql, index);
      out += sql.slice(index, end);
      index = end;
      continue;
    }
    if (sql.startsWith(call, index) && !isIdentifierChar(sql[index - 1])) {
      const parsed = parseCallArgs(sql, index + call.length);
      if (parsed !== null && parsed.args.length === 2) {
        const [column, path] = parsed.args;
        if (column !== undefined && column.length > 0 && path !== undefined && path.length > 0) {
          out += rewrittenCall(dialect, column, path);
          index = parsed.end;
          continue;
        }
      }
    }
    out += char;
    index += 1;
  }
  return out;
}
