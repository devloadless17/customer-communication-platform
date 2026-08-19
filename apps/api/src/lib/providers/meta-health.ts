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

import type { Prisma } from "@prisma/client";

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
  /**
   * `UNTIERED` is an observed-on-the-wire member of `whatsapp_business_manager_messaging_limit`
   * (seen live 2026-08-11 on an unregistered number; NOT in Meta's published
   * vocabulary, which enumerates 250/2K/10K/100K/UNLIMITED — this mapping is
   * wire tolerance, same posture as the template parsers)
   * alongside the TIER_* values, but Meta publishes NO numeric meaning for it.
   *
   * It is mapped here — rather than left to fall through `normalizeMessagingTier`'s
   * final `return null` — purely so the token is RECOGNISED. Falling through made
   * it indistinguishable from `TIER_UNLIMITED`, because that also carries a null
   * cap: the composer showed no headroom warning either way, so an untiered number
   * looked exactly like an uncapped one.
   *
   * The cap stays null because inventing a number would be a guess, and this gate
   * is deliberately ADVISORY (it warns and shows headroom, it does not refuse), so
   * the correct behaviour for "limit unknown" is to say so rather than to fabricate
   * a ceiling. Callers that need to tell the two apart compare the tier STRING —
   * `"UNTIERED"` (Meta has not assigned one) vs `"TIER_UNLIMITED"` (genuinely
   * uncapped) vs `null` (we have no snapshot at all).
   */
  UNTIERED: null,
};

