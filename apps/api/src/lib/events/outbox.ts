// Transactional outbox helper. See the model comment in prisma/schema.prisma
// for the architectural rationale.

import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type {
  DomainEventOf,
  DomainEventType,
} from "@ccp/shared/events/types";

/**
 * Tx-scoped Prisma client surface. Matches the type Prisma yields inside
 * `db.$transaction(async (tx) => ...)`. Kept narrow on purpose — we only need
 * `outboundEvent.create`. Importing the wider `Prisma.TransactionClient` here
 * would force every caller into a tighter dependency.
 */
export type TxClient = Pick<
  Prisma.TransactionClient,
  "outboundEvent"
>;

interface OutboxRow {
  id: string;
  teamId: string;
  type: string;
  payload: Prisma.JsonValue;
  createdAt: Date;
  attempts: number;
}

/**
 * Persist a domain event INSIDE the caller's transaction so the outbox
 * INSERT commits atomically with the entity write. The drainer
 * (OutboxDrainerService) picks it up on next poll and runs subscribers.
 *
 * Use this from any `db.$transaction(async (tx) => { ... })` block where
 * you want at-most-once durable delivery — the typical case is the
 * inbound-webhook path (message + denorm + event must all land together
 * or none of them do).
 *
 * For non-tx call sites, use `publish` from `bus.ts` instead — it writes
 * a row here AND dispatches synchronously.
 */
export async function publishInTx<K extends DomainEventType>(
  tx: TxClient,
  event: DomainEventOf<K>,
): Promise<void> {
  const { type, teamId, ...rest } = event as DomainEventOf<K> & { teamId: string };
  await tx.outboundEvent.create({
    data: {
      teamId,
      type,
      payload: rest as unknown as Prisma.InputJsonValue,
    },
  });
}

/**
 * Persist a domain event AFTER the synchronous `publish()` path has finished
 * dispatching its in-process subscribers. The row is written with
 * `publishedAt = NOW()` (and `failedAt` if a subscriber threw) so the outbox
 * drainer's `WHERE publishedAt IS NULL` filter never picks it up — sync
 * dispatch must NOT race the drainer.
 *
 * The earlier shape ("insert with NULL → run subscribers → mark published")
 * left a window where the 100ms drainer poll could grab the row mid-dispatch
 * and re-run every subscriber. Catalog-revalidate publishes routinely
 * exceeded that window, producing duplicate audit rows, double-incremented
 * counters, and double-fired workflow runs / outbound webhooks.
 *
 * Tradeoff: if the process crashes between `runSubscribers` returning and
 * this insert, the audit row is lost. Acceptable per the existing "better
 * stale audit than dropped fanout" posture — in-process subscriber state
 * mutations are already partial in that crash scenario.
 */
export async function persistDispatchedRow<K extends DomainEventType>(
  event: DomainEventOf<K>,
  error: string | null,
): Promise<void> {
  const { type, teamId, ...rest } = event as DomainEventOf<K> & { teamId: string };
  const now = new Date();
  const truncatedError =
    error && error.length > 1000 ? error.slice(0, 1000) + "…" : error;
  await db.outboundEvent.create({
    data: {
      teamId,
      type,
      payload: rest as unknown as Prisma.InputJsonValue,
      publishedAt: now,
      attempts: 1,
      ...(truncatedError
        ? { failedAt: now, lastError: truncatedError }
        : {}),
    },
    select: { id: true },
  });
}

/**
 * Mark a row as dispatch-failed. The drainer does NOT retry these — the
 * operator decides what to do via a query like:
 *
 *   SELECT id, type, "lastError" FROM "OutboundEvent"
 *   WHERE "failedAt" IS NOT NULL AND "publishedAt" IS NULL
 *   ORDER BY "createdAt" DESC LIMIT 100;
 */
export async function markFailed(id: string, lastError: string): Promise<void> {
  // Truncate so a verbose stack doesn't bloat the row; the operator can find
  // the full one in process logs by `withCorrelation`.
  const truncated = lastError.length > 1000 ? lastError.slice(0, 1000) + "…" : lastError;
  await db.outboundEvent.updateMany({
    where: { id, publishedAt: null, failedAt: null },
    data: { failedAt: new Date(), lastError: truncated },
  });
}

/**
 * Stamp `failedAt` + `lastError` on an already-claimed (publishedAt set) row
 * when a subscriber threw mid-dispatch. The row STAYS marked-published
 * (at-most-once dispatch was completed; we won't re-fire — the drainer's claim
 * filters on `publishedAt IS NULL`, so setting failedAt here can't make it
 * re-grab the row), but the error trail is now durable instead of stdout-only.
 *
 * `failedAt` is set so the row matches the retention sweeper's "failedAt NOT
 * NULL → KEEP for operator triage" rule (outbound-event-retention.ts). Without
 * it, the sweeper's `publishedAt NOT NULL AND failedAt IS NULL` delete predicate
 * reaped these errored rows after 7 days, silently dropping the very triage
 * signal this function exists to preserve. Forensic query:
 *
 *   SELECT id, type, "lastError" FROM "OutboundEvent"
 *   WHERE "publishedAt" IS NOT NULL AND "lastError" IS NOT NULL
 *   ORDER BY "createdAt" DESC LIMIT 100;
 */
