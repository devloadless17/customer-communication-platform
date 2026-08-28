#!/usr/bin/env node
/**
 * Keep the widget embed script's `Cache-Control` identical in the two places
 * that set it.
 *
 * `/widget.js` is the ONE asset a customer's site loads on every page view, and
 * the only one whose URL can never carry a content hash — the `<script src>` is
 * pasted into their HTML once and lives there forever. Its caching is therefore
 * set deliberately (short `max-age` + `stale-while-revalidate`, never the
 * 1-year `immutable` used for `/_next/static/*`, which would pin a broken widget
 * on every customer site with no way to recall it).
 *
 * It has to be set TWICE, and that is not redundancy:
 *   - `deploy/Caddyfile.template` is what production actually serves (Caddy
 *     fronts the app and overwrites the header on conflict);
 *   - `apps/web/next.config.ts` covers the paths that never meet Caddy — the
 *     local Docker stack and `next dev`.
 *
 * Two values that must agree, in two files, edited months apart, is precisely
 * the shape that drifts — this repo has already recorded two such incidents for
 * HSTS and X-Frame-Options in the very same pair of files. A comment saying
 * "change it in both" is the instruction that decays; this is the one that
 * cannot.
 *
 * Enforces PARITY, not presence: if neither file caches the widget there is
 * nothing to drift and the check passes. It fails when the two disagree — which
 * includes one setting it and the other forgetting, the exact half-applied edit
 * the comment warns about.
 */
import { readFileSync } from "node:fs";

const CADDY = "deploy/Caddyfile.template";
const NEXT = "apps/web/next.config.ts";
/** Both files must cover the raw path AND the prod rewrite target. */
const PATHS = ["/widget.js", "/widget.min.js"];

/**
 * The Caddy value: a `header @matcher Cache-Control "…"` whose matcher block
 * lists the widget paths. Read the matcher rather than assuming its name, so
 * renaming `@widgetScript` doesn't silently disable this check.
 */
function fromCaddy(src) {
  const matchers = new Set();
  // @name { path /a /b }  — capture every matcher covering a widget path.
  for (const m of src.matchAll(/@(\w+)\s*\{([^}]*)\}/g)) {
    const [, name, body] = m;
    const paths = [...body.matchAll(/path\s+([^\n]+)/g)].flatMap((p) =>
      p[1].trim().split(/\s+/),
    );
    if (PATHS.some((p) => paths.includes(p))) matchers.add(name);
  }
  for (const name of matchers) {
    const re = new RegExp(`header\\s+@${name}\\s+Cache-Control\\s+"([^"]+)"`);
    const hit = src.match(re);
    if (hit) return { value: hit[1], matcher: name, paths: [...matchers] };
  }
  return null;
}

/**
 * The Next value: a headers() entry whose `source` is a widget path and whose
 * key is Cache-Control. The current form builds both entries by mapping over a
 * literal path array, so match the array + the nearby value rather than a
 * hand-written object per path.
 */
function fromNext(src) {
  const listed = PATHS.every((p) => src.includes(`"${p}"`));
  if (!listed) return null;
  // The Cache-Control value that appears in the same headers() block as the
  // widget paths. Scoped to the 800 chars after the path list so an unrelated
  // Cache-Control elsewhere in the file can't be mistaken for it.
  const at = src.indexOf(`"${PATHS[0]}"`);
  const near = src.slice(at, at + 800);
  const hit = near.match(/key:\s*"Cache-Control",\s*\n?\s*value:\s*"([^"]+)"/);
  return hit ? { value: hit[1] } : null;
}

const caddySrc = readFileSync(CADDY, "utf8");
const nextSrc = readFileSync(NEXT, "utf8");
const caddy = fromCaddy(caddySrc);
const next = fromNext(nextSrc);

if (!caddy && !next) {
  console.log("✔ widget-cache check: neither file caches the embed script — nothing to drift");
  process.exit(0);
}

const problems = [];
if (caddy && !next) {
  problems.push(
    `${CADDY} caches the widget ("${caddy.value}") but ${NEXT} does not.\n` +
      `    Production would be correct while the local Docker stack and \`next dev\`\n` +
      `    still pay a revalidation round trip on every page view.`,
  );
} else if (next && !caddy) {
  problems.push(
    `${NEXT} caches the widget ("${next.value}") but ${CADDY} does not.\n` +
      `    Caddy fronts the app in production and its header wins, so the value you\n` +
      `    set would be the one customers never get.`,
  );
} else if (caddy.value !== next.value) {
  problems.push(
    `The two values disagree:\n` +
      `      ${CADDY}: "${caddy.value}"\n` +
      `      ${NEXT}: "${next.value}"\n` +
      `    Caddy wins in production, so the Next value is the one that silently\n` +
      `    stops describing reality.`,
  );
}

// A matcher that covers only one of the two paths caches half the traffic: prod
// rewrites /widget.js to /widget.min.js, so a request can arrive as either.
if (caddy) {
  const covered = [...caddySrc.matchAll(/@(\w+)\s*\{([^}]*)\}/g)]
    .filter(([, name]) => caddy.paths.includes(name))
    .flatMap(([, , body]) =>
      [...body.matchAll(/path\s+([^\n]+)/g)].flatMap((p) => p[1].trim().split(/\s+/)),
    );
  const missing = PATHS.filter((p) => !covered.includes(p));
  if (missing.length > 0) {
    problems.push(
      `${CADDY} caches only ${covered.filter((p) => PATHS.includes(p)).join(", ")} — missing ${missing.join(", ")}.\n` +
        `    Production rewrites /widget.js to /widget.min.js, so a request can be\n` +
        `    matched on either path and both must carry the header.`,
    );
  }
}

if (problems.length === 0) {
  console.log(`✔ widget-cache check: "${caddy.value}" in both ${CADDY} and ${NEXT}`);
  process.exit(0);
}

console.error(`✖ widget embed-script caching has drifted:\n`);
for (const p of problems) console.error(`  - ${p}\n`);
console.error(
  `  /widget.js is loaded on every page view of every customer site and its URL\n` +
    `  can never carry a content hash, so its caching is set in BOTH files on\n` +
    `  purpose: Caddy is what production serves, next.config.ts covers the paths\n` +
    `  that never meet Caddy. The same pairing already drifted twice for HSTS and\n` +
    `  X-Frame-Options. Set the two to the same value.`,
);
process.exit(1);
