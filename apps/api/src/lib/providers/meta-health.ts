/**
 * WhatsApp messaging-health (messaging-limit tier / quality / throughput).
 *
 * WhatsApp gates how many UNIQUE customers a business phone number may message in
 * a rolling 24h to its **messaging-limit tier** (1K → 10K → 100K → Unlimited),
 * earned via quality + volume ramp. A number also carries a **quality rating**
 * (GREEN/YELLOW/RED — RED risks a tier downgrade) and a **throughput level**
 * (STANDARD ~80 msg/s, HIGH up to ~1000 msg/s). None of this is knowable from a
 * send response; Meta exposes it on the phone-number node + pushes changes via
 * webhooks. We cache a snapshot on the team's WhatsApp `ChannelConnection` so a
 * large template broadcast can be gated on the number's real capacity BEFORE we
 * burn the audience on guaranteed failures, and the composer can show the
 * operator their remaining daily allowance.
 *
 * This is a best-effort ADVISORY layer: Meta remains the source of truth and the
 * runner still handles a real rate-limit at send time. A connection with no
 * snapshot (nulls) is simply ungated — never blocked.
 */

import { db } from "@/lib/db";
import { GRAPH_BASE, graphGetJson } from "./meta-graph";
import { getMetaSendConfig, invalidateProviderConfig } from "./config";
import { ProviderNotConfiguredError } from "./config";

/**
 * Normalized daily unique-recipient cap per Meta messaging-limit tier. `null` =
 * effectively unlimited (or unknown). These are Meta's published tier sizes; the
 * numbers are what the pre-send gate compares an audience against. Kept as a map
 * (not an enum) because Meta occasionally adds intermediate tiers — an unknown
 * tier string just yields `null` (ungated) rather than a crash.
 *
 * VERIFIED against Meta's live docs 2026-07-18:
 *   https://developers.facebook.com/docs/whatsapp/messaging-limits/
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/upcoming-messaging-limits-changes/
 *
 * Three facts from that pass worth keeping in view:
 *
 *  1. The ladder changed on **2025-10-07**: it is now 250 → 2K → 10K → 100K →
 *     Unlimited. `TIER_1K` is gone (the auto-scale threshold moved 1,000 →
 *     2,000) and upgrades land within ~6h instead of 24h.
 *
 *  2. **Limits are per business PORTFOLIO, shared by every phone number in it** —
 *     not per number, as they were before 2025-10-07. We store the cap on the
 *     per-team `ChannelConnection`, which is correct for the one-number-per-team
 *     shape we actually have, but it means the budget gate is OPTIMISTIC for a
 *     customer running several numbers inside one portfolio: their real
 *     remaining allowance is the portfolio's, and our per-number view can't see
 *     the other numbers' spend. Meta still enforces the true limit, so the
 *     failure mode is a rejected send, not an overcharge. Closing this needs the
 *     `whatsapp_business_manager_messaging_limit` field at portfolio scope.
 *
 *  3. The **`FLAGGED` phone-number quality state no longer exists**, and a
 *     quality drop no longer downgrades a messaging limit. Quality still matters
 *     for reputation, but it is no longer a mechanism that shrinks the cap
 *     mid-campaign.
 */
const TIER_DAILY_CAP: Record<string, number | null> = {
  TIER_50: 50,
  TIER_250: 250,
  // TIER_1K is LEGACY — Meta's 2025-10-07 messaging-limits change moved the
  // auto-scaling threshold from 1,000 to 2,000, so 1K is no longer a tier a
  // number can currently sit at. Kept in the map (not deleted) so a stale
  // snapshot taken before that change still sizes correctly instead of
  // normalizing to null and going ungated.
  TIER_1K: 1_000,
  TIER_2K: 2_000,
  TIER_10K: 10_000,
  TIER_100K: 100_000,
  TIER_UNLIMITED: null,
};

/** Snapshot shape read back for the gate + UI. */
export interface WhatsappHealthSnapshot {
  messagingTier: string | null;
  /** Derived numeric 24h unique-recipient cap for the tier; null = unlimited/unknown. */
  messagingDailyCap: number | null;
  qualityRating: string | null;
  throughputLevel: string | null;
  messagingHealthUpdatedAt: Date | null;
  /** The portfolio the cap belongs to — the scope its 24h budget is shared over. */
  portfolioId: string | null;
}

