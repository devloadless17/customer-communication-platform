import { getRedisConnection } from "@/lib/workflows/queue";

/**
 * Per-number send-rate ceiling — a Redis token bucket.
 *
 * WHY THIS EXISTS. The runner paces sends with a fixed `gapMs` sleep per lane.
 * That approximates a rate, but it cannot ENFORCE one: the real period is
 * `work + gapMs`, so the actual rate drifts with Meta's latency, and — the part
 * that matters — the sleep is per-process and per-run. Two broadcasts on the
 * same WhatsApp number, or a second app instance, each pace themselves to the
 * target and together sail past it. Meta's throughput ceiling is per NUMBER and
 * counts inbound too, so overshooting risks the number's quality rating, which
 * is expensive and slow to recover.
 *
 * A bucket keyed on the phone-number id is the one place that can be true
 * regardless of how many runs, lanes or processes exist.
 *
 * WHY LUA. Refill-then-take must be atomic; done as GET/SET from Node, two
 * lanes read the same token count and both take it. The script also reads
 * `redis.TIME` rather than accepting a client timestamp, so the api process and
 * a future worker container can't disagree about "now" — clock skew between
 * them would otherwise let one side over-refill.
 *
 * ON BY DEFAULT (opt out with `BROADCAST_RATE_LIMITER_ENABLED=0`). It is the
 * rate authority the lane sizing depends on, and it can only slow sending —
 * never break it, since a Redis outage fails open. Rollback is an env flip.
 */

/**
 * Refill and take one token.
 *
 * KEYS[1] bucket, ARGV[1] rate/sec, ARGV[2] capacity.
 * Returns milliseconds to wait: 0 = a token was taken, >0 = try again after.
 *
 * State is two fields — token count and the last-refill timestamp in
 * microseconds — with a TTL so an idle number's key evaporates instead of
 * accumulating one row per number forever.
 *
 * Exported so the spec runs THIS script rather than a copy of it. Every
 * property worth testing (atomicity, refill, the clock-skew guard) lives in
 * here, and a duplicated copy in the test would drift silently — passing while
 * the shipped script rots.
 */
export const ACQUIRE_LUA = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])

local t = redis.call('TIME')
local now_us = (tonumber(t[1]) * 1000000) + tonumber(t[2])

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])

if tokens == nil or ts == nil then
  -- First caller for this number: start full, so a campaign opening on an idle
  -- number is not throttled for a second before it can send anything.
  tokens = capacity
  ts = now_us
end

-- Refill for the elapsed time, clamped to capacity. Elapsed can be negative if
-- Redis time went backwards (NTP step); treat that as zero rather than
-- draining the bucket.
local elapsed_us = now_us - ts
if elapsed_us < 0 then elapsed_us = 0 end
tokens = math.min(capacity, tokens + (elapsed_us / 1000000) * rate)

local wait_ms = 0
if tokens >= 1 then
  tokens = tokens - 1
