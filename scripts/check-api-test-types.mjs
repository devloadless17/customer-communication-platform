#!/usr/bin/env node
/**
 * Type-error ratchet for `apps/api/test`.
 *
 * These 130+ specs were typechecked by NOTHING. `apps/api/tsconfig.json`
 * includes only `src/**`, and `tests/tsconfig.json` covers the repo-root
 * `tests/` directory — so a spec could call a domain function with the wrong
 * argument shape and compile clean, failing only at runtime with a confusing
 * message. That is not hypothetical: two such bugs were written on 2026-07-31
 * (`patch: { assignedUserId }` against a function taking a flat field, and
 * `targetWorkspaceId` against one taking `guestWorkspaceId`), and the second
 * produced a Prisma serialization error four frames deep instead of a
 * compile error on the line that was wrong.
 *
 * The directory does not typecheck CLEAN today (98 errors in 39 files: strict
 * null noise in fixtures, structural-typing friction from the
 * `as unknown as Parameters<typeof f>[0]` idiom, and constructor calls that
 * went stale when a service gained a dependency). Fixing all of it at once
 * would be churn in files this change has no business touching; letting it
 * GROW would be rot. So: a ratchet, exactly like the double-assertion one.
 *
 *   - A file whose error count RISES fails (fix the types instead).
 *   - A file whose count FELL updates nothing automatically — run with
 *     `--update` in the same commit that fixed them, to lock the win in.
 *   - A file with NO baseline entry must be clean, so every NEW spec is
 *     fully typechecked from birth.
 *
 * Run:    node scripts/check-api-test-types.mjs
 * Lower:  node scripts/check-api-test-types.mjs --update
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const BASELINE_FILE = join(ROOT, "scripts", "api-test-type-baseline.json");
const PROJECT = "apps/api/test/tsconfig.json";

/** `path/to/file.ts(12,3): error TS2345: …` → the file path. */
const ERROR_LINE = /^(.+?)\(\d+,\d+\): error TS\d+:/;

function countErrors() {
  let out = "";
  try {
    out = execFileSync("npx", ["tsc", "-p", PROJECT], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    // tsc exits non-zero when it reports errors — that is the normal path here.
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    if (!out.trim()) {
      console.error("✖ tsc produced no output but failed — is TypeScript installed?");
      process.exit(1);
    }
  }
  const counts = {};
  for (const line of out.split("\n")) {
    const m = ERROR_LINE.exec(line.trim());
    if (!m) continue;
    // Normalize to a repo-relative POSIX path so the baseline is portable.
    const file = m[1].replace(/\\/g, "/").replace(/^\.\//, "");
    counts[file] = (counts[file] ?? 0) + 1;
  }
  return counts;
}

const counts = countErrors();
const total = Object.values(counts).reduce((a, b) => a + b, 0);

if (process.argv.includes("--update")) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(
    `baseline updated: ${total} type errors across ${Object.keys(counts).length} spec files`,
  );
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
  console.error(`✖ api-test type errors increased in ${regressions.length} file(s):`);
  for (const r of regressions) {
    console.error(
      `  ${r.file}: ${r.n} (baseline ${r.allowed})` +
        (r.allowed === 0 ? "  ← new spec files must typecheck clean" : ""),
    );
  }
  console.error(`\n  npx tsc -p ${PROJECT}   # to see them`);
  process.exit(1);
}

const baselineTotal = Object.values(baseline).reduce((a, b) => a + b, 0);
const improved = baselineTotal - total;
console.log(
  `✓ api-test type ratchet: ${total} errors (baseline ${baselineTotal})` +
    (improved > 0
      ? ` — ${improved} fewer! lock it in: node scripts/check-api-test-types.mjs --update`
      : ""),
);
