import {
  GRAPH_BASE,
  graphDelete,
  graphGetJson,
  graphPostForm,
} from "@/lib/providers/meta-graph";

/**
 * WABA ↔ app webhook subscription (`/{waba-id}/subscribed_apps`).
 *
 * Meta only delivers `object:"whatsapp_business_account"` webhooks (messages,
 * template lifecycle, quality, capability — everything ingest consumes) for
 * WABAs that are subscribed to the app. Nothing in the product used to assert
 * this — WhatsApp onboarding relied on prose telling the admin to tick boxes
 * in the Meta dashboard, which is exactly the omission that took Messenger
 * dark in prod on 2026-07-10 (see meta-page-subscription.ts): a dashboard
 * re-save silently reset the subscription and zero inbound arrived, with
 * valid credentials and no error anywhere.
 *
 * Simpler than the Page module on purpose: WhatsApp webhook FIELDS are
 * configured app-wide (the dashboard's field checklist), not per-WABA — the
 * per-WABA question is only "is this app subscribed at all". So there is no
 * field-union dance; POST subscribes, GET confirms.
 *
 * BEST-EFFORT, like the Page module: a failure here must never fail the
 * connect (the token may lack `whatsapp_business_management` on the WABA);
 * the caller surfaces a warning instead of blocking onboarding.
 */
export async function ensureWabaSubscribed(
  wabaId: string,
  accessToken: string,
  graphVersion: string,
  appId?: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = `${GRAPH_BASE}/${graphVersion}/${encodeURIComponent(wabaId)}/subscribed_apps`;
  try {
    // Idempotent — subscribing an already-subscribed app succeeds.
    await graphPostForm(url, accessToken, new FormData());
    // Re-read rather than trust the `{success:true}` echo — the truth for the
    // settings warning must be what Meta stored, not our optimistic intent.
    const after = await graphGetJson(url, accessToken);
    if (!isAppSubscribedToWaba(after, appId)) {
      return {
        ok: false,
        error: appId
          ? `subscription did not stick (app ${appId} absent from subscribed_apps)`
          : "subscription did not stick (subscribed_apps reads back empty)",
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Is OUR app among the apps subscribed to this WABA?
 *
 * `GET /{waba-id}/subscribed_apps` lists EVERY app subscribed to the WABA — Meta's
 * own reference ships a "Multiple apps subscribed to WABA" example response, and a
 * WABA shared with another BSP (Coexistence, partner onboarding, a previous vendor
 * the customer never detached) is the normal way that happens. Reading the answer
 * as `data.length > 0` therefore answered a different question than the one asked:
 * "is anyone subscribed", not "are WE". Our app could be absent — receiving nothing
 * — while the health check reported subscribed, which is precisely the silent hole
 * the check exists to close.
 *
 * Two deliberate fallbacks, both toward NOT crying wolf:
 *  - no `appId` known (a row stored before it was captured) → any subscription
 *    counts, the pre-existing behaviour;
 *  - `data` is non-empty but no id could be read from it (a shape Meta changed
 *    under us) → treat as subscribed rather than flag every connection at once.
 * An empty `data` is unambiguous in every case: nobody is subscribed.
 */
export function isAppSubscribedToWaba(
  res: Record<string, unknown>,
  appId?: string | null,
): boolean {
  const data = Array.isArray(res.data) ? res.data : [];
  if (data.length === 0) return false;
  if (!appId) return true;
  const ids: string[] = [];
  for (const row of data as Array<{ whatsapp_business_api_data?: { id?: unknown } }>) {
    const id = row?.whatsapp_business_api_data?.id;
    if (typeof id === "string" && id.length > 0) ids.push(id);
    else if (typeof id === "number") ids.push(String(id));
  }
  if (ids.length === 0) return true;
  return ids.includes(appId);
}

/**
 * Release this app's subscription to a WABA (`DELETE /{waba-id}/subscribed_apps`).
 *
 * The counterpart to {@link ensureWabaSubscribed}, and the half that was missing:
 * connecting asserted the subscription, disconnecting never released it, so Meta
 * kept POSTing a removed customer's message content to us indefinitely. We dropped
 * it fail-soft as `unknown_account`, but "we drop it" is not the same as "we don't
 * receive it" — under a Tech Provider model that is a churned customer's traffic
 * still arriving at our ingest.
 *
 * Only removes OUR app's subscription; any other app subscribed to the same WABA is
 * untouched. Callers MUST first confirm no other active connection still uses this
 * WABA — numbers under one WABA share the subscription, so releasing it while a
 * sibling number is live would take that number's inbound dark.
 *
 * BEST-EFFORT: never throws. Failing to unsubscribe must not block a removal the
 * operator asked for — the worst case is the status quo ante.
 */
export async function releaseWabaSubscription(
  wabaId: string,
  accessToken: string,
  graphVersion: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = `${GRAPH_BASE}/${graphVersion}/${encodeURIComponent(wabaId)}/subscribed_apps`;
  try {
    await graphDelete(url, accessToken);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