export async function markPublishedWithError(
  id: string,
  lastError: string,
): Promise<void> {
  const truncated = lastError.length > 1000 ? lastError.slice(0, 1000) + "…" : lastError;
  await db.outboundEvent.updateMany({
    where: { id, publishedAt: { not: null } },
    data: { lastError: truncated, failedAt: new Date() },
  });
}

/**
 * Drainer-side batch fetch. Picks the oldest pending rows up to `limit` and
 * atomically marks them attempted via a single UPDATE…RETURNING so two
 * drainer instances in a hypothetical multi-process future would not pick
 * the same row twice.
 *
 * We mark `publishedAt = now()` BEFORE dispatching subscribers (at-most-
 * once) — if the process dies between this mark and the subscriber call,
 * the row is "lost" forever from the wire but visible to a forensic query
 * as `attempts = 1 AND publishedAt IS NOT NULL`. The operator can then
 * manually decide whether to re-publish.
 */
/**
 * Per-team fairness: how many rows the drainer pulls from a SINGLE team per
 * `claimBatch` call. Without this, a 5k-row bulk import from one team publishes
 * a contiguous block; the strict `ORDER BY createdAt` claim meant every other
 * team's realtime events waited behind it until the block drained. With per-team
 * windowing, each team contributes up to `PER_TEAM_BATCH_CAP` rows per claim —
 * slow-but-fair on a hot tenant.
 *
 * Sizing: this was `4`, which — combined with the drainer's per-CLAIM trickle —
 * throttled a SINGLE tenant (the actual pilot deployment) to ~40 events/s and
 * left every other tenant waiting behind a backlog. `4` is far too low: it must
 * be high enough that one tenant drains at a healthy rate, yet low enough that a
 * bursty tenant can't monopolize a `BATCH_SIZE`-bounded claim when OTHER tenants
 * also have pending rows. At `100` against `BATCH_SIZE=200`, a lone tenant gets
 * 100 rows/claim (and the drainer now keeps claiming within the tick — see
 * OutboxDrainerService.tick — so its real ceiling is 100 × MAX_DRAINS_PER_TICK
 * per 100ms tick), while two simultaneously-hot tenants split a claim 100/100.
 * The window function still just reorders WITHIN the `limit` budget.
 */
const PER_TEAM_BATCH_CAP = 100;

export async function claimBatch(limit: number): Promise<OutboxRow[]> {
  // Raw SQL because Prisma can't express UPDATE…WHERE…ORDER BY…LIMIT…
  // RETURNING in one query. The FOR UPDATE SKIP LOCKED clause makes this
  // safe under a future multi-drainer rollout — today there's only one
  // drainer per process, but the clause is free.
  //
  // Postgres rejects `FOR UPDATE` in any query that uses window functions
  // (SQLSTATE 0A000). To get BOTH the SKIP-LOCKED safety AND the per-team
  // fairness, split into two steps:
  //   1. CTE `candidates`: select a wider window (limit × 4) of oldest
  //      unpublished rows, taking the row-level lock with FOR UPDATE SKIP
  //      LOCKED. No window functions in this CTE.
  //   2. CTE `ranked`: apply ROW_NUMBER() to the locked candidates and
  //      keep at most PER_TEAM_BATCH_CAP per team.
  //   3. Outer UPDATE: mark the ranked subset published.
  // This preserves both invariants: nothing else can claim our locked
  // rows (the candidates' locks are held until commit), and a single
  // bursty tenant can't monopolize a batch — at most 4 of their rows per
  // tick interleave with other tenants' events.
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      teamId: string;
      type: string;
      payload: Prisma.JsonValue;
      createdAt: Date;
      attempts: number;
    }>
  >`
    WITH candidates AS (
      SELECT "id", "teamId", "createdAt"
      FROM   "OutboundEvent"
      WHERE  "publishedAt" IS NULL
        AND  "failedAt"    IS NULL
      ORDER BY "createdAt" ASC
      LIMIT  ${limit * 4}
      FOR UPDATE SKIP LOCKED
    ),
    ranked AS (
      SELECT "id",
             "teamId",
             "createdAt",
             ROW_NUMBER() OVER (PARTITION BY "teamId" ORDER BY "createdAt") AS team_rn
      FROM   candidates
    )
    UPDATE "OutboundEvent"
    SET    "publishedAt" = NOW(),
           "attempts" = "attempts" + 1
    WHERE  "id" IN (
      SELECT "id" FROM ranked
      WHERE team_rn <= ${PER_TEAM_BATCH_CAP}
      -- Explicit ORDER BY so the LIMIT picks the OLDEST rows across teams,
      -- not whatever order the planner happens to materialize the CTE in.
      -- Postgres preserves CTE row order today, but the docs don't guarantee
      -- it — without this, a future plan change could pick non-oldest rows
      -- under load, breaking FIFO + fairness.
      ORDER BY team_rn, "createdAt"
      LIMIT ${limit}
    )
    RETURNING "id", "teamId", "type", "payload", "createdAt", "attempts";
  `;
  return rows;
}

