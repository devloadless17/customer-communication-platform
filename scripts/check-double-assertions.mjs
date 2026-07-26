#!/usr/bin/env node
/**
 * `as unknown as` ratchet.
 *
 * A double-assertion silently defeats strict TypeScript — it is the escape
 * hatch that `@ts-ignore` review-culture pushed people toward (this repo has
 * ZERO hand-written ts-ignores and ~140 double-assertions). Removing them all
 * at once would be churn; letting them GROW would be rot. So: a ratchet.
 *
 *   - Counts `as unknown as` per file across apps/ + packages/ + tests/ +
 *     scripts/, compares against the checked-in baseline.
 *   - A file whose count RISES fails CI (add a real type instead).
 *   - A file whose count FELL updates nothing automatically — run with
 *     `--update` in the same commit that removed the casts to lower the
 *     baseline, so the improvement is locked in.
 *
 * Run:    node scripts/check-double-assertions.mjs
 * Lower:  node scripts/check-double-assertions.mjs --update
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const BASELINE_FILE = join(ROOT, "scripts", "double-assertion-baseline.json");
const SCAN_DIRS = ["apps/api/src", "apps/web/src", "packages", "tests", "scripts"];
const RE = /\bas\s+unknown\s+as\b/g;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      yield* walk(p);
    } else if (/\.(ts|tsx|mts|cts)$/.test(name)) {
      yield p;
    }
  }
}

const counts = {};
let total = 0;
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const n = (readFileSync(file, "utf8").match(RE) ?? []).length;
    if (n > 0) {
      counts[file.slice(ROOT.length)] = n;
      total += n;
    }
  }
}

if (process.argv.includes("--update")) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`baseline updated: ${total} double-assertions across ${Object.keys(counts).length} files`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
} catch {
  console.error(`✖ missing/unreadable ${BASELINE_FILE} — run with --update to create it`);
  process.exit(1);
}

const regressions = [];
for (const [file, n] of Object.entries(counts)) {
  const allowed = baseline[file] ?? 0;
  if (n > allowed) regressions.push({ file, n, allowed });
}

if (regressions.length > 0) {
  console.error("✖ double-assertion ratchet — `as unknown as` count ROSE:\n");
  for (const r of regressions) {
    console.error(`  ${r.file}: ${r.n} (baseline ${r.allowed})`);
  }
  console.error(
    "\nWrite a real type (Zod parse, generic, narrowing) instead of a double" +
      " assertion. If the cast is genuinely unavoidable, lower some other" +
      " file first or justify it in review and update the baseline:" +
      " node scripts/check-double-assertions.mjs --update",
  );
  process.exit(1);
}

const baselineTotal = Object.values(baseline).reduce((a, b) => a + b, 0);
console.log(
  `✓ double-assertion ratchet: ${total} (baseline ${baselineTotal})` +
    (total < baselineTotal
      ? " — improved! lock it in: node scripts/check-double-assertions.mjs --update"
      : ""),
);
