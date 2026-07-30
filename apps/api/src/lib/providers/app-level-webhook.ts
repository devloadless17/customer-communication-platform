/**
 * The APP-LEVEL Meta webhook callback: which workspace does this payload belong to?
 *
 * ## Why this exists
 *
 * Today every workspace brings its own Meta app, and its webhooks arrive on
 * `POST /webhooks/meta/:workspaceId` — the path names the tenant. Under Embedded
 * Signup that stops being true: all onboarded customers' webhooks are delivered to
 * the **app's** callback URL, and Meta's docs are explicit that the override
 * mechanism cannot cover it. Per-WABA / per-phone-number `override_callback_uri`
 * applies ONLY to `messages`, `message_echoes`, `calls`, `consumer_profile`,
 * `messaging_handovers`, the group topics, `smb_message_echoes`,
 * `smb_app_state_sync`, `history` and `account_settings_update`. Template webhooks
 * (`message_template_status_update`, `_quality_update`, `_components_update`,
 * `template_category_update`) and account webhooks (`account_update`,
 * `account_review_update`, `account_alerts`) are **always** sent to the app's
 * default callback URL. There is no configuration that routes those per tenant.
 *
 * So a route with no workspaceId in the path is a requirement, not a nicety, and
 * the tenant has to come from the (already HMAC-verified) payload.
 *
 * ## Order is load-bearing
 *
 * VERIFY the signature first, resolve the workspace second. The per-workspace
 * route's own docstring notes that `workspaceId` in the path is a routing signal
 * and not proof of origin; here there is no path at all, so resolving first would
 * let an unauthenticated body drive DB lookups — an enumeration oracle and a DoS
 * lever. The caller enforces this; this module only ever sees trusted payloads.
 *
 * ## Never guess
 *
 * Every resolution path is an exact indexed lookup, and an ambiguous payload is
 * dropped with a warn. `WhatsappBusinessAccount.externalWabaId` is globally unique
 * precisely so this is a single `findUnique` — that index is the tenancy guard.
 */

import { db } from "@/lib/db";
import type { Channel } from "@ccp/shared/types";

export type AppLevelResolution =
  | { kind: "ok"; workspaceId: string; via: "waba_info" | "waba_id" | "portfolio_id" | "account_id" }
  | { kind: "none" }
  | { kind: "ambiguous"; detail: string };

