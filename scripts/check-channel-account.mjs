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

/**
 * RULE 2 — reading "the default account" is a budgeted, reviewed act.
 *
 * `findFirst({ channel, isDefault: true })` on ChannelConnection answers a
 * question about ONE account using whichever row happens to be default. That is
 * right in a handful of places (an explicit outbound-first fallback, the
 * placeholder repair, the legacy single-account settings forms) and wrong
 * everywhere else — it is how inbound webhook HMAC came to be resolved from a
 * single account, silently dropping every sibling's messages.
 *
 * Rule 1 can't see these: they aren't credential-loader calls.
 *
 * Budgeted PER FILE rather than per line, so ordinary edits don't churn the
 * list while a NEW default-scoped read still fails the build. Scoped to
 * ChannelConnection `where` clauses only — `select: { isDefault: true }`, a
 * `data:` write, and the many `isDefault` columns on other models (TeamChannel,
 * ContactStage, AssignmentPolicy) are not this rule's business, and a checker
 * that cries wolf gets ignored.
 */
const DEFAULT_READ_BUDGET = new Map([
  [
    "apps/api/src/lib/conversations/account.ts",
    { max: 1, why: "resolveOutboundAccountId — the ONE sanctioned outbound-first fallback." },
  ],
  [
    "apps/api/src/lib/providers/normalize-default-account.ts",
    { max: 2, why: "Placeholder repair: its whole job is to find and fix the default row." },
  ],
  [
    "apps/api/src/lib/providers/config.ts",
    { max: 2, why: "loadSendCipher (guarded by the active>1 refusal) + getBusinessNumberCountry's per-account-or-default read." },
  ],
  [
    "apps/api/src/lib/providers/messenger-config.ts",
    { max: 1, why: "loadSendCipher — guarded by the same active>1 refusal." },
  ],
  [
    "apps/api/src/lib/providers/instagram-config.ts",
    { max: 1, why: "loadSendCipher — guarded by the same active>1 refusal." },
  ],
  [
    "apps/api/src/lib/providers/meta-health.ts",
    { max: 1, why: "getWhatsappHealth — explicit id when the caller names one, default otherwise." },
  ],
  [
    "apps/api/src/webhooks/meta/meta.controller.ts",
    { max: 1, why: "Documented social fallback: a payload with no entry[].id has nothing else to attribute to." },
  ],
  [
    "apps/api/src/calls/calls.service.ts",
    { max: 4, why: "Thread's own connection when known, default for workspace-level settings reads." },
  ],
  [
    "apps/api/src/workspace-settings/whatsapp/whatsapp.service.ts",
    { max: 6, why: "Legacy single-account settings form (getConfig, verify-token pre-mint, template op fallbacks)." },
  ],
  [
    "apps/api/src/workspace-settings/messenger/messenger.service.ts",
    { max: 2, why: "Legacy single-account settings form." },
  ],
  [
    "apps/api/src/workspace-settings/instagram/instagram.service.ts",
    { max: 2, why: "Legacy single-account settings form." },
  ],
  [
    "apps/api/src/workspace-settings/channel-accounts/channel-accounts.service.ts",
    { max: 1, why: "setDefault — demoting the current default is the operation." },
  ],
  [
    "apps/api/src/lib/analytics/template-analytics.ts",
    { max: 3, why: "KNOWN GAP, documented in-file: Meta's insights switch is per-WABA and the route takes no accountId yet." },
  ],
  [
    "apps/api/src/outbound-webhooks/outbound-webhooks.subscriber.ts",
    { max: 1, why: "Channel-default fallback for events that carry neither an account nor a conversation." },
  ],
]);

/** ChannelConnection reads whose `where` names the default account. */
function countDefaultAccountReads(code) {
  let count = 0;
  const re = /\bchannelConnection\s*\.\s*(findFirst|findMany|findUnique|findUniqueOrThrow|findFirstOrThrow|count)\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < code.length && depth > 0) {
      if (code[j] === "(") depth++;
      else if (code[j] === ")") depth--;
      j++;
    }
    const call = code.slice(m.index + m[0].length, j - 1);
    // Isolate the `where:` object — a `select: { isDefault: true }` is a
    // projection, not a default-scoped read, and must not count.
    const w = call.indexOf("where:");
    if (w === -1) continue;
    const braceStart = call.indexOf("{", w);
    if (braceStart === -1) continue;
    let d = 1;
    let k = braceStart + 1;
    while (k < call.length && d > 0) {
      if (call[k] === "{") d++;
      else if (call[k] === "}") d--;
      k++;
    }
    if (/isDefault\s*:\s*true/.test(call.slice(braceStart, k))) count++;
  }
  return count;
}

const violations = [];
const budgetViolations = [];
let scanned = 0;
let checked = 0;

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    scanned++;
    const raw = readFileSync(file, "utf8");
    const rel = relative(ROOT, file);

    // RULE 2 runs on every file — a default-scoped read need not sit next to a
    // credential loader (the webhook HMAC one didn't).
    if (raw.includes("channelConnection")) {
      const found = countDefaultAccountReads(stripNonCode(raw));
      const budget = DEFAULT_READ_BUDGET.get(rel);
      if (found > (budget?.max ?? 0)) {
        budgetViolations.push({ file: rel, found, allowed: budget?.max ?? 0 });
      }
    }

    if (!LOADERS.some((l) => raw.includes(l))) continue;
    const code = stripNonCode(raw);

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

if (budgetViolations.length > 0) {
  console.error("✖ channel-account check — NEW default-account read(s):\n");
  for (const v of budgetViolations) {
    console.error(`  ${v.file}  ${v.found} ChannelConnection read(s) scoped to isDefault (budget ${v.allowed})`);
  }
  console.error(
    "\nReading `isDefault: true` answers a per-account question with whichever row\n" +
      "happens to be the workspace default. That is how inbound webhook HMAC came to\n" +
      "be resolved from ONE account, silently dropping every sibling's messages.\n" +
      "Prefer the account the thing actually belongs to:\n" +
      "  · a thread    → conversation.channelConnectionId\n" +
      "  · a message   → message.channelConnectionId (its historical account)\n" +
      "  · a campaign  → broadcast.channelConnectionId\n" +
      "  · a webhook   → resolveInboundAccount\n" +
      "  · ALL of them → findMany({ isActive: true }) and handle each\n" +
      "If the default genuinely IS the answer here, raise this file's budget in\n" +
      "DEFAULT_READ_BUDGET (scripts/check-channel-account.mjs) with the reason.",
  );
  process.exit(1);
}

console.log(
  `✓ channel-account check passed (${checked} credential resolution(s) in ${scanned} files, all account-scoped;\n` +
    `  default-account reads within budget in ${DEFAULT_READ_BUDGET.size} reviewed file(s))`,
);
