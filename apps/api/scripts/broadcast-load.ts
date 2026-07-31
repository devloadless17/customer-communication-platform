/**
 * WhatsApp broadcast-pipeline load harness — materialize → send → statuses →
 * edge cases, all through the REAL product code paths (no reimplementation).
 *
 *   NODE_OPTIONS="--conditions=react-server" pnpm --filter @ccp/api exec tsx \
 *     scripts/broadcast-load.ts <recipients> [--phase=all|materialize|send|statuses|edges]
 *
 * (`--conditions=react-server` is how the api runtime itself resolves the
 * `server-only` guard in lib/crypto/envelope.ts to a no-op — see apps/api
 * package.json `dev`/`start`; without it the runner's import chain refuses to
 * load under plain Node.)
 *
 * The product claim is "a 100k template campaign runs in-process on the VPS,
 * keyset-paged, paced to the number's Meta tier, exactly-once per recipient".
 * That claim is only real if it has been MEASURED (CLAUDE.md §15-16), so this
 * seeds a throwaway workspace (contacts + portfolio/WABA/connection at the
 * highest tier: TIER_UNLIMITED, throughput HIGH) and runs, with peak RSS +
 * heap sampled throughout:
 *
 *   1. MATERIALIZE — a Broadcast row staged exactly as the create path stages
 *      a large audience (status `materializing`, recipients on the row), then
 *      the real `materializeBroadcast()` (the BullMQ worker's body, called
 *      directly). Asserts recipient count == N and bounded heap.
 *   2. SEND — global fetch stubbed (every Graph POST answers 200 with a
 *      wamid, like test/bsuid-send-routing.spec.ts), then the real
 *      `startBroadcast()` runner over the materialized broadcast. Asserts
 *      sent == N, zero stuck recipients, zero duplicate accepted sends, flat
 *      heap (the keyset-paging claim).
 *   3. STATUSES — N `delivered` then N `read` status webhooks, 1000 per body
 *      (Meta's batch cap), through the real `metaProvider.parseWebhook` →
 *      `groupEventsByInboundAccount` → `ingestEvents` path. Asserts every
 *      BroadcastRecipient.deliveryState converges to `read` and the campaign
 *      report's funnel agrees.
 *   4. EDGES (smaller N) — (a) shutdown-pause mid-run + resume, (b) a 130429
 *      rate-limit storm, (c) an abuse warning (613/2018338) whose pause must
 *      survive every automatic resume path, (d) a kill/restart with a
 *      synthesized crash-window OutboundSendAttempt (the ledger must
 *      reconcile, not re-send). Each asserts exactly-once delivery via the
 *      stub's accepted-send ledger.
 *
 * RUN IT UNDER A HARD HEAP CAP — this is the part that actually proves the
 * paging claims:
 *
 *   NODE_OPTIONS="--max-old-space-size=512 --conditions=react-server" \
 *     pnpm --filter @ccp/api exec tsx scripts/broadcast-load.ts 250000 --phase=all
 *
 * Under a cap, a genuinely keyset-paged runner completes (GC reclaims each
 * page); one that loads the audience whole OOMs. The cap is the test.
 *
 * MEASURED 2026-07-31, 1,000 recipients, --max-old-space-size=512 (dev box,
 * local Postgres + Redis, stubbed Meta):
 *
 *   materialize   1,000 rows      0.1s   ~12,000 rows/s    peak heap 108 MB
 *   send          1,000 sends     3.3s     ~300 send/s     peak heap 126 MB
 *                 (900/s HIGH bucket; pipeline overhead ~688 ms/send/lane
 *                  across 225 lanes ⇒ measured ceiling ~327 sends/s — the
 *                  in-process DB+event cost, all under the 900/s tier target)
 *   statuses      2,000 statuses  2.6s     ~765 status/s   peak heap 132 MB
 *                 (+0.0s convergence wait; report funnel read == 1,000)
 *   edges (1,000 recipients @ BROADCAST_RATE_HIGH=120, 200 for abuse):
 *     pause/resume    runner stopped in 0.4s after signalShutdown; resume
 *                     completed; 1,000 accepted sends, 0 duplicates
 *     429 storm 10s   parked `rate_limited` (sustained-limit path), resumed
 *                     clean; 1,000 accepted, 0 duplicates, 0 failed
 *     abuse warning   paused on FIRST hit, reason `abuse_warning`; survived
 *                     resumePausedBroadcasts + resumePausedBroadcastsForTeam;
 *                     only resumeBroadcastManually lifted it (188 sent + 12
 *                     failed = 200, 0 duplicates)
 *     kill/restart    paused mid-flight, crash-window attempt synthesized,
 *                     resume reconciled it WITHOUT a Graph call: 1,000 sent,
 *                     999 accepted POSTs (victim reused wamid), 0 duplicates
 *
 * Projected 1M-recipient wall time from Meta's real tiers (pacing-bound; the
 * measured in-process ceiling above must exceed the tier rate to hold it):
 *   80/s STANDARD ≈ 3.5h · 1000/s HIGH ≈ 17min (bucket targets 900/s; the
 *   measured ~327/s DB+event ceiling is the binding limit on THIS dev box —
 *   see the send-phase notes) · 20/s coexistence ≈ 13.9h.
 *
 * Everything is scoped to a throwaway workspace `load-broadcast-<uuid>` and
 * deleted in a finally (one cascade). Redis keys touched: the runner's own
 * `wa-send-rate:<phoneNumberId>` token bucket (unique per run, 60s TTL) and —
 * only if a status ever races its Message row — `ccp:parked-status:<ws>|…`
 * (short TTL). Nothing is flushed.
 */