/** Snapshot shape read back for the gate + UI. */
export interface WhatsappHealthSnapshot {
  messagingTier: string | null;
  /** Derived numeric 24h unique-recipient cap for the tier; null = unlimited/unknown. */
  messagingDailyCap: number | null;
  qualityRating: string | null;
  throughputLevel: string | null;
  /** COEXISTENCE: Meta hard-caps this number at 20 messages/second, outside the
   *  80/1000 throughput ladder. Null = not polled yet (treated as not-coexistence). */
  isOnBusinessApp: boolean | null;
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
  /** Meta's `max_phone_numbers_per_business` for the portfolio: how many business
   *  phone numbers it may have REGISTERED. New portfolios start at 2 and go to 20
   *  on business verification (or a 2,000 messaging limit). Null = unknown, which
   *  means ungated — same posture as `messagingDailyCap`. */
  maxPhoneNumbers: number | null;
  /** Where the portfolio's identity came from. `local` means "not linked to a
   *  real Meta portfolio yet" — the UI says so instead of showing a null id. */
  portfolioSource: "embedded_signup" | "graph_discovered" | "local" | null;
  /** A WhatsApp Business policy violation Meta reported, and when we saw it. */
  policyViolationType?: string | null;
  policyViolationAt?: Date | null;
  /** Template-categorization enforcement on this number's WABA (utility sends
   *  rate-limited / utility templates restricted), with Meta's own expiry. */
  utilityRestrictionType?: string | null;
  utilityRestrictedUntil?: Date | null;
  /** Policy/spam MESSAGING enforcement on this number's WABA, one (type,
   *  until) pair per blocked direction. Type is the presence marker — an
   *  indefinite lock/ban has no expiry. See the schema comment. */
  bizMessagingRestrictionType?: string | null;
  bizMessagingRestrictedUntil?: Date | null;
  customerMessagingRestrictionType?: string | null;
  customerMessagingRestrictedUntil?: Date | null;
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
  /**
   * The PORTFOLIO's phone-number allowance
   * (`business_capability_update.max_phone_numbers_per_business_portfolio`).
   * Portfolio-scoped like the tier; `undefined` untouched.
   */
  maxPhoneNumbers?: number | null;
  qualityRating?: string | null;
  throughputLevel?: string | null;
  /**
   * COEXISTENCE marker (`is_on_biz_app`): the number is used in the WhatsApp
   * Business app alongside Cloud API, which Meta hard-caps at 20 messages/second.
   * Per-NUMBER, like quality and throughput. `undefined` leaves it untouched — an
   * absent field must never clear a real marker.
   */
  isOnBusinessApp?: boolean | null;
  /**
   * The number's WhatsApp @username, lowercase (`business_username_updates`
   * webhook, or the settings read-through). Per-NUMBER like `qualityRating` —
   * a username is 1:1 with a business phone number. `null` clears (the
   * username was removed); `undefined` untouched.
   */
  businessUsername?: string | null;
  /**
   * Cloud API registration state of the number (Meta `status` on the
   * phone-number node — CONNECTED | DISCONNECTED | PENDING | ...). Stored raw
   * and uppercased like the tier. Per-NUMBER. `undefined` untouched; callers
   * never pass `null` in practice (there is no "unregistered" webhook — the
   * poll always reads a concrete value), but `null` clears for symmetry.
   */
  registrationStatus?: string | null;
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
  /**
   * Template-categorization enforcement. `null` clears (the *_UNBAN /
   * *_RECOVERY webhook); `undefined` untouched. WABA-scoped.
   */
  utilityRestrictionType?: string | null;
  utilityRestrictedUntil?: Date | null;
  /**
   * Policy/spam messaging enforcement, per blocked direction. `null` clears
   * (a DISABLED_UPDATE REINSTATE); `undefined` untouched — a webhook that
   * restricts one direction must not wipe the other. WABA-scoped.
   */
  bizMessagingRestrictionType?: string | null;
  bizMessagingRestrictedUntil?: Date | null;
  customerMessagingRestrictionType?: string | null;
  customerMessagingRestrictedUntil?: Date | null;
  /**
   * An account-level alert with no dedicated field (unparsed `account_update`
   * events, `account_alerts` envelopes). One slot, last-writer-wins,
   * WABA-scoped like the calling/policy fields. `undefined` untouched.
   */
  accountAlert?: {
    source:
      | "account_update"
      | "account_alerts"
      | "account_review_update"
      | "security"
      | "webhook_errors";
    event: string | null;
    detail: string | null;
  };
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
  // The legacy `max_daily_conversation_per_phone` field documents `-1` as
  // UNLIMITED (business-capability-update reference). Without this, an
  // unlimited business normalized to null — "unknown" — and the eligibility
  // gate conservatively capped campaigns on the one portfolio that has no cap.
  if (n === -1) return "TIER_UNLIMITED";
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
 * Resolve WHICH connection an account-level health webhook is about.
 *
 * Account-level webhooks (`phone_number_quality_update`,
 * `business_capability_update`, `account_update`, `account_alerts`) carry no
 * `metadata.phone_number_id`, so the controller cannot attribute them the way
 * it does message webhooks. What they DO carry:
 *   - `value.display_phone_number` (per-number webhooks) — digit-matched
 *     against each stored connection's `config.displayPhoneNumber`;
 *   - `entry[].id` = the WABA id — decisive when exactly one of the
 *     workspace's numbers sits under that WABA.
 * Returns null when neither pins ONE connection — the caller must then treat
 * per-number fields as unattributable rather than guessing.
 */
export async function resolveWhatsappHealthAccount(
  workspaceId: string,
  hints: { phoneNumberId?: string; displayPhoneNumber?: string; wabaId?: string },
): Promise<string | null> {
  if (!hints.phoneNumberId && !hints.displayPhoneNumber && !hints.wabaId) return null;
  // A workspace holds a handful of numbers at most — fetch once, match in JS
  // (the display number needs digit-normalization Prisma can't express).
  const connections = await db.channelConnection.findMany({
    where: { workspaceId, channel: "whatsapp" },
    select: {
      id: true,
      config: true,
      externalAccountId: true,
      wabaAccount: { select: { externalWabaId: true } },
    },
  });
  if (connections.length === 0) return null;

  // Strongest hint first: the provider's own phone-number id (account_alerts
  // `entity_id`) IS our externalAccountId — an exact match with no
  // normalization and no ambiguity.
  if (hints.phoneNumberId) {
    const byId = connections.find((c) => c.externalAccountId === hints.phoneNumberId);
    if (byId) return byId.id;
  }

  if (hints.displayPhoneNumber) {
    const digits = hints.displayPhoneNumber.replace(/\D/g, "");
    if (digits) {
      const byNumber = connections.filter((c) => {
        const display = (c.config as { displayPhoneNumber?: string } | null)
          ?.displayPhoneNumber;
        return typeof display === "string" && display.replace(/\D/g, "") === digits;
      });
      if (byNumber.length === 1) return byNumber[0]!.id;
    }
  }
  if (hints.wabaId) {
    const underWaba = connections.filter(
      (c) => c.wabaAccount?.externalWabaId === hints.wabaId,
    );
    if (underWaba.length === 1) return underWaba[0]!.id;
  }
  return null;
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
   * Omitted with ONE connection (the pre-multi-account shape) still writes
   * workspace-wide, which is trivially the right row. Omitted with SEVERAL,
   * per-number fields are DROPPED with a structured warn — never written onto
   * an arbitrary sibling — while WABA-scoped fields (calling enforcement,
   * policy violations, which Meta reports at account level) fall back to every
   * connection under `wabaId`, and the tier still lands at portfolio scope.
   */
  channelConnectionId?: string | null,
  /** The WABA the signal arrived under (webhook `entry[].id`), when known. */
  wabaId?: string | null,
): Promise<void> {
  // Fields split by their TRUE Meta scope, so each lands on the right rows:
  //   per-NUMBER  — quality rating, throughput;
  //   per-WABA    — calling enforcement + policy violations (`account_update`
  //                 is a WABA-level webhook: the enforcement applies to every
  //                 number under it);
  //   per-PORTFOLIO — the messaging tier (written separately below).
  const perNumber: {
    qualityRating?: string | null;
    throughputLevel?: string | null;
    isOnBusinessApp?: boolean | null;
    businessUsername?: string | null;
    registrationStatus?: string | null;
  } = {};
  const wabaScoped: {
    callingRestrictedUntil?: Date | null;
    callingRestrictionType?: string | null;
    callingRestrictionReason?: string | null;
    callingQualityWarning?: string | null;
    policyViolationType?: string | null;
    policyViolationAt?: Date | null;
    utilityRestrictionType?: string | null;
    utilityRestrictedUntil?: Date | null;
    bizMessagingRestrictionType?: string | null;
    bizMessagingRestrictedUntil?: Date | null;
    customerMessagingRestrictionType?: string | null;
    customerMessagingRestrictedUntil?: Date | null;
    lastAccountAlert?: Prisma.InputJsonValue;
  } = {};

  let portfolioTier: string | null | undefined;
  if (update.messagingTier !== undefined) {
    if (update.messagingTier) {
      const normalized = normalizeMessagingTier(update.messagingTier);
      // A PRESENT-but-unrecognized token must not clobber the stored cap.
      // `TIER_NOT_SET` / `ONBOARDING` are documented `current_limit` /
      // `max_daily_conversations_per_business` values meaning "this NUMBER
      // hasn't sent yet" — which says nothing about its PORTFOLIO's limit,
      // the scope this column gates. Writing null here silently ungated the
      // 24h budget gate for the whole portfolio off one idle number's
      // webhook. Unrecognized ⇒ leave the stored tier alone; an explicit
      // null/empty from a caller still clears.
      //
      // `UNTIERED` gets the same leave-alone treatment HERE (though it is a
      // recognized token): on the NUMBER node it means "this number has no
      // tier" — true for any unregistered number — while its PORTFOLIO can
      // simultaneously hold a real limit. Caught live by the reconciler on
      // 2026-08-11: `linkWhatsappPortfolio` wrote the portfolio node's real
      // TIER_250 and this per-number persist immediately clobbered it back to
      // UNTIERED on every health poll, forever. The portfolio-node read in
      // `linkWhatsappPortfolio` stays the ONLY writer allowed to store
      // UNTIERED, since there it genuinely describes the portfolio.
      portfolioTier = normalized === "UNTIERED" ? undefined : (normalized ?? undefined);
    } else {
      portfolioTier = null;
    }
  }
  // Portfolio-scoped like the tier, and written by the same block below.
  let portfolioCap: number | null | undefined;
  if (update.maxPhoneNumbers !== undefined) {
    portfolioCap =
      update.maxPhoneNumbers != null &&
      Number.isFinite(update.maxPhoneNumbers) &&
      update.maxPhoneNumbers > 0
        ? Math.floor(update.maxPhoneNumbers)
        : update.maxPhoneNumbers == null
          ? null
          : undefined;
  }
  if (update.isOnBusinessApp !== undefined) {
    perNumber.isOnBusinessApp = update.isOnBusinessApp;
  }
  if (update.businessUsername !== undefined) {
    // Already normalized (lowercase) by the parser/service; an empty string
    // is not a username.
    perNumber.businessUsername = update.businessUsername?.trim().toLowerCase() || null;
  }
  if (update.registrationStatus !== undefined) {
    // Raw + uppercased, like the tier: Meta's vocabulary churns and this field
    // gates a BANNER, not a send path — an unrecognized value must render as
    // itself, never coerce to "fine".
    perNumber.registrationStatus = update.registrationStatus
      ? update.registrationStatus.trim().toUpperCase() || null
      : null;
  }
  if (update.qualityRating !== undefined) {
    perNumber.qualityRating = update.qualityRating
      ? normalizeQualityRating(update.qualityRating)
      : null;
  }
  if (update.throughputLevel !== undefined) {
    perNumber.throughputLevel = update.throughputLevel
      ? normalizeThroughputLevel(update.throughputLevel)
      : null;
  }
  // Calling enforcement. A restriction arrives with its own expiry and clears
  // the earlier warning that preceded it — by the time calling is paused, the
  // "quality is slipping" nudge is no longer the actionable message.
  if (update.callingRestrictedUntil !== undefined) {
    wabaScoped.callingRestrictedUntil = update.callingRestrictedUntil;
    wabaScoped.callingRestrictionType = update.callingRestrictionType ?? null;
    wabaScoped.callingRestrictionReason = update.callingRestrictionReason ?? null;
    wabaScoped.callingQualityWarning = null;
  }
  if (update.callingQualityWarning !== undefined) {
    wabaScoped.callingQualityWarning = update.callingQualityWarning;
  }
  if (update.policyViolationType !== undefined) {
    wabaScoped.policyViolationType = update.policyViolationType;
    // Meta's violation payload carries no timestamp, so observation time is
    // what we have — and "when did this land" is the question an operator asks.
    wabaScoped.policyViolationAt = update.policyViolationType ? new Date() : null;
  }
  if (update.utilityRestrictionType !== undefined) {
    wabaScoped.utilityRestrictionType = update.utilityRestrictionType;
    wabaScoped.utilityRestrictedUntil = update.utilityRestrictedUntil ?? null;
  }
  if (update.bizMessagingRestrictionType !== undefined) {
    wabaScoped.bizMessagingRestrictionType = update.bizMessagingRestrictionType;
    wabaScoped.bizMessagingRestrictedUntil = update.bizMessagingRestrictedUntil ?? null;
  }
  if (update.customerMessagingRestrictionType !== undefined) {
    wabaScoped.customerMessagingRestrictionType = update.customerMessagingRestrictionType;
    wabaScoped.customerMessagingRestrictedUntil =
      update.customerMessagingRestrictedUntil ?? null;
  }
  if (update.accountAlert !== undefined) {
    wabaScoped.lastAccountAlert = {
      ...update.accountAlert,
      observedAt: new Date().toISOString(),
    };
  }
  const hasPerNumber = Object.keys(perNumber).length > 0;
  const hasWabaScoped = Object.keys(wabaScoped).length > 0;
  if (
    portfolioTier === undefined &&
    portfolioCap === undefined &&
    !hasPerNumber &&
    !hasWabaScoped
  )
    return;

  // With no named connection, the legacy workspace-wide write is only safe when
  // there is exactly one row it could hit.
  const soleConnection =
    !channelConnectionId &&
    (await db.channelConnection.count({
      where: { workspaceId, channel: "whatsapp" },
    })) <= 1;

  if (portfolioTier !== undefined || portfolioCap !== undefined) {
    const portfolioData = {
      ...(portfolioTier !== undefined
        ? {
            messagingTier: portfolioTier,
            messagingDailyCap: tierDailyCap(portfolioTier),
          }
        : {}),
      ...(portfolioCap !== undefined ? { maxPhoneNumbers: portfolioCap } : {}),
      messagingHealthUpdatedAt: new Date(),
    };
    const updated = await db.whatsappPortfolio.updateMany({
      // The portfolio owning THIS account (or, for an account-level webhook,
      // the one owning the WABA's numbers). Unscoped, a tier update for one
      // portfolio would overwrite every other portfolio in the workspace —
      // each of which has its own independent 24h budget.
      // Portfolio → WABA → number is Meta's real hierarchy, so the portfolio is
      // reached through its WABAs. Unscoped, a tier update for one portfolio
      // would overwrite every other portfolio in the workspace — each of which
      // has its own independent 24h budget.
      where: {
        wabaAccounts: {
          some: {
            workspaceId,
            ...(channelConnectionId
              ? { connections: { some: { id: channelConnectionId, workspaceId } } }
              : wabaId
                ? { externalWabaId: wabaId }
                : {}),
          },
        },
      },
      data: portfolioData,
    });
    // Self-healing: a workspace whose WABA has no portfolio linked yet (no
    // `business_management` scope, or connected before the portfolio table) has
    // nothing to update, and silently dropping the tier would leave the pre-send
    // gate permanently ungated. Mint a local container — but ONLY for a WABA this
    // event can be attributed to.
    //
    // The attribution used to need three tiers (connection → WABA's connections →
    // sole connection) because `portfolioId` hung off the NUMBER, so the DB could
    // express "two numbers of one WABA in different portfolios" — a state Meta
    // cannot produce. Now that the link lives on the WABA, and a WABA has exactly
    // one portfolio by construction, ONE tier is enough: find the WABA. With none,
    // drop the tier — the next Graph poll resolves the real portfolio id and
    // `linkWhatsappPortfolio`'s upsert converges.
    if (updated.count === 0) {
      const wabaWhere = channelConnectionId
        ? {
            workspaceId,
            portfolioId: null,
            connections: { some: { id: channelConnectionId, workspaceId } },
          }
        : wabaId
          ? { workspaceId, portfolioId: null, externalWabaId: wabaId }
          : soleConnection
            ? { workspaceId, portfolioId: null }
            : null;
      if (wabaWhere) {
        const created = await db.whatsappPortfolio.create({
          data: { workspaceId, source: "local", ...portfolioData },
          select: { id: true },
        });
        const attached = await db.whatsappBusinessAccount.updateMany({
          where: wabaWhere,
          data: { portfolioId: created.id },
        });
        // A race (another writer attached the rows first) would leave this
        // container connection-less — delete it rather than strand an orphan.
        if (attached.count === 0) {
          await db.whatsappPortfolio
            .delete({ where: { id: created.id } })
            .catch(() => undefined);
        }
      } else {
        console.warn(
          `[whatsapp-health] dropped unattributable tier for team=${workspaceId} — ` +
            `several WABAs, no connection/WABA in payload; next Graph poll links the real portfolio`,
        );
      }
    }
  }

  let wrote = portfolioTier !== undefined;

  if (hasPerNumber) {
    if (channelConnectionId || soleConnection) {
      const res = await db.channelConnection.updateMany({
        where: {
          workspaceId,
          channel: "whatsapp",
          ...(channelConnectionId ? { id: channelConnectionId } : {}),
        },
        data: { ...perNumber, messagingHealthUpdatedAt: new Date() },
      });
      wrote ||= res.count > 0;
    } else {
      // Several numbers, none identified: dropping is the only correct move —
      // stamping quality/throughput on an arbitrary sibling is exactly the
      // misattribution this scope split exists to prevent. The warn is the
      // audit trail for "why didn't the webhook update my panel".
      console.warn(
        `[whatsapp-health] dropped unattributable per-number fields ` +
          `(${Object.keys(perNumber).join(", ")}) for team=${workspaceId}` +
          `${wabaId ? ` waba=${wabaId}` : ""} — several numbers, none identified`,
      );
    }
  }

  if (hasWabaScoped) {
    if (wabaId || channelConnectionId || soleConnection) {
      // Prefer the WABA scope when known — `account_update` enforcement applies
      // to every number under the WABA, and narrowing it to one row would leave
      // sibling numbers looking healthy while calling is actually paused.
      const res = await db.channelConnection.updateMany({
        where: {
          workspaceId,
          channel: "whatsapp",
          ...(wabaId
            ? { wabaAccount: { externalWabaId: wabaId } }
            : channelConnectionId
              ? { id: channelConnectionId }
              : {}),
        },
        data: { ...wabaScoped, messagingHealthUpdatedAt: new Date() },
      });
      wrote ||= res.count > 0;
      if (res.count === 0) {
        // Matched NOTHING despite having a scope to write to. The common cause is
        // a WABA that holds ZERO phone numbers — Embedded Signup's
        // `FINISH_ONLY_WABA` is a completed onboarding with no number, and its
        // template and account webhooks start arriving immediately. Every
        // WABA-scoped enforcement field is denormalized onto `ChannelConnection`
        // rows, so with no rows there is nowhere for the restriction to land.
        //
        // This used to be silent: `wrote` stayed false and the `else` warn below
        // could not fire, because it is gated on `wabaId` being ABSENT and here it
        // is present. So an ACCOUNT_RESTRICTION / DISABLED_UPDATE /
        // ACCOUNT_VIOLATION for such a WABA was discarded with no DB row and no
        // log line, and a number later added under it was born looking healthy
        // while Meta was already refusing its sends.
        //
        // Warning rather than persisting is deliberate for now: giving these
        // fields their true home is a column move onto `WhatsappBusinessAccount`,
        // i.e. a schema change. Until then the loss is at least visible.
        console.warn(
          `[whatsapp-health] account-level fields matched NO connection ` +
            `(${Object.keys(wabaScoped).join(", ")}) for team=${workspaceId}` +
            `${wabaId ? ` waba=${wabaId}` : ""} — the WABA has no phone number rows ` +
            `to hold them (FINISH_ONLY_WABA), so this enforcement state is LOST`,
        );
      }
    } else {
      console.warn(
        `[whatsapp-health] dropped unattributable account-level fields ` +
          `(${Object.keys(wabaScoped).join(", ")}) for team=${workspaceId} — ` +
          `several numbers, no WABA in payload`,
      );
    }
  }

  if (wrote) {
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
 * SCOPE: broadcast recipients UNION every other outbound template send
 * (`Message.templateName != null`). It used to count broadcasts alone and
 * self-documented as a LOWER BOUND — workflow, inbox-composer and `/v1` template
 * sends spend Meta's real budget while being invisible to the gate. That marker
 * column now exists, so they are counted.
 *
 * WHICH DIRECTION THIS CAN ERR IN, and why it's acceptable: a template sent
 * INSIDE an already-open customer-service window arguably doesn't consume the
 * business-initiated budget, so the count can now slightly OVER-report. For a
 * hard block that would be the unsafe direction (refusing a send Meta would
 * accept), which is why `checkBroadcastEligibility` stays ADVISORY — it warns and
 * shows headroom rather than hard-refusing, and a missing snapshot is still
 * ungated.
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
              { channelConnection: { wabaAccount: { portfolioId } } },
              { channelConnectionId: null },
            ],
          }
        : {}),
      // Contact-mode WhatsApp sends only. LEGACY-ONLY filter: the omnichannel
      // `customer` mode was removed 2026-07-27 (creation rejects it), but the
      // 72h lookback can still see rows sent before the removal — those stored
      // `channel: "whatsapp"` as an inert default while routing recipients to
      // their best channel, so counting them would charge Messenger/Instagram
      // deliveries against the WhatsApp portfolio's budget and falsely block
      // later sends. Keep the filter as long as any legacy row can age in.
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
  const contacts = new Set(rows.map((r) => r.contactId));
  for (const id of await recentTemplateSendContactIds(workspaceId, portfolioId, now)) {
    contacts.add(id);
  }
  return contacts;
}

