// Transactional outbox helper. See the model comment in prisma/schema.prisma
// for the architectural rationale.

import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { getChainDepth, getCorrelationId } from "@/common/correlation";
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
  // Captured at publish time (request scope) so the drainer can restore the
  // ALS context before dispatch — keeps the cross-system loop counter honest
  // across the async publish→dispatch boundary (EVT-1).
  chainDepth: number;
  correlationId: string | null;
}

/**
 * Immediate-drain signal. The OutboxDrainerService registers a `kick` fn on
 * boot; a commit site calls `kickOutbox()` right AFTER its transaction commits
 * so the event dispatches in ~1ms instead of waiting out the drainer's poll.
 * Decoupled via a module-level hook because framework-agnostic lib code can't
 * import the NestJS drainer (layering) — same pattern as `setSharedDb`.
 *
 * MUST be called AFTER commit, never inside the tx: the drainer's claim uses
 * SKIP LOCKED and can't see an uncommitted row, so a pre-commit kick is wasted.
 * It is a pure latency optimization — never a correctness dependency. If the
 * kick is skipped (no handler, or called too early), the poll still drains the
 * row ≤POLL_INTERVAL_MS later.
 */
let outboxKick: (() => void) | null = null;
export function setOutboxKickHandler(fn: (() => void) | null): void {
  outboxKick = fn;
}
export function kickOutbox(): void {
  outboxKick?.();
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
      // Capture the request-scoped loop counter + correlation id NOW, while we
      // are still inside the originating HTTP request's ALS scope. The drainer
      // dispatches this row LATER (outside that scope) and restores them, so an
      // outbound-webhook fired for this event stamps the correct X-CCP-Depth
      // instead of resetting to 1 (EVT-1).
      chainDepth: getChainDepth(),
      correlationId: getCorrelationId() ?? null,
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
 *
 * Returns the new row's id so `publish()` can stamp `dispatchedAt` on it AFTER
 * the DETACHED background tier resolves (see below).
 */
export async function persistDispatchedRow<K extends DomainEventType>(
  event: DomainEventOf<K>,
  error: string | null,
): Promise<string> {
  const { type, teamId, ...rest } = event as DomainEventOf<K> & { teamId: string };
  const now = new Date();
  const truncatedError =
    error && error.length > 1000 ? error.slice(0, 1000) + "…" : error;
  const row = await db.outboundEvent.create({
    data: {
      teamId,
      type,
      payload: rest as unknown as Prisma.InputJsonValue,
      publishedAt: now,
      attempts: 1,
      // Sync path already dispatched in request scope; store these for forensic
      // consistency with the tx path (never re-dispatched, so not load-bearing).
      chainDepth: getChainDepth(),
      correlationId: getCorrelationId() ?? null,
      // dispatchedAt is intentionally left NULL here. The bare publish() path
      // spawns the background tier (audit → analytics → workflow-dispatch →
      // outbound-webhooks) DETACHED — those subscribers have NOT run yet when
      // this row is written. Stamping dispatchedAt=NOW now produced a
      // false-green forensic trail: a crash between this write and the
      // background subscribers creating their rows (e.g. an OutboundWebhook
      // delivery) looked fully dispatched, hiding the loss. Instead publish()
      // stamps dispatchedAt via markDispatched() once the background promise
      // resolves; a crash before that leaves publishedAt set + dispatchedAt
      // NULL — exactly the "hard-crash loss window" the detection query looks
      // for, and the retention sweeper's `dispatchedAt: { not: null }` GC only
      // fires once the bracket is honestly closed.
      // The error branch also leaves dispatchedAt NULL: failedAt is set, so the
      // sweeper KEEPS the row for operator triage.
      ...(truncatedError ? { failedAt: now, lastError: truncatedError } : {}),
    },
    select: { id: true },
  });
  return row.id;
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
 * Stamp `dispatchedAt` AFTER every subscriber for these rows finished
 * dispatching (success path). publishedAt is set BEFORE dispatch (at-most-once);
 * dispatchedAt closes the bracket. A row stuck published-but-undispatched for
 * minutes = the rare hard-crash-mid-dispatch loss window — see the column doc
 * in schema.prisma for the ad-hoc detection query. One batched UPDATE per
 * drain claim (cheap); never re-dispatches (that would double-fire side
 * effects — the no-duplicates posture). Best-effort: a failure here only loses
 * the bracket stamp, not the dispatch itself.
 */
export async function markDispatched(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.outboundEvent.updateMany({
    where: { id: { in: ids }, dispatchedAt: null },
    data: { dispatchedAt: new Date() },
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
 * The cap is enforced at candidate-selection time (a LATERAL `LIMIT` per team),
 * so a bursty tenant's backlog can never crowd another tenant out of the window.
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
  // fairness, select candidates PER TEAM so one tenant's backlog can never
  // crowd the window:
  //   1. CTE `teams`: DISTINCT teamIds present in the OLDEST pending window
  //      (bounded to `limit × 8` rows, NOT the whole backlog — see the CTE
  //      comment for why an unbounded DISTINCT is O(backlog) per tick).
  //   2. CTE `candidates`: a LATERAL join per team pulling only that team's
  //      oldest PER_TEAM_BATCH_CAP unpublished rows, taking the row-level
  //      lock with FOR UPDATE SKIP LOCKED inside the lateral subquery (no
  //      window functions there, so the lock is legal). Bounding the cap HERE
  //      — instead of over a shared `limit × 4` oldest-first window — is the
  //      whole point: a single team with >`limit × 4` pending rows used to
  //      fully consume the flat window and starve every other team's realtime
  //      / webhook / workflow fanout until its backlog drained (the exact
  //      total-starvation the PER_TEAM_BATCH_CAP fairness exists to prevent).
  //   3. CTE `ranked`: ROW_NUMBER() per team so the outer LIMIT interleaves
  //      teams (oldest-of-each first) rather than draining one team fully.
  //   4. Outer UPDATE: mark the ranked subset published.
  // This preserves both invariants: nothing else can claim our locked rows
  // (the candidates' locks are held until commit, and SKIP LOCKED keeps a
  // second drainer from blocking or deadlocking), and a single bursty tenant
  // contributes at most PER_TEAM_BATCH_CAP rows per claim.
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      teamId: string;
      type: string;
      payload: Prisma.JsonValue;
      createdAt: Date;
      attempts: number;
      chainDepth: number;
      correlationId: string | null;
    }>
  >`
    WITH teams AS (
      -- Distinct teamIds present in the OLDEST pending window, NOT over the
      -- whole backlog. A plain DISTINCT teamId over every unpublished row is
      -- O(backlog) each tick (the only pending index,
      -- OutboundEvent_drainer_pending_idx, is a partial btree on createdAt
      -- with no teamId, and Postgres has no DISTINCT skip-scan), so it degraded
      -- exactly during the broadcast/fanout backlog the drainer exists to clear.
      -- Bounding to the oldest limit*8 rows keeps the scan O(limit) while
      -- preserving fairness: the claim can pull at most limit rows anyway, so
      -- every team that owns a row old enough to be claimable THIS tick is
      -- present in an 8x window (headroom for the worst realistic skew: one
      -- team's contiguous burst pushing others' oldest rows deeper). A team
      -- whose oldest row sits beyond the window simply isn't claimable yet and
      -- surfaces on a later tick as the window drains, which is the correct
      -- round-robin-among-the-oldest-backlog behavior fairness wants.
      SELECT DISTINCT "teamId"
      FROM   (
        SELECT "teamId"
        FROM   "OutboundEvent"
        WHERE  "publishedAt" IS NULL
          AND  "failedAt"    IS NULL
        ORDER BY "createdAt" ASC
        LIMIT ${limit * 8}
      ) oldest_window
    ),
    candidates AS (
      SELECT c."id", c."teamId", c."createdAt"
      FROM   teams t
      CROSS JOIN LATERAL (
        SELECT "id", "teamId", "createdAt"
        FROM   "OutboundEvent" o
        WHERE  o."publishedAt" IS NULL
          AND  o."failedAt"    IS NULL
          AND  o."teamId"      = t."teamId"
        ORDER BY o."createdAt" ASC
        LIMIT  ${PER_TEAM_BATCH_CAP}
        FOR UPDATE SKIP LOCKED
      ) c
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
      -- Explicit ORDER BY so the LIMIT interleaves teams (each team's oldest
      -- first) and, within a team, picks the OLDEST rows — not whatever order
      -- the planner happens to materialize the CTE in. Postgres preserves CTE
      -- row order today, but the docs don't guarantee it; without this a future
      -- plan change could pick non-oldest rows under load, breaking FIFO +
      -- fairness.
      ORDER BY team_rn, "createdAt"
      LIMIT ${limit}
    )
    RETURNING "id", "teamId", "type", "payload", "createdAt", "attempts", "chainDepth", "correlationId";
  `;
  return rows;
}

