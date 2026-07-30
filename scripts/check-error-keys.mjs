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
import { stripComments } from "./lib/strip-non-code.mjs";

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
 * Per-site escape hatch. Put this comment on the line ABOVE an `error:` that
 * is legitimately prose:
 *
 *     // error-key-checker: column-not-envelope
 *     error: "The transfer stopped unexpectedly. …",
 *
 * The real case it exists for: `ContactTransferJob.error` is a database
 * COLUMN the UI renders verbatim, not an HTTP envelope — there the sentence
 * IS the value, and snake-casing it would put an identifier in front of a
 * user. An inline marker beats a string allowlist because it lives at the
 * site, explains itself, and survives a reword.
 */
const ESCAPE_MARKER = "error-key-checker: column-not-envelope";

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
  // Match against CODE only. `stripComments` preserves offsets and newlines, so
  // every index and line number below still refers to the real file.
  const code = stripComments(src);
  let m;
  PROSE_KEY.lastIndex = 0;
  while ((m = PROSE_KEY.exec(code))) {
    const key = m[1];
    // Template literals and interpolations are not literal keys.
    if (key.includes("${")) continue;
    const line = code.slice(0, m.index).split("\n").length;
    // An internal RESULT object — `{ ok: false, error: "…" }` — is not the HTTP
    // envelope. The envelope is `{ error, detail? }` and never carries `ok`;
    // a Result carries a human sentence for a caller to surface, exactly like
    // the sibling line that does `error: err.message`. Flagging those would
    // push snake_case identifiers into UI copy, which is the same mistake as
    // the column case above — so the discriminator is `ok:` in the same
    // object literal, not a per-site marker.
    const objStart = code.lastIndexOf("{", m.index);
    if (objStart !== -1 && /\bok:\s*(true|false)/.test(code.slice(objStart, m.index))) {
      continue;
    }
    // Escape marker on any of the few lines above (the write may be wrapped).
    // Read the ORIGINAL source here — the marker lives in a comment, which
    // `code` has blanked out by design.
    const preceding = src.split("\n").slice(Math.max(0, line - 7), line - 1).join("\n");
    if (preceding.includes(ESCAPE_MARKER)) continue;
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
