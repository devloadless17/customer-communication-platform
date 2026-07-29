/**
 * Operational snapshot for the super-admin Platform page.
 *
 * Why this file exists: `health/ops-snapshot.ts` had ZERO tests (verification
 * program, 2026-07-29). Its whole reason for being is that failed BullMQ jobs
 * are retained for 7 days and surfaced NOWHERE — the in-process counters reset
 * on every restart, so after a deploy they read zero while a hundred failed
 * jobs sit in Redis. If this page lies, the operator's only signal is gone.
 *
 * The property that actually needs pinning is the DEGRADATION one, and it is
 * the kind that rots silently: a wedged Redis must turn the page into PARTIAL
 * data, never a hang and never a throw. `Promise.all` over eleven probes is one
 * un-caught rejection away from taking the whole snapshot down, and a probe
 * without a timeout is one wedged connection away from hanging it.
 *
 *   pnpm --filter @ccp/api exec vitest run test/ops-snapshot.spec.ts
 */
import { existsSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/workflows/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workflows/queue")>();
  return { ...actual, getWorkflowQueue: vi.fn(actual.getWorkflowQueue) };
});

import { getWorkflowQueue } from "@/lib/workflows/queue";
import { buildOpsSnapshot } from "@/health/ops-snapshot";
import type { DbService } from "@/db/db.service";

import { createTestPrismaClient } from "./_prisma";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
const mockedWorkflowQueue = vi.mocked(getWorkflowQueue);

/** The snapshot needs `$queryRaw`, `broadcast` and `getPoolStats` off DbService.
 *  Everything else it reaches through module-level queue getters. */
function fakeDb(overrides: Partial<Record<string, unknown>> = {}): DbService {
  return Object.assign(Object.create(Object.getPrototypeOf(prisma) as object), prisma, {
    getPoolStats: () => ({ max: 50, total: 3, idle: 2, waiting: 0 }),
    ...overrides,
  }) as unknown as DbService;
}

/** The seven queues the Platform page renders. Named here so a queue silently
 *  dropped from the snapshot fails a test rather than just vanishing from the
 *  operator's table. */
const EXPECTED_QUEUES = [
  "workflows",
  "message-sends",
  "webhook-deliveries",
  "broadcast-materialize",
  "ai",
  "contact-transfer",
  "coexistence-history",
];

beforeAll(() => {
  // Guard: these specs assert against a live Redis + Postgres.
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("ops snapshot", () => {
  it("reports every queue the Platform page renders", async () => {
    const snap = await buildOpsSnapshot(fakeDb());

    expect(Object.keys(snap.queues).sort()).toEqual([...EXPECTED_QUEUES].sort());
    expect(snap.uptimeSec).toBeGreaterThanOrEqual(0);
    // NOT `expect(snap.db).toBe(true)`. Every probe here is bounded at 2.5s and
    // is DESIGNED to degrade rather than block, so under a loaded box (a full
    // parallel suite, a dev stack sharing the pool) `db` can legitimately come
    // back false and `outboxLag.pendingCount` as its -1 sentinel. Asserting the
    // happy path of a deliberately-degradable probe made this inventory test
    // fail for a reason that has nothing to do with what it checks — the same
    // mistake as the platform-wide sweep in whatsapp-health-per-account.
    // What this test is ABOUT is that every queue the Platform page renders is
    // present; the db field has its own test below.
    expect(typeof snap.db).toBe("boolean");
  });

  it("a WEDGED queue degrades to null instead of hanging the page", async () => {
    // The reason every probe is time-bounded. A queue whose getJobCounts never
    // settles must cost the page one null cell, not the whole snapshot.
    mockedWorkflowQueue.mockReturnValueOnce({
      getJobCounts: () => new Promise(() => {}),
    } as unknown as ReturnType<typeof getWorkflowQueue>);

    const t0 = Date.now();
    const snap = await buildOpsSnapshot(fakeDb());
    const elapsed = Date.now() - t0;

    expect(snap.queues.workflows).toBeNull();
    // Bounded at 2.5s per probe; allow generous headroom for a loaded box but
    // still fail if the bound is gone entirely.
    expect(elapsed).toBeLessThan(20_000);
    // The rest of the page still rendered — that is what "partial data" means.
    // Asserted via the SIBLING QUEUES rather than `db`, which is itself a
    // degradable probe (see the inventory test above).
    for (const name of EXPECTED_QUEUES.filter((q) => q !== "workflows")) {
      expect(snap.queues[name], `${name} should be unaffected`).not.toBeNull();
    }
  }, 40_000);

  it("a THROWING queue degrades to null and never rejects the snapshot", async () => {
    // Promise.all over eleven probes: one un-caught rejection would take the
    // entire Platform page down rather than one cell.
    mockedWorkflowQueue.mockReturnValueOnce({
      getJobCounts: () => Promise.reject(new Error("redis connection lost")),
    } as unknown as ReturnType<typeof getWorkflowQueue>);

    const snap = await buildOpsSnapshot(fakeDb());

    expect(snap.queues.workflows).toBeNull();
    // The siblings still reported — one rejecting probe did not take the whole
    // Promise.all down, which is the property under test.
    expect(snap.queues["message-sends"]).not.toBeNull();
  });

  it("a SLOW stuck-broadcast probe cannot hang the snapshot", async () => {
    // /health is the api container's Docker healthcheck (timeout 3s, retries 3)
    // and the deploy gate reads .State.Health.Status. This probe was the ONE
    // unbounded one across all three of its callers, so a saturated pg pool —
    // the exact moment you least want it — could hold it until the 30s
    // statement_timeout, read the api as unhealthy, and auto-roll-back a
    // perfectly good release. `catch` does not help: the query does not fail,
    // it just takes too long.
    const t0 = Date.now();
    const snap = await buildOpsSnapshot(
      fakeDb({
        broadcast: { findMany: () => new Promise(() => {}) },
      }),
    );
    const elapsed = Date.now() - t0;

    // Bounded at 2.5s here; generous headroom for a loaded box, but nowhere
    // near the 30s statement_timeout an unbounded probe would wait for.
    expect(elapsed).toBeLessThan(20_000);
    // And the rest of the page still rendered.
    expect(Object.keys(snap.queues)).toHaveLength(EXPECTED_QUEUES.length);
  }, 40_000);

  it("a DEAD database reports db:false rather than throwing", async () => {
    const snap = await buildOpsSnapshot(
      fakeDb({
        $queryRaw: () => Promise.reject(new Error("connection refused")),
        broadcast: {
          findMany: () => Promise.reject(new Error("connection refused")),
        },
      }),
    );

    expect(snap.db).toBe(false);
    // The outbox probe rides the same dead connection; it reports its -1
    // sentinel rather than a fabricated zero, so the page cannot show a
    // reassuring "0 pending" for a database it cannot reach.
    expect(snap.outboxLag.pendingCount).toBe(-1);
  });
});
