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
 */
const TIER_DAILY_CAP: Record<string, number | null> = {
  TIER_50: 50,
  TIER_250: 250,
  TIER_1K: 1_000,
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
}

/** A partial update — a webhook carries only the field(s) that changed. */
export interface WhatsappHealthUpdate {
  messagingTier?: string | null;
  qualityRating?: string | null;
  throughputLevel?: string | null;
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
  // Bare number or "1K"/"10K"/"100K" shorthand.
  const kMatch = s.match(/^(\d+)\s*K$/);
  if (kMatch) return numberToTier(Number(kMatch[1]) * 1_000);
  if (/^\d+$/.test(s)) return numberToTier(Number(s));
  if (s === "UNLIMITED" || s === "TIER_UNLIMITED") return "TIER_UNLIMITED";
  return null;
}

function numberToTier(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n <= 50) return "TIER_50";
  if (n <= 250) return "TIER_250";
  if (n <= 1_000) return "TIER_1K";
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
  teamId: string,
  update: WhatsappHealthUpdate,
): Promise<void> {
  const data: {
    messagingTier?: string | null;
    messagingDailyCap?: number | null;
    qualityRating?: string | null;
    throughputLevel?: string | null;
    messagingHealthUpdatedAt: Date;
  } = { messagingHealthUpdatedAt: new Date() };

  let touched = false;
  if (update.messagingTier !== undefined) {
    const tier = update.messagingTier ? normalizeMessagingTier(update.messagingTier) : null;
    data.messagingTier = tier;
    data.messagingDailyCap = tierDailyCap(tier);
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
  if (!touched) return;

  const res = await db.channelConnection.updateMany({
    where: { teamId, channel: "whatsapp" },
    data,
  });
  if (res.count > 0) {
    // The eligibility read below goes through the provider-config cache path;
    // bust it so a just-changed tier is reflected immediately.
    invalidateProviderConfig(teamId);
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
  teamId: string,
  audienceSize: number,
): Promise<BroadcastEligibility> {
  const health = await getWhatsappHealth(teamId);
  const base: BroadcastEligibility = {
    allowed: true,
    reason: null,
    exceedsCap: false,
    messagingTier: health?.messagingTier ?? null,
    messagingDailyCap: health?.messagingDailyCap ?? null,
    qualityRating: health?.qualityRating ?? null,
    hasSnapshot: !!health && health.messagingHealthUpdatedAt !== null,
    audienceSize,
  };
  const cap = health?.messagingDailyCap ?? null;
  if (cap !== null && audienceSize > cap) {
    return {
      ...base,
      allowed: false,
      exceedsCap: true,
      reason:
        `This number can message ${cap.toLocaleString()} unique customers per 24h ` +
        `(${health?.messagingTier ?? "current"} tier), but this audience is ` +
        `${audienceSize.toLocaleString()}. Meta will reject the excess — split the ` +
        `send across days, reduce the audience, or raise your messaging limit with Meta first.`,
    };
  }
  if (base.qualityRating === "RED") {
    return {
      ...base,
      reason:
        "This number's quality rating is RED — sending a large marketing blast now " +
        "risks a further downgrade or block. Consider warming up with a smaller, " +
        "high-engagement send first.",
    };
  }
  return base;
}

/** Read the current snapshot for the team's WhatsApp connection (null if none). */
export async function getWhatsappHealth(
  teamId: string,
): Promise<WhatsappHealthSnapshot | null> {
  const row = await db.channelConnection.findUnique({
    where: { teamId_channel: { teamId, channel: "whatsapp" } },
    select: {
      messagingTier: true,
      messagingDailyCap: true,
      qualityRating: true,
      throughputLevel: true,
      messagingHealthUpdatedAt: true,
    },
  });
  if (!row) return null;
  return {
    messagingTier: row.messagingTier,
    messagingDailyCap: row.messagingDailyCap,
    qualityRating: row.qualityRating,
    throughputLevel: row.throughputLevel,
    messagingHealthUpdatedAt: row.messagingHealthUpdatedAt,
  };
}

/**
 * Pull the current messaging-limit tier / quality / throughput from the Graph
 * phone-number node and persist it. Called on connect + a periodic sweep so a
 * team that connected before the webhooks were subscribed still gets a snapshot.
 * Best-effort — throws are swallowed by callers; a not-configured team is a
 * silent no-op. Idempotent.
 */
export async function fetchWhatsappHealthFromGraph(teamId: string): Promise<void> {
  let config;
  try {
    config = await getMetaSendConfig(teamId);
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

  await persistWhatsappHealth(teamId, {
    messagingTier: (node.messaging_limit_tier as string | undefined) ?? null,
    qualityRating: (node.quality_rating as string | undefined) ?? null,
    throughputLevel: (throughputLevel as string | undefined) ?? null,
  });
}