/** A partial update — a webhook carries only the field(s) that changed. */
export interface WhatsappHealthUpdate {
  messagingTier?: string | null;
  qualityRating?: string | null;
  throughputLevel?: string | null;
  /**
   * Calling enforcement. `null` clears a stored restriction/warning (the
   * provider lifted it); `undefined` leaves it untouched, because these events
   * carry partial state and a messaging-tier update must not wipe a live
   * calling restriction.
   */
  callingRestrictedUntil?: Date | null;
  callingRestrictionType?: string | null;
  callingRestrictionReason?: string | null;
  callingQualityWarning?: string | null;
}

/**
 * Canonicalize whatever tier representation Meta hands us into a `TIER_*` key.
 * The phone-number node returns `messaging_limit_tier` as `TIER_1K` etc; the
 * `phone_number_quality_update` webhook uses `current_limit` with the SAME
 * vocabulary; some legacy payloads send a bare number ("1000"). Returns null for
 * anything unrecognized so the caller stores null (ungated) rather than a bad key.
 */
export function normalizeMessagingTier(raw: unknown): string | null {
  if (typeof raw === "number") return numberToTier(raw);
  if (typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase();
  if (s.length === 0) return null;
  // Already a TIER_* key we know.
  if (s in TIER_DAILY_CAP) return s;
  if (s === "UNLIMITED" || s === "TIER_UNLIMITED") return "TIER_UNLIMITED";
  // "2K"/"10K"/"100K" shorthand, with or without the TIER_ prefix. The prefix
  // must be optional: Meta's own vocabulary is `TIER_2K`, and a regex anchored
  // without it silently failed to parse EVERY prefixed tier not already in the
  // map above — which meant an unrecognised tier normalized to null and left
  // the number completely ungated rather than conservatively capped.
  const kMatch = s.match(/^(?:TIER_)?(\d+)\s*K$/);
  if (kMatch) return numberToTier(Number(kMatch[1]) * 1_000);
  const nMatch = s.match(/^(?:TIER_)?(\d+)$/);
  if (nMatch) return numberToTier(Number(nMatch[1]));
  return null;
}

/**
 * Map a raw cap number onto the tier at or above it.
 *
 * Buckets follow Meta's post-2025-10-07 ladder — 250 → 2K → 10K → 100K →
 * Unlimited. Each bucket rounds a number UP to the tier whose cap covers it,
 * so an unfamiliar intermediate value is never sized ABOVE its real allowance.
 * (The pre-fix version had a 1,000 bucket and none at 2,000, so a genuine
 * 2,000-cap number fell into `n <= 10_000` and was sized as TIER_10K — a 5x
 * over-estimate that would wave a 10k campaign through on a 2k number.)
 */
function numberToTier(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n <= 50) return "TIER_50";
  if (n <= 250) return "TIER_250";
  if (n <= 1_000) return "TIER_1K";
  if (n <= 2_000) return "TIER_2K";
  if (n <= 10_000) return "TIER_10K";
  if (n <= 100_000) return "TIER_100K";
  return "TIER_UNLIMITED";
}

/** Numeric cap for a normalized tier key; null = unlimited/unknown. */
export function tierDailyCap(tier: string | null): number | null {
  if (!tier) return null;
  return TIER_DAILY_CAP[tier] ?? null;
}

/** Normalize a quality band to GREEN/YELLOW/RED (or null). */
export function normalizeQualityRating(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase();
  return s === "GREEN" || s === "YELLOW" || s === "RED" ? s : null;
}

/** Normalize a throughput level to STANDARD/HIGH (or null). */
export function normalizeThroughputLevel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase();
  return s === "STANDARD" || s === "HIGH" ? s : null;
}

/**
 * Merge a partial health update onto the team's WhatsApp ChannelConnection.
 * Only the fields present in `update` are written (a webhook that carries only a
 * new tier must not blank the quality band). `messagingDailyCap` is re-derived
 * whenever the tier changes. Best-effort: a missing connection is a no-op.
 * Invalidates the provider-config cache so a fresh eligibility read reflects it.
 */
