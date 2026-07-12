import { GRAPH_BASE, graphGetJson, graphPostForm } from "@/lib/providers/meta-graph";

/**
 * Facebook Page ↔ app webhook subscription (`/{page-id}/subscribed_apps`).
 *
 * Meta only delivers `object:"page"` (Messenger) and the Page-hosted Instagram
 * messaging webhooks for Pages that are subscribed to the app FOR THE RELEVANT
 * FIELDS. Nothing in the product used to do this — onboarding relied on an admin
 * ticking boxes in the Meta dashboard, and a single re-save there silently reset
 * the set (observed in prod 2026-07-10: `subscribed_fields: ["name"]`, zero
 * Messenger inbound, WhatsApp + Instagram unaffected because they subscribe
 * separately). Connecting a channel now (re-)asserts the subscription.
 *
 * TWO PROPERTIES THIS MODULE MUST KEEP:
 *
 *  1. `POST subscribed_apps` REPLACES the whole field set, it does not merge.
 *     Messenger and Instagram can share ONE Page, so if each channel posted only
 *     its own fields, connecting one would silently unsubscribe the other. We
 *     therefore GET the current set and POST the UNION — additive, never lossy,
 *     and it preserves unrelated fields (`name`, `feed`, …) the team may rely on.
 *
 *  2. It is BEST-EFFORT. A failure here must never fail the connect: the
 *     credentials are valid and every other path works, so we surface the
 *     problem (health warning on the settings page) rather than block onboarding
 *     behind a Graph permission we may not have.
 */

/**
 * The Page webhook fields our social parser consumes (`meta-social.ts`). Kept as
 * ONE union across Messenger + Instagram precisely because they share a Page —
 * see property (1) above. Adding a parser branch for a new field means adding it
 * here, otherwise Meta never sends it.
 */
export const PAGE_MESSAGING_FIELDS = [
  "messages", // inbound text/media/attachments (+ is_echo when subscribed below)
  "message_echoes", // replies typed in Meta's native Page inbox
  "messaging_postbacks", // Get Started / persistent-menu / postback-button taps
  "messaging_referrals", // m.me `ref` deep links + Click-to-Messenger ad attribution
  "messaging_optins", // opt-in / notification tokens
  "message_deliveries", // delivery receipts
  "message_reads", // read receipts ("Seen")
  "message_reactions", // reactions on a message
  "message_edits", // customer edited a message
] as const;

/**
 * Best-effort fields, kept SEPARATE from the required set: an app that lacks the
 * relevant permission gets the whole `subscribed_fields` POST rejected rather
 * than a partial apply. We try them, and fall back to the core set — losing a
 * read receipt or a calls webhook is far better than losing every inbound
 * message. They are also excluded from `missingFields`, so a field Meta silently
 * ignores can't raise a permanent false warning on the settings page.
 *
 *  - `calls`          — Messenger Calling (`entry.calls[]`).
 *  - `messaging_seen` — Instagram's read receipt. Messenger delivers reads on
 *    `message_reads`; Instagram has no such field and uses this one instead. Both
 *    land on `entry.messaging[].read` and are parsed by the same branch, but
 *    without this subscription Instagram read receipts never arrive at all,
 *    despite `CHANNEL_CAPABILITIES.instagram.readReceipts === true`.
 */
const PAGE_OPTIONAL_FIELDS = ["calls", "messaging_seen"] as const;

export interface PageSubscriptionStatus {
  /** Fields the app is currently subscribed to for this Page. */
  subscribedFields: string[];
  /** Fields from {@link PAGE_MESSAGING_FIELDS} that are NOT subscribed. */
  missingFields: string[];
  /** False when `messages` is missing — i.e. no inbound will ever arrive. */
  receivesMessages: boolean;
}

function fieldsFromGraph(res: Record<string, unknown>): string[] {
  const data = Array.isArray(res.data) ? res.data : [];
  const fields = new Set<string>();
  for (const app of data as Array<{ subscribed_fields?: unknown }>) {
    if (!Array.isArray(app.subscribed_fields)) continue;
    for (const f of app.subscribed_fields) if (typeof f === "string") fields.add(f);
  }
  return [...fields];
}

/**
 * Read which webhook fields this app is subscribed to for the Page. Used by the
 * settings page to render the "Page isn't subscribed to `messages`" warning that
 * would have caught the outage above the moment it happened.
 */
export async function getPageSubscription(
  pageId: string,
  pageAccessToken: string,
  graphVersion: string,
): Promise<PageSubscriptionStatus> {
  const url = `${GRAPH_BASE}/${graphVersion}/${encodeURIComponent(pageId)}/subscribed_apps`;
  const subscribedFields = fieldsFromGraph(await graphGetJson(url, pageAccessToken));
  const missingFields = PAGE_MESSAGING_FIELDS.filter((f) => !subscribedFields.includes(f));
  return {
    subscribedFields,
    missingFields,
    receivesMessages: subscribedFields.includes("messages"),
  };
}

/**
 * Subscribe the app to this Page for (at least) every field our parser reads.
 * Idempotent and additive: existing fields are preserved, so re-connecting one
 * channel can never unsubscribe the other channel sharing the Page.
 *
 * Never throws — returns `{ ok: false, error }` so the caller can complete the
 * connect and surface a warning instead of rolling back valid credentials.
 */
export async function ensurePageSubscribedToMessaging(
  pageId: string,
  pageAccessToken: string,
  graphVersion: string,
): Promise<{ ok: true; subscribedFields: string[] } | { ok: false; error: string }> {
  const url = `${GRAPH_BASE}/${graphVersion}/${encodeURIComponent(pageId)}/subscribed_apps`;
  const post = async (fields: string[]) => {
    const form = new FormData();
    form.set("subscribed_fields", fields.join(","));
    await graphPostForm(url, pageAccessToken, form);
  };

  try {
    const current = await getPageSubscription(pageId, pageAccessToken, graphVersion);
    const wanted = [...current.subscribedFields, ...PAGE_MESSAGING_FIELDS];
    if (
      current.missingFields.length === 0 &&
      PAGE_OPTIONAL_FIELDS.every((f) => current.subscribedFields.includes(f))
    ) {
      return { ok: true, subscribedFields: current.subscribedFields };
    }
    // Union, not replacement — see property (1).
    const union = [...new Set(wanted)];
    try {
      await post([...union, ...PAGE_OPTIONAL_FIELDS]);
    } catch {
      // An optional field was rejected (no permission / not enabled for this
      // app) — retry with the core messaging set so a calling or read-receipt
      // gap can't cost us every message.
      await post(union);
    }
    // Re-read rather than trust the `{success:true}` echo: Meta silently ignores
    // fields the app lacks permission for, and we want the truth on the settings
    // page, not our optimistic intent.
    const after = await getPageSubscription(pageId, pageAccessToken, graphVersion);
    return { ok: true, subscribedFields: after.subscribedFields };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
