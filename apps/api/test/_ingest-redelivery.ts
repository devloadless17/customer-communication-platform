/**
 * `ingestEvents` with the half of the production contract a unit test is missing.
 *
 * Ingest deliberately THROWS on a transient DB fault instead of swallowing it —
 * that is the fail-soft contract (CLAUDE.md §8): the webhook controller maps the
 * throw to a 503, and Meta redelivers the batch. Dropping it would answer 200 and
 * lose a customer message forever, which is the failure the whole ingest path is
 * built to avoid.
 *
 * A spec that calls `ingestEvents` directly gets the throw and no redelivery,
 * because there is no controller and no Meta. So under the contention of a full
 * parallel suite against one Postgres, a perfectly correct Serializable conflict
 * surfaced as a test failure — `DriverAdapterError: TransactionWriteConflict` in
 * `webhook-batched-entries` and `webhook-account-attribution`.
 *
 * Retrying here is not papering over the flake, it is completing the harness:
 * the system's real answer to that error is "Meta sends this batch again", and
 * this models exactly that. It is also safe to assert against, because ingest is
 * idempotent by design — `webhook-batched-entries` has a test whose entire point
 * is that redelivering the identical POST creates no duplicates.
 *
 * Strictly bounded and strictly scoped: only `isTransientDbError` retries (the
 * same predicate the controller uses to choose 503), everything else propagates
 * on the first attempt, and exhaustion rethrows. A real, persistent ingest bug
 * still fails the test — it just takes four attempts to say so.
 *
 * Related: `serializable-retry.spec.ts`, which covers the retry INSIDE ingest
 * that should absorb most of these before they ever reach here.
 */
import { ingestEvents, isTransientDbError } from "@/lib/providers/ingest";

/** How many deliveries Meta is standing in for. */
const MAX_DELIVERIES = 4;

export async function ingestWithRedelivery(
  ...args: Parameters<typeof ingestEvents>
): Promise<Awaited<ReturnType<typeof ingestEvents>>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ingestEvents(...args);
    } catch (err) {
      if (!isTransientDbError(err) || attempt === MAX_DELIVERIES - 1) throw err;
      // Meta's redelivery is not instant, and an immediate retry would collide
      // with whatever we just lost to. Small exponential back-off, jittered.
      await new Promise((r) => setTimeout(r, Math.random() * 40 * 2 ** attempt));
    }
  }
}