export async function persistWhatsappHealth(
  workspaceId: string,
  update: WhatsappHealthUpdate,
): Promise<void> {
  const data: {
    messagingTier?: string | null;
    messagingDailyCap?: number | null;
    qualityRating?: string | null;
    throughputLevel?: string | null;
    callingRestrictedUntil?: Date | null;
    callingRestrictionType?: string | null;
    callingRestrictionReason?: string | null;
    callingQualityWarning?: string | null;
    messagingHealthUpdatedAt: Date;
  } = { messagingHealthUpdatedAt: new Date() };

  let touched = false;
  // The messaging limit is PORTFOLIO-scoped; it is written separately below
  // (a per-number write would let one portfolio's budget be recorded N times).
  let portfolioTier: string | null | undefined;
  if (update.messagingTier !== undefined) {
    portfolioTier = update.messagingTier ? normalizeMessagingTier(update.messagingTier) : null;
    touched = true;
  }
  if (update.qualityRating !== undefined) {
    data.qualityRating = update.qualityRating
      ? normalizeQualityRating(update.qualityRating)
      : null;
    touched = true;
  }
  if (update.throughputLevel !== undefined) {
    data.throughputLevel = update.throughputLevel
      ? normalizeThroughputLevel(update.throughputLevel)
      : null;
    touched = true;
  }
  // Calling enforcement. A restriction arrives with its own expiry and clears
  // the earlier warning that preceded it — by the time calling is paused, the
  // "quality is slipping" nudge is no longer the actionable message.
  if (update.callingRestrictedUntil !== undefined) {
    data.callingRestrictedUntil = update.callingRestrictedUntil;
    data.callingRestrictionType = update.callingRestrictionType ?? null;
    data.callingRestrictionReason = update.callingRestrictionReason ?? null;
    data.callingQualityWarning = null;
    touched = true;
  }
  if (update.callingQualityWarning !== undefined) {
    data.callingQualityWarning = update.callingQualityWarning;
    touched = true;
  }
  if (!touched) return;

  if (portfolioTier !== undefined) {
    const portfolioData = {
      messagingTier: portfolioTier,
      messagingDailyCap: tierDailyCap(portfolioTier),
      messagingHealthUpdatedAt: new Date(),
    };
    const updated = await db.whatsappPortfolio.updateMany({
      where: { connections: { some: { workspaceId, channel: "whatsapp" } } },
      data: portfolioData,
    });
    // Self-healing: a workspace whose WhatsApp account predates the portfolio
    // table (or was connected without one) has nothing to update, and silently
    // dropping the tier here would leave the pre-send gate permanently ungated.
    // Mint the portfolio and attach every WhatsApp account to it.
    if (updated.count === 0) {
      const created = await db.whatsappPortfolio.create({
        data: { workspaceId, ...portfolioData },
        select: { id: true },
      });
      await db.channelConnection.updateMany({
        where: { workspaceId, channel: "whatsapp", portfolioId: null },
        data: { portfolioId: created.id },
      });
    }
  }

  const res = await db.channelConnection.updateMany({
    where: { workspaceId, channel: "whatsapp" },
    data,
  });
  if (res.count > 0) {
    // The eligibility read below goes through the provider-config cache path;
    // bust it so a just-changed tier is reflected immediately.
    invalidateProviderConfig(workspaceId);
  }
}

/** Result of a broadcast eligibility check against the number's messaging tier. */
export interface BroadcastEligibility {
  /** Whether the send is allowed to proceed (false only on a hard tier overage). */
  allowed: boolean;
  /** Human, actionable reason when blocked or when there's an advisory concern. */
  reason: string | null;
  /** Whether the audience exceeds the number's 24h messaging-limit cap. */
  exceedsCap: boolean;
  /** The number's messaging tier snapshot (null when unknown → ungated). */
  messagingTier: string | null;
  messagingDailyCap: number | null;
  qualityRating: string | null;
  /** Whether we had a tier snapshot at all — false = advisory-only (ungated). */
  hasSnapshot: boolean;
  audienceSize: number;
  /**
   * Unique customers this number has ALREADY messaged in the trailing 24h, from
   * broadcasts. The tier cap applies to a rolling window across every send, not
   * per campaign, so this is what makes `audienceSize <= cap` an honest check
   * rather than one that passes three 40k campaigns against a 100k cap.
   * Null when there is no cap to measure against (unknown tier / unlimited).
   */
  recentUniqueRecipients: number | null;
  /** `cap - recentUniqueRecipients`, floored at 0. Null when uncapped. */
  remainingDailyBudget: number | null;
}

