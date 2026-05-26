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
 * Stamp a `lastError` on an already-claimed (publishedAt set) row when a
 * subscriber threw mid-dispatch. The row STAYS marked-published (at-most-
 * once dispatch was completed; we won't re-fire), but the error trail is
 * now durable instead of stdout-only. Forensic query:
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
    data: { lastError: truncated },
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
export async function claimBatch(limit: number): Promise<OutboxRow[]> {
  // Raw SQL because Prisma can't express UPDATE…WHERE…ORDER BY…LIMIT…
  // RETURNING in one query. The FOR UPDATE SKIP LOCKED clause makes this
  // safe under a future multi-drainer rollout — today there's only one
  // drainer per process, but the clause is free.
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
    UPDATE "OutboundEvent"
    SET    "publishedAt" = NOW(),
           "attempts" = "attempts" + 1
    WHERE  "id" IN (
      SELECT "id" FROM "OutboundEvent"
      WHERE  "publishedAt" IS NULL
        AND  "failedAt"    IS NULL
      ORDER BY "createdAt" ASC
      LIMIT  ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "teamId", "type", "payload", "createdAt", "attempts";
  `;
  return rows;
}

