/**
 * PAGE INTEGRITY — why a Page stopped being able to message, in Meta's own words.
 *
 * Two halves of one thing (Page Integrity API & Webhook, shipped 2026-01-30):
 *
 *   PULL  `GET /{PAGE_ID}/page_status` — the full current picture.
 *   PUSH  the `business_integrity` webhook field — the same information as
 *         incremental events.
 *
 * ## Why this matters more than it looks
 *
 * `normalizeMetaSendError` classifies Meta error `10 – 1893063` ("Pages
 * temporarily restricted from sending messages") as `account_restricted`. That is
 * the RIGHT answer at the wrong time: by then an agent's reply has already
 * failed, or a broadcast has already tripped its breaker. `restrictions[]` here
 * carries `feature: "page_messaging_api"` with an `expiration_time` BEFORE the
 * first send fails — so the operator can be told "this Page is restricted until
 * Thursday, here is the appeal link" instead of discovering it as an outage.
 *
 * ## Two spellings of the same field, and other tolerances
 *
 * Meta's own examples disagree with each other, so this module is deliberately
 * lenient in the three places they differ:
 *
 *   - The API response calls the appeal list `actions_events`; the webhook calls
 *     it `action_events`. Both are read.
 *   - An appeal's `type` appears as both `FILE_APPEAL` and `APPEAL`, and its
 *     `status` as `OPEN`, `OPENED`, `RESOLVED` and `CLOSED`. All are passed
 *     through verbatim rather than mapped onto an enum of ours that would have to
 *     grow every time Meta adds a value.
 *   - `restrictions[]` sits INSIDE `messaging[]` in one webhook example and as a
 *     SIBLING of it in another. Both positions are checked.
 *
 * Nothing here maps Meta's vocabulary onto our own. `status`, `violations[].type`
 * and `restrictions[].feature` are stored and displayed as Meta spells them, for
 * the same reason `qualityRating` is a raw string on ChannelConnection: the vendor
 * vocabulary churns, and a stale mapping silently mislabels an enforcement.
 */

import { GRAPH_BASE, graphGetJson } from "@/lib/providers/meta-graph";
import type { SocialSendTarget } from "@/lib/providers/meta-social";

/**
 * Meta's documented `status` values, in escalating order:
 *   ok         — no active violations or restrictions
 *   warning    — not restricted, but may be soon
 *   restricted — currently restricted because of one or more violations
 *   suspended  — suspended due to severe violations
 *
 * Typed as a plain string with the known values documented rather than a union,
 * because a value Meta adds later must still reach the operator instead of being
 * dropped by a parser that only knows four words.
 */
export type PageIntegrityStatus = string;

/**
 * The restricted features Meta documents. Two of the four stop messaging, and
 * they are NOT interchangeable:
 *   page_messaging_api — blocks sending via the Messenger Platform API (us)
 *   page_messaging     — blocks the Page from sending ANY message to users
 *   page_read_only     — no new content or changes for a period
 *   page_publish       — the Page is unpublished from Meta's platform
 */
export const MESSAGING_RESTRICTION_FEATURES: ReadonlySet<string> = new Set([
  "page_messaging_api",
  "page_messaging",
]);

export interface PageViolation {
  type: string;
  description: string | null;
  /** Meta's own explainer link — worth surfacing verbatim; we can't write it. */
  url: string | null;
}

export interface PageRestriction {
  feature: string;
  /** RESTRICTED | UNRESTRICTED. Absent on the API shape, present on the webhook. */
  status: string | null;
  description: string | null;
  appliedAt: string | null;
  /** ISO expiry. Null means Meta gave no end date — treat as indefinite. */
  expiresAt: string | null;
  violationTypes: string[];
}

export interface PageRecommendedAction {
  /** LEARN_MORE | FILE_APPEAL | SUPPORT_TICKET. */
  actionType: string;
  url: string | null;
  violationTypes: string[];
}

