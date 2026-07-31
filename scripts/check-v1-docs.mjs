#!/usr/bin/env node
/**
 * CHECKER 8 — every `/v1` route is scope-gated and documented.
 *
 * TWO properties, both previously enforced by nothing:
 *
 *   1. Every route carries `@RequireScope`. `ScopeGuard` is permissive by
 *      DEFAULT (`if (!required) return true`), so a route added without the
 *      decorator is reachable by ANY valid API key whatever its scopes. All 163
 *      carried it on 2026-07-29 — but that held only because someone re-counted
 *      by hand, on a controller that grew from 111 to 163 routes in a month.
 *
 *   2. Every route appears in the in-app `/docs/api` page, which CLAUDE.md §12
 *      makes a locked rule ("every capability the UI has, the API has, and
 *      every endpoint is documented"). Undocumented routes are invisible from
 *      every side: the code compiles, the page renders, and only a partner
 *      discovers the route they needed was never written down.
 *
 * DOC SURFACE: the in-app page ONLY. `the in-app /docs/api page` was deleted
 * from this branch on purpose — the maintainer removed the whole `docs/` tree
 * as stale, and CLAUDE.md is the source of truth. A checker that requires a
 * file the project deliberately dropped is a checker that fails for a reason
 * nobody wants fixed. If a markdown reference ever comes back, add it to
 * SURFACES and this check covers it again for free.
 *
 * WHY THE MATCH IS STRICT. A first version probed for the route's bare stem,
 * and "workflows" appears in prose all over a reference page — it reported 0
 * missing while 10 routes were genuinely absent. A checker that matches prose
 * is a checker that lies. The path must appear in a ROUTE-shaped context.
 *
 * Run: node scripts/check-v1-docs.mjs
 */
import { readFileSync, readdirSync } from "node:fs";

// EVERY *.controller.ts in the /v1 folder — discovered, not hand-named. The
// 2026-07-31 split peels the 197-route god-controller into per-resource
// controllers; a hand-named single file here would silently DROP each peeled
// route from this check (the first peel took the count 197 → 191 with a green
// tick, which is exactly the unnamed-surface failure the UX rubric documented).
const V1_DIR = "apps/api/src/external/v1";
const CONTROLLERS = readdirSync(V1_DIR)
  .filter((f) => f.endsWith(".controller.ts"))
  .map((f) => `${V1_DIR}/${f}`)
  .sort();
const SURFACES = [
  { label: "the in-app /docs/api page", path: "apps/web/src/app/docs/api/page.tsx" },
];

/**
 * Routes deliberately absent from the public docs, each with a reason.
 * Keep this empty unless there is a real one — an allowlist is where a
 * checker goes to die.
 */
const ALLOWLIST = new Map([
  // e.g. ["POST internal/thing", "internal-only, never advertised"],
]);

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    console.error(`✖ v1-docs check: cannot read ${path}`);
    process.exit(1);
  }
}

/** Strip comments and string literals so a route named in prose or in a
 *  docblock cannot satisfy the check for the controller side. */
function routesFrom(src) {
  const out = new Set();
  const re = /@(Get|Post|Patch|Put|Delete)\(\s*"([^"]*)"\s*\)/g;
  let m;
  while ((m = re.exec(src))) out.add(`${m[1].toUpperCase()} ${m[2]}`);
  return [...out].sort();
}

/**
 * The LITERAL segments of a path, in order — `:params` dropped.
 *
 * `contacts/:id/spam` → ["contacts", "spam"]. The second one is the whole point:
 * it is what distinguishes this route from `contacts/:id/block`, and until
 * 2026-07-30 nothing checked it.
 */
function literalSegments(path) {
  return path
    .split("/")
    .filter((seg) => seg && !seg.startsWith(":"));
}

/**
 * PATH-EXACT: the route's literal-segment sequence must match an
 * `<Endpoint path="...">` declaration on the docs page.
 *
 * Two weaker versions preceded this, and each hid a real gap:
 *   - stem matching (dropped 2026-07-30): only the prefix before the first
 *     `:param` was checked, so every `.../:id/<verb>` route passed on its
 *     collection's docs — found by adding `POST contacts/:id/spam` and
 *     watching the checker stay green.
 *   - independent per-segment matching (dropped 2026-07-31): each segment was
 *     looked up separately, so `GET reports/acquisition` passed on the
 *     strength of `reports/overview` + `contacts/:id/acquisition` while being
 *     nowhere on the page — and it was hiding `assignment-policies`, a route
 *     documented only inside another endpoint's prose.
 * A guard whose green light does not depend on the thing it guards is worse
 * than no guard: it is the reason nobody re-checks by hand.
 *
 * Item routes that add no segment of their own (`ticket-fields/:id`,
 * `tickets/views/:viewId`) still pass on their collection's declaration, which
 * is correct — there is nothing distinguishing left to document.
 */
function documented(path, text) {
  const segments = literalSegments(path);
  if (segments.length === 0) return true;
  // PATH-EXACT first: the docs page declares each route as
  // `<Endpoint path="/api/external/v1/...">`, so the literal-segment SEQUENCE
  // of a route must match one of those declarations.
  //
  // Checking segments INDEPENDENTLY was still a hole, found 2026-07-31 by
  // adding `GET reports/acquisition` and watching the checker report "all
  // documented": `reports` appears (reports/overview) and `acquisition`
  // appears (contacts/:id/acquisition), so every segment passed while the
  // route itself was nowhere on the page. Same lesson as the 2026-07-30 fix
  // one function up — a green light that does not depend on the thing it
  // guards is worse than no guard.
  // PATH-EXACT, with no prose fallback. A per-segment fallback would re-open
  // the exact hole this replaced: `reports/acquisition` passes it on the
  // strength of two unrelated routes. Every one of the 149 routes carries its
  // own <Endpoint> declaration today, so the strict form costs nothing — and
  // the one route that did not (`assignment-policies`, mentioned only inside
  // another endpoint's prose) turned out to be a real documentation gap the
  // loose check had been hiding.
  return documentedPaths(text).has(segments.join("/"));
}