import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { NormalizedEvent } from "@ccp/shared/providers/types";

import { config as loadEnv } from "dotenv";

loadEnv({ path: resolve(__dirname, "../../../.env") });

// The dev .env may carry DEBUG_META_WIRE=1 — that logger prints every Graph
// request/response body, which at 250k sends is gigabytes of stdout measuring
// the terminal, not the pipeline. Must be forced off BEFORE the provider
// modules load (the flag is read at module init).
process.env.DEBUG_META_WIRE = "0";

const { db, setSharedDb } = require("../src/lib/db") as typeof import("../src/lib/db");
const { PrismaPg } = require("@prisma/adapter-pg") as typeof import("@prisma/adapter-pg");
const { PrismaClient } = require("@prisma/client") as typeof import("@prisma/client");
const { Pool } = require("pg") as typeof import("pg");

// Mirror DbService's pool + tx budget: the send phase runs up to 225 lanes and
// the model script's default 10-connection pool would starve them into
// connection-acquire timeouts that measure the harness, not the pipeline.
setSharedDb(
  new PrismaClient({
    adapter: new PrismaPg(
      new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 50,
        idleTimeoutMillis: 30_000,
        statement_timeout: 30_000,
        connectionTimeoutMillis: 5_000,
      }),
    ),
    transactionOptions: { timeout: 15_000, maxWait: 5_000 },
  }) as never,
);

const { materializeBroadcast } =
  require("../src/lib/broadcasts/materialize-worker") as typeof import("../src/lib/broadcasts/materialize-worker");
const runner = require("../src/lib/broadcast-runner") as typeof import("../src/lib/broadcast-runner");
const { resolveSendRate } =
  require("../src/lib/broadcasts/send-rate-limiter") as typeof import("../src/lib/broadcasts/send-rate-limiter");
const { checkBroadcastEligibility } =
  require("../src/lib/providers/meta-health") as typeof import("../src/lib/providers/meta-health");
const { metaProvider } =
  require("../src/lib/providers/meta") as typeof import("../src/lib/providers/meta");
const { ingestEvents } =
  require("../src/lib/providers/ingest") as typeof import("../src/lib/providers/ingest");
const { groupEventsByInboundAccount } =
  require("../src/lib/providers/inbound-accounts") as typeof import("../src/lib/providers/inbound-accounts");
const { encryptSecret } =
  require("../src/lib/crypto/envelope") as typeof import("../src/lib/crypto/envelope");
const { getBroadcastReport } =
  require("../src/lib/broadcast-report") as typeof import("../src/lib/broadcast-report");
const { getRedisConnection } =
  require("../src/lib/workflows/queue") as typeof import("../src/lib/workflows/queue");

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const N = Number(argv.find((a) => !a.startsWith("--")) ?? 1_000);
const PHASE = (argv.find((a) => a.startsWith("--phase="))?.slice("--phase=".length) ??
  "all") as "all" | "materialize" | "send" | "statuses" | "edges";
if (!["all", "materialize", "send", "statuses", "edges"].includes(PHASE)) {
  console.error(`unknown --phase=${PHASE}`);
  process.exit(1);
}
if (!Number.isFinite(N) || N < 10) {
  console.error(`recipients must be ≥ 10, got ${N}`);
  process.exit(1);
}

/** Edge scenarios run at a bounded size — their point is behaviour, not scale. */
const EDGE_N = Math.min(N, 5_000);
/** The abuse-warning scenario needs only enough recipients to have lanes in flight. */
const ABUSE_N = Math.min(EDGE_N, 200);

/**
 * Peak-heap budget per phase. The send phase's real footprint is lanes ×
 * (one recipient row + its in-flight DB work) + a 500-row page — measured
 * 126 MB at N=1k; a regression to "load all recipients" scales with N and
 * trips this immediately at large N.
 */
const HEAP_CEILING_MB = 420;

// ---------------------------------------------------------------------------
// Sampling / timing (same shape as contact-transfer-load.ts)
// ---------------------------------------------------------------------------

let peakHeapMb = 0;
let peakRssMb = 0;
let sampler: NodeJS.Timeout | null = null;

function startSampling(): void {
  peakHeapMb = 0;
  peakRssMb = 0;
  const sample = (): void => {
    const m = process.memoryUsage();
    peakHeapMb = Math.max(peakHeapMb, m.heapUsed / 1048576);
    peakRssMb = Math.max(peakRssMb, m.rss / 1048576);
  };
  sample(); // one-shot so a sub-100ms phase still reports a real figure
  sampler = setInterval(sample, 100);
  sampler.unref();
}

function stopSampling(): { heap: number; rss: number } {
  if (sampler) clearInterval(sampler);
  sampler = null;
  return { heap: Math.round(peakHeapMb), rss: Math.round(peakRssMb) };
}

