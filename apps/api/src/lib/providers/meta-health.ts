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
 *     not per number, as they were before 2025-10-07. We model exactly that:
 *     the tier/cap live on `WhatsappPortfolio` (one row per Meta portfolio,
 *     shared by every `ChannelConnection` under it), populated by
 *     `linkWhatsappPortfolio` reading `owner_business_info` +
 *     `whatsapp_business_manager_messaging_limit` at portfolio scope. The gate
 *     remains OPTIMISTIC in one documented way: the usage counter only sees
 *     BROADCAST sends (see `recentUniqueRecipientIds`), so workflow//v1/direct
 *     template sends spend Meta budget uncounted. Meta still enforces the true
 *     limit, so the failure mode is a rejected send, not an overcharge.
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
  /** Meta's own portfolio id, once resolved. Null until a token with
   *  `business_management` has read `owner_business_info`. */
  externalPortfolioId: string | null;
  /** How many WhatsApp accounts share this portfolio's 24h budget. The number
   *  that makes "7,850 of 10,000 remaining" legible when it isn't just yours. */
  portfolioAccountCount: number;
  /** Meta's raw `verification_status` for the portfolio. Drives the TEMPLATE
   *  limit (see {@link portfolioTemplateLimit}), not the messaging limit. */
  verificationStatus: string | null;
  /** A WhatsApp Business policy violation Meta reported, and when we saw it. */
  policyViolationType?: string | null;
  policyViolationAt?: Date | null;
}

/**
 * How many templates each WABA under this portfolio may hold.
 *
 * Meta scopes the template limit to the parent BUSINESS PORTFOLIO: an
 * unverified portfolio caps every one of its WABAs at 250 templates; a verified
 * one raises that to 6,000 — provided at least one of its WABAs also has a
 * business phone number with an APPROVED DISPLAY NAME.
 *
 * That second condition is not readable from any single node we already fetch,
 * so the verified figure is an upper bound, not a promise. The UI says "up to"
 * and treats the number as a headroom cue, never as a hard gate — Meta is the
 * authority and rejects at the real limit with its own error.
 */
export function portfolioTemplateLimit(verificationStatus: string | null): number {
  return verificationStatus === "verified" ? 6_000 : 250;
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
  policyViolationType?: string | null;
}

