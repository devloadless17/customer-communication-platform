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
 * Persist a domain event OUTSIDE a transaction. Used by the synchronous
 * `publish()` path in `bus.ts` so every published event has a durable
 * audit row even when dispatch is immediate.
 *
 * Returns the row id so the synchronous path can mark it published (or
 * failed) once the in-process subscriber dispatch completes.
 */
export async function persistOutboxRow<K extends DomainEventType>(
  event: DomainEventOf<K>,
): Promise<string> {
  const { type, teamId, ...rest } = event as DomainEventOf<K> & { teamId: string };
  const row = await db.outboundEvent.create({
    data: {
      teamId,
      type,
      payload: rest as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Mark a row as successfully dispatched. Idempotent — calling twice is a
 * no-op; the second update returns 0 rows affected.
 */
export async function markPublished(id: string): Promise<void> {
  await db.outboundEvent.updateMany({
    where: { id, publishedAt: null },
    data: { publishedAt: new Date() },
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

