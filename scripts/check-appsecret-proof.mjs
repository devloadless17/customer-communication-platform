#!/usr/bin/env node
/**
 * check-appsecret-proof — every Meta Graph call must be SIGNABLE.
 *
 * The bug class this pins: a Graph call made without `appsecret_proof` fails
 * with code 100 against any customer Meta app that has "Require app secret"
 * ON (App settings → Advanced) — the posture the onboarding runbook
 * prescribes. It bit FOUR times on 2026-08-11 alone, each a different layer
 * of the same omission, each silent in a different way:
 *   - the /settings/meta and channel connect validations (blocked onboarding),
 *   - ensureWabaSubscribed (WABA never subscribed → zero inbound, and the
 *     30-min sweeper's self-heal failing identically),
 *   - the meta-health reads ("Meta didn't respond" panel, portfolio stranded),
 *   - the meta-social calling calls and sticker catalog reads.
 *
 * Rule enforced, mechanically: inside apps/api/src, every call to a signing
 * helper (`graphGetJson` / `graphPostJson` / `graphPostForm` / `graphDelete` /
 * `graphDeleteJson` / `metaFetch`) must mention `appSecret` (or an app-token
 * builder, which embeds the secret) somewhere inside its argument list, and
 * every raw `fetch(` whose argument list references GRAPH_BASE or
 * graph.facebook.com must wrap the URL in `withAppsecretProof`.
 *
 * The check is textual and paren-aware, not type-aware — it asks "was a secret
 * HANDED to the call", which is the failure mode that actually shipped
 * (helpers and env-gating were all correct; call sites just passed nothing).
 * `withAppsecretProof` itself no-ops unless META_APPSECRET_PROOF=1, so a
 * passing site is zero-risk in dev/CI.
 *
 * Deliberately unsigned (and excluded here): non-Graph origins — the
 * lookaside/CDN media hop (signing it 401'd ALL inbound media on 2026-08-03),
 * avatar source fetches, and non-Meta services. Only Graph-origin calls are
 * asserted.
 *
 * False-positive escape hatch: a line-comment `// appsecret-proof-exempt: <why>`
 * on the line directly above the call skips it. Use it for a Graph call that
 * genuinely must not be signed (none known today).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "apps/api/src");

/** The helpers that accept an appSecret and sign when given one. */
const HELPER_CALL =
  /\b(graphGetJson|graphPostJson|graphPostForm|graphDelete|graphDeleteJson|metaFetch)\(/g;
/** Raw fetch — only flagged when its argument list references Graph. */
const RAW_FETCH = /\bawait fetch\(|\b= fetch\(/g;

/** Files that ARE the signing layer (their internal fetch is the mechanism). */
const SIGNING_LAYER = new Set([
  "lib/providers/meta-graph.ts",
  "lib/providers/meta-transport.ts",
]);

const EXEMPT_MARK = "appsecret-proof-exempt:";

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (p.endsWith(".ts") && !p.endsWith(".spec.ts")) yield p;
  }
}

/** The balanced-paren argument span starting at the `(` at src[open]. */
function callSpan(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open); // unbalanced — return the tail; the match will fail loudly
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

function lineAbove(src, index) {
  const upto = src.slice(0, index);
  const lines = upto.split("\n");
  return lines.length >= 2 ? lines[lines.length - 2] : "";
}

const failures = [];
for (const file of walk(SRC)) {
  const rel = file.slice(SRC.length + 1);
  if (SIGNING_LAYER.has(rel)) continue;
  const src = readFileSync(file, "utf8");

  for (const m of src.matchAll(HELPER_CALL)) {
    const call = callSpan(src, m.index + m[0].length - 1);
    if (/appSecret|appsecret_proof|appAccessToken|appToken/i.test(call)) continue;
    if (lineAbove(src, m.index).includes(EXEMPT_MARK)) continue;
    failures.push(
      `${rel}:${lineOf(src, m.index)} ${m[1]}(...) passes no appSecret — a "Require app secret" customer app 400s this call`,
    );
  }

  for (const m of src.matchAll(RAW_FETCH)) {
    const openIdx = m.index + m[0].lastIndexOf("(");
    const call = callSpan(src, openIdx);
    if (!/GRAPH_BASE|graph\.facebook\.com/.test(call)) continue; // non-Graph origin — out of scope
    if (/withAppsecretProof|appsecret_proof/.test(call)) continue;
    if (lineAbove(src, m.index).includes(EXEMPT_MARK)) continue;
    failures.push(
      `${rel}:${lineOf(src, m.index)} raw fetch to Graph without withAppsecretProof(...)`,
    );
  }
}

if (failures.length > 0) {
  console.error(`✘ appsecret-proof check: ${failures.length} unsigned Graph call(s):\n`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "\nEvery Graph call must hand its helper the calling app's secret (the secret of the app" +
      "\nthat ISSUED the bearer token). See apps/api/src/lib/providers/appsecret-proof.ts.",
  );
  process.exit(1);
}
console.log("✔ appsecret-proof check: every Graph call site hands its helper an app secret");
