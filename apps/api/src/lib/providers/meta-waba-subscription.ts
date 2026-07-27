import { GRAPH_BASE, graphGetJson, graphPostForm } from "@/lib/providers/meta-graph";

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
): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = `${GRAPH_BASE}/${graphVersion}/${encodeURIComponent(wabaId)}/subscribed_apps`;
  try {
    // Idempotent — subscribing an already-subscribed app succeeds.
    await graphPostForm(url, accessToken, new FormData());
    // Re-read rather than trust the `{success:true}` echo — the truth for the
    // settings warning must be what Meta stored, not our optimistic intent.
    const after = await graphGetJson(url, accessToken);
    const apps = Array.isArray(after.data) ? after.data : [];
    if (apps.length === 0) {
      return {
        ok: false,
        error: "subscription did not stick (subscribed_apps reads back empty)",
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
