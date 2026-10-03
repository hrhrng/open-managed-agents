/**
 * JSON path for one metadata key. The path is bound as a parameter.
 * Quoted member names keep keys such as `project_id` ordinary strings.
 */
export function sessionMetadataJsonPath(key: string): string {
  if (key.length === 0) {
    throw new Error("Session metadata filter key must not be empty");
  }
  let escaped = "";
  for (const char of key) {
    if (char === "\\" || char === "\"") {
      escaped += `\\${char}`;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20) {
      escaped += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    escaped += char;
  }
  return `$.metadata."${escaped}"`;
}