else
  -- Time until one whole token exists, rounded up so the caller never wakes a
  -- hair early and spins.
  wait_ms = math.ceil(((1 - tokens) / rate) * 1000)
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now_us)
-- Generous relative to any refill window; purely so idle keys expire.
redis.call('PEXPIRE', key, 60000)
return wait_ms
`;

/**
 * Is the bucket switched on? **On by default** — opt OUT with
 * `BROADCAST_RATE_LIMITER_ENABLED=0`.
 *
 * It shipped dark, but it is now the mechanism the whole send path depends on:
 * lane counts are derived from the target rate (see `lanesForRate`), and that
 * is only safe because the bucket — not the lane count — decides how fast we
 * actually talk to Meta. With it off, the runner falls back to fixed-gap pacing
 * that tops out around 60 msg/s regardless of the number's tier, so a number
 * Meta has scaled to 10K/100K would never use its allowance.
 *
 * Safe as a default because it can only ever SLOW sending, never break it: a
 * Redis outage fails open (see `acquireSendToken`), and every wait is bounded.
 */
export function sendRateLimiterEnabled(): boolean {
  return process.env.BROADCAST_RATE_LIMITER_ENABLED !== "0";
}

function envInt(name: string, def: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(raw) || raw < min || raw > max) return def;
  return raw;
}

/**
 * Target messages/second for a number, from its Meta throughput level.
 *
 * Deliberately BELOW Meta's published ceilings (80 / 1000). The ceiling counts
 * inbound as well as outbound, so a campaign that saturates it starves the
 * inbox — replies queue behind a blast, which is precisely when a customer is
 * most likely to be answering one. The gap is reserved headroom, not caution.
 */
export function resolveSendRate(
  throughputLevel: string | null | undefined,
  /**
   * COEXISTENCE (`ChannelConnection.isOnBusinessApp`): the number is used in the
   * WhatsApp Business app alongside Cloud API.
   *
   * Meta caps those at a FIXED 20 messages/second, outside the 80 (default) /
   * 1,000 (upgraded) ladder that `throughput.level` reports. Meta still reports a
   * level for them, so pacing off the level alone ran a Coexistence number at 75/s
   * (STANDARD) or 40/s (unknown) — 2-4x over a hard ceiling. That earns sustained
   * 130429s mid-campaign and damages the quality rating of exactly the fragile
   * numbers Coexistence serves: a small business's own handset, still carrying
   * personal traffic on the same line.
   *
   * The cap WINS over the level rather than being blended with it — a
   * simultaneously-app-used number does not get the ladder at all.
   */
  isOnBusinessApp?: boolean | null,
): number {
  if (isOnBusinessApp === true) {
    // 18, deliberately under Meta's 20, matching how HIGH/STANDARD sit under
    // 1,000/80 — the margin is what protects the quality rating.
    return envInt("BROADCAST_RATE_COEXISTENCE", 18, 1, 20);
  }
  if (throughputLevel === "HIGH") return envInt("BROADCAST_RATE_HIGH", 900, 1, 5_000);
  if (throughputLevel === "STANDARD") return envInt("BROADCAST_RATE_STANDARD", 75, 1, 5_000);
  // Unknown throughput — Meta hasn't told us yet. Assume the slower tier: being
  // wrong in this direction sends more slowly than necessary, while the other
  // direction risks the number's quality rating.
  return envInt("BROADCAST_RATE_BASELINE", 40, 1, 5_000);
}

/**
 * Send rate for a SOCIAL channel (Messenger / Instagram), which has nothing to do
 * with the WhatsApp throughput ladder above.
 *
 * `resolveSendRate` was being used for these too, and since social carries no
 * `throughput.level` it landed on the WhatsApp BASELINE of 40/s. That is the wrong
 * number for the wrong reason, and it sat exactly ON the binding limit rather than
 * under it.
 *
 * Meta's Page limits are a ladder of three, and the LOWEST one binds:
 *   - 300 calls/s per Page for text, links, reactions and stickers,
 *   - 10/s for audio and video,
 *   - and a ~40 messages/s Page-INBOX ceiling, past which the Page silently stops
 *     sending — the nastiest of the three because nothing errors.
 *
 * So 300 is a red herring for a campaign: the inbox ceiling is what actually stops
 * you, and being at 40 rather than below it means the first burst is the one that
 * finds out. Default 36 keeps a margin, mirroring how HIGH/STANDARD sit under
 * 1,000/80 for WhatsApp.
 *
 * The 10/s audio-video tier deliberately has no branch: `Broadcast` carries only
 * `bodyText` / `templateName` and no media columns, so a social broadcast is text by
 * construction. If media broadcasts ever ship for social, this is the function that
 * needs the second rate — not the caller.
 */
export function resolveSocialSendRate(): number {
  return envInt("BROADCAST_RATE_SOCIAL", 36, 1, 300);
}

/**
 * Take one send token for `accountKey`, waiting if the bucket is empty.
 *
 * `accountKey` is the provider's own account id (WhatsApp `phoneNumberId`) —
 * NOT the workspace and not the broadcast, because Meta's ceiling belongs to
 * the number. Two campaigns on one number correctly share a budget; two numbers
 * in one workspace correctly do not.
 *
 * Bounded by `maxWaitMs` so a misconfigured rate can never park a lane
 * indefinitely: on timeout it returns and lets the send proceed. Meta's own 429
 * handling (already in the runner) remains the backstop — this is a smoother,
 * not the only defence.
 */
export async function acquireSendToken(
  accountKey: string,
  ratePerSec: number,
  opts: { capacity?: number; maxWaitMs?: number } = {},
): Promise<void> {
  if (!sendRateLimiterEnabled()) return;

  // One second of burst. Enough to absorb the jitter of N lanes finishing
  // together; small enough that a burst can't meaningfully exceed the rate when
  // averaged over the window Meta measures.
  const capacity = opts.capacity ?? Math.max(1, Math.ceil(ratePerSec));
  const maxWaitMs = opts.maxWaitMs ?? 5_000;
  const key = `wa-send-rate:${accountKey}`;
  const redis = getRedisConnection();

  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    let waitMs: number;
    try {
      const res = await redis.eval(ACQUIRE_LUA, 1, key, String(ratePerSec), String(capacity));
      waitMs = Number(res) || 0;
    } catch {
      // Redis is unreachable. Fail OPEN: a rate limiter that stops the sending
      // of an already-paid-for campaign because a cache is down has done more
      // damage than the overshoot it was preventing.
      return;
    }
    if (waitMs <= 0) return;
    if (Date.now() + waitMs > deadline) return;
    await new Promise((r) => setTimeout(r, waitMs));
  }
}