/**
 * Contacts reached by a NON-broadcast outbound template send in the window —
 * workflow steps, the inbox composer, and `/v1`.
 *
 * UNION with the broadcast set, never a replacement for it. The broadcast runner
 * writes its per-recipient `Message` row inside a best-effort try/catch whose own
 * comment says a failure "must NEVER flip the recipient back to failed… Worst case
 * the inbox is missing the row" — so a recipient can be `sent` (Meta charged,
 * budget spent) with no Message row at all. Counting from Message alone would
 * therefore under-report in exactly the place the old count already did. Set union
 * is idempotent, so overlap cannot double-count.
 *
 * `broadcastId: null` keeps this set small — these paths produce tens to hundreds
 * of sends per day, not 100k — so the `conversationId → contactId` resolution
 * stays a bounded second query with no unbounded `IN` list. Server-side `groupBy`
 * for the same heap reason as the broadcast leg. Rides
 * `Message_template_send_budget_idx`.
 */
async function recentTemplateSendContactIds(
  workspaceId: string,
  portfolioId: string | null | undefined,
  now: number,
): Promise<Set<string>> {
  // `Message.channelConnectionId` is deliberately a PLAIN id with no relation —
  // the conversation's FK is `onDelete: SetNull`, which would erase a historical
  // stamp — so the portfolio scope can't be expressed as a nested filter here.
  // Resolve the portfolio's numbers first: a portfolio holds a handful of them, so
  // this is a small bounded `in` list, not an unbounded one.
  let accountIds: string[] | null = null;
  if (portfolioId) {
    const conns = await db.channelConnection.findMany({
      where: { workspaceId, channel: "whatsapp", wabaAccount: { portfolioId } },
      select: { id: true },
    });
    if (conns.length === 0) return new Set();
    accountIds = conns.map((c) => c.id);
  }

  const grouped = await db.message.groupBy({
    by: ["conversationId"],
    where: {
      workspaceId,
      channel: "whatsapp",
      direction: "out",
      templateName: { not: null },
      broadcastId: null,
      createdAt: { gte: new Date(now - ROLLING_WINDOW_HOURS * 3_600_000) },
      // Exact scoping: the stamp is written at the idempotent-create choke point,
      // so unlike the broadcast leg this needs no null-account escape hatch.
      ...(accountIds ? { channelConnectionId: { in: accountIds } } : {}),
    },
  });
  if (grouped.length === 0) return new Set();
  const convos = await db.conversation.findMany({
    where: { workspaceId, id: { in: grouped.map((g) => g.conversationId) } },
    select: { contactId: true },
  });
  return new Set(convos.map((c) => c.contactId));
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
  //
  // ADVISORY, not a hard refusal — matching the header's promise. Our usage
  // count deliberately OVER-reports versus Meta's definition (docs: the limit
  // counts messages DELIVERED "outside of a customer service window", while we
  // count every attempted template send, window or not — free service-window
  // sends accrue zero real budget). A hard block on an over-count refused a
  // TIER_250 client's legitimate first campaign (doc-review 2026-08-11). Meta
  // enforces the true limit; our job is the specific warning, not a fabricated
  // refusal. The `audienceSize > cap` branch above stays hard — that comparison
  // needs no usage estimate and is a plain fact about the tier.
  if (newUniques > remaining) {
    const overlap = audienceSize - newUniques;
    const alreadyCounted =
      overlap > 0
        ? ` ${overlap.toLocaleString()} of them were already messaged in this window and cost no extra allowance, but`
        : "";
    return {
      ...withUsage,
      exceedsCap: true,
      reason:
        `This number has already messaged about ${used.toLocaleString()} unique customers in ` +
        `the last 24h, leaving roughly ${remaining.toLocaleString()} of its ${cap.toLocaleString()} ` +
        `${tier}-tier allowance. This audience is ${audienceSize.toLocaleString()};` +
        `${alreadyCounted} Meta may reject roughly ` +
        `${(newUniques - remaining).toLocaleString()} of them. (Our count is an over-estimate: ` +
        `replies inside an open 24h service window are free and don't spend this budget.) ` +
        `If sends fail, wait for the window to roll over or split the campaign across days.`,
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
      isOnBusinessApp: true,
      messagingHealthUpdatedAt: true,
      policyViolationType: true,
      policyViolationAt: true,
      utilityRestrictionType: true,
      utilityRestrictedUntil: true,
      bizMessagingRestrictionType: true,
      bizMessagingRestrictedUntil: true,
      customerMessagingRestrictionType: true,
      customerMessagingRestrictedUntil: true,
      // The 24h messaging limit is PORTFOLIO-scoped since 2025-10-07 (shared by
      // every number in the portfolio), so tier + cap come off the portfolio, not
      // this number. Quality + throughput above stay per-number.
      //
      // Reached THROUGH the WABA: Meta records portfolio ownership on the WABA
      // node (`owner_business_info`), so portfolio → WABA → number is the real
      // hierarchy. `portfolioAccountCount` counts the numbers sharing this budget
      // across ALL of the portfolio's WABAs, which is what makes "7,850 of 10,000
      // remaining" legible when the budget isn't just this number's.
      wabaAccount: {
        select: {
          portfolioId: true,
          portfolio: {
            select: {
              messagingTier: true,
              messagingDailyCap: true,
              externalPortfolioId: true,
              verificationStatus: true,
              maxPhoneNumbers: true,
              source: true,
              _count: { select: { wabaAccounts: true } },
              wabaAccounts: { select: { _count: { select: { connections: true } } } },
            },
          },
        },
      },
    },
  });
  if (!row) return null;
  const portfolio = row.wabaAccount?.portfolio ?? null;
  return {
    messagingTier: portfolio?.messagingTier ?? null,
    messagingDailyCap: portfolio?.messagingDailyCap ?? null,
    qualityRating: row.qualityRating,
    throughputLevel: row.throughputLevel,
    isOnBusinessApp: row.isOnBusinessApp,
    policyViolationType: row.policyViolationType,
    policyViolationAt: row.policyViolationAt,
    utilityRestrictionType: row.utilityRestrictionType,
    utilityRestrictedUntil: row.utilityRestrictedUntil,
    bizMessagingRestrictionType: row.bizMessagingRestrictionType,
    bizMessagingRestrictedUntil: row.bizMessagingRestrictedUntil,
    customerMessagingRestrictionType: row.customerMessagingRestrictionType,
    customerMessagingRestrictedUntil: row.customerMessagingRestrictedUntil,
    messagingHealthUpdatedAt: row.messagingHealthUpdatedAt,
    portfolioId: row.wabaAccount?.portfolioId ?? null,
    externalPortfolioId: portfolio?.externalPortfolioId ?? null,
    portfolioAccountCount:
      portfolio?.wabaAccounts.reduce((n, w) => n + w._count.connections, 0) ?? 0,
    verificationStatus: portfolio?.verificationStatus ?? null,
    maxPhoneNumbers: portfolio?.maxPhoneNumbers ?? null,
    portfolioSource: portfolio?.source ?? null,
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
  /**
   * OUR `WhatsappBusinessAccount.id`. The portfolio link lives on the WABA, not
   * on a phone number — Meta records it as `owner_business_info` on the WABA
   * node — so a WABA with ZERO numbers (Embedded Signup's `FINISH_ONLY_WABA`)
   * still gets attributed.
   */
  wabaAccountId: string,
  wabaId: string,
  accessToken: string,
  graphVersion: string,
  /** Signs with `appsecret_proof` — a "Require app secret" customer app 400s
   *  unsigned reads, which left the portfolio permanently unresolved. */
  appSecret?: string,
): Promise<{ portfolioId: string; externalPortfolioId: string } | null> {
  let externalPortfolioId: string | null = null;
  try {
    const owner = await graphGetJson(
      `${GRAPH_BASE}/${graphVersion}/${encodeURIComponent(wabaId)}?fields=owner_business_info`,
      accessToken,
      { retry: true },
      appSecret,
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
  // Both fields on ONE node read, and reading the messaging limit on the
  // PORTFOLIO node is documented — do not "fix" this to a phone-number read.
  // The Messaging Limits page's "Via API" section only shows the phone-number
  // form, which makes this look like an invalid field; the upcoming-changes
  // page is the one that spells it out: request
  // `whatsapp_business_manager_messaging_limit` "on the business portfolio, or
  // a WhatsApp Business account or business phone number within the
  // portfolio". That matters because one bad field fails the WHOLE request,
  // and `verificationStatus` — the template limit's only input — rides along
  // here. It would strand at null permanently, silently pinning every
  // portfolio to the unverified 250-template figure.
  try {
    const node = await graphGetJson(
      `${GRAPH_BASE}/${graphVersion}/${encodeURIComponent(externalPortfolioId)}` +
        `?fields=whatsapp_business_manager_messaging_limit,verification_status`,
      accessToken,
      { retry: true },
      appSecret,
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
      // Graph-verified: we read this id back off the WABA node, as opposed to an
      // Embedded Signup `business_id` the customer merely selected in the flow.
      source: "graph_discovered",
      ...(tier ? { messagingTier: tier, messagingDailyCap: tierDailyCap(tier) } : {}),
      ...(verificationStatus ? { verificationStatus } : {}),
      messagingHealthUpdatedAt: new Date(),
    },
    // A null tier must NOT clobber a good stored one — a scope-less token would
    // otherwise wipe the cap on every sweep and leave the gate permanently open.
    // Same rule for verificationStatus, for the same reason.
    update: {
      // Reading the id back off Graph upgrades an ES-asserted row to verified;
      // it never downgrades one.
      source: "graph_discovered",
      ...(tier ? { messagingTier: tier, messagingDailyCap: tierDailyCap(tier) } : {}),
      ...(verificationStatus ? { verificationStatus } : {}),
      messagingHealthUpdatedAt: new Date(),
    },
    select: { id: true },
  });

  await db.whatsappBusinessAccount.updateMany({
    where: { id: wabaAccountId, workspaceId },
    data: { portfolioId: portfolio.id },
  });
  invalidateProviderConfig(workspaceId);

  // Re-pointing a connection onto its REAL portfolio can orphan the local
  // null-id container the self-heal minted before the id was known. Orphans
  // aren't just clutter: the settings panel's "shared by N numbers" framing
  // reads their stale counts.
  await gcOrphanWhatsappPortfolios(workspaceId);

  return { portfolioId: portfolio.id, externalPortfolioId };
}

/**
 * Delete portfolio rows no WABA points at anymore. Called after a portfolio
 * re-point and from the account-removal paths (SetNull FKs mean deleting the last
 * WABA strands the row silently). Workspace-scoped, idempotent, best-effort.
 *
 * Gated on `source: "local"`: those are the containers the health self-heal minted
 * to hold a tier, and they are pure derived state. A `graph_discovered` or
 * `embedded_signup` row records a REAL Meta portfolio — including its tier, cap
 * and `maxPhoneNumbers` — and momentarily having no WABA (mid re-point, or an ES
 * install whose WABA hasn't landed yet) must not destroy that.
 */
export async function gcOrphanWhatsappPortfolios(workspaceId: string): Promise<void> {
  await db.whatsappPortfolio
    .deleteMany({ where: { workspaceId, source: "local", wabaAccounts: { none: {} } } })
    .catch(() => undefined);
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
    // `is_on_biz_app` marks a COEXISTENCE number (still used in the WhatsApp
    // Business app alongside Cloud API). Meta hard-caps those at 20 messages/second
    // — a fixed ceiling outside the 80/1000 throughput ladder — so the broadcast
    // runner has to know, or it paces them ~4x too fast. `platform_type` rides along
    // because Meta's Coexistence doc pairs the two for exactly this check.
    // `status` is the number's Cloud API REGISTRATION state — non-CONNECTED
    // means every send fails, and until 2026-08-13 it was read once at connect
    // and dropped, so the settings page said "Connected" over a number that
    // couldn't send (the 2026-08-11 live incident). Riding this read costs
    // no extra Graph call and the health sweep keeps it fresh.
    `quality_rating,throughput,is_on_biz_app,platform_type,status`;
  // Idempotent GET — one retry on a 5xx blip. Signed: the old "no
  // appsecret_proof, matches the send path" note was stale (the send path signs
  // via metaFetch when META_APPSECRET_PROOF=1), and against a customer app with
  // "Require app secret" ON every unsigned health read 400'd, so the panel
  // showed "Meta didn't respond" forever (observed live 2026-08-11).
  const node = await graphGetJson(url, config.accessToken, { retry: true }, config.appSecret);

  const throughput = node.throughput;
  const throughputLevel =
    throughput && typeof throughput === "object"
      ? (throughput as { level?: unknown }).level
      : undefined;
  // Only a definite boolean is recorded — an absent field must NOT be read as
  // `false`, or one field-less response would clear a real Coexistence marker and
  // silently restore the 4x-too-fast pacing.
  const isOnBusinessApp =
    typeof node.is_on_biz_app === "boolean" ? node.is_on_biz_app : undefined;

  // Resolve the owning portfolio FIRST, so the tier written just below lands on
  // the right portfolio row rather than on whatever local container the
  // self-healing path last minted. Best-effort: a token without
  // `business_management` returns null and we fall through to the old
  // behaviour, which is correct for a single-portfolio workspace.
  // The portfolio link lives on the WABA (Meta records `owner_business_info` on the
  // WABA node), so what this needs is the WABA row's id — NOT the connection's.
  // `getSendConfig` already joined it, so there is nothing extra to look up.
  // Still needed for the per-NUMBER half of the snapshot below (quality,
  // throughput), which is scoped to the polled connection.
  const connection = channelConnectionId
    ? { id: channelConnectionId }
    : await db.channelConnection.findFirst({
        where: { workspaceId, channel: "whatsapp", externalAccountId: config.phoneNumberId },
        select: { id: true },
      });
  if (config.wabaAccountId && config.wabaId) {
    await linkWhatsappPortfolio(
      workspaceId,
      config.wabaAccountId,
      config.wabaId,
      config.accessToken,
      config.graphVersion,
      config.appSecret,
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
      ...(isOnBusinessApp === undefined ? {} : { isOnBusinessApp }),
      // Leave-alone posture: an absent field must not clear a stored state —
      // only a present value writes (same rule as isOnBusinessApp above).
      ...(typeof node.status === "string" && node.status
        ? { registrationStatus: node.status }
        : {}),
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
  /**
   * COEXISTENCE (`is_on_biz_app`) — the number is also in use in the WhatsApp
   * Business app. Meta hard-caps those at 20 msg/s OUTSIDE the throughput
   * ladder while still reporting a level for them (see `resolveSendRate`), so
   * a reader that renders `throughputLevel` alone states a ceiling 4-50x the
   * real one. Null = never polled; treated as not-coexistence, like the gate.
   */
  isOnBusinessApp: boolean | null;
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
  /** ACTIVE template-categorization enforcement on this number's WABA (expired
   *  restrictions are filtered server-side): utility sends rate-limited or
   *  utility templates restricted. Null = none active. */
  utilityRestrictionType: string | null;
  utilityRestrictedUntil: string | null;
  /** ACTIVE policy/spam messaging enforcement (expired restrictions filtered
   *  server-side; a set type with a null `until` is an indefinite lock/ban).
   *  Business-initiated covers broadcasts/templates; customer-initiated covers
   *  even replies. Null = that direction is not restricted. */
  bizMessagingRestrictionType: string | null;
  bizMessagingRestrictedUntil: string | null;
  customerMessagingRestrictionType: string | null;
  customerMessagingRestrictedUntil: string | null;
  messagingHealthUpdatedAt: string | null;
}

/** Active-restriction filter shared by the summary fields below: expired →
 *  gone (a missed recovery webhook must not warn forever), null expiry with a
 *  type set → active indefinitely (locks/bans carry no end date). */
function activeRestriction(
  type: string | null | undefined,
  until: Date | null | undefined,
): { type: string | null; until: string | null } {
  const active = !!type && (!until || until > new Date());
  return {
    type: active ? (type ?? null) : null,
    until: active && until ? until.toISOString() : null,
  };
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
  const bizRestriction = activeRestriction(
    health?.bizMessagingRestrictionType,
    health?.bizMessagingRestrictedUntil,
  );
  const customerRestriction = activeRestriction(
    health?.customerMessagingRestrictionType,
    health?.customerMessagingRestrictedUntil,
  );
  return {
    messagingTier: health?.messagingTier ?? null,
    messagingDailyCap: cap,
    qualityRating: health?.qualityRating ?? null,
    hasSnapshot: !!health && health.messagingHealthUpdatedAt !== null,
    recentUniqueRecipients: used,
    remainingDailyBudget: used === null || cap === null ? null : Math.max(0, cap - used),
    throughputLevel: health?.throughputLevel ?? null,
    isOnBusinessApp: health?.isOnBusinessApp ?? null,
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
    // Template-categorization enforcement. Expired restrictions are filtered
    // HERE so no reader has to re-implement the expiry check (Meta also sends
    // the recovery webhook, but a missed webhook must not warn forever).
    utilityRestrictionType:
      health?.utilityRestrictionType &&
      (!health.utilityRestrictedUntil || health.utilityRestrictedUntil > new Date())
        ? health.utilityRestrictionType
        : null,
    utilityRestrictedUntil:
      health?.utilityRestrictedUntil && health.utilityRestrictedUntil > new Date()
        ? health.utilityRestrictedUntil.toISOString()
        : null,
    // Policy/spam messaging enforcement, same expiry posture as utility above.
    bizMessagingRestrictionType: bizRestriction.type,
    bizMessagingRestrictedUntil: bizRestriction.until,
    customerMessagingRestrictionType: customerRestriction.type,
    customerMessagingRestrictedUntil: customerRestriction.until,
    messagingHealthUpdatedAt: health?.messagingHealthUpdatedAt?.toISOString() ?? null,
  };
}
