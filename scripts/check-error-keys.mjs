#!/usr/bin/env node
/**
 * Guard: API error keys are snake_case machine identifiers, not prose.
 *
 * The structured error envelope is `{ error: "<snake_case_key>", detail?: "…" }`
 * (CLAUDE.md §13). `error` is a WIRE CONTRACT — clients branch on it, and at
 * least one did: the reply box matched `error === "waba id missing"` to decide
 * whether to render the WhatsApp-setup nudge. `detail` is where the human
 * sentence belongs, because that is the field you can reword without breaking
 * a caller.
 *
 * Before 2026-07-27 both spellings coexisted for the SAME condition —
 * "not found" (26 sites) alongside "not_found" (18), "conversation not found"
 * alongside "conversation_not_found" — so a client could not know which to
 * match. 269 keys were normalized in one pass; this stops the drift returning.
 *
 * Run: node scripts/check-error-keys.mjs   (wired into `pnpm run check` + CI)
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Only surfaces that emit the HTTP error ENVELOPE. Deliberately NOT all of
 * `apps/web/src`: a Next server action returns `{ error: "Enter the 6-digit
 * code." }` straight to the form component that RENDERS it — there the string
 * is the display payload, not a key anyone branches on, and snake-casing it
 * would put "Enter_the_6_digit_code." on screen.
 */
const SCAN_DIRS = [
  "apps/api/src",
  "apps/web/src/app/api", // route handlers — real HTTP responses
];
const SCAN_FILES = ["apps/web/src/proxy.ts"]; // edge responses

/**
 * Keys that are allowed to contain spaces because they are NOT ours to
 * rename — a provider's own string echoed back, or a value that is prose by
 * definition. Keep this list short and justified; an entry here is a promise
 * that the value never reaches a client as a branchable key.
 */
const ALLOWED = new Set([]);

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next" || e.name.startsWith("."))
        continue;
      await walk(full, out);
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = [...SCAN_FILES];
for (const d of SCAN_DIRS) await walk(d, files);

// `error: "two words"` — a quoted value containing a space, assigned to the
// `error` field of a structured response.
const PROSE_KEY = /\berror:\s*"([^"]*\s[^"]*)"/g;

const problems = [];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  let m;
  PROSE_KEY.lastIndex = 0;
  while ((m = PROSE_KEY.exec(src))) {
    const key = m[1];
    if (ALLOWED.has(key)) continue;
    // Template literals and interpolations are not literal keys.
    if (key.includes("${")) continue;
    const line = src.slice(0, m.index).split("\n").length;
    problems.push(
      `${file}:${line}\n    error: "${key}"\n` +
        `    → keys are snake_case identifiers clients branch on; put the sentence in \`detail\`.\n` +
        `      Suggested: error: "${key.trim().replace(/\s+/g, "_")}"`,
    );
  }
}

if (problems.length > 0) {
  console.error("✗ error-key check failed:\n");
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}

console.log(`✓ error-key check passed (${files.length} files, no prose error keys)`);