let failures = 0;
function check(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}`);
  }
}

interface ResultRow {
  phase: string;
  wallS: number;
  rate: string;
  heapMb: number;
  rssMb: number;
  note: string;
}
const results: ResultRow[] = [];

async function timed<T>(
  label: string,
  fn: () => Promise<T>,
  rateOf?: (out: T, secs: number) => string,
  note = "",
): Promise<T> {
  startSampling();
  const t0 = Date.now();
  const out = await fn();
  const secs = (Date.now() - t0) / 1000;
  const { heap, rss } = stopSampling();
  const rate = rateOf ? rateOf(out, secs) : "";
  console.log(`\n${label}`);
  console.log(
    `  wall ${secs.toFixed(1)}s · ${rate ? `${rate} · ` : ""}peak heap ${heap} MB · peak rss ${rss} MB`,
  );
  check(heap <= HEAP_CEILING_MB, `${label}: peak heap ${heap} MB within ${HEAP_CEILING_MB} MB budget`);
  results.push({ phase: label, wallS: secs, rate, heapMb: heap, rssMb: rss, note });
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Graph fetch stub — the bsuid-send-routing.spec.ts pattern, sized for load:
// bodies are not retained; the stub keeps an accepted-send ledger instead
// (count per destination) so exactly-once is assertable at 250k without
// buffering 250k request bodies.
// ---------------------------------------------------------------------------

interface StubResponsePlan {
  status: number;
  body: unknown;
}
interface FetchStub {
  /** Total POSTs seen since last reset. */
  calls: number;
  /** POSTs answered 200-with-wamid since last reset. */
  accepted: number;
  /** Destinations accepted MORE than once since last reset (double-send!). */
  duplicateAccepts: number;
  /** Per-call script; return undefined for the default 200+wamid. */
  script: ((n: number, body: Record<string, unknown>) => StubResponsePlan | undefined) | null;
  /** Artificial Meta latency per call. */
  delayMs: number;
  reset(): void;
}

const realFetch = globalThis.fetch;
let wamidSeq = 0;

function installFetchStub(): FetchStub {
  const acceptedPerTo = new Map<string, number>();
  const stub: FetchStub = {
    calls: 0,
    accepted: 0,
    duplicateAccepts: 0,
    script: null,
    delayMs: 0,
    reset() {
      this.calls = 0;
      this.accepted = 0;
      this.duplicateAccepts = 0;
      this.script = null;
      this.delayMs = 0;
      acceptedPerTo.clear();
    },
  };
  const impl = async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    if (!url.includes("graph.facebook.com")) {
      throw new Error(`fetch stub: unexpected non-Graph URL ${url}`);
    }
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    const n = ++stub.calls;
    if (stub.delayMs > 0) await sleep(stub.delayMs);
    const plan = stub.script?.(n, body) ?? {
      status: 200,
      body: { messages: [{ id: `wamid.load.${++wamidSeq}` }] },
    };
    if (plan.status === 200) {
      stub.accepted += 1;
      const to = typeof body.to === "string" ? body.to : String(body.recipient ?? "?");
      const prev = acceptedPerTo.get(to) ?? 0;
      if (prev === 1) stub.duplicateAccepts += 1;
      acceptedPerTo.set(to, prev + 1);
    }
    return new Response(JSON.stringify(plan.body), {
      status: plan.status,
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.fetch = impl as typeof fetch;
  return stub;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const RUN_TAG = randomUUID().slice(0, 8);
const PHONE_NUMBER_ID = `loadpn${RUN_TAG}`;
const WABA_EXTERNAL_ID = `loadwaba${RUN_TAG}`;
const DISPLAY_PHONE = "+1 555-000-0000";
const TEMPLATE_NAME = "load_order_ready";
const TEMPLATE_BODY = "Hello {{1}}, your order is ready for pickup.";

interface Fixture {
  organizationId: string;
  workspaceId: string;
  connectionId: string;
  templateId: string;
  contactIds: string[];
}

async function seedFixture(): Promise<Fixture> {
  const org = await db.organization.create({
    data: { name: `load-broadcast-org-${RUN_TAG}` },
    select: { id: true },
  });
  const ws = await db.workspace.create({
    data: { name: `load-broadcast-${RUN_TAG}`, organizationId: org.id },
    select: { id: true },
  });
  const workspaceId = ws.id;

  // The exact rows getWhatsappHealth() joins for the runner's pacing decision:
  // tier + cap live on the PORTFOLIO, throughput/quality/coexistence on the
  // CONNECTION, reached through the WABA (meta-health.ts).
  const portfolio = await db.whatsappPortfolio.create({
    data: {
      workspaceId,
      externalPortfolioId: `loadpf${RUN_TAG}`,
      messagingTier: "TIER_UNLIMITED",
      messagingDailyCap: null,
      verificationStatus: "verified",
      source: "graph_discovered",
      messagingHealthUpdatedAt: new Date(),
    },
    select: { id: true },
  });
  const waba = await db.whatsappBusinessAccount.create({
    data: {
      workspaceId,
      externalWabaId: WABA_EXTERNAL_ID,
      portfolioId: portfolio.id,
      label: "load harness WABA",
    },
    select: { id: true },
  });
  const conn = await db.channelConnection.create({
    data: {
      workspaceId,
      channel: "whatsapp",
      externalAccountId: PHONE_NUMBER_ID,
      label: "load harness number",
      isDefault: true,
      isActive: true,
      wabaAccountId: waba.id,
      qualityRating: "GREEN",
      throughputLevel: "HIGH",
      isOnBusinessApp: false,
      messagingHealthUpdatedAt: new Date(),
      config: { phoneNumberId: PHONE_NUMBER_ID, displayPhoneNumber: DISPLAY_PHONE },
      // Envelope-encrypted like the settings page writes it (ENCRYPTION_KEY).
      secrets: { accessToken: encryptSecret(`load-token-${RUN_TAG}`) },
    },
    select: { id: true },
  });
  const template = await db.messageTemplate.create({
    data: {
      workspaceId,
      wabaAccountId: waba.id,
      externalId: `loadtpl${RUN_TAG}`,
      name: TEMPLATE_NAME,
      language: "en_US",
      // UTILITY so the runner's marketing-opt-out fire-time re-check is the
      // no-op it would be for this category (the create-path suppression scan
      // is out of scope here — the harness stages the audience directly).
      category: "utility",
      status: "approved",
      bodyText: TEMPLATE_BODY,
      components: [{ type: "BODY", text: TEMPLATE_BODY }] as unknown as Prisma.InputJsonValue,
      parameterFormat: "positional",
    },
    select: { id: true },
  });

  // Seed contacts with chunked createMany — the fixture must fit the same
  // heap budget as the thing being measured (see contact-transfer-load.ts).
  const CHUNK = 1_000;
  const t0 = Date.now();
  for (let i = 0; i < N; i += CHUNK) {
    const rows = [];
    for (let j = i; j < Math.min(i + CHUNK, N); j++) {
      rows.push({
        workspaceId,
        identityChannel: "whatsapp" as const,
        // Deterministic, valid E.164-able US numbers (unique per contact).
        phoneNumber: `1555${String(j).padStart(7, "0")}`,
        name: `Load Contact ${j}`,
      });
    }
    await db.contact.createMany({ data: rows, skipDuplicates: true });
    process.stdout.write(`\rseeding contacts ${Math.min(i + CHUNK, N).toLocaleString()}/${N.toLocaleString()}`);
  }
  console.log(`\rseeded ${N.toLocaleString()} contacts in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Resolve the audience ids keyset-paged (ids only), the same snapshot the
  // create path stages on the row for the materialize worker.
  const contactIds: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await db.contact.findMany({
      where: { workspaceId, deletedAt: null },
      select: { id: true },
      orderBy: { id: "asc" },
      take: 10_000,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;
    for (const row of page) contactIds.push(row.id);
  }

  return {
    organizationId: org.id,
    workspaceId,
    connectionId: conn.id,
    templateId: template.id,
    contactIds,
  };
}

