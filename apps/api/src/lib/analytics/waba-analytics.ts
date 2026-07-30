import { BadGatewayException, BadRequestException } from "@nestjs/common";

import { db } from "@/lib/db";
import { WABA_PROBE_ORDER, wabaProbeMismatch } from "@/lib/providers/waba-probe";
import { getProviderBinding } from "@/lib/providers";

/**
 * Meta's ACCOUNT-level analytics — spend, volume, conversations, calls.
 *
 * Meta exposes seven analytics surfaces on the WhatsApp Business Account node.
 * `template_analytics` (and its template-group sibling) are per-template and
 * live in `template-analytics.ts`. This module owns the other four, which are
 * per-ACCOUNT and answer the questions that one can't:
 *
 *   - `pricing_analytics`      — what we are BEING CHARGED, per delivered
 *                                message, by category/country/number, plus the
 *                                VOLUME TIER ladder. The current billing truth.
 *   - `conversation_analytics` — how many CONVERSATIONS opened, by direction and
 *                                free-tier vs regular. A different unit from
 *                                pricing analytics; never sum the two.
 *   - `analytics` (messaging)  — raw sent/delivered throughput per number.
 *   - `call_analytics`         — completed calls, average duration, call spend.
 *
 * WHY THERE IS NO ROLLUP TABLE HERE. `template-analytics.ts` stores its results
 * because Meta reports template read/click for only ~7 days and then zeroes
 * them: uncaptured is lost forever, so a sweeper + a merge-on-conflict upsert
 * are load-bearing. These four have a ONE-YEAR lookback (cut from ten years on
 * 2025-12-01), which means any window inside a year is re-fetchable on demand.
 * Storing them would add a table, a sweeper and a drift-reconciler to buy
 * nothing but a cache — so this module fetches live behind a short TTL cache
 * instead. That is the whole reason the two halves of Meta analytics are shaped
 * differently, and it is a deliberate asymmetry, not an inconsistency.
 *
 * REPORTED PER-WABA — but not everything IS per-WABA. Analytics are a WABA-node
 * field, a workspace can hold several WABAs, and their figures must never be
 * silently pooled: the CURRENCY can differ (Meta: cost is "in your WABA's
 * currency"), and one account's outage would otherwise look like a company-wide
 * drop. Each account reports its own block with its own `unavailable` reason.
 *
 * The one exception, corrected 2026-07-30: the VOLUME TIER is NOT per-WABA.
 * "Messages are aggregated at the business portfolio level, across all WhatsApp
 * Business Accounts (WABAs) owned by the portfolio… This rate applies across all of
 * their WABAs", and tiers reset monthly at 12am in the WABA's timezone. This
 * docblock previously asserted "the tier ladders are independent", which is the
 * opposite. Meta stamps the portfolio-derived tier onto each WABA's rows, so
 * PRESENTING it per WABA is still right — but any future change that ROLLS UP or
 * derives a tier per WABA would double-count a portfolio-wide counter. See the
 * `toNextTier` caveat on TierStanding.
 */

/** Meta cut messaging/conversation/pricing analytics to a one-year lookback on
 *  2025-12-01. An out-of-range start returns an EMPTY set rather than an error,
 *  which is indistinguishable from "this account sent nothing" — so clamp here
 *  rather than passing a wider window through and reporting the silence as data. */
export const WABA_ANALYTICS_MAX_LOOKBACK_DAYS = 365;

/** Our own vocabulary. Mapped to each surface's enum spelling below, because
 *  Meta spells the same concept two ways across these four fields. */
export type WabaAnalyticsGranularity = "day" | "month";

/**
 * Granularity translation, isolated because it is a live trap.
 *
 * Messaging `analytics` takes `DAY`/`MONTH`; conversation, pricing and call
 * analytics take `DAILY`/`MONTHLY`. One letter apart, and the wrong spelling is
 * `#100 Invalid parameter` on every request rather than a graceful degradation.
 */
function messagingGranularity(g: WabaAnalyticsGranularity): "DAY" | "MONTH" {
  return g === "month" ? "MONTH" : "DAY";
}
function standardGranularity(g: WabaAnalyticsGranularity): "DAILY" | "MONTHLY" {
  return g === "month" ? "MONTHLY" : "DAILY";
}

export interface WabaAnalyticsQuery {
  from: Date;
  to: Date;
  granularity?: WabaAnalyticsGranularity;
  /** Limit to one of the workspace's WABAs. Absent = every one of them. */
  wabaAccountId?: string | null;
}