/**
 * How far back to count toward the rolling 24h messaging limit.
 * Meta's window is rolling, not calendar-day — a send at 23:00 still occupies
 * budget at 09:00 the next morning.
 */
const ROLLING_WINDOW_HOURS = 24;
/**
 * How far back to look for broadcasts that might still have recipients inside
 * the rolling window. Wider than the window itself ON PURPOSE: a 100k campaign
 * takes 1–3 hours and a paused/resumed one can span far longer, so a broadcast
 * created well before the window can still be stamping `sentAt` inside it.
 */
const BROADCAST_LOOKBACK_HOURS = 72;

/**
 * Count the UNIQUE customers this team has messaged on WhatsApp in the trailing
 * rolling window, as counted against the number's messaging limit.
 *
 * SCOPE, stated honestly: this counts BROADCAST recipients only. Template sends
 * driven by a workflow or the /v1 API also consume Meta's real budget but are
 * not counted here, so this is a LOWER BOUND — it can under-report, never
 * over-report. That's the safe direction for a gate (it will not block a send
 * Meta would have accepted), and broadcasts are the dominant source of
 * business-initiated volume by orders of magnitude. Widening it to all template
 * sends needs a template marker on `Message`, which does not exist today.
 *
 * Two-step rather than one join so it rides existing indexes: `[workspaceId,
 * createdAt desc]` on Broadcast, then the `broadcastId`-leading indexes on
 * BroadcastRecipient. Runs once per broadcast creation, not per message.
 */
export async function countRecentUniqueRecipients(
  workspaceId: string,
  portfolioId?: string | null,
): Promise<number> {
  const ids = await recentUniqueRecipientIds(workspaceId, portfolioId);
  return ids.size;
}

/**
 * The actual SET of contacts messaged in the rolling window, not just its size.
 *
 * The set — rather than a count — is what makes the gate correct for a REPEAT
 * campaign. Meta charges budget per unique customer per window, so re-messaging
 * someone already inside the window costs nothing extra. Comparing a raw
 * audience size against `cap - used` double-counts them and refuses a send Meta
 * would happily accept (see `checkBroadcastEligibility`).
 *
 * `groupBy` rather than `findMany({ distinct })`: distinct materializes one row
 * object per unique recipient in the client, and this runs on the composer's
 * polling path, so a TIER_100K team would repeatedly pull ~100k objects into
 * heap on an 8GB box. groupBy aggregates server-side.
 */
async function recentUniqueRecipientIds(
  workspaceId: string,
  /**
   * The portfolio whose budget we're counting. Meta's 24h limit is shared by
   * EVERY number in a portfolio, so the count spans all of its accounts — but it
   * must NOT span a second portfolio in the same workspace, which has its own
   * independent budget. Null = count the whole workspace (the pre-portfolio
   * behaviour, and correct while a workspace has one portfolio).
   */
  portfolioId?: string | null,
): Promise<Set<string>> {
  const now = Date.now();
  const recent = await db.broadcast.findMany({
    where: {
      workspaceId,
      // Scope to the portfolio's accounts. A broadcast with no account stamped
      // (pre-multi-account) is counted too: it went out the number that existed
      // at the time, which is in this portfolio.
      ...(portfolioId
        ? {
            OR: [
              { channelConnection: { portfolioId } },
              { channelConnectionId: null },
            ],
          }
        : {}),
      // Contact-mode WhatsApp sends only. A `targetMode: "customer"` broadcast
      // stores `channel: "whatsapp"` as an inert default while routing each
      // recipient to their best channel, so counting those would charge
      // Messenger/Instagram deliveries against the WhatsApp number's budget and
      // falsely block later sends.
      channel: "whatsapp",
      targetMode: { not: "customer" },
      createdAt: { gte: new Date(now - BROADCAST_LOOKBACK_HOURS * 3_600_000) },
    },
    select: { id: true },
  });
  if (recent.length === 0) return new Set();

  const rows = await db.broadcastRecipient.groupBy({
    by: ["contactId"],
    where: {
      broadcastId: { in: recent.map((b) => b.id) },
      sentAt: { gte: new Date(now - ROLLING_WINDOW_HOURS * 3_600_000) },
    },
  });
  return new Set(rows.map((r) => r.contactId));
}