/** Platform app secrets, comma-separated to allow a rotation window. */
export function platformAppSecrets(): string[] {
  const raw = process.env.META_APP_SECRET ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function platformVerifyToken(): string | null {
  const raw = process.env.META_APP_VERIFY_TOKEN?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/** True when the app-level callback is configured at all. */
export function appLevelWebhookEnabled(): boolean {
  return Boolean(process.env.META_APP_ID) && platformAppSecrets().length > 0;
}

/**
 * `value.waba_info.waba_id` anywhere in the batch.
 *
 * The most specific hint, and the one that covers `account_update` /
 * `PARTNER_ADDED` — the webhook Meta fires when a customer completes Embedded
 * Signup. THAT event is a trap worth naming: its `entry[].id` is the customer's
 * BUSINESS PORTFOLIO id, not a WABA id, with the WABA nested at
 * `value.waba_info.waba_id`. Code that assumes `entry[].id` is always a WABA
 * resolves the wrong thing (or nothing) for exactly the onboarding event.
 */
function wabaInfoIds(payload: unknown): string[] {
  const p = payload as {
    entry?: Array<{
      changes?: Array<{ value?: { waba_info?: { waba_id?: string } } }>;
    }>;
  };
  const out: string[] = [];
  for (const entry of Array.isArray(p?.entry) ? p.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const id = change?.value?.waba_info?.waba_id;
      if (typeof id === "string" && id.length > 0 && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** Distinct `entry[].id` values. WABA id, portfolio id, Page id or IG id
 *  depending on the `object` and the field — hence the ordered attempts below. */
function entryIds(payload: unknown): string[] {
  const p = payload as { entry?: Array<{ id?: string }> };
  const out: string[] = [];
  for (const entry of Array.isArray(p?.entry) ? p.entry : []) {
    const id = entry?.id;
    if (typeof id === "string" && id.length > 0 && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Collapse a set of candidate workspace ids to one answer. */
function single(ids: string[], what: string): AppLevelResolution | null {
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) return null;
  if (distinct.length > 1) {
    return {
      kind: "ambiguous",
      detail: `${what} maps to ${distinct.length} workspaces`,
    };
  }
  return { kind: "ok", workspaceId: distinct[0]!, via: "waba_id" };
}

/**
 * Resolve the owning workspace from a VERIFIED app-level payload.
 *
 * WhatsApp attempts, most specific first:
 *   1. `value.waba_info.waba_id` — the `PARTNER_ADDED` / account_update case.
 *   2. `entry[].id` read as a WABA id — every ordinary WABA-scoped topic.
 *   3. `entry[].id` read as a business-PORTFOLIO id — the account_update shape.
 *      Genuinely ambiguous in principle (`WhatsappPortfolio` is unique per
 *      workspace, so one Meta portfolio can map to two of OUR workspaces for the
 *      same customer), which is exactly why the WABA hints are tried first and why
 *      several matches drop rather than pick.
 *
 * Social attempts: `entry[].id` is the Page (Messenger) or IG account id, matched
 * against `ChannelConnection.externalAccountId` across workspaces. That column is
 * NOT globally unique yet — cross-workspace uniqueness for social accounts is
 * enforced only in application code — so several matches drop with a warn. Making
 * it a DB constraint is the deferred follow-up, triggered by shipping app-level
 * SOCIAL ingest for real.
 */
export async function resolveAppLevelWorkspace(
  channel: Channel,
  payload: unknown,
): Promise<AppLevelResolution> {
  if (channel === "whatsapp") {
    const infoIds = wabaInfoIds(payload);
    if (infoIds.length > 0) {
      const rows = await db.whatsappBusinessAccount.findMany({
        where: { externalWabaId: { in: infoIds } },
        select: { workspaceId: true },
      });
      const hit = single(
        rows.map((r) => r.workspaceId),
        "waba_info.waba_id",
      );
      if (hit) return hit.kind === "ok" ? { ...hit, via: "waba_info" } : hit;
    }

    const ids = entryIds(payload);
    if (ids.length === 0) return { kind: "none" };

    const byWaba = await db.whatsappBusinessAccount.findMany({
      where: { externalWabaId: { in: ids } },
      select: { workspaceId: true },
    });
    const wabaHit = single(
      byWaba.map((r) => r.workspaceId),
      "entry[].id as WABA id",
    );
    if (wabaHit) return wabaHit;

    // `account_update` puts the PORTFOLIO id in `entry[].id`.
    const byPortfolio = await db.whatsappPortfolio.findMany({
      where: { externalPortfolioId: { in: ids } },
      select: { workspaceId: true },
    });
    const portfolioHit = single(
      byPortfolio.map((r) => r.workspaceId),
      "entry[].id as portfolio id",
    );
    if (portfolioHit) {
      return portfolioHit.kind === "ok" ? { ...portfolioHit, via: "portfolio_id" } : portfolioHit;
    }
    return { kind: "none" };
  }

  const ids = entryIds(payload);
  if (ids.length === 0) return { kind: "none" };
  const rows = await db.channelConnection.findMany({
    where: { channel, externalAccountId: { in: ids } },
    select: { workspaceId: true },
  });
  const hit = single(
    rows.map((r) => r.workspaceId),
    `entry[].id as ${channel} account id`,
  );
  if (!hit) return { kind: "none" };
  return hit.kind === "ok" ? { ...hit, via: "account_id" } : hit;
}
