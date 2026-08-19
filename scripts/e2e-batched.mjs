#!/usr/bin/env node
/**
 * Run the main Playwright suite in BATCHES, for boxes that cannot hold it in
 * one pass.
 *
 * WHY THIS EXISTS. Predeploy step 4 is `pnpm test:e2e` against a running stack.
 * On a memory-constrained machine that command cannot finish, and — this is the
 * part that costs hours — it does not fail honestly. Measured 2026-07-29 on a
 * 5.9 GB box:
 *
 *   - Next dev + Nest dev + Chromium + Postgres + Redis exceeds available RAM,
 *     so the kernel OOM-kills the web dev server mid-run (`exit 137`). Every
 *     subsequent test then fails against a server that is simply gone.
 *   - The OOM lands mid-COMPILE, which truncates `.next` artifacts. Routes that
 *     exist as files (`/settings/whatsapp`, `/team`, `/organization/*`) start
 *     answering 404, which reads exactly like a routing regression.
 *   - A full run reported **91 failures**. Every one was environmental. Run
 *     spec-by-spec on a fresh `.next`, the same specs were 20/20, 31/31, 20/20,
 *     28/28.
 *
 * A gate that reports 91 phantom failures is worse than no gate: it trains
 * people to re-run until green, which is how a real failure gets waved through.
 *
 * WHAT THIS DOES. Caps the dev servers' heaps so V8 collects instead of
 * ballooning, runs the suite in chunks, and restarts the stack between chunks so
 * leaked memory is reclaimed. Slower, but it completes — and a gate that
 * completes is worth more than one that lies.
 *
 *   node scripts/e2e-batched.mjs              # all batches
 *   node scripts/e2e-batched.mjs --fresh      # rm -rf apps/web/.next first
 *   node scripts/e2e-batched.mjs --only 3     # one batch, by index
 *
 * On a machine with headroom, prefer plain `pnpm test:e2e` — this is a
 * workaround for a constraint, not the preferred path.
 */
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";

/** Grouped so each chunk's peak memory stays inside a constrained box, and so a
 *  chunk that dies costs one group rather than the whole run. */
const BATCHES = [
  ["tests/e2e/launch-smoke.spec.ts", "tests/e2e/predeploy.spec.ts", "tests/e2e/section-chrome.spec.ts"],
  ["tests/e2e/auth-recovery.spec.ts", "tests/e2e/workspace-isolation.spec.ts", "tests/e2e/workspace-switch.spec.ts"],
  ["tests/e2e/inbox-views.spec.ts", "tests/e2e/inbox-multi-account.spec.ts", "tests/e2e/message-flags.spec.ts"],
  ["tests/e2e/availability-sweeper.spec.ts", "tests/e2e/availability-work-hours.spec.ts", "tests/e2e/meta-ui"],
  ["tests/e2e/calls", "tests/e2e/platform", "tests/e2e/contacts-transfer"],
  ["tests/e2e/team-chat", "tests/e2e/webchatwidget"],
  ["tests/e2e/workflows-events"],
  ["tests/e2e/post-audit-fixes"],
  [
    "tests/e2e/contacts-segments.spec.ts",
    "tests/e2e/contact-select-fields.spec.ts",
    "tests/e2e/reports-team.spec.ts",
  ],
  // Two real sessions at once — its own batch because it holds a SECOND logged-in
  // browser context for the whole run, and one of its cases deliberately takes
  // the network offline.
  ["tests/e2e/realtime-convergence.spec.ts"],
];

/**
 * Every root spec `playwright.config.ts` would run must appear in a batch.
 *
 * This is the gate's own honesty check. The batches are a hand-written list, and
 * three specs had silently fallen off it — `contacts-segments` (the e2e for the
 * newest feature), `contact-select-fields` and `reports-team`. A run reported
 * green while never executing them, which is the same failure mode this file's
 * header rails against: a gate you cannot trust is worse than no gate, because
 * it launders an untested change as a verified one. (Audit 2026-08-19.)
 *
 * Directory suites (`tests/e2e/calls`, …) are listed as directories, so a spec
 * added inside one is covered automatically; only ROOT specs need registering.
 * `meta-channels` is deliberately absent — it runs under its own config via
 * `pnpm test:e2e:meta`, as `playwright.config.ts`'s `testIgnore` records.
 */