/**
 * Evaluate whether a WhatsApp template broadcast of `audienceSize` recipients is
 * within the number's messaging-limit tier. This is the pre-send eligibility
 * gate: WhatsApp caps how many UNIQUE customers a number may message per rolling
 * 24h to its tier, and a marketing blast past that just burns the audience on
 * guaranteed 131xxx failures AND drags the number's quality rating down.
 *
 *  - No snapshot (never polled / not connected) → `allowed: true`, `hasSnapshot:
 *    false`: we don't block on missing data; Meta still enforces the real limit.
 *  - Unlimited tier (cap null) → allowed.
 *  - audienceSize > cap → `allowed: false` with an actionable reason.
 *  - A RED quality band is surfaced as an advisory `reason` even when allowed.
 *
 * Read-only + cheap (one indexed row read). Used by the create gate AND the
 * composer preview endpoint.
 */
export async function checkBroadcastEligibility(
  workspaceId: string,
  audienceSize: number,
  /**
   * The audience's contact ids. Optional, but pass them whenever you have them:
   * without it the gate assumes every recipient is NEW to the rolling window,
   * which over-charges a repeat campaign and refuses sends Meta would accept.
   * See the overlap note below.
   */
  audienceContactIds?: readonly string[],
): Promise<BroadcastEligibility> {
  const health = await getWhatsappHealth(workspaceId);
  const base: BroadcastEligibility = {
    allowed: true,
    reason: null,
    exceedsCap: false,
    messagingTier: health?.messagingTier ?? null,
    messagingDailyCap: health?.messagingDailyCap ?? null,
    qualityRating: health?.qualityRating ?? null,
    hasSnapshot: !!health && health.messagingHealthUpdatedAt !== null,
    audienceSize,
    recentUniqueRecipients: null,
    remainingDailyBudget: null,
  };
  const cap = health?.messagingDailyCap ?? null;
  if (cap === null) return base;

  // Only pay for the usage query when there IS a cap to compare it against.
  const alreadyMessaged = await recentUniqueRecipientIds(workspaceId, health?.portfolioId);
  const used = alreadyMessaged.size;
  const remaining = Math.max(0, cap - used);

  // How many of THIS audience are new to the window. Meta's cap counts unique
  // customers, so a recipient already inside the window costs no additional
  // budget — re-messaging the same 1,800 people at 14:00 that you messaged at
  // 09:00 consumes 1,800 of the cap in total, not 3,600. Comparing raw
  // `audienceSize` against `remaining` double-counted them and hard-refused a
  // legitimate follow-up campaign with "Meta would reject roughly 1,600".
  //
  // Without ids we cannot compute the overlap, so we fall back to treating the
  // whole audience as new: that over-estimates consumption and can only ever
  // block too eagerly, never wave through a send Meta would reject.
  const newUniques = audienceContactIds
    ? audienceContactIds.reduce((n, id) => (alreadyMessaged.has(id) ? n : n + 1), 0)
    : audienceSize;
  const withUsage: BroadcastEligibility = {
    ...base,
    recentUniqueRecipients: used,
    remainingDailyBudget: remaining,
  };
  const tier = health?.messagingTier ?? "current";

  if (audienceSize > cap) {
    return {
      ...withUsage,
      allowed: false,
      exceedsCap: true,
      reason:
        `This number can message ${cap.toLocaleString()} unique customers per 24h ` +
        `(${tier} tier), but this audience is ` +
        `${audienceSize.toLocaleString()}. Meta will reject the excess — split the ` +
        `send across days, reduce the audience, or raise your messaging limit with Meta first.`,
    };
  }
  // The audience fits the cap on its own, but not alongside what this number has
  // ALREADY sent in the rolling window. Without this branch, three 40k campaigns
  // each pass a 100k cap and Meta silently rejects the last ~20k — and those
  // rejections get bucketed as "retryable", telling the operator to retry into
  // an exhausted budget.
  if (newUniques > remaining) {
    const overlap = audienceSize - newUniques;
    const alreadyCounted =
      overlap > 0
        ? ` ${overlap.toLocaleString()} of them were already messaged in this window and cost no extra allowance, but`
        : "";
    return {
      ...withUsage,
      allowed: false,
      exceedsCap: true,
      reason:
        `This number has already messaged ${used.toLocaleString()} unique customers in ` +
        `the last 24h, leaving ${remaining.toLocaleString()} of its ${cap.toLocaleString()} ` +
        `${tier}-tier allowance. This audience is ${audienceSize.toLocaleString()};` +
        `${alreadyCounted} Meta would reject roughly ` +
        `${(newUniques - remaining).toLocaleString()} of them. ` +
        `Wait for the window to roll over, reduce the audience, or raise your messaging ` +
        `limit with Meta first.`,
    };
  }
  if (withUsage.qualityRating === "RED") {
    return {
      ...withUsage,
      reason:
        "This number's quality rating is RED — sending a large marketing blast now " +
        "risks a further downgrade or block. Consider warming up with a smaller, " +
        "high-engagement send first.",
    };
  }
  return withUsage;
}

