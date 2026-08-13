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
  /** Signs with `appsecret_proof`, like `listWabaPhoneNumberIds` below. Against a
   *  customer app with "Require app secret" ON, the UNSIGNED subscribe 400s — so
   *  the WABA was never subscribed, zero inbound arrived, and the 30-min sweeper's
   *  self-heal failed the same way twice an hour (observed live 2026-08-11). */
  appSecret?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = `${GRAPH_BASE}/${graphVersion}/${encodeURIComponent(wabaId)}/subscribed_apps`;
  try {
    // Idempotent — subscribing an already-subscribed app succeeds.
    await graphPostForm(url, accessToken, new FormData(), appSecret);
    // Re-read rather than trust the `{success:true}` echo — the truth for the
    // settings warning must be what Meta stored, not our optimistic intent.
    const after = await graphGetJson(url, accessToken, undefined, appSecret);
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
 * The Meta APP the token belongs to (`GET /app?fields=id` — the `/app` node
 * resolves to the app that ISSUED the bearer token).
 *
 * This is what makes the "is OUR app subscribed" check above scopable for rows
 * connected before the App ID form field existed: their `config.appId` is
 * empty, so `isAppSubscribedToWaba` degrades to any-app — a shared WABA reads
 * healthy while our app receives nothing. Learn the id from the token once
 * (connect-time, plus a one-shot sweeper backfill for legacy rows), persist
 * it, and the fallback branch becomes unreachable in practice while staying
 * exactly as documented for the rows it still covers.
 *
 * Never throws — `null` means "couldn't learn it today"; callers keep the
 * unscoped behaviour and try again another day.
 */
export async function fetchTokenAppId(
  accessToken: string,
  graphVersion: string,
  appSecret?: string,
): Promise<string | null> {
  try {
    const res = await graphGetJson(
      `${GRAPH_BASE}/${graphVersion}/app?fields=id`,
      accessToken,
      { retry: true },
      appSecret,
    );
    const id = (res as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
    if (typeof id === "number") return String(id);
    return null;
  } catch {
    return null;
  }
}

/**
 * Every phone-number id this WABA currently owns (`GET /{waba-id}/phone_numbers`).
 *
 * Two callers, one question: connect-time asserts the pasted WABA really owns the
 * number being connected, and the health sweeper asserts it STILL does. That second
 * use is the one that matters, because a number can leave a WABA without us doing
 * anything — see the re-parent detection in `webhook-subscription-health.ts`.
 *
 * PAGES, and treats truncation as an ERROR rather than a short list. Both callers ask
 * "is my number in here", so a truncated page is a FALSE NEGATIVE: connect refuses a
 * WABA that does own the number, and the sweeper reports a re-parent that never
 * happened. A single `limit=200` read was silently capable of both — Meta documents
 * WABAs with "expanded limits of up to 1,200 numbers", so 200 is not a safe ceiling.
 * Same discipline as `fetchTemplates`: an incomplete list must not be handed to a
 * membership test.
 *
 * Returns `rowsSeen` alongside the ids, and callers MUST branch on it, for the same
 * reason `isAppSubscribedToWaba` refuses to cry wolf: `ids: []` with `rowsSeen > 0`
 * means Meta returned numbers in a shape we could not read, NOT that the WABA owns
 * none. Collapsing those two into "owns nothing" makes one Meta shape change refuse
 * every connect and report every WhatsApp account on the platform as dark at once —
 * a self-inflicted outage dressed as a detection.
 */
const WABA_NUMBER_PAGE_LIMIT = 200;
/** 1,200 documented max ÷ 200 per page, with headroom. */
const WABA_NUMBER_MAX_PAGES = 12;

export async function listWabaPhoneNumberIds(
  wabaId: string,
  accessToken: string,
  graphVersion: string,
  /** Threaded so this call is covered when `META_APPSECRET_PROOF` is flipped on,
   *  rather than becoming one more unproofed read outside `meta.ts`. */
  appSecret?: string,
): Promise<{ ok: true; ids: string[]; rowsSeen: number } | { ok: false; error: string }> {
  const ids: string[] = [];
  let rowsSeen = 0;
  let url =
    `${GRAPH_BASE}/${graphVersion}/${encodeURIComponent(wabaId)}` +
    `/phone_numbers?fields=id&limit=${WABA_NUMBER_PAGE_LIMIT}`;
  try {
    for (let page = 0; ; page++) {
      if (page >= WABA_NUMBER_MAX_PAGES) {
        return {
          ok: false,
          error:
            `phone_numbers did not terminate within ${WABA_NUMBER_MAX_PAGES} pages — ` +
            "refusing to answer an ownership question from a truncated list",
        };
      }
      const res = await graphGetJson(url, accessToken, { retry: true }, appSecret);
      const rows = Array.isArray(res.data) ? (res.data as Array<{ id?: unknown }>) : [];
      rowsSeen += rows.length;
      for (const row of rows) {
        if (typeof row?.id === "string" && row.id.length > 0) ids.push(row.id);
        else if (typeof row?.id === "number") ids.push(String(row.id));
      }
      const next = (res.paging as { next?: unknown } | undefined)?.next;
      if (typeof next !== "string" || next.length === 0) return { ok: true, ids, rowsSeen };
      url = next;
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
  /** Same signing rationale as `ensureWabaSubscribed`. */
  appSecret?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = `${GRAPH_BASE}/${graphVersion}/${encodeURIComponent(wabaId)}/subscribed_apps`;
  try {
    await graphDelete(url, accessToken, appSecret);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