function assertEveryRootSpecBatched() {
  const listed = new Set(BATCHES.flat());
  const missing = readdirSync("tests/e2e")
    .filter((f) => f.endsWith(".spec.ts"))
    .map((f) => `tests/e2e/${f}`)
    .filter((p) => !listed.has(p));
  if (missing.length > 0) {
    console.error(
      `✖ e2e-batched: ${missing.length} root spec(s) are not in any batch, so this ` +
        `run would report green without executing them:\n  ${missing.join("\n  ")}\n` +
        `Add each to a BATCHES group (pick one whose peak memory has headroom).`,
    );
    process.exit(1);
  }
}

/**
 * Routes warmed before each batch. Next dev compiles on FIRST VISIT, and a cold
 * compile is not fast: measured warm, every route below answers in under 1.2 s
 * except `/reports`, which took **24.5 s** cold. Navigation waits of 10–20 s in
 * the specs are budgeted for a warm server, so without this the suite fails on
 * compile latency and blames the product.
 */
const WARM = [
  "/", "/login", "/inbox", "/contacts", "/broadcasts", "/templates", "/workflows",
  "/team", "/flags", "/settings", "/settings/whatsapp", "/settings/channels",
  "/settings/tickets", "/settings/members", "/settings/tags", "/settings/stages",
  "/settings/integrations", "/account", "/tickets", "/reports",
  "/organization/members", "/organization/workspaces",
];

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const API = process.env.E2E_API_URL ?? "http://127.0.0.1:4000";
const args = process.argv.slice(2);
const only = args.includes("--only") ? Number(args[args.indexOf("--only") + 1]) : null;

const sh = (cmd, opts = {}) => spawnSync("bash", ["-lc", cmd], { stdio: "ignore", ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stopStack() {
  for (const p of ["next-server", "turbo run dev", "@swc-node/register ./src/main.ts"]) {
    sh(`pkill -f ${JSON.stringify(p)}`);
  }
}

async function up(url, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = sh(`curl -s -o /dev/null -w '%{http_code}' -m 5 ${JSON.stringify(url)}`, {
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (String(r.stdout ?? "").trim() === "200") return true;
    await sleep(2000);
  }
  return false;
}

async function startStack() {
  spawn("pnpm", ["dev"], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      // The web server is the one that gets reaped, so it gets the ceiling.
      // Under a cap V8 collects; without one it grows until the kernel kills it.
      NODE_OPTIONS: "--max-old-space-size=1400",
      CALLS_SKIP_PREFLIGHT: "0", // or the calls specs silently skip their gates
    },
  }).unref();
  return (await up(`${API}/health`, 240_000)) && (await up(`${BASE}/login`, 240_000));
}

assertEveryRootSpecBatched();

const results = [];
const batches = only === null ? BATCHES.map((b, i) => [i, b]) : [[only, BATCHES[only]]];

for (const [i, specs] of batches) {
  if (!specs) continue;
  stopStack();
  await sleep(4000);
  if (i === batches[0][0] && args.includes("--fresh")) {
    rmSync("apps/web/.next", { recursive: true, force: true });
    console.log("cleared apps/web/.next");
  }
  if (!(await startStack())) {
    results.push({ i, ok: false, note: "stack failed to come up" });
    console.error(`✖ batch ${i}: stack failed to come up`);
    continue;
  }
  for (const p of WARM) sh(`curl -s -o /dev/null -m 300 ${JSON.stringify(BASE + p)}`);

  const r = spawnSync(
    "bash",
    ["-lc", `E2E_BASE_URL=${JSON.stringify(BASE)} CALLS_SKIP_PREFLIGHT=0 pnpm exec playwright test ${specs.join(" ")}`],
    { stdio: "inherit" },
  );
  results.push({ i, ok: r.status === 0, specs });
  console.log(`${r.status === 0 ? "✓" : "✖"} batch ${i} — ${specs.join(" ")}`);
}
stopStack();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} batches passed`);
if (failed.length) {
  console.error(
    `\n  Before treating these as product defects, check the environment FIRST —\n` +
      `  that ordering is the whole reason this script exists:\n` +
      `    1. are Postgres and Redis still up?  (they stopped mid-run once)\n` +
      `    2. did the web server get OOM-killed? (exit 137 in its output)\n` +
      `    3. re-run the failing specs ALONE with --fresh; a truncated .next\n` +
      `       makes routes that exist answer 404.\n`,
  );
  process.exit(1);
}