/**
 * Create a Broadcast row exactly as `BroadcastsService.create()` stages a
 * LARGE audience: status `materializing`, resolved recipients on the row.
 * (The harness bypasses the HTTP create — audience resolution, suppression
 * and the eligibility gate are create-path concerns; the gate is exercised
 * explicitly in the materialize phase below.)
 */
async function createStagedBroadcast(
  fx: Fixture,
  name: string,
  ids: readonly string[],
): Promise<string> {
  const row = await db.broadcast.create({
    data: {
      workspaceId: fx.workspaceId,
      name,
      kind: "template",
      targetMode: "contact",
      channel: "whatsapp",
      channelConnectionId: fx.connectionId,
      templateId: fx.templateId,
      templateName: TEMPLATE_NAME,
      templateLanguage: "en_US",
      templateCategory: "utility",
      bodyText: null,
      variables: { body: ["friend"] } as unknown as Prisma.InputJsonValue,
      audienceMode: "all",
      totalCount: ids.length,
      status: "materializing",
      materializeRecipients: ids.map((contactId) => ({ contactId })) as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return row.id;
}

interface BroadcastSnapshot {
  status: string;
  sentCount: number;
  failedCount: number;
  totalCount: number;
  pausedReason: string | null;
  lastError: string | null;
}

async function readBroadcast(id: string): Promise<BroadcastSnapshot> {
  return db.broadcast.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      sentCount: true,
      failedCount: true,
      totalCount: true,
      pausedReason: true,
      lastError: true,
    },
  });
}

/** Wait until the broadcast leaves the active states (or times out). */
async function settleBroadcast(id: string, timeoutMs: number): Promise<BroadcastSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Await the runner's own in-flight promise so "settled" means the lanes
    // actually drained, not just that the row flipped.
    await Promise.allSettled(runner.getInFlightRunPromises());
    const row = await readBroadcast(id);
    if (["completed", "failed", "canceled", "paused"].includes(row.status)) return row;
    if (Date.now() > deadline) {
      throw new Error(`broadcast ${id} did not settle in ${timeoutMs}ms (status=${row.status})`);
    }
    await sleep(200);
  }
}

async function pollUntil(
  label: string,
  timeoutMs: number,
  fn: () => Promise<boolean>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) {
      console.error(`  ✗ timed out waiting for: ${label}`);
      return false;
    }
    await sleep(150);
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — materialize
// ---------------------------------------------------------------------------

async function phaseMaterialize(fx: Fixture, measured: boolean): Promise<string> {
  // The real create-path eligibility gate, against the seeded tier: proves
  // the portfolio/WABA/connection fixture satisfies the gate the composer and
  // create() consult (TIER_UNLIMITED ⇒ cap null ⇒ allowed).
  const gate = await checkBroadcastEligibility(fx.workspaceId, N, fx.contactIds, fx.connectionId);
  if (measured) check(gate.allowed, `eligibility gate allows N=${N.toLocaleString()} on ${gate.messagingTier}`);

  const broadcastId = await createStagedBroadcast(fx, `load-main-${RUN_TAG}`, fx.contactIds);

  // Block the finalize's automatic startBroadcast() hand-off so the send is a
  // separately measured phase. signalShutdown() is the runner's own refusal
  // gate (the SIGTERM path); reset before the send phase.
  runner.signalShutdown();
  const run = () => materializeBroadcast(broadcastId);
  if (measured) {
    await timed(
      `materialize ${N.toLocaleString()} recipients`,
      run,
      (_, secs) => `${Math.round(N / Math.max(secs, 0.001)).toLocaleString()} rows/s`,
    );
  } else {
    await run();
  }

  const inserted = await db.broadcastRecipient.count({ where: { broadcastId } });
  const row = await readBroadcast(broadcastId);
  if (measured) {
    check(inserted === N, `materialized recipient rows == N (${inserted.toLocaleString()})`);
    check(row.status === "queued", `broadcast flipped materializing → queued (got ${row.status})`);
    check(row.totalCount === N, `authoritative totalCount == N (${row.totalCount.toLocaleString()})`);
  }
  return broadcastId;
}

