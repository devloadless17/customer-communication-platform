#!/usr/bin/env node
/**
 * Test-isolation tripwire.
 *
 * Fails if any file under tests/ contains a Prisma `deleteMany` / `updateMany`
 * call with NO argument, an empty object, or an object without a `where` —
 * i.e. an unfiltered bulk write. The e2e suites share the maintainer's ONE
 * dev database; on 2026-07-26 `wipeTestData()` was found to be 14 unfiltered
 * `deleteMany({})` calls that had been destroying real tenant data on every
 * run. This checker (plus the `e2e-` workspace-id tripwire in
 * tests/e2e/_helpers/db.ts and the isolation canary) makes that class of
 * accident structurally impossible to reintroduce.
 *
 * Scope note: it checks tests/ only. Application code has legitimate
 * cross-tenant sweeps (retention cleanup); tests never do.
 *
 * Run: node scripts/check-test-isolation.mjs   (wired into `pnpm run check` + CI)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN_DIR = join(ROOT, "tests");
const CALL_RE = /\.(deleteMany|updateMany)\s*\(/g;

/** Strip line/block comments and string contents so a commented-out or
 *  quoted call can't false-positive (same scrub posture as
 *  check-prisma-fields.mjs). String BODIES are blanked but quotes kept. */
function scrub(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += quote;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
      out += quote;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Extract the balanced-paren argument list starting at `openIdx` (the `(`). */
function balancedArg(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return src.slice(openIdx + 1); // unbalanced — report as-is
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      yield* walk(p);
    } else if (/\.(ts|mts|cts|tsx|js|mjs)$/.test(name)) {
      yield p;
    }
  }
}

const violations = [];
for (const file of walk(SCAN_DIR)) {
  const src = scrub(readFileSync(file, "utf8"));
  let m;
  CALL_RE.lastIndex = 0;
  while ((m = CALL_RE.exec(src)) !== null) {
    const arg = balancedArg(src, m.index + m[0].length - 1).trim();
    const bare = arg === "" || arg === "{}" ;
    // An object argument must carry a `where` key; a spread/variable arg is
    // opaque — require the literal key so intent is visible at the call site.
    const hasWhere = /(^|[{,\s])where\s*:/.test(arg);
    if (bare || !hasWhere) {
      const line = src.slice(0, m.index).split("\n").length;
      violations.push({
        file: file.slice(ROOT.length),
        line,
        call: m[1],
        arg: arg.length > 80 ? `${arg.slice(0, 77)}...` : arg || "(no argument)",
      });
    }
  }
}

if (violations.length > 0) {
  console.error("✖ test-isolation check failed — unfiltered bulk writes in tests/:\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  .${v.call}(${v.arg})`);
  }
  console.error(
    "\nEvery deleteMany/updateMany in tests/ must carry an explicit `where`" +
      " (scoped to an e2e- workspace). See tests/e2e/_helpers/db.ts.",
  );
  process.exit(1);
}
console.log("✓ test-isolation check passed (no unfiltered bulk writes in tests/)");