/**
 * Every route path declared on the docs page, as its literal-segment sequence.
 *
 * Read from the `path="..."` attribute of each `<Endpoint>` — an exact,
 * machine-readable declaration, unlike the surrounding prose.
 */
const _documentedPaths = new Map();
function documentedPaths(text) {
  // Keyed by the surface's text, NOT a process-global: with a single cached
  // set, adding a second surface to SURFACES would silently reuse the first
  // surface's paths and report the second fully documented without ever
  // reading it — a green light independent of the thing it guards, again.
  let set = _documentedPaths.get(text);
  if (set) return set;
  set = new Set();
  for (const m of text.matchAll(/path="([^"]+)"/g)) {
    const p = m[1].replace(/^\/api\/external\/v1\/?/, "");
    set.add(literalSegments(p).join("/"));
  }
  _documentedPaths.set(text, set);
  return set;
}


/**
 * Every route must carry `@RequireScope`.
 *
 * ScopeGuard is permissive by DEFAULT — `if (!required) return true` — so a
 * route added without the decorator is reachable by ANY valid API key,
 * whatever its scopes. Nothing enforced this; the invariant held only because
 * someone re-counted by hand. All 163 routes carried it on 2026-07-29; this is
 * what keeps that true.
 *
 * The decorator sits AFTER the verb in this controller, so the search window
 * runs from the previous verb to the start of the method body. (A first pass
 * that looked only backwards reported 78 false positives.)
 */
function routesMissingScope(src) {
  const lines = src.split("\n");
  const verb = /@(Get|Post|Patch|Put|Delete)\(\s*"([^"]*)"\s*\)/;
  const body = /^\s*(public |private |protected )?(async )?[A-Za-z_]\w*\s*\(/;
  const verbLines = [];
  lines.forEach((l, i) => { if (verb.test(l)) verbLines.push(i); });
  const missing = [];
  verbLines.forEach((i, idx) => {
    const m = verb.exec(lines[i]);
    const start = idx > 0 ? verbLines[idx - 1] + 1 : 0;
    let end = i;
    while (end < lines.length && !body.test(lines[end]) && end - i <= 25) end++;
    const block = lines.slice(start, end + 1).join("\n");
    if (!block.includes("@RequireScope(")) {
      missing.push(`${m[1].toUpperCase()} /v1/${m[2]} (line ${i + 1})`);
    }
  });
  return missing;
}

const controller = CONTROLLERS.map((p) => read(p)).join("\n");
const routes = CONTROLLERS.flatMap((p) => routesFrom(read(p)));
const scopes = [...new Set([...controller.matchAll(/@RequireScope\("([^"]+)"\)/g)].map((m) => m[1]))].sort();

if (routes.length === 0) {
  console.error("✖ v1-docs check: found no routes — the controller shape changed, fix this checker");
  process.exit(1);
}

let failures = 0;
for (const { label, path } of SURFACES) {
  const text = read(path);

  const missingRoutes = routes.filter((r) => {
    const [, p] = r.split(" ");
    return !ALLOWLIST.has(r) && !documented(p, text);
  });
  const missingScopes = scopes.filter((s) => !text.includes(s));

  if (missingRoutes.length) {
    failures += missingRoutes.length;
    console.error(`✖ ${missingRoutes.length} /v1 route(s) not documented in ${label}:`);
    for (const r of missingRoutes) console.error(`    ${r}`);
  }
  if (missingScopes.length) {
    failures += missingScopes.length;
    console.error(`✖ scope(s) not named in ${label}: ${missingScopes.join(", ")}`);
  }
}

/** A scope the docs advertise that NO route requires is worse than a missing
 *  one: a partner mints a key from it and gets 403 with nothing to explain it.
 *  That is exactly what `write:users` did. */
const SCOPE_RE = /`((?:read|write|delete|admin):[a-z]+)`/g;
for (const { label, path } of SURFACES) {
  const text = read(path);
  const advertised = new Set([...text.matchAll(SCOPE_RE)].map((m) => m[1]));
  const phantom = [...advertised].filter((s) => !scopes.includes(s)).sort();
  if (phantom.length) {
    // Only flag it when the doc presents it as usable — a sentence explaining
    // that a scope was retired is the correct way to mention a dead one.
    const real = phantom.filter((s) => !new RegExp(`\`${s}\`[^.\\n]*(no longer|retired|removed)`).test(text));
    if (real.length) {
      failures += real.length;
      console.error(`✖ ${label} advertises scope(s) no route requires: ${real.join(", ")}`);
    }
  }
}


const missingScope = routesMissingScope(controller);
if (missingScope.length) {
  failures += missingScope.length;
  console.error(`✖ ${missingScope.length} /v1 route(s) with NO @RequireScope — reachable by any valid key:`);
  for (const r of missingScope) console.error(`    ${r}`);
}

if (failures) {
  console.error(
    `\n  CLAUDE.md §12 makes /v1 parity a LOCKED RULE: document the route in the\n` +
      `  in-app /docs/api page and give it an @RequireScope, or add it to\n` +
      `  ALLOWLIST in this file with a reason.`,
  );
  process.exit(1);
}

console.log(
  `✓ v1-docs check passed (${routes.length} routes, ${scopes.length} scopes, all @RequireScope-gated and documented)`,
);