/**
 * Canonicalize whatever tier representation Meta hands us into a `TIER_*` key.
 * Every source uses a different spelling of the same ladder:
 *   - `whatsapp_business_manager_messaging_limit` (the current field, on the
 *     portfolio / WABA / phone-number node) → `TIER_250`, `TIER_2K`, …
 *   - `messaging_limit_tier` on the phone-number node → same vocabulary, but
 *     DEPRECATED;
 *   - `max_daily_conversations_per_business` on either health webhook → a bare
 *     number (2000 | 10000 | 100000) or the string `UNLIMITED`;
 *   - `current_limit` on `phone_number_quality_update` → same vocabulary, but it
 *     now carries EITHER the limit or the number's throughput level, so an
 *     unrecognized value must return null rather than guess.
 * Returns null for anything unrecognized so the caller stores null (ungated)
 * rather than a bad key.
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
  /**
   * The ACCOUNT this health signal is about.
   *
   * Load-bearing since a workspace may hold several WhatsApp numbers: quality
   * rating, throughput and calling restrictions are all genuinely PER-NUMBER,
   * so writing them workspace-wide would let a quality drop on the US Sales
   * line mark UK Sales and Support degraded too — and, worse, let a calling
   * restriction on one number silently block calls on the others.
   *
   * Omitted (the pre-multi-account shape) still writes workspace-wide, which
   * is correct for the single-number case and for a signal we genuinely can't
   * attribute to one account.
   */
  channelConnectionId?: string | null,
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
    policyViolationType?: string | null;
    policyViolationAt?: Date | null;
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
  if (update.policyViolationType !== undefined) {
    data.policyViolationType = update.policyViolationType;
    // Meta's violation payload carries no timestamp, so observation time is
    // what we have — and "when did this land" is the question an operator asks.
    data.policyViolationAt = update.policyViolationType ? new Date() : null;
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
      // The portfolio owning THIS account. Unscoped, a tier update for one
      // portfolio would overwrite every other portfolio in the workspace —
      // each of which has its own independent 24h budget.
      where: {
        connections: {
          some: {
            workspaceId,
            channel: "whatsapp",
            ...(channelConnectionId ? { id: channelConnectionId } : {}),
          },
        },
      },
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
    // Narrow to the one account when we know which it is — see the param doc.
    where: {
      workspaceId,
      channel: "whatsapp",
      ...(channelConnectionId ? { id: channelConnectionId } : {}),
    },
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
  /**
   * The account this campaign sends FROM. Load-bearing: the 24h budget belongs
   * to that number's portfolio, not to whichever account happens to be the
   * channel default. Omit only when the caller genuinely has no account yet.
   */
  channelConnectionId?: string | null,
): Promise<BroadcastEligibility> {
  const health = await getWhatsappHealth(workspaceId, channelConnectionId);
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

/**
 * Read the messaging-health snapshot for ONE WhatsApp account.
 *
 * `channelConnectionId` selects the account; omitting it falls back to the
 * channel DEFAULT, which is right for a workspace with one number and for
 * surfaces that genuinely describe "the default" (compose-new, the settings
 * summary).
 *
 * Passing it is REQUIRED wherever the answer changes per number — above all the
 * broadcast gate. Quality and throughput are per-number, and the 24h cap is per
 * PORTFOLIO, so a campaign sent from the second number was being gated against
 * the first number's portfolio budget: either refused while it had headroom, or
 * waved through against a budget it did not own.
 */
export async function getWhatsappHealth(
  workspaceId: string,
  channelConnectionId?: string | null,
): Promise<WhatsappHealthSnapshot | null> {
  const row = await db.channelConnection.findFirst({
    where: channelConnectionId
      ? { id: channelConnectionId, workspaceId, channel: "whatsapp" }
      : { workspaceId, channel: "whatsapp", isDefault: true },
    select: {
      qualityRating: true,
      throughputLevel: true,
      messagingHealthUpdatedAt: true,
      policyViolationType: true,
      policyViolationAt: true,
      portfolioId: true,
      // The 24h messaging limit is PORTFOLIO-scoped since 2025-10-07 (shared by
      // every number in the portfolio), so tier + cap come off the portfolio,
      // not this number. Quality + throughput above stay per-number.
      portfolio: {
        select: {
          messagingTier: true,
          messagingDailyCap: true,
          externalPortfolioId: true,
          verificationStatus: true,
          _count: { select: { connections: true } },
        },
      },
    },
  });
  if (!row) return null;
  return {
    messagingTier: row.portfolio?.messagingTier ?? null,
    messagingDailyCap: row.portfolio?.messagingDailyCap ?? null,
    qualityRating: row.qualityRating,
    throughputLevel: row.throughputLevel,
    policyViolationType: row.policyViolationType,
    policyViolationAt: row.policyViolationAt,
    messagingHealthUpdatedAt: row.messagingHealthUpdatedAt,
    portfolioId: row.portfolioId,
    externalPortfolioId: row.portfolio?.externalPortfolioId ?? null,
    portfolioAccountCount: row.portfolio?._count.connections ?? 0,
    verificationStatus: row.portfolio?.verificationStatus ?? null,
  };
}

/**
 * Discover and link the BUSINESS PORTFOLIO that owns a WABA.
 *
 * Meta moved the 24h messaging limit from the phone NUMBER to the business
 * PORTFOLIO on 2025-10-07, so the budget is shared by every number under one
 * portfolio. `WhatsappPortfolio` models that, but nothing populated its
 * `externalPortfolioId` — the row was only ever minted as a local container by
 * the self-healing path in `persistWhatsappHealth`. That works while a
 * workspace has ONE portfolio and breaks the moment it has two: both numbers'
 * accounts would share a single local row and appear to share a budget they
 * don't actually share.
 *
 * Two reads, both cheap and idempotent:
 *   1. `/{wabaId}?fields=owner_business_info` → the portfolio's real id.
 *   2. `/{portfolioId}?fields=whatsapp_business_manager_messaging_limit`
 *      → the portfolio-scoped tier.
 *
 * Best-effort by design: a token without `business_management` cannot read the
 * portfolio node, and that must degrade to "no portfolio id yet" rather than
 * failing the connect flow. The caller keeps whatever tier it already had.
 */
export async function linkWhatsappPortfolio(
  workspaceId: string,
  channelConnectionId: string,
  wabaId: string,
  accessToken: string,
  graphVersion: string,
): Promise<{ portfolioId: string; externalPortfolioId: string } | null> {
  let externalPortfolioId: string | null = null;
  try {
    const owner = await graphGetJson(
      `${GRAPH_BASE}/${graphVersion}/${encodeURIComponent(wabaId)}?fields=owner_business_info`,
      accessToken,
      { retry: true },
    );
    const info = owner.owner_business_info;
    if (info && typeof info === "object") {
      const id = (info as { id?: unknown }).id;
      if (typeof id === "string" && id.length > 0) externalPortfolioId = id;
    }
  } catch {
    // No `business_management` scope, or Meta is having a moment. Not fatal —
    // the connection keeps working, it just isn't portfolio-attributed yet and
    // the next health sweep retries.
    return null;
  }
  if (!externalPortfolioId) return null;

  // The portfolio-scoped tier. Separate try: knowing WHICH portfolio a number
  // belongs to is valuable on its own, so a failure to read the limit must not
  // discard the id we just resolved.
  let tier: string | null = null;
  // Portfolio verification decides the TEMPLATE limit (250 unverified vs up to
  // 6,000 verified, per WABA), so it rides along on the same node read rather
  // than costing a second round trip.
  let verificationStatus: string | null = null;
  try {
    const node = await graphGetJson(
      `${GRAPH_BASE}/${graphVersion}/${encodeURIComponent(externalPortfolioId)}` +
        `?fields=whatsapp_business_manager_messaging_limit,verification_status`,
      accessToken,
      { retry: true },
    );
    tier = normalizeMessagingTier(node.whatsapp_business_manager_messaging_limit);
    const vs = node.verification_status;
    if (typeof vs === "string" && vs.length > 0) verificationStatus = vs.toLowerCase();
  } catch {
    tier = null;
  }

  // Upsert on the real Meta id, so two numbers in the same portfolio converge
  // on ONE row (and correctly share a budget) while numbers in different
  // portfolios stay independent.
  const portfolio = await db.whatsappPortfolio.upsert({
    where: { workspaceId_externalPortfolioId: { workspaceId, externalPortfolioId } },
    create: {
      workspaceId,
      externalPortfolioId,
      ...(tier ? { messagingTier: tier, messagingDailyCap: tierDailyCap(tier) } : {}),
      ...(verificationStatus ? { verificationStatus } : {}),
      messagingHealthUpdatedAt: new Date(),
    },
    // A null tier must NOT clobber a good stored one — a scope-less token would
    // otherwise wipe the cap on every sweep and leave the gate permanently open.
    // Same rule for verificationStatus, for the same reason.
    update: {
      ...(tier ? { messagingTier: tier, messagingDailyCap: tierDailyCap(tier) } : {}),
      ...(verificationStatus ? { verificationStatus } : {}),
      messagingHealthUpdatedAt: new Date(),
    },
    select: { id: true },
  });

  await db.channelConnection.updateMany({
    where: { id: channelConnectionId, workspaceId },
    data: { portfolioId: portfolio.id },
  });
  invalidateProviderConfig(workspaceId);

  return { portfolioId: portfolio.id, externalPortfolioId };
}

/**
 * Pull the current messaging-limit tier / quality / throughput from the Graph
 * phone-number node and persist it. Called on connect + a periodic sweep so a
 * team that connected before the webhooks were subscribed still gets a snapshot.
 * Best-effort — throws are swallowed by callers; a not-configured team is a
 * silent no-op. Idempotent.
 *
 * `channelConnectionId` names WHICH number to poll. Every production caller
 * passes it: with several active numbers, omitting it makes `getMetaSendConfig`
 * refuse (`account-unresolved`) and this function silently no-ops — which is
 * the correct fail-safe, but it means "poll the workspace" is only meaningful
 * for single-account workspaces.
 */
export async function fetchWhatsappHealthFromGraph(
  workspaceId: string,
  channelConnectionId?: string | null,
): Promise<void> {
  let config;
  try {
    config = await getMetaSendConfig(workspaceId, channelConnectionId);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) return; // not connected — nothing to poll
    throw err;
  }
  // `whatsapp_business_manager_messaging_limit` is the CURRENT field — Meta
  // deprecated `messaging_limit_tier`, which is what this used to ask for alone.
  // Both are requested because a deprecated field is not yet a removed one, and
  // the tier drives lane derivation and the rolling-24h budget gate: reading
  // null there silently ungates a number rather than failing loudly.
  const url =
    `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}` +
    `?fields=whatsapp_business_manager_messaging_limit,messaging_limit_tier,` +
    `quality_rating,throughput`;
  // Idempotent GET — one retry on a 5xx blip. No appsecret_proof (matches the
  // send path default); the token alone authorizes a read of the number's own node.
  const node = await graphGetJson(url, config.accessToken, { retry: true });

  const throughput = node.throughput;
  const throughputLevel =
    throughput && typeof throughput === "object"
      ? (throughput as { level?: unknown }).level
      : undefined;

  // Resolve the owning portfolio FIRST, so the tier written just below lands on
  // the right portfolio row rather than on whatever local container the
  // self-healing path last minted. Best-effort: a token without
  // `business_management` returns null and we fall through to the old
  // behaviour, which is correct for a single-portfolio workspace.
  // When the caller named the connection, `getMetaSendConfig` already proved it
  // belongs to this workspace+channel and is active — no re-lookup needed.
  const connection = channelConnectionId
    ? { id: channelConnectionId }
    : await db.channelConnection.findFirst({
        where: { workspaceId, channel: "whatsapp", externalAccountId: config.phoneNumberId },
        select: { id: true },
      });
  if (connection && config.wabaId) {
    await linkWhatsappPortfolio(
      workspaceId,
      connection.id,
      config.wabaId,
      config.accessToken,
      config.graphVersion,
    );
  }

  await persistWhatsappHealth(
    workspaceId,
    {
      // Prefer the current field; fall back to the deprecated one so a graph
      // version that still only returns the old shape keeps working.
      messagingTier:
        (node.whatsapp_business_manager_messaging_limit as string | undefined) ??
        (node.messaging_limit_tier as string | undefined) ??
        null,
      qualityRating: (node.quality_rating as string | undefined) ?? null,
      throughputLevel: (throughputLevel as string | undefined) ?? null,
    },
    // Scope to the polled number — see the param doc on persistWhatsappHealth.
    connection?.id ?? null,
  );
}