// ---------------------------------------------------------------------------
// Phase 2 — send
// ---------------------------------------------------------------------------

async function phaseSend(broadcastId: string, stub: FetchStub, measured: boolean): Promise<void> {
  stub.reset();
  runner.resetShutdownFlag();

  const run = async () => {
    await runner.startBroadcast(broadcastId);
    return settleBroadcast(broadcastId, Math.max(120_000, N * 50));
  };
  const targetRate = resolveSendRate("HIGH", false);
  // The runner clamps its lane pool to the first page / queue depth.
  const lanes = Math.min(runner.lanesForRate(targetRate), N);
  let row: BroadcastSnapshot;
  if (measured) {
    row = await timed(
      `send ${N.toLocaleString()} recipients (stubbed Meta)`,
      run,
      (_, secs) => `${Math.round(N / Math.max(secs, 0.001)).toLocaleString()} sends/s achieved (bucket target ${targetRate}/s, ${lanes} lanes)`,
    );
  } else {
    row = await run();
  }

  const sent = await db.broadcastRecipient.count({ where: { broadcastId, status: "sent" } });
  const queued = await db.broadcastRecipient.count({ where: { broadcastId, status: "queued" } });
  if (measured) {
    check(row.status === "completed", `broadcast completed (got ${row.status}${row.lastError ? ` — ${row.lastError}` : ""})`);
    check(row.sentCount === N && row.failedCount === 0, `counters converge: sent ${row.sentCount.toLocaleString()} / failed ${row.failedCount}`);
    check(sent === N && queued === 0, `recipient rows: sent ${sent.toLocaleString()}, stuck-queued ${queued}`);
    check(stub.accepted === N, `Graph accepted exactly N sends (${stub.accepted.toLocaleString()})`);
    check(stub.duplicateAccepts === 0, `no destination accepted twice (duplicates=${stub.duplicateAccepts})`);

    // Pipeline overhead per send: how long ONE lane spends on one recipient
    // (DB writes + state machine + event publish), the number that must stay
    // under the tier interval for the pacing to be the binding limit. Timed
    // from the row's own startedAt→completedAt so the harness's settle-poll
    // granularity doesn't pollute the figure.
    const stamps = await db.broadcast.findUniqueOrThrow({
      where: { id: broadcastId },
      select: { startedAt: true, completedAt: true },
    });
    const runSecs =
      stamps.startedAt && stamps.completedAt
        ? (stamps.completedAt.getTime() - stamps.startedAt.getTime()) / 1000
        : 0;
    const perLaneMs = (runSecs * 1000 * lanes) / N;
    const ceiling = Math.round(lanes / (perLaneMs / 1000));
    console.log(
      `  runner wall ${runSecs.toFixed(1)}s (row stamps) · pipeline overhead ≈ ${perLaneMs.toFixed(0)} ms/send/lane ` +
        `across ${lanes} lanes ⇒ in-process ceiling ≈ ${ceiling.toLocaleString()} sends/s (tier target ${targetRate}/s)`,
    );
    console.log(
      `  projected 1M-recipient wall (pacing-bound): STANDARD 80/s ≈ ${(1_000_000 / 80 / 3600).toFixed(1)}h · ` +
        `HIGH 1000/s ≈ ${(1_000_000 / 1000 / 60).toFixed(0)}min · coexistence 20/s ≈ ${(1_000_000 / 20 / 3600).toFixed(1)}h`,
    );
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — statuses
// ---------------------------------------------------------------------------

/** Feed one full pass of `status` webhooks for every sent recipient, 1000 per
 *  body (Meta's documented batch cap), through parse → group → ingest. */
async function feedStatuses(
  fx: Fixture,
  broadcastId: string,
  status: "delivered" | "read",
): Promise<number> {
  let cursor: string | undefined;
  let fed = 0;
  const ts = String(Math.floor(Date.now() / 1000));
  for (;;) {
    const page = await db.broadcastRecipient.findMany({
      where: { broadcastId, status: "sent", externalId: { not: null } },
      select: { id: true, externalId: true },
      orderBy: { id: "asc" },
      take: 1_000,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA_EXTERNAL_ID,
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: DISPLAY_PHONE,
                  phone_number_id: PHONE_NUMBER_ID,
                },
                statuses: page.map((r) => ({ id: r.externalId!, status, timestamp: ts })),
              },
            },
          ],
        },
      ],
    };
    // The exact webhook-route body: parse per-event, partition per receiving
    // account, ingest sequentially per group.
    const events: NormalizedEvent[] = metaProvider.parseWebhook(body);
    const grouped = await groupEventsByInboundAccount(fx.workspaceId, "whatsapp", events);
    for (const group of grouped.groups) {
      await ingestEvents(fx.workspaceId, "whatsapp", group.events, group.channelConnectionId);
    }
    fed += page.length;
  }
  return fed;
}