/** A time bucket of throughput. */
export interface MessagingPoint {
  start: string;
  sent: number;
  delivered: number;
  groupsSent: number | null;
  groupsDelivered: number | null;
}

/** Spend and volume for one (category, type, country) slice. */
export interface PricingSlice {
  category: string | null;
  type: string | null;
  country: string | null;
  phoneNumber: string | null;
  volume: number;
  cost: number | null;
}

/** Where an account sits on Meta's volume ladder for one market–category pair. */
export interface TierStanding {
  country: string | null;
  category: string | null;
  tier: string;
  /** Messages counted so far in this window against this pair. */
  volume: number;
  /** Inclusive upper bound, or null when the tier is unbounded (`MAX`). */
  upper: number | null;
  /** `upper - volume`, or null when unbounded. How many more messages buy the
   *  cheaper rate — the only actionable number on this whole surface. */
  toNextTier: number | null;
}

export interface ConversationSlice {
  category: string | null;
  type: string | null;
  direction: string | null;
  country: string | null;
  conversations: number;
  cost: number | null;
}

export interface CallSlice {
  direction: string | null;
  country: string | null;
  count: number;
  cost: number | null;
  /** Seconds, weighted by call count so a 1-call bucket can't outweigh a 500. */
  averageDurationSec: number | null;
}

/** One WABA's complete analytics block. */
export interface WabaAnalyticsAccount {
  wabaAccountId: string;
  externalWabaId: string;
  label: string | null;
  /** The denomination of every cost below. Null = Meta didn't report it. */
  currency: string | null;
  /** Meta's own answer, falling back to our stamp — see getInsightsStatus. */
  insightsEnabled: boolean;
  /**
   * Why this account has no figures, when it has none. A null block with no
   * reason is what makes a dashboard look broken; the reason is what makes it
   * trustworthy.
   */
  unavailable: string | null;
  messaging: MessagingPoint[];
  pricing: PricingSlice[];
  tiers: TierStanding[];
  conversations: ConversationSlice[];
  calls: CallSlice[];
  /** Totals over the window, for the headline tiles. */
  totals: {
    sent: number;
    delivered: number;
    /** Messages Meta BILLED for (pricing type `REGULAR`). */
    billableVolume: number;
    /** Delivered messages Meta did NOT charge for (any `FREE_*` type). */
    freeVolume: number;
    messagingCost: number | null;
    callCost: number | null;
    conversations: number;
    calls: number;
  };
  /**
   * True when Meta returned volume but withheld every cost figure — the
   * documented behaviour for a WABA billed through a Solution Partner. Lets the
   * UI say WHY the money column is blank instead of showing an unexplained dash
   * that reads as a bug in this code.
   */
  costWithheld: boolean;
}

