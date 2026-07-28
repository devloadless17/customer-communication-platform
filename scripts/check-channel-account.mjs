#!/usr/bin/env node
/**
 * CHECKER 7 — every provider-credential resolution must NAME AN ACCOUNT.
 *
 * WHY THIS EXISTS
 * ---------------
 * A workspace holds several accounts on one channel (WhatsApp numbers under a
 * portfolio, Facebook Pages, Instagram handles). `getSendConfig(workspaceId)`
 * with no account is not "the obvious default" — it is a GUESS, and the loaders
 * refuse it (`account-unresolved`) as soon as a second live account exists.
 *
 * Every bug in this family looked different and had the same shape:
 *   - replies going out from a number the customer never messaged (no 24h
 *     window there), and later failing outright;
 *   - typing indicators and read receipts silently never delivered;
 *   - social contacts stuck named by their raw PSID with no avatar;
 *   - inbound call artifacts and media downloads failing;
 *   - a workflow reporting "no reachable channel" for a workspace with two
 *     healthy WhatsApp numbers.
 * Each was invisible in a single-account workspace and each was found by hand,
 * one at a time, months apart. That is what this checker replaces.
 *
 * THE RULE
 * --------
 * A call to a credential loader passes an account as its second argument. If a
 * call site genuinely cannot name one, allowlist it HERE with a reason — the
 * point is that skipping it becomes a deliberate, reviewed act instead of an
 * omission nobody notices.
 *
 * Comments and strings are stripped before matching: an earlier hand-run of
 * this scan reported a false positive from the phrase `getSendConfig(workspaceId)`
 * inside a docblock, and a checker that cries wolf gets ignored.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["apps/api/src"];

/** Functions that load per-account provider credentials. */
const LOADERS = [
  "getSendConfig",
  "getMetaSendConfig",
  "getMessengerSendConfig",
  "getInstagramSendConfig",
];

/**
 * Call sites that legitimately pass no account, each with the reason it is
 * safe. Keyed by "<repo-relative path>:<loader>" so moving a call within a file
 * doesn't silently re-allow it, but a line edit doesn't churn the list.
 */
const ALLOWLIST = new Map([
  [
    "apps/api/src/lib/providers/webchatwidget-config.ts:getWebchatwidgetSendConfig",
    "First-party channel: its config lives outside ChannelConnection, so there is no account to name and no ambiguous fallback.",
  ],
]);

/** The DEFINITION, not a call — `getSendConfig(workspaceId: string, ...)`. */
const IS_DECLARATION = /^\s*(?:workspaceId|teamId)\s*:/;

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

/**
 * Blank out comments and string/template literals, preserving offsets and
 * newlines so reported line numbers stay true.
 */
function stripNonCode(src) {
  const out = src.split("");
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
    } else if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      blank(i, end === -1 ? src.length : end + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      const quote = src[i];
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") j += 2;
        else if (src[j] === quote) break;
        else j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else i++;
  }
  return out.join("");
}

/** Split a call's argument text on TOP-LEVEL commas. */
function topLevelArgs(text) {
  const args = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      args.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

const violations = [];
let scanned = 0;
let checked = 0;

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    scanned++;
    const raw = readFileSync(file, "utf8");
    if (!LOADERS.some((l) => raw.includes(l))) continue;
    const code = stripNonCode(raw);
    const rel = relative(ROOT, file);

    for (const loader of LOADERS) {
      const re = new RegExp(`\\b${loader}\\s*\\(`, "g");
      let m;
      while ((m = re.exec(code))) {
        // Walk to the matching close paren.
        let depth = 1;
        let j = m.index + m[0].length;
        while (j < code.length && depth > 0) {
          if (code[j] === "(") depth++;
          else if (code[j] === ")") depth--;
          j++;
        }
        const inner = code.slice(m.index + m[0].length, j - 1);
        if (IS_DECLARATION.test(inner)) continue; // the definition itself
        checked++;
        const args = topLevelArgs(inner);
        if (args.length >= 2) continue;
        if (ALLOWLIST.has(`${rel}:${loader}`)) continue;
        violations.push({
          file: rel,
          line: code.slice(0, m.index).split("\n").length,
          loader,
          args: inner.trim().replace(/\s+/g, " ").slice(0, 60),
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error("✖ channel-account check — credential resolution with NO account:\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.loader}(${v.args})`);
  }
  console.error(
    "\nA workspace can hold several accounts on one channel, so resolving credentials\n" +
      "without naming one is a guess — and the loaders refuse it outright\n" +
      "(`account-unresolved`) once a second live account exists. Pass the account:\n" +
      "  · a thread    → conversation.channelConnectionId\n" +
      "  · a campaign  → broadcast.channelConnectionId\n" +
      "  · a call      → call.conversation.channelConnectionId\n" +
      "  · a webhook   → the account the batch was attributed to\n" +
      "  · a template  → the WABA that owns it (templateOpConfig)\n" +
      "  · outbound-first → resolveOutboundAccountId (lib/conversations/account.ts)\n" +
      "If this site genuinely cannot name one, add it to ALLOWLIST in\n" +
      "scripts/check-channel-account.mjs with the reason.",
  );
  process.exit(1);
}

console.log(
  `✓ channel-account check passed (${checked} credential resolution(s) in ${scanned} files, all account-scoped)`,
);
