/**
 * In-process idempotency lock for browser-driven sends, keyed by
 * `(teamId, userId, conversationId, clientTempId)`. The frontend already
 * guards against double-click via `sendInFlightRef`, but a refresh / second
 * tab / network retry can still race; this gives the server the final word.
 *
 * Behavior:
 *   - First call with a fresh key kicks off the work and registers an
 *     in-flight Promise<T> under that key.
 *   - Concurrent calls with the same key await the in-flight Promise and
 *     get the same result back — no Meta send replay, no duplicate DB row.
 *   - Once settled, the result (or the error) is cached for IDEMPOTENCY_TTL_MS
 *     so a same-key retry within the window also short-circuits to the
 *     original result. Past the TTL the entry is dropped and a new send
 *     proceeds (the customer would still be deduped at the DB layer via the
 *     compound `externalId` unique, but we'd hit Meta twice — fine; this
 *     window covers the realistic double-click / network-stutter case).
 *
 * Scope deliberately narrow: in-process only, not Redis. The browser
 * frontend always reconnects to the same api container in single-VPS
 * topology, so the lock works. When we scale out, move to a Redis-based
 * SETNX (the API-key path already uses the DB `ApiIdempotencyKey` table
 * for cross-process idempotency).
 */
const IDEMPOTENCY_TTL_MS = 5 * 60_000;
const IDEMPOTENCY_MAX = 5_000;

interface Entry<T> {
  promise: Promise<T>;
  expiresAt: number;
}

const inflight = new Map<string, Entry<unknown>>();

function buildKey(
  teamId: string,
  userId: string,
  conversationId: string,
  clientTempId: string,
): string {
  return `${teamId}|${userId}|${conversationId}|${clientTempId}`;
}

function evictExpired(now: number): void {
  if (inflight.size < IDEMPOTENCY_MAX) return;
  for (const [k, v] of inflight) {
    if (v.expiresAt <= now) inflight.delete(k);
  }
  // Hard cap: still over → drop oldest by insertion order.
  while (inflight.size >= IDEMPOTENCY_MAX) {
    const oldest = inflight.keys().next().value;
    if (oldest === undefined) break;
    inflight.delete(oldest);
  }
}

/**
 * Run `work` under an idempotency lock keyed by clientTempId. When
 * clientTempId is absent (legacy clients), the work runs through directly
 * with no caching — preserves prior behavior for callers that don't opt in.
 */
export async function runWithSendIdempotency<T>(
  scope: {
    teamId: string;
    userId: string;
    conversationId: string;
    clientTempId: string | undefined;
  },
  work: () => Promise<T>,
): Promise<T> {
  if (!scope.clientTempId) return work();

  const key = buildKey(scope.teamId, scope.userId, scope.conversationId, scope.clientTempId);
  const now = Date.now();
  const existing = inflight.get(key);
  if (existing && existing.expiresAt > now) {
    return existing.promise as Promise<T>;
  }
  if (existing) inflight.delete(key);

  evictExpired(now);

  const promise = work();
  inflight.set(key, { promise, expiresAt: now + IDEMPOTENCY_TTL_MS });

  // We deliberately don't `await` here — the in-flight Promise stays in the
  // map so concurrent callers can await the same value. On settle we keep
  // the cached result around for the full TTL (covers the "double-click +
  // network blip causes a 2nd POST after the 1st returned" pattern).
  promise.catch(() => {
    // Errors are cached too — re-throwing the same error to all racers is
    // the correct behavior. The TTL eviction will clear it.
  });

  return promise;
}
