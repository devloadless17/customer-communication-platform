/**
 * In-process idempotency lock for browser-driven sends, keyed by
 * `(workspaceId, userId, conversationId, clientTempId)`. The frontend already
 * guards against double-click via `sendInFlightRef`, but a refresh / second
 * tab / network retry can still race; this gives the server the final word.
 *
 * Behavior:
 *   - First call with a fresh key kicks off the work and registers an
 *     in-flight Promise<T> under that key.
 *   - Concurrent calls with the same key await the in-flight Promise and
 *     get the same result back — no Meta send replay, no duplicate DB row.
 *   - Once settled, a SUCCESS is cached for IDEMPOTENCY_TTL_MS so a same-key
 *     retry within the window short-circuits to the original result. Past the
 *     TTL the entry is dropped and a new send proceeds (the customer would
 *     still be deduped at the DB layer via the compound `externalId` unique,
 *     but we'd hit Meta twice — fine; this window covers the realistic
 *     double-click / network-stutter case). A settled REJECTION is cached only
 *     briefly (REJECTION_TTL_MS): the designed Retry flow reuses the
 *     clientTempId with EDITED content ("fix + resend"), so replaying a stale
 *     error for the full TTL would block the corrected send.
 *
 * Scope deliberately narrow: in-process only, not Redis. The browser
 * frontend always reconnects to the same api container in single-VPS
 * topology, so the lock works. When we scale out, move to a Redis-based
 * SETNX (the API-key path already uses the DB `ApiIdempotencyKey` table
 * for cross-process idempotency).
 *
 * ACCEPTED, and the reason this is a lock rather than a ledger: only the
 * QUEUED text path writes `OutboundSendAttempt`, so the synchronous composer
 * senders (media, forward, template, interactive, structured, sticker) lose
 * this map with the process. A crash between Meta accepting the send and the
 * HTTP response landing therefore leaves a same-key retry free to re-hit Meta,
 * and the second send earns its own `externalId`, so the message-level dedupe
 * cannot absorb it — the customer sees it twice. The exposure is one process
 * death inside one send's window; closing it costs an `OutboundSendAttempt`
 * write on every composer send. Revisit if a real restart is ever observed to
 * double-send.
 */
import { HttpException } from "@nestjs/common";

const IDEMPOTENCY_TTL_MS = 5 * 60_000;
// A settled REJECTION is cached only briefly (vs. the full TTL for a success):
// long enough to absorb an adversarial double-POST, short enough that a human's
// fix-and-resend (always more than a few seconds) re-runs the work instead of
// replaying the stale error. See the reject branch in runWithSendIdempotency.
const REJECTION_TTL_MS = 12_000;
const IDEMPOTENCY_MAX = 5_000;

/**
 * A transient failure — the send didn't deterministically fail, the infra /
 * upstream was momentarily unavailable or the request was rate-limited. Such a
 * failure must be retryable IMMEDIATELY, so we must NOT cache it at all
 * (otherwise a retry of the same clientTempId gets the stale cached failure,
 * even after the infra recovers / the bucket refills). Covers ONLY errors
 * thrown BEFORE the Meta send is attempted (provably not delivered):
 *   - 503 queue/Redis unavailable, provider temporarily down
 *   - 429 conversation_rate_limited (the bucket refills within seconds)
 * NOTE: 502 is deliberately EXCLUDED — on the synchronous template/interactive
 * paths (which have no OutboundSendAttempt double-send guard) a 502 is the
 * AMBIGUOUS transport error (normalizeMetaSendError returned null → Meta may
 * have already accepted the send). Evicting it would let a same-key retry
 * re-hit Meta and double-send. It falls through to the short REJECTION cache.
 * Deterministic 4xx errors (outside_24h_window, template rejected,
 * unsupported_file_type, …) fall through to the short REJECTION_TTL_MS cache —
 * re-failing an immediate same-key retry is correct, but the window stays short
 * so a genuine fix-and-resend isn't blocked.
 */
function isTransientError(err: unknown): boolean {
  if (!(err instanceof HttpException)) return false;
  const status = err.getStatus();
  return status === 503 || status === 429;
}

interface Entry<T> {
  promise: Promise<T>;
  expiresAt: number;
}

const inflight = new Map<string, Entry<unknown>>();

function buildKey(
  workspaceId: string,
  userId: string,
  conversationId: string,
  clientTempId: string,
): string {
  return `${workspaceId}|${userId}|${conversationId}|${clientTempId}`;
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
    workspaceId: string;
    userId: string;
    conversationId: string;
    clientTempId: string | undefined;
  },
  work: () => Promise<T>,
): Promise<T> {
  if (!scope.clientTempId) return work();

  const key = buildKey(scope.workspaceId, scope.userId, scope.conversationId, scope.clientTempId);
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
  // map so concurrent callers can await the same value. On a SUCCESS we keep
  // the cached result for the full TTL (covers the "double-click + network blip
  // causes a 2nd POST after the 1st returned" pattern).
  promise.catch((err) => {
    const entry = inflight.get(key);
    // Only act if THIS promise is still the cached entry (a newer attempt may
    // have already replaced it).
    if (entry?.promise !== promise) return;
    if (isTransientError(err)) {
      // Transient (503/429, thrown pre-send) — retryable immediately, drop now.
      inflight.delete(key);
      return;
    }
    // Deterministic rejection: keep only briefly so an immediate adversarial
    // double-POST still dedupes, but a human's fix-and-resend (reusing the
    // clientTempId with edited content) re-runs the work instead of replaying
    // the stale error.
    entry.expiresAt = Math.min(entry.expiresAt, Date.now() + REJECTION_TTL_MS);
  });

  return promise;
}

/**
 * Drop any cached entry for this send key. Called when a queued send later
 * FAILS terminally in the worker (worker + HTTP share the process under
 * `RUN_WORKER_INLINE=1`): the HTTP POST cached a `{ ok, queued }` SUCCESS for
 * the full TTL, so without this a same-clientTempId Retry within the window
 * would short-circuit to that stale success and never re-enqueue. Safe to call
 * with no matching entry (no-op) and with a legacy client that sent no
 * clientTempId.
 */
export function invalidateSendIdempotency(scope: {
  workspaceId: string;
  userId: string;
  conversationId: string;
  clientTempId: string | undefined;
}): void {
  if (!scope.clientTempId) return;
  inflight.delete(
    buildKey(scope.workspaceId, scope.userId, scope.conversationId, scope.clientTempId),
  );
}
