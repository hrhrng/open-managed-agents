#!/usr/bin/env node
/**
 * Require 100% line + branch coverage on git-changed lines in tools.ts (#281).
 *
 * Usage:
 *   node scripts/check-tools-ts-diff-coverage.mjs [coverage-final.json] [git-base]
 *
 * Defaults:
 *   coverage-final.json → coverage/harness-tools-wiring/coverage-final.json
 *   git-base → origin/main
 */
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const TOOLS_REL = "apps/agent/src/harness/tools.ts";
const coveragePath =
  process.argv[2] ?? path.join("coverage/harness-tools-wiring/coverage-final.json");
const baseRef = process.argv[3] ?? "origin/main";

function git(...args) {
  return execSync(["git", ...args].join(" "), { encoding: "utf8" }).trimEnd();
}

/** @returns {Set<number>} executable changed line numbers (1-based) */
function changedLinesFromDiff() {
  const diff = git("diff", "-U0", `${baseRef}...HEAD`, "--", TOOLS_REL);
  const lines = new Set();
  let newLine = 0;
  for (const row of diff.split("\n")) {
    if (row.startsWith("@@")) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(row);
      if (!m) continue;
      newLine = Number(m[1]);
      const count = m[2] ? Number(m[2]) : 1;
      if (count === 0) newLine -= 1;
      continue;
    }
    if (row.startsWith("+++") || row.startsWith("---")) continue;
    if (row.startsWith("+")) {
      const text = row.slice(1);
      if (text.trim() && !text.trim().startsWith("//") && !text.trim().startsWith("*")) {
        lines.add(newLine);
      }
      newLine += 1;
      continue;
    }
    if (row.startsWith(" ")) {
      newLine += 1;
    }
  }
  return lines;
}

function loadToolsCoverage() {
  if (!existsSync(coveragePath)) {
    console.error(`Missing coverage file: ${coveragePath}`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(coveragePath, "utf8"));
  const key = Object.keys(raw).find((k) => k.replace(/\\/g, "/").endsWith(TOOLS_REL));
  if (!key) {
    console.error(`No coverage entry for ${TOOLS_REL} in ${coveragePath}`);
    process.exit(1);
  }
  return raw[key];
}

/** Map statement id → start line */
function statementLines(entry) {
  const map = new Map();
  for (const [id, loc] of Object.entries(entry.statementMap)) {
    map.set(id, loc.start.line);
  }
  return map;
}

/** Branches whose source line is in `changed` must be fully hit. */
function uncoveredBranches(entry, changed) {
  const misses = [];
  for (const [id, meta] of Object.entries(entry.branchMap)) {
    const line = meta.loc?.start?.line ?? meta.line;
    if (!changed.has(line)) continue;
    const hits = entry.b[id];
    if (!hits) continue;
    const allZero = hits.every((h) => h === 0);
    const anyZero = hits.some((h) => h === 0);
    if (anyZero) {
      misses.push({ line, branchId: id, hits });
    }
  }
  return misses;
}

function main() {
  const changed = changedLinesFromDiff();
  const entry = loadToolsCoverage();
  const stmtLine = statementLines(entry);

  const uncoveredLines = [];
  for (const [id, count] of Object.entries(entry.s)) {
    const line = stmtLine.get(id);
    if (line == null || !changed.has(line)) continue;
    if (count === 0) uncoveredLines.push(line);
  }

  const branchMisses = uncoveredBranches(entry, changed);

  let lineHits = 0;
  let lineTotal = 0;
  const uncoveredStmtLines = new Set();
  for (const line of changed) {
    const stmtsOnLine = [...stmtLine.entries()].filter(([, l]) => l === line);
    if (stmtsOnLine.length === 0) continue;
    lineTotal += 1;
    const hit = stmtsOnLine.some(([id]) => entry.s[id] > 0);
    if (hit) lineHits += 1;
    else uncoveredStmtLines.add(line);
  }
  const uniqueUncovered = [...uncoveredStmtLines].sort((a, b) => a - b);

  let branchTotal = 0;
  let branchHits = 0;
  for (const [id, meta] of Object.entries(entry.branchMap)) {
    const line = meta.loc?.start?.line ?? meta.line;
    if (!changed.has(line)) continue;
    const hits = entry.b[id] ?? [];
    branchTotal += hits.length;
    branchHits += hits.filter((h) => h > 0).length;
  }

  const linePct = lineTotal ? (100 * lineHits) / lineTotal : 100;
  const branchPct = branchTotal ? (100 * branchHits) / branchTotal : 100;

  console.log(`tools.ts diff coverage (base ${baseRef}...HEAD)`);
  console.log(`  changed executable lines tracked: ${changed.size}`);
  console.log(`  line coverage on changed stmts: ${lineHits}/${lineTotal} (${linePct.toFixed(1)}%)`);
  console.log(`  branch coverage on changed branches: ${branchHits}/${branchTotal} (${branchPct.toFixed(1)}%)`);

  if (uniqueUncovered.length || branchMisses.length) {
    if (uniqueUncovered.length) {
      console.error("\nUncovered changed lines (statements):", uniqueUncovered.join(", "));
    }
    if (branchMisses.length) {
      console.error(
        "\nPartially uncovered branches on changed lines:",
        branchMisses.map((m) => `${m.line}#${m.branchId}`).join(", "),
      );
    }
    process.exit(1);
  }

  if (linePct < 100 || branchPct < 100) {
    console.error("\nDiff coverage below 100%.");
    process.exit(1);
  }

  console.log("\nOK: 100% line + branch on all changed tools.ts lines.");
}

main();
