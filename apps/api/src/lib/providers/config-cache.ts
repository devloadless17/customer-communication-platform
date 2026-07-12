/**
 * Shared in-process credential-cache primitive for the per-channel provider
 * config loaders (WhatsApp `config.ts`, `messenger-config.ts`,
 * `instagram-config.ts`). Each of those keeps its own channel-specific config
 * shape + loaders, but the caching mechanics — short TTL, bounded size with
 * least-recently-refreshed eviction, and a periodic expiry sweep — were
 * byte-for-byte identical in all three. This is that one mechanism.
 *
 * Why a cache at all: team credentials change ~never, but the send/read/webhook
 * paths hit the `ChannelConnection` row on every request — a DB round-trip on
 * the realtime hot path for effectively-static data. Cache it with a short TTL,
 * and each loader busts its team explicitly when the settings page saves new
 * credentials (`invalidate*Config`).
 *
 * SECURITY: callers store the *encrypted ciphertext* of secrets here, never the
 * decrypted plaintext (decryption happens per-call, scoped to the request). See
 * the header comment in `config.ts` for the full rationale — this primitive is
 * secret-agnostic and just holds whatever value the loader put in.
 *
 * Single-process only by design (CLAUDE.md: one VPS, one app instance). The day
 * a second instance shows up this moves to Redis alongside the Socket.io adapter.
 */

const CONFIG_TTL_MS = 60_000;
// Bound the per-team caches so a multi-tenant scale-up doesn't grow them
// unboundedly. 10k teams is comfortably above the documented "~5 tenants"
// trigger threshold from CLAUDE.md — entries past that get evicted (oldest
// first) on insert. The periodic sweep drops expired entries on top of that so
// memory stays bounded even before the cap kicks in.
const CONFIG_CACHE_MAX = 10_000;
const CONFIG_SWEEP_INTERVAL_MS = 5 * 60_000;

// Every live cache, swept by the single shared interval below so we don't spin
// up one timer per channel-config module.
const registry = new Set<{ sweepExpired: () => void }>();

/**
 * A string-keyed cache with per-entry TTL and a hard size cap. `get` returns
 * `undefined` on a miss OR an expired entry; a stored value of `null` is a real
 * hit (the config loaders cache `null` to mean "known not-configured", distinct
 * from "not looked up yet").
 */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; exp: number }>();

  constructor(
    private readonly ttlMs: number = CONFIG_TTL_MS,
    private readonly max: number = CONFIG_CACHE_MAX,
  ) {
    registry.add(this);
  }

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.exp <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    // `Map.set` on an EXISTING key keeps its original insertion position, so a
    // team whose credentials are refreshed every TTL would stay at the head and
    // be evicted before teams nobody has touched in hours. Delete first so a
    // refresh moves the entry to the tail — eviction order then tracks recency
    // of use, not first sight.
    this.map.delete(key);
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, exp: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  sweepExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.map) if (v.exp <= now) this.map.delete(k);
  }
}

const sweeper = setInterval(() => {
  for (const cache of registry) cache.sweepExpired();
}, CONFIG_SWEEP_INTERVAL_MS);
sweeper.unref?.();
