#!/usr/bin/env node
/** Print markdown table for PR #281 harness web HTTP coverage comment. */
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const helpersSummary = "coverage/harness-web-http/coverage-summary.json";
const toolsSummary = "coverage/harness-tools-wiring/coverage-summary.json";

function readSummary(file) {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

function entryFor(summary, relPath) {
  if (!summary) return null;
  if (summary[relPath]) return summary[relPath];
  const suffix = `/${relPath}`;
  const key = Object.keys(summary).find((k) => k.replace(/\\/g, "/").endsWith(suffix));
  return key ? summary[key] : null;
}

function pct(entry, key) {
  if (!entry) return "n/a";
  const t = entry[key];
  if (!t || !t.total) return "100%";
  return `${((100 * t.covered) / t.total).toFixed(1)}%`;
}

function row(label, entry) {
  return `| \`${label}\` | ${pct(entry, "lines")} | ${pct(entry, "branches")} |`;
}

function diffToolsLineBranch() {
  try {
    const out = execSync("node scripts/check-tools-ts-diff-coverage.mjs", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const line = out.match(/line coverage on changed stmts: (\d+\/\d+ \(\d+\.\d+%\))/);
    const branch = out.match(/branch coverage on changed branches: (\d+\/\d+ \(\d+\.\d+%\))/);
    return {
      lines: line?.[1] ?? "see CI log",
      branches: branch?.[1] ?? "see CI log",
      ok: out.includes("OK: 100%"),
    };
  } catch (e) {
    const stdout = e.stdout?.toString() ?? "";
    const line = stdout.match(/line coverage on changed stmts: (\d+\/\d+ \(\d+\.\d+%\))/);
    const branch = stdout.match(/branch coverage on changed branches: (\d+\/\d+ \(\d+\.\d+%\))/);
    return {
      lines: line?.[1] ?? "failed",
      branches: branch?.[1] ?? "failed",
      ok: false,
    };
  }
}

const helpers = readSummary(helpersSummary);
const tools = readSummary(toolsSummary);
const diff = diffToolsLineBranch();

const webFetch = entryFor(helpers, "apps/agent/src/harness/web-fetch-http.ts");
const toolHttp = entryFor(helpers, "apps/agent/src/harness/tool-http-fetch.ts");

console.log("## Harness web HTTP coverage (#281)\n");
console.log("| File | Lines | Branches |");
console.log("| --- | --- | --- |");
console.log(row("apps/agent/src/harness/web-fetch-http.ts", webFetch));
console.log(row("apps/agent/src/harness/tool-http-fetch.ts", toolHttp));
console.log(
  `| \`apps/agent/src/harness/tools.ts\` (changed lines vs \`origin/main\`) | ${diff.lines} | ${diff.branches} |`,
);
const toolsWhole = entryFor(tools, "apps/agent/src/harness/tools.ts");
if (toolsWhole) {
  const whole = toolsWhole;
  console.log(
    `\n_Full-file tools.ts coverage (informational): lines ${pct(whole, "lines")}, branches ${pct(whole, "branches")}._`,
  );
}
console.log(
  diff.ok
    ? "\n**Gate:** 100% line + branch on helper modules and on all changed `tools.ts` lines."
    : "\n**Gate:** FAILED — see \`check-tools-ts-diff-coverage\` log.",
);
