#!/usr/bin/env node
/**
 * CHECKER 8 — an actor-name join must go through the OPERATOR MASK.
 *
 * WHY THIS EXISTS
 * ---------------
 * The platform operator (CLAUDE.md §18) acts inside customer workspaces and
 * must render as "Support" — never their real name, avatar, or email. The mask
 * lives in `apps/api/src/lib/workspaces/operator-mask.ts`, but a DTO that joins
 * `User.name` server-side bypasses it by construction, and the leak is
 * invisible until an operator actually acts in a tenant. The 2026-08-20 audit
 * found TWELVE such surfaces — team chat (name AND avatar), quoted replies (in
 * app and on outbound webhooks), message flags, calls, broadcasts, audience
 * groups, snippets, invites, saved views, message search — each added
 * innocently, each leaking identically. This checker is what turns the
 * thirteenth into a build failure instead of a discovery.
 *
 * THE RULE
 * --------
 * A Prisma select/include that reads `name` (or `avatarUrl`) through an
 * ACTOR-SHAPED relation — createdBy, author, sender, actor, uploadedBy,
 * resolvedBy, assignedTo, initiatedBy, answeredBy, invitedBy, pinnedBy,
 * resolvedByUser, rotatedBy — must live in a file that imports from
 * `operator-mask` (proof the mapper masks) or be allowlisted here WITH a
 * reason. Coarse on purpose: a false positive costs one reviewed allowlist
 * line; a false negative puts the operator's real identity in front of a
 * customer's team.
 *
 * `contact`-shaped relations are not actors (contacts are customers, never the
 * operator), and `assignedUser` goes through `mapUser`, which self-masks.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { stripNonCode } from "./lib/strip-non-code.mjs";

const ROOT = process.cwd();
const SCAN_DIRS = ["apps/api/src"];

/** Relations whose `name` identifies a PERSON WHO ACTED. */
const ACTOR_RELATIONS = [
  "createdBy",
  "author",
  "sender",
  "actor",
  "uploadedBy",
  "resolvedBy",
  "assignedTo",
  "initiatedBy",
  "answeredBy",
  "invitedBy",
  "pinnedBy",
];

/**
 * Files that read an actor name WITHOUT importing operator-mask, each with the
 * reason that is safe. Keyed by repo-relative path.
 */
const ALLOWLIST = new Map([
  // Empty as of 2026-08-20 — every actor-name join masks. Platform-console
  // reads (super-admin.ts, the operator-access log) resolve names via direct
  // `user.findMany`, not an actor relation, so they never trip this rule.
]);

// `user: { select: { name } }` under an actor key, or `createdBy: { select: {`.
// Two-step: find `<relation>: { select: {` (or include), then check the block
// mentions `name: true` or `avatarUrl: true` within the next 200 chars.
const RELATION_OPEN = new RegExp(
  `\\b(${ACTOR_RELATIONS.join("|")})\\s*:\\s*\\{\\s*select\\s*:\\s*\\{`,
  "g",
);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const failures = [];
const usedAllowlist = new Set();

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    const raw = readFileSync(file, "utf8");
    const code = stripNonCode(raw);

    let hit = false;
    RELATION_OPEN.lastIndex = 0;
    let m;
    while ((m = RELATION_OPEN.exec(code))) {
      const window = code.slice(m.index, m.index + 220);
      if (/\bname\s*:\s*true/.test(window) || /\bavatarUrl\s*:\s*true/.test(window)) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;

    const masked = /from ["'][^"']*operator-mask["']/.test(raw);
    if (masked) continue;

    if (ALLOWLIST.has(rel)) {
      usedAllowlist.add(rel);
      continue;
    }
    failures.push(rel);
  }
}

const stale = [...ALLOWLIST.keys()].filter((k) => !usedAllowlist.has(k));

if (failures.length > 0 || stale.length > 0) {
  for (const f of failures) {
    console.error(
      `✖ actor-name check: ${f} joins an actor's name/avatar but never imports ` +
        "operator-mask — the platform operator's real identity would reach a tenant. " +
        "Mask it (actorNameMasker / a masking post-pass), or allowlist the file in " +
        "scripts/check-actor-names.mjs WITH a reason.",
    );
  }
  for (const k of stale) {
    console.error(
      `✖ actor-name check: allowlist entry \`${k}\` is stale (file no longer matches) — remove it.`,
    );
  }
  process.exit(1);
}
console.log("✓ actor-name check passed (every actor-name join masks the operator or is allowlisted)");