/** Read the current snapshot for the team's WhatsApp connection (null if none). */
export async function getWhatsappHealth(
  workspaceId: string,
): Promise<WhatsappHealthSnapshot | null> {
  const row = await db.channelConnection.findFirst({
    where: { workspaceId, channel: "whatsapp", isDefault: true },
    select: {
      qualityRating: true,
      throughputLevel: true,
      messagingHealthUpdatedAt: true,
      portfolioId: true,
      // The 24h messaging limit is PORTFOLIO-scoped since 2025-10-07 (shared by
      // every number in the portfolio), so tier + cap come off the portfolio,
      // not this number. Quality + throughput above stay per-number.
      portfolio: { select: { messagingTier: true, messagingDailyCap: true } },
    },
  });
  if (!row) return null;
  return {
    messagingTier: row.portfolio?.messagingTier ?? null,
    messagingDailyCap: row.portfolio?.messagingDailyCap ?? null,
    qualityRating: row.qualityRating,
    throughputLevel: row.throughputLevel,
    messagingHealthUpdatedAt: row.messagingHealthUpdatedAt,
    portfolioId: row.portfolioId,
  };
}

/**
 * Pull the current messaging-limit tier / quality / throughput from the Graph
 * phone-number node and persist it. Called on connect + a periodic sweep so a
 * team that connected before the webhooks were subscribed still gets a snapshot.
 * Best-effort — throws are swallowed by callers; a not-configured team is a
 * silent no-op. Idempotent.
 */
export async function fetchWhatsappHealthFromGraph(workspaceId: string): Promise<void> {
  let config;
  try {
    config = await getMetaSendConfig(workspaceId);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) return; // not connected — nothing to poll
    throw err;
  }
  const url =
    `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}` +
    `?fields=messaging_limit_tier,quality_rating,throughput`;
  // Idempotent GET — one retry on a 5xx blip. No appsecret_proof (matches the
  // send path default); the token alone authorizes a read of the number's own node.
  const node = await graphGetJson(url, config.accessToken, { retry: true });

  const throughput = node.throughput;
  const throughputLevel =
    throughput && typeof throughput === "object"
      ? (throughput as { level?: unknown }).level
      : undefined;

  await persistWhatsappHealth(workspaceId, {
    messagingTier: (node.messaging_limit_tier as string | undefined) ?? null,
    qualityRating: (node.quality_rating as string | undefined) ?? null,
    throughputLevel: (throughputLevel as string | undefined) ?? null,
  });
}