export interface PageAppealEvent {
  type: string;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PageIntegrity {
  status: PageIntegrityStatus | null;
  /** When Meta computed this, not when we read it. */
  timestamp: string | null;
  violations: PageViolation[];
  restrictions: PageRestriction[];
  recommendedActions: PageRecommendedAction[];
  appeals: PageAppealEvent[];
}

/** True when this snapshot says the Page cannot message right now. */
export function blocksMessaging(integrity: PageIntegrity): boolean {
  return integrity.restrictions.some(
    (r) =>
      MESSAGING_RESTRICTION_FEATURES.has(r.feature) &&
      // A restriction row is also how Meta announces a LIFT (`UNRESTRICTED`), so
      // presence alone is not enough — an absent status means the API shape,
      // which only ever lists ACTIVE restrictions.
      (r.status ?? "RESTRICTED").toUpperCase() !== "UNRESTRICTED",
  );
}

/**
 * The soonest moment a messaging restriction lifts, or null when there is none
 * (or Meta gave no expiry, which means indefinite — deliberately NOT rendered as
 * "expires now").
 */
export function messagingRestrictionExpiry(integrity: PageIntegrity): string | null {
  const active = integrity.restrictions.filter(
    (r) =>
      MESSAGING_RESTRICTION_FEATURES.has(r.feature) &&
      (r.status ?? "RESTRICTED").toUpperCase() !== "UNRESTRICTED" &&
      r.expiresAt,
  );
  if (active.length === 0) return null;
  return active.map((r) => r.expiresAt!).sort()[0]!;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
/** Meta sends Unix SECONDS throughout this node. Normalize at the seam. */
function iso(v: unknown): string | null {
  return typeof v === "number" && v > 0 ? new Date(v * 1000).toISOString() : null;
}
/**
 * The object entries of an unknown array.
 *
 * NARROWS rather than asserts, which is not just ratchet hygiene: every caller
 * then reads properties off something proven to be an object, so a malformed
 * `violations: ["SPAM"]` (a bare string where Meta documents an object) yields
 * nothing instead of `undefined.type` at render time.
 */
function rows(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
}
function violationTypes(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * The fields this parser reads, from either source.
 *
 * Structural rather than `Record<string, unknown>` so the webhook's own wire type
 * (`MessagingEvent` in meta-social.ts) can be passed straight in — an index-
 * signature parameter forced a double assertion at that call site, which is
 * precisely what this signature exists to make unnecessary. Both spellings of the
 * appeal array appear because Meta uses one in the API response and the other in
 * the webhook.
 */
export interface PageIntegritySource {
  status?: unknown;
  timestamp?: unknown;
  violations?: unknown;
  restrictions?: unknown;
  recommended_actions?: unknown;
  action_events?: unknown;
  actions_events?: unknown;
}

/**
 * Map one integrity-shaped object — the API response OR a webhook `messaging[]`
 * item, which carry the same fields — into {@link PageIntegrity}.
 *
 * `extra` lets the caller pass a second object to merge restrictions from, for
 * the webhook example where `restrictions` is a sibling of `messaging` rather
 * than inside it.
 */
export function parsePageIntegrity(
  node: PageIntegritySource,
  extra?: { restrictions?: unknown },
): PageIntegrity {
  const restrictionRows = [...rows(node.restrictions), ...rows(extra?.restrictions)];
  // Both spellings — see the header.
  const appealRows = [...rows(node.action_events), ...rows(node.actions_events)];

  return {
    status: str(node.status),
    timestamp: iso(node.timestamp),
    violations: rows(node.violations).flatMap((v) => {
      const type = str(v.type);
      return type ? [{ type, description: str(v.description), url: str(v.url) }] : [];
    }),
    restrictions: restrictionRows.flatMap((r) => {
      const feature = str(r.feature);
      return feature
        ? [
            {
              feature,
              status: str(r.status),
              description: str(r.description),
              appliedAt: iso(r.applied_time),
              expiresAt: iso(r.expiration_time),
              violationTypes: violationTypes(r.violation_type),
            },
          ]
        : [];
    }),
    recommendedActions: rows(node.recommended_actions).flatMap((a) => {
      const actionType = str(a.action_type);
      return actionType
        ? [{ actionType, url: str(a.url), violationTypes: violationTypes(a.violation_type) }]
        : [];
    }),
    appeals: appealRows.flatMap((a) => {
      const type = str(a.type);
      const status = str(a.status);
      return type && status
        ? [{ type, status, createdAt: iso(a.created_time), updatedAt: iso(a.updated_time) }]
        : [];
    }),
  };
}

/**
 * Read the Page's current integrity (`GET /{PAGE_ID}/page_status`).
 *
 * Requires `pages_manage_metadata`. Throws like the other Graph reads so the
 * caller can fail soft — every caller here treats an unreadable status as
 * "unknown", never as "healthy": claiming a Page is fine because we couldn't ask
 * is the same cry-wolf-in-reverse mistake the subscription checker already
 * documents.
 */
export async function getPageIntegrity(opts: SocialSendTarget): Promise<PageIntegrity> {
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${encodeURIComponent(opts.accountId)}/page_status`;
  return parsePageIntegrity(await graphGetJson(url, opts.accessToken, { retry: true }, opts.appSecret));
}