export interface WabaAnalyticsResult {
  from: string;
  to: string;
  granularity: WabaAnalyticsGranularity;
  accounts: WabaAnalyticsAccount[];
  /** When this was pulled from Meta. Live figures behind a short cache, so the
   *  UI can state freshness rather than implying a realtime feed. */
  fetchedAt: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Short TTL cache in front of Graph.
 *
 * Meta's analytics move on a scale of hours and these reads are Business-Use-Case
 * rate limited (`GET /{waba-id}` is explicitly listed as subject to BUC limits),
 * so an operator flipping between date ranges must not spend the account's whole
 * budget. BOUNDED, not grow-only: a per-tenant cache with no eviction is the
 * recurring leak class in this codebase, so insertion beyond the cap evicts the
 * oldest key.
 */
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 200;
const cache = new Map<string, { at: number; value: WabaAnalyticsResult }>();

function cacheKey(workspaceId: string, q: Required<WabaAnalyticsQuery>): string {
  return [
    workspaceId,
    q.wabaAccountId ?? "*",
    q.granularity,
    q.from.toISOString(),
    q.to.toISOString(),
  ].join("|");
}

/** Drop every cached range for a workspace — used when an account is connected,
 *  disconnected or re-pointed, so the next read can't serve a stale account set. */
export function invalidateWabaAnalytics(workspaceId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${workspaceId}|`)) cache.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Every account-level analytics surface for a workspace, in one call.
 *
 * One round trip for the caller, four concurrent Graph reads per WABA. The four
 * are independent surfaces, so they run in parallel and each failure is isolated
 * to its own block: a calling permission the account doesn't have must not cost
 * the operator their spend report.
 */
export async function getWabaAnalytics(
  workspaceId: string,
  query: WabaAnalyticsQuery,
): Promise<WabaAnalyticsResult> {
  const granularity = query.granularity ?? "day";
  if (query.to < query.from) {
    throw new BadRequestException({ error: "invalid_range" });
  }
  // Clamp rather than reject: a UI offering "last 2 years" should return the
  // year Meta has, not an error the operator can't act on.
  const floor = new Date(Date.now() - WABA_ANALYTICS_MAX_LOOKBACK_DAYS * 86_400_000);
  const from = query.from < floor ? floor : query.from;
  const resolved = {
    from,
    to: query.to,
    granularity,
    wabaAccountId: query.wabaAccountId ?? null,
  };

  const key = cacheKey(workspaceId, resolved);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const wabas = await db.whatsappBusinessAccount.findMany({
    where: {
      workspaceId,
      ...(resolved.wabaAccountId ? { id: resolved.wabaAccountId } : {}),
    },
    select: {
      id: true,
      externalWabaId: true,
      label: true,
      insightsEnabledAt: true,
      // A WABA legitimately holds ZERO numbers (Embedded Signup's
      // FINISH_ONLY_WABA), and with no number there is no token to read with —
      // that is an `unavailable` reason, not an error.
      connections: {
        where: { channel: "whatsapp", isActive: true },
        // Deterministic: `take: 1` with no ordering let Postgres hand back any
        // number, so a dead token on an arbitrary sibling made the WHOLE WABA
        // report unavailable — non-deterministically, which reads as flaky rather
        // than broken. Shared rule, same as catalog-sync.
        orderBy: WABA_PROBE_ORDER,
        select: { id: true },
        take: 1,
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const accounts = await Promise.all(
    wabas.map((waba) => loadAccount(workspaceId, waba, resolved)),
  );

  const value: WabaAnalyticsResult = {
    from: resolved.from.toISOString(),
    to: resolved.to.toISOString(),
    granularity,
    accounts,
    fetchedAt: new Date().toISOString(),
  };

  // Bounded insert: evict the oldest key once at cap. Map preserves insertion
  // order, so the first key is the oldest.
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

const EMPTY_TOTALS: WabaAnalyticsAccount["totals"] = {
  sent: 0,
  delivered: 0,
  billableVolume: 0,
  freeVolume: 0,
  messagingCost: null,
  callCost: null,
  conversations: 0,
  calls: 0,
};

async function loadAccount(
  workspaceId: string,
  waba: {
    id: string;
    externalWabaId: string;
    label: string | null;
    insightsEnabledAt: Date | null;
    connections: Array<{ id: string }>;
  },
  q: Required<WabaAnalyticsQuery>,
): Promise<WabaAnalyticsAccount> {
  const base: WabaAnalyticsAccount = {
    wabaAccountId: waba.id,
    externalWabaId: waba.externalWabaId,
    label: waba.label,
    currency: null,
    insightsEnabled: !!waba.insightsEnabledAt,
    unavailable: null,
    messaging: [],
    pricing: [],
    tiers: [],
    conversations: [],
    calls: [],
    totals: { ...EMPTY_TOTALS },
    costWithheld: false,
  };

  const connectionId = waba.connections[0]?.id;
  if (!connectionId) {
    // Not a failure: an onboarded WABA with no phone number yet is a real,
    // documented state, and it has nothing to report on.
    return { ...base, unavailable: "This account has no connected phone number yet." };
  }

  const binding = getProviderBinding("whatsapp");
  const provider = binding.provider;
  let config: Awaited<ReturnType<typeof binding.getSendConfig>>;
  try {
    config = await binding.getSendConfig(workspaceId, connectionId);
  } catch (err) {
    // Carry the operator-actionable reason (missing WABA id, undecryptable
    // token) instead of collapsing every cause into an empty panel.
    return {
      ...base,
      unavailable: err instanceof Error ? err.message.slice(0, 200) : "Connection unavailable.",
    };
  }

  // Assert the join before reading. Every request below is built from
  // `config.wabaId`, so if the connection→WABA FK and the resolved send config ever
  // disagree we would authorize against a DIFFERENT WABA and then report the result
  // under THIS one's label — silently attributing one account's spend to another.
  // That is the §18 invariant ("a WABA's figures belong to the WABA they came from,
  // or to nothing"), and `catalog-sync` has always guarded it for the same reason.
  // `binding.getSendConfig` is typed against the generic provider binding, so it
  // widens; every other read of `config` in this function narrows the same way.
  const mismatch = wabaProbeMismatch(
    config as { wabaAccountId?: string | null; wabaId?: string | null },
    waba.id,
  );
  if (mismatch) {
    return { ...base, unavailable: mismatch };
  }

  const [messaging, pricing, conversations, calls, state] = await Promise.all([
    safe(() =>
      provider.fetchMessagingAnalytics?.(
        {
          start: q.from,
          end: q.to,
          granularity: messagingGranularity(q.granularity),
          // Deliberately NOT passing product_types: Meta returns every class
          // together when it is omitted, and the inbound class (100) cannot be
          // combined with the others anyway — asking for "all" by omission is
          // both correct and one request instead of two.
        },
        config,
      ),
    ),
    safe(() =>
      provider.fetchPricingAnalytics?.(
        {
          start: q.from,
          end: q.to,
          granularity: standardGranularity(q.granularity),
          // TIER is the reason this surface is worth a request. COUNTRY and
          // PRICING_CATEGORY come with it because a tier bound is only meaningful
          // for the market–category pair it belongs to.
          dimensions: ["PRICING_CATEGORY", "PRICING_TYPE", "COUNTRY", "TIER"],
        },
        config,
      ),
    ),
    safe(() =>
      provider.fetchConversationAnalytics?.(
        {
          start: q.from,
          end: q.to,
          granularity: standardGranularity(q.granularity),
          dimensions: ["CONVERSATION_CATEGORY", "CONVERSATION_TYPE", "CONVERSATION_DIRECTION"],
        },
        config,
      ),
    ),
    safe(() =>
      provider.fetchCallAnalytics?.(
        {
          start: q.from,
          end: q.to,
          granularity: standardGranularity(q.granularity),
          // DIRECTION is essential, not decorative: user-initiated calls are
          // always free, so without it a large count beside a zero cost reads as
          // a reporting failure rather than the correct answer.
          dimensions: ["DIRECTION", "COUNTRY"],
        },
        config,
      ),
    ),
    safe(() => provider.fetchTemplateInsightsState?.(config)),
  ]);

  // Every surface refused. Almost always one cause (token, permissions, region),
  // so report it once rather than four times.
  if (!messaging && !pricing && !conversations && !calls) {
    return { ...base, unavailable: "Meta returned no analytics for this account." };
  }

  const pricingSlices = (pricing ?? []).map((r) => ({
    category: r.category,
    type: r.type,
    country: r.country,
    phoneNumber: r.phoneNumber,
    volume: r.volume ?? 0,
    cost: r.cost,
  }));

  const messagingCost = sumNullable(pricingSlices.map((s) => s.cost));
  const callCost = sumNullable((calls ?? []).map((c) => c.cost));

  return {
    ...base,
    currency: state?.currency ?? null,
    insightsEnabled: state?.enabled ?? !!waba.insightsEnabledAt,
    messaging: (messaging ?? []).map((p) => ({
      start: p.start.toISOString(),
      sent: p.sent,
      delivered: p.delivered,
      groupsSent: p.groupsSent,
      groupsDelivered: p.groupsDelivered,
    })),
    pricing: pricingSlices,
    tiers: tierStandings(pricing ?? []),
    conversations: (conversations ?? []).map((r) => ({
      category: r.category,
      type: r.type,
      direction: r.direction,
      country: r.country,
      conversations: r.conversations ?? 0,
      cost: r.cost,
    })),
    calls: callSlices(calls ?? []),
    totals: {
      sent: (messaging ?? []).reduce((a, p) => a + p.sent, 0),
      delivered: (messaging ?? []).reduce((a, p) => a + p.delivered, 0),
      // `REGULAR` is the only billable pricing type; every `FREE_*` value is not.
      // Split rather than summed because "we sent 10k" and "we paid for 3k of
      // them" are the two numbers an operator actually compares.
      billableVolume: pricingSlices
        .filter((s) => s.type?.toUpperCase() === "REGULAR")
        .reduce((a, s) => a + s.volume, 0),
      freeVolume: pricingSlices
        .filter((s) => s.type?.toUpperCase().startsWith("FREE"))
        .reduce((a, s) => a + s.volume, 0),
      messagingCost,
      callCost,
      conversations: (conversations ?? []).reduce((a, r) => a + (r.conversations ?? 0), 0),
      calls: (calls ?? []).reduce((a, c) => a + (c.count ?? 0), 0),
    },
    // Volume arrived but not one cost figure did — the Solution-Partner case.
    costWithheld:
      pricingSlices.length > 0 &&
      pricingSlices.some((s) => s.volume > 0) &&
      pricingSlices.every((s) => s.cost === null),
  };
}

/**
 * Collapse pricing rows into one standing per (country, category).
 *
 * Meta repeats the tier bound on every data point of the window, so the same
 * pair appears once per day. Volume ADDS across those buckets while the bound
 * itself is a property of the pair, not of the day — taking the widest bound
 * seen keeps a mid-window tier promotion from reporting the old ceiling.
 *
 * Free rows are skipped entirely: Meta omits the tier for them because they do
 * not count toward tiering, and folding them in would inflate the progress bar
 * with messages that never move it.
 */
export function tierStandings(rows: Array<{
  country: string | null;
  category: string | null;
  volume: number | null;
  tier: string | null;
  tierUpper: number | null;
}>): TierStanding[] {
  const byPair = new Map<string, TierStanding>();
  for (const r of rows) {
    if (!r.tier) continue;
    // NUL separator, written as the escape — a literal NUL byte makes the whole
    // file read as binary to grep and git grep, which has already hidden one bug
    // from a repo-wide sweep in this codebase.
    const key = `${r.country ?? ""}\u0000${r.category ?? ""}`;
    const prev = byPair.get(key);
    if (prev) {
      prev.volume += r.volume ?? 0;
      if (r.tierUpper !== null && (prev.upper === null || r.tierUpper > prev.upper)) {
        prev.upper = r.tierUpper;
        prev.tier = r.tier;
      }
    } else {
      byPair.set(key, {
        country: r.country,
        category: r.category,
        tier: r.tier,
        volume: r.volume ?? 0,
        upper: r.tierUpper,
        toNextTier: null,
      });
    }
  }
  for (const standing of byPair.values()) {
    standing.toNextTier =
      standing.upper === null ? null : Math.max(0, standing.upper - standing.volume);
  }
  return [...byPair.values()];
}

/**
 * Collapse call rows into one slice per (direction, country).
 *
 * `average_duration` is an AVERAGE, so it cannot be summed. Re-weighting by call
 * count is the only honest merge — a plain mean would let a single 1-call bucket
 * count as much as a 500-call one and quietly halve the reported duration.
 */
export function callSlices(rows: Array<{
  direction: string | null;
  country: string | null;
  count: number | null;
  cost: number | null;
  averageDuration: number | null;
}>): CallSlice[] {
  const byPair = new Map<string, { slice: CallSlice; durationWeight: number; durationSum: number }>();
  for (const r of rows) {
    const key = `${r.direction ?? ""}\u0000${r.country ?? ""}`;
    const count = r.count ?? 0;
    const entry = byPair.get(key) ?? {
      slice: {
        direction: r.direction,
        country: r.country,
        count: 0,
        cost: null,
        averageDurationSec: null,
      },
      durationWeight: 0,
      durationSum: 0,
    };
    entry.slice.count += count;
    if (r.cost !== null) entry.slice.cost = (entry.slice.cost ?? 0) + r.cost;
    if (r.averageDuration !== null && count > 0) {
      entry.durationSum += r.averageDuration * count;
      entry.durationWeight += count;
    }
    byPair.set(key, entry);
  }
  return [...byPair.values()].map(({ slice, durationSum, durationWeight }) => ({
    ...slice,
    averageDurationSec: durationWeight > 0 ? durationSum / durationWeight : null,
  }));
}

/**
 * Sum a nullable metric: nulls contribute nothing, but an all-null set stays
 * null rather than collapsing to 0. "Meta withheld the cost" and "it cost
 * nothing" must never render identically — one is a gap, the other is a result.
 */
function sumNullable(values: Array<number | null>): number | null {
  let total = 0;
  let any = false;
  for (const v of values) {
    if (v !== null) {
      total += v;
      any = true;
    }
  }
  return any ? total : null;
}

/**
 * Run one provider read, returning null instead of throwing.
 *
 * Per-surface isolation is the point: these four are independent Graph calls,
 * and the common failures are per-surface (no calling permission, an
 * unsupported region, a partner-billed cost refusal). One of them failing must
 * degrade its own block, never the other three — a spend report lost because
 * the account can't place calls would be an outage we caused ourselves.
 */
async function safe<T>(run: () => Promise<T> | undefined): Promise<T | null> {
  try {
    const out = await run();
    return out ?? null;
  } catch (err) {
    console.warn(
      "[waba-analytics] surface unavailable:",
      err instanceof Error ? err.message.slice(0, 300) : err,
    );
    return null;
  }
}

/** Thrown shape kept for parity with the template-analytics reader, so callers
 *  handle one vocabulary across both halves of Meta analytics. */
export function wabaAnalyticsUnavailable(detail: string): never {
  throw new BadGatewayException({ error: "meta_analytics_fetch_failed", detail });
}