/**
 * The secret-free messaging-health summary the broadcast composer, the settings
 * panel and the `/v1` API all render.
 *
 * Lives here rather than in `BroadcastsService` because THREE surfaces read it
 * and the §12 parity rule is only real if they share one implementation — a
 * `/v1` copy would be the thing that quietly disagrees about the remaining
 * budget after the next tier change.
 *
 * Carries no credentials, so it is safe for any signed-in user and for a
 * `read:catalog` key.
 */
export interface MessagingHealthSummary {
  messagingTier: string | null;
  messagingDailyCap: number | null;
  qualityRating: string | null;
  hasSnapshot: boolean;
  recentUniqueRecipients: number | null;
  remainingDailyBudget: number | null;
  throughputLevel: string | null;
  externalPortfolioId: string | null;
  portfolioAccountCount: number;
  /** The account these figures describe; null = the channel default. */
  channelConnectionId: string | null;
  /** Meta's raw portfolio `verification_status`, or null if never read. */
  verificationStatus: string | null;
  /** Templates each WABA under the portfolio may hold, derived from
   *  `verificationStatus`. An upper bound — see `portfolioTemplateLimit`. */
  templateLimit: number;
  /**
   * A WhatsApp Business POLICY violation Meta reported via `account_update`
   * (e.g. "ALCOHOL"), and when we observed it. This is the warning that arrives
   * BEFORE an account restriction — it used to be parsed and dropped, so the
   * first thing a tenant learned was the restriction itself.
   */
  policyViolationType: string | null;
  policyViolationAt: string | null;
  messagingHealthUpdatedAt: string | null;
}

