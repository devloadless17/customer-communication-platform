/**
 * In-memory per-key token bucket. Single-process pilot — moves to Redis on
 * the same trigger as everything else (second app instance).
 *
 * Bucket capacity refills continuously at `perMin / 60_000` tokens per ms,
 * so a burst at second 59 doesn't get fresh budget at second 60. Idle keys
 * are LRU-evicted (`maxKeys`) and time-evicted (`idleSweepMs` via the
 * shared module-level sweeper) so memory stays bounded.
 */

interface Bucket {
  tokens: number;
  capacity: number;
  lastRefill: number;
}

export interface TokenBucketOptions {
  /** Tokens issued per 60-second rolling window. */
  perMin: number;
  /** Hard cap on distinct keys in this bucket map. Default 5_000. */
  maxKeys?: number;
}

export interface TokenBucket {
  /**
   * Attempt to consume one token for `key`. Returns `ok: true` on success.
   * On failure, `retryAfter` is the smallest integer seconds the caller
   * should wait before retrying.
   */
  consume(key: string): { ok: true } | { ok: false; retryAfter: number };

  /**
   * Refund one token to `key`. Used when an early-path consume was
   * speculative (e.g. before an idempotency-cache hit check). No-ops if
   * the bucket has been evicted; over-refunds clip at `capacity`.
   */
  refund(key: string): void;
}

const WINDOW_MS = 60_000;
const DEFAULT_MAX_KEYS = 5_000;
const IDLE_SWEEP_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;

// Shared sweeper across every bucket map in this process. One timer instead
// of N, less event-loop noise, same eviction guarantee.
const allMaps = new Set<Map<string, Bucket>>();
const sweeper = setInterval(() => {
  const cutoff = Date.now() - IDLE_SWEEP_MS;
  for (const map of allMaps) {
    for (const [k, b] of map) {
      if (b.lastRefill < cutoff) map.delete(k);
    }
  }
}, SWEEP_INTERVAL_MS);
sweeper.unref?.();

export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  const { perMin } = options;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const refillPerMs = perMin / WINDOW_MS;
  const map = new Map<string, Bucket>();
  allMaps.add(map);

  return {
    consume(key: string) {
      const now = Date.now();
      const bucket = map.get(key);
      if (!bucket) {
        if (map.size >= maxKeys) {
          // LRU-ish: Map preserves insertion order, drop the oldest.
          const oldest = map.keys().next().value;
          if (oldest !== undefined) map.delete(oldest);
        }
        map.set(key, { tokens: perMin - 1, capacity: perMin, lastRefill: now });
        return { ok: true };
      }
      const elapsed = now - bucket.lastRefill;
      bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * refillPerMs);
      bucket.lastRefill = now;
      if (bucket.tokens < 1) {
        return {
          ok: false,
          retryAfter: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000)),
        };
      }
      bucket.tokens -= 1;
      return { ok: true };
    },
    refund(key: string) {
      const bucket = map.get(key);
      if (!bucket) return;
      bucket.tokens = Math.min(bucket.capacity, bucket.tokens + 1);
    },
  };
}