async function phaseStatuses(fx: Fixture, broadcastId: string, measured: boolean): Promise<void> {
  const run = async () => {
    const delivered = await feedStatuses(fx, broadcastId, "delivered");
    const read = await feedStatuses(fx, broadcastId, "read");
    return delivered + read;
  };
  const total = measured
    ? await timed(
        `statuses ${(2 * N).toLocaleString()} webhooks (delivered + read)`,
        run,
        (out, secs) => `${Math.round(out / Math.max(secs, 0.001)).toLocaleString()} statuses/s`,
      )
    : await run();

  // The recipient-ladder propagation inside ingest is fire-and-forget by
  // design; convergence is the assertion, so wait (bounded) for it.
  const t0 = Date.now();
  const converged = await pollUntil("deliveryState == read for all N", 60_000, async () => {
    const read = await db.broadcastRecipient.count({ where: { broadcastId, deliveryState: "read" } });
    return read === N;
  });
  const waitS = ((Date.now() - t0) / 1000).toFixed(1);

  if (measured) {
    check(total === 2 * N, `fed ${total.toLocaleString()} statuses (expected ${(2 * N).toLocaleString()})`);
    check(converged, `every BroadcastRecipient.deliveryState converged to read (+${waitS}s settle)`);
    const readMsgs = await db.message.count({
      where: { workspaceId: fx.workspaceId, broadcastId, status: "read" },
    });
    check(readMsgs === N, `Message.status == read for all N (${readMsgs.toLocaleString()})`);
    const report = await getBroadcastReport(fx.workspaceId, broadcastId);
    check(
      report?.funnel.read === N && report.funnel.reached === N,
      `campaign report funnel agrees (read ${report?.funnel.read?.toLocaleString() ?? "?"}, reached ${report?.funnel.reached?.toLocaleString() ?? "?"})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Phase 4 — edges
// ---------------------------------------------------------------------------

async function edgePauseResume(fx: Fixture, stub: FetchStub): Promise<void> {
  console.log(`\nedge (a): shutdown-pause mid-run, then resume — ${EDGE_N.toLocaleString()} recipients`);
  const ids = fx.contactIds.slice(0, EDGE_N);
  const broadcastId = await createStagedBroadcast(fx, `load-edge-pause-${RUN_TAG}`, ids);
  runner.signalShutdown();
  await materializeBroadcast(broadcastId);

  stub.reset();
  stub.delayMs = 20;
  runner.resetShutdownFlag();
  await runner.startBroadcast(broadcastId);

  const midway = await pollUntil("≥15% sent", 60_000, async () => {
    const row = await readBroadcast(broadcastId);
    return row.sentCount >= Math.max(20, Math.floor(EDGE_N * 0.15));
  });
  check(midway, "run reached mid-flight before the pause");

  const t0 = Date.now();
  runner.signalShutdown();
  await Promise.allSettled(runner.getInFlightRunPromises());
  const stopS = (Date.now() - t0) / 1000;
  const paused = await readBroadcast(broadcastId);
  check(stopS < 15, `runner stopped promptly after signalShutdown (${stopS.toFixed(1)}s)`);
  check(
    paused.status === "paused" && paused.pausedReason === "shutdown",
    `parked paused/shutdown mid-run (got ${paused.status}/${paused.pausedReason ?? "-"}, sent ${paused.sentCount})`,
  );
  check(stub.duplicateAccepts === 0, "no duplicate accepted send before the pause");

  runner.resetShutdownFlag();
  await runner.resumePausedBroadcasts({ workspaceId: fx.workspaceId, label: "load-harness" });
  const done = await settleBroadcast(broadcastId, 240_000);
  check(done.status === "completed", `resumed to completion (got ${done.status})`);
  check(done.sentCount === EDGE_N && done.failedCount === 0, `sent ${done.sentCount.toLocaleString()} / failed ${done.failedCount}`);
  check(stub.accepted === EDGE_N, `Graph accepted exactly ${EDGE_N.toLocaleString()} sends across pause+resume (${stub.accepted.toLocaleString()})`);
  check(stub.duplicateAccepts === 0, `no recipient double-sent across the resume (duplicates=${stub.duplicateAccepts})`);
}

async function edgeRateLimitStorm(fx: Fixture, stub: FetchStub): Promise<void> {
  console.log(`\nedge (b): 130429 storm (~10s) — ${EDGE_N.toLocaleString()} recipients`);
  const ids = fx.contactIds.slice(0, EDGE_N);
  const broadcastId = await createStagedBroadcast(fx, `load-edge-429-${RUN_TAG}`, ids);
  runner.signalShutdown();
  await materializeBroadcast(broadcastId);

  stub.reset();
  const stormUntil = Date.now() + 10_000;
  stub.script = () =>
    Date.now() < stormUntil
      ? {
          status: 429,
          body: {
            error: {
              message: "(#130429) Rate limit hit: Cloud API message throughput reached",
              type: "OAuthException",
              code: 130429,
            },
          },
        }
      : undefined;
  runner.resetShutdownFlag();
  await runner.startBroadcast(broadcastId);

  // The runner's own responses to a sustained limit: in-lane backoff+retry,
  // the cross-lane 60s pause at a 10-streak, or the `rate_limited` park whose
  // recovery is the drift sweeper's resume. Drive the same resume the sweeper
  // would and require eventual convergence with zero losses/dupes.
  let row = await settleBroadcast(broadcastId, 300_000);
  let resumes = 0;
  while (row.status === "paused" && resumes < 5) {
    check(
      row.pausedReason === "rate_limited",
      `parked with pausedReason=rate_limited (got ${row.pausedReason ?? "-"})`,
    );
    resumes += 1;
    await runner.resumePausedBroadcasts({ workspaceId: fx.workspaceId, label: "load-harness-429" });
    row = await settleBroadcast(broadcastId, 300_000);
  }
  check(row.status === "completed", `converged after the storm (status ${row.status}, ${resumes} resume(s))`);
  check(
    row.sentCount === EDGE_N && row.failedCount === 0,
    `no recipient lost to the storm: sent ${row.sentCount.toLocaleString()} / failed ${row.failedCount}`,
  );
  check(stub.accepted === EDGE_N, `Graph accepted exactly ${EDGE_N.toLocaleString()} (accepted=${stub.accepted.toLocaleString()}, total POSTs ${stub.calls.toLocaleString()})`);
  check(stub.duplicateAccepts === 0, `no double-send through backoff/retry (duplicates=${stub.duplicateAccepts})`);
}

async function edgeAbuseWarning(fx: Fixture, stub: FetchStub): Promise<void> {
  console.log(`\nedge (c): abuse warning 613/2018338 — ${ABUSE_N} recipients`);
  const ids = fx.contactIds.slice(0, ABUSE_N);
  const broadcastId = await createStagedBroadcast(fx, `load-edge-abuse-${RUN_TAG}`, ids);
  runner.signalShutdown();
  await materializeBroadcast(broadcastId);

  stub.reset();
  stub.script = () => ({
    status: 400,
    body: {
      error: {
        message:
          "Warning! You are engaging in behavior that may be considered bothersome or abusive.",
        type: "OAuthException",
        code: 613,
        error_subcode: 2018338,
      },
    },
  });
  runner.resetShutdownFlag();
  await runner.startBroadcast(broadcastId);
  let row = await settleBroadcast(broadcastId, 120_000);
  check(
    row.status === "paused" && row.pausedReason === "abuse_warning",
    `paused immediately with pausedReason=abuse_warning (got ${row.status}/${row.pausedReason ?? "-"})`,
  );
  const failedEarly = row.failedCount;

  // Every AUTOMATIC resume path must skip it…
  await runner.resumePausedBroadcasts({ workspaceId: fx.workspaceId, label: "load-harness-abuse" });
  row = await readBroadcast(broadcastId);
  check(row.status === "paused", "survived resumePausedBroadcasts (the sweeper/boot path)");
  await runner.resumePausedBroadcastsForTeam(fx.workspaceId);
  await Promise.allSettled(runner.getInFlightRunPromises());
  row = await readBroadcast(broadcastId);
  check(
    row.status === "paused" && row.pausedReason === "abuse_warning",
    "survived resumePausedBroadcastsForTeam (the settings-save path)",
  );

  // …and only the explicit operator Resume lifts it.
  stub.script = null;
  const lifted = await runner.resumeBroadcastManually(fx.workspaceId, broadcastId);
  check(lifted, "resumeBroadcastManually accepted the paused row");
  row = await settleBroadcast(broadcastId, 120_000);
  check(row.status === "completed", `completed after the human resume (got ${row.status})`);
  check(
    row.sentCount + row.failedCount === ABUSE_N && row.failedCount >= 1,
    `accounting holds: ${row.sentCount} sent + ${row.failedCount} failed (${failedEarly} failed pre-pause) == ${ABUSE_N}`,
  );
  check(stub.duplicateAccepts === 0, `no double-send around the pause (duplicates=${stub.duplicateAccepts})`);
}

async function edgeKillRestart(fx: Fixture, stub: FetchStub): Promise<void> {
  console.log(`\nedge (d): kill/restart + crash-window ledger — ${EDGE_N.toLocaleString()} recipients`);
  const ids = fx.contactIds.slice(0, EDGE_N);
  const broadcastId = await createStagedBroadcast(fx, `load-edge-crash-${RUN_TAG}`, ids);
  runner.signalShutdown();
  await materializeBroadcast(broadcastId);

  stub.reset();
  stub.delayMs = 15;
  runner.resetShutdownFlag();
  await runner.startBroadcast(broadcastId);
  await pollUntil("≥15% sent before the abort", 60_000, async () => {
    const row = await readBroadcast(broadcastId);
    return row.sentCount >= Math.max(20, Math.floor(EDGE_N * 0.15));
  });
  runner.signalShutdown();
  await Promise.allSettled(runner.getInFlightRunPromises());
  const paused = await readBroadcast(broadcastId);
  check(paused.status === "paused", `aborted mid-flight (status ${paused.status}, sent ${paused.sentCount})`);
  const acceptedBeforeCrash = stub.accepted;

  // Synthesize the exact crash window the OutboundSendAttempt ledger exists
  // for: Meta ACCEPTED a send (attempt completed, wamid recorded) but the
  // process died before the recipient's queued→sent CAS. On resume the claim
  // must take the `reconcile` branch — recipient becomes `sent` with the
  // stored wamid and NO second Graph call.
  const victim = await db.broadcastRecipient.findFirstOrThrow({
    where: { broadcastId, status: "queued" },
    orderBy: { id: "asc" },
    select: { id: true, contactId: true },
  });
  let conversation = await db.conversation.findFirst({
    where: { workspaceId: fx.workspaceId, contactId: victim.contactId },
    select: { id: true },
  });
  conversation ??= await db.conversation.create({
    data: {
      workspaceId: fx.workspaceId,
      contactId: victim.contactId,
      channel: "whatsapp",
      channelConnectionId: fx.connectionId,
      status: "pending",
      lastMessagePreview: "",
    },
    select: { id: true },
  });
  const crashWamid = `wamid.load.crash.${RUN_TAG}`;
  await db.outboundSendAttempt.create({
    data: {
      jobId: `bc-recipient-${victim.id}`,
      workspaceId: fx.workspaceId,
      conversationId: conversation.id,
      completedAt: new Date(),
      externalId: crashWamid,
    },
  });

  runner.resetShutdownFlag();
  await runner.resumePausedBroadcasts({ workspaceId: fx.workspaceId, label: "load-harness-crash" });
  const done = await settleBroadcast(broadcastId, 240_000);
  check(done.status === "completed", `completed after restart (got ${done.status})`);
  check(done.sentCount === EDGE_N && done.failedCount === 0, `sent == N exactly (${done.sentCount.toLocaleString()} / failed ${done.failedCount})`);
  check(
    stub.accepted === EDGE_N - 1,
    `crash-window recipient was reconciled, not re-sent: ${stub.accepted.toLocaleString()} accepted POSTs for ${EDGE_N.toLocaleString()} sends (pre-abort ${acceptedBeforeCrash})`,
  );
  const victimRow = await db.broadcastRecipient.findUniqueOrThrow({
    where: { id: victim.id },
    select: { status: true, externalId: true },
  });
  check(
    victimRow.status === "sent" && victimRow.externalId === crashWamid,
    `victim carries the ledger's wamid (${victimRow.status}/${victimRow.externalId ?? "-"})`,
  );
  check(stub.duplicateAccepts === 0, `no double-send across the restart (duplicates=${stub.duplicateAccepts})`);
}

async function phaseEdges(fx: Fixture, stub: FetchStub): Promise<void> {
  // Slow the tier for the edge scenarios so "mid-run" exists: at the HIGH
  // bucket's 900/s + 900-token burst, 1–5k recipients finish before any pause
  // can land. env knobs are the runner's supported tuning surface; each run
  // re-reads them at claim time.
  const prevHigh = process.env.BROADCAST_RATE_HIGH;
  process.env.BROADCAST_RATE_HIGH = "120";
  try {
    await edgePauseResume(fx, stub);
    await edgeRateLimitStorm(fx, stub);
    await edgeAbuseWarning(fx, stub);
    await edgeKillRestart(fx, stub);
  } finally {
    if (prevHigh === undefined) delete process.env.BROADCAST_RATE_HIGH;
    else process.env.BROADCAST_RATE_HIGH = prevHigh;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    `broadcast load harness · N=${N.toLocaleString()} · phase=${PHASE} · edge N=${EDGE_N.toLocaleString()}`,
  );
  const stub = installFetchStub();
  let fx: Fixture | null = null;
  try {
    fx = await seedFixture();
    console.log(`workspace ${fx.workspaceId} · number ${PHONE_NUMBER_ID} · WABA ${WABA_EXTERNAL_ID}\n`);

    if (PHASE === "edges") {
      await phaseEdges(fx, stub);
    } else {
      const broadcastId = await phaseMaterialize(fx, PHASE === "all" || PHASE === "materialize");
      if (PHASE !== "materialize") {
        await phaseSend(broadcastId, stub, PHASE === "all" || PHASE === "send");
      }
      if (PHASE === "all" || PHASE === "statuses") {
        await phaseStatuses(fx, broadcastId, true);
      }
      if (PHASE === "all") {
        await phaseEdges(fx, stub);
      }
    }

    if (results.length > 0) {
      console.log("\nresults");
      for (const r of results) {
        console.log(
          `  ${r.phase.padEnd(52)} ${r.wallS.toFixed(1).padStart(7)}s  ${r.rate.padEnd(58)} heap ${String(r.heapMb).padStart(4)} MB  rss ${String(r.rssMb).padStart(4)} MB`,
        );
      }
    }
  } finally {
    globalThis.fetch = realFetch;
    // Make sure no lane is still writing before the cascade delete.
    runner.signalShutdown();
    await Promise.allSettled(runner.getInFlightRunPromises());
    if (fx) {
      // One cascade from the org root: workspace, contacts, conversations,
      // messages, broadcasts, recipients, attempts, outbox rows, connection,
      // WABA, portfolio. Retried: on a contended box the pool can be starved
      // at the exact moment the run aborts, and a failed cleanup leaks a
      // 250k-contact workspace into the shared dev DB.
      for (let attempt = 0; ; attempt++) {
        try {
          await db.organization.delete({ where: { id: fx.organizationId } });
          break;
        } catch (e) {
          if (attempt >= 4) {
            console.error(
              `cleanup FAILED — delete Organization ${fx.organizationId} by hand`,
              e,
            );
            break;
          }
          await sleep(3_000 * (attempt + 1));
        }
      }
    }
  }

  console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect().catch(() => {});
    try {
      getRedisConnection().disconnect();
    } catch {
      /* redis may never have connected */
    }
    process.exit(process.exitCode ?? 0);
  });