export async function getMessagingHealthSummary(
  workspaceId: string,
  /**
   * Which account to describe. Omit for the channel default — correct for a
   * one-number workspace and for surfaces that mean "the default". The broadcast
   * composer passes the account it is about to send from, because quality and
   * throughput are per-number and the budget is per-portfolio.
   */
  channelConnectionId?: string | null,
): Promise<MessagingHealthSummary> {
  const health = await getWhatsappHealth(workspaceId, channelConnectionId);
  const cap = health?.messagingDailyCap ?? null;
  // Only pay for the usage count when there's a cap to measure against —
  // mirrors checkBroadcastEligibility so the two never disagree.
  const used =
    cap === null ? null : await countRecentUniqueRecipients(workspaceId, health?.portfolioId);
  return {
    messagingTier: health?.messagingTier ?? null,
    messagingDailyCap: cap,
    qualityRating: health?.qualityRating ?? null,
    hasSnapshot: !!health && health.messagingHealthUpdatedAt !== null,
    recentUniqueRecipients: used,
    remainingDailyBudget: used === null || cap === null ? null : Math.max(0, cap - used),
    throughputLevel: health?.throughputLevel ?? null,
    externalPortfolioId: health?.externalPortfolioId ?? null,
    portfolioAccountCount: health?.portfolioAccountCount ?? 0,
    /** Which account these figures describe — so the UI never has to guess. */
    channelConnectionId: channelConnectionId ?? null,
    verificationStatus: health?.verificationStatus ?? null,
    templateLimit: portfolioTemplateLimit(health?.verificationStatus ?? null),
    // The warning that PRECEDES an account restriction. Surfaced beside the
    // other health figures because "we got restricted out of nowhere" is
    // exactly what dropping this used to produce.
    policyViolationType: health?.policyViolationType ?? null,
    policyViolationAt: health?.policyViolationAt?.toISOString() ?? null,
    messagingHealthUpdatedAt: health?.messagingHealthUpdatedAt?.toISOString() ?? null,
  };
}
