import {
  GRAPH_BASE,
  graphDelete,
  graphGetJson,
  graphPostForm,
} from "@/lib/providers/meta-graph";

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
 *  - `response_feedback` — Messenger's built-in 👍/👎 rating of a business
 *    message. The parser has produced `message_feedback` from it for a while, but
 *    the field was never subscribed, so the branch was unreachable. Meta's
 *    reference is explicit that this is a real subscription field AND that
 *    subscribing is what puts the buttons in the thread: "By subscribing to the
 *    `response_feedback` field for a particular page, all messages sent by your app
 *    on behalf of that page will have the response feedback options in the message
 *    thread." Unsubscribed, the customer never saw the buttons and we never got the
 *    event — the feature was dead at both ends. OPTIONAL rather than required
 *    because it changes the customer-facing thread and is Messenger-only: an
 *    Instagram-only Page rejecting it must not take the core `messages`
 *    subscription down with it.
 */
export const PAGE_OPTIONAL_FIELDS = ["calls", "messaging_seen", "response_feedback"] as const;

export interface PageSubscriptionStatus {
  /** Fields the app is currently subscribed to for this Page. */
  subscribedFields: string[];
  /** Fields from {@link PAGE_MESSAGING_FIELDS} that are NOT subscribed. */
  missingFields: string[];
  /** False when `messages` is missing — i.e. no inbound will ever arrive. */
  receivesMessages: boolean;
  /**
   * True when the fields above are OUR app's, false when they are the union over
   * every app on the Page because no `appId` was known. A caller that alerts on
   * this status should say which it got — "subscribed" means something weaker in
   * the unscoped case.
   */
  scopedToApp: boolean;
}

/**
 * The fields OUR app is subscribed to for this Page.
 *
 * `GET /{page-id}/subscribed_apps` returns "a list of Application nodes" and
 * "the following fields will be added to each node: `subscribed_fields`" (Graph
 * API reference, Page > Subscribed Apps) — one node per app subscribed to the
 * Page, each with its OWN field set. Unioning across every node credited us with
 * ANOTHER app's subscription: on a Page shared with a second app (an agency's
 * tool, a previous vendor, the customer's own integration) `receivesMessages`
 * read true while our app was subscribed to nothing. Worse, it also fed
 * {@link ensurePageSubscribedToMessaging}'s early return, so the self-heal
 * concluded there was nothing to do and never subscribed us — the one repair
 * path silently doing nothing in exactly the case it exists for.
 *
 * `appId` is OPTIONAL because a connection stored before the id was captured has
 * none, and refusing to answer would take the detector down for those rows. Its
 * absence falls back to the union — the pre-existing behaviour, which still
 * catches "nobody is subscribed", just not "somebody else is". `scopedToApp`
 * reports which answer the caller got rather than letting the two look alike.
 */
function fieldsFromGraph(
  res: Record<string, unknown>,
  appId?: string | null,
): { fields: string[]; scopedToApp: boolean } {
  const data = Array.isArray(res.data) ? res.data : [];
  const nodes = data as Array<{ id?: unknown; subscribed_fields?: unknown }>;
  const scopedToApp = Boolean(appId);
  const source = scopedToApp ? nodes.filter((n) => String(n.id ?? "") === appId) : nodes;
  const fields = new Set<string>();
  for (const app of source) {
    if (!Array.isArray(app.subscribed_fields)) continue;
    for (const f of app.subscribed_fields) if (typeof f === "string") fields.add(f);
  }
  return { fields: [...fields], scopedToApp };
}

/**
 * Read which webhook fields this app is subscribed to for the Page. Used by the
 * settings page to render the "Page isn't subscribed to `messages`" warning that
 * would have caught the outage above the moment it happened.
 *
 * Pass `appId` whenever the caller knows it — see {@link fieldsFromGraph} for why
 * a shared Page otherwise reports another app's subscription as ours.
 */
export async function getPageSubscription(
  pageId: string,
  pageAccessToken: string,
  graphVersion: string,
  appId?: string | null,
): Promise<PageSubscriptionStatus> {
  const url = `${GRAPH_BASE}/${graphVersion}/${encodeURIComponent(pageId)}/subscribed_apps`;
  const { fields: subscribedFields, scopedToApp } = fieldsFromGraph(
    await graphGetJson(url, pageAccessToken),
    appId,
  );
  const missingFields = PAGE_MESSAGING_FIELDS.filter((f) => !subscribedFields.includes(f));
  return {
    subscribedFields,
    missingFields,
    receivesMessages: subscribedFields.includes("messages"),
    scopedToApp,
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
  appId?: string | null,
): Promise<{ ok: true; subscribedFields: string[] } | { ok: false; error: string }> {
  const url = `${GRAPH_BASE}/${graphVersion}/${encodeURIComponent(pageId)}/subscribed_apps`;
  const post = async (fields: string[]) => {
    const form = new FormData();
    form.set("subscribed_fields", fields.join(","));
    await graphPostForm(url, pageAccessToken, form);
  };

  try {
    // Scoped to our own app: the union we POST must extend OUR current set (so a
    // shared Page's other channel keeps its fields — property (1)), never another
    // app's, which would both skip the work below and subscribe us to fields no
    // parser here reads.
    const current = await getPageSubscription(pageId, pageAccessToken, graphVersion, appId);
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
    const after = await getPageSubscription(pageId, pageAccessToken, graphVersion, appId);
    return { ok: true, subscribedFields: after.subscribedFields };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Release this app's messaging subscription to a Page when the LAST channel using
 * that Page is disconnected.
 *
 * The counterpart to {@link ensurePageSubscribedToMessaging}. Connecting asserted
 * the subscription; nothing ever released it, so Meta kept delivering a removed
 * Page's customer messages forever — we dropped them fail-soft as `unknown_account`,
 * but "we drop it" is not "we don't receive it".
 *
 * `stillInUse` is the whole safety story. Messenger and Instagram can share ONE
 * Page, and this module deliberately keeps a SINGLE union of fields across both
 * (see property (1) at the top) — there is no per-channel subset to subtract. So
 * while the sibling channel is still connected this is a NO-OP: releasing anything
 * would take that channel's inbound dark, which is the exact failure the union was
 * written to prevent, just in the opposite direction. Only when nobody is left do
 * we DELETE.
 *
 * Removes only OUR app's subscription; other apps on the same Page are untouched.
 *
 * BEST-EFFORT: never throws. Failing to unsubscribe must not block a removal the
 * operator asked for — worst case is the status quo.
 */
export async function releasePageSubscription(
  pageId: string,
  pageAccessToken: string,
  graphVersion: string,
  opts: { stillInUse: boolean },
): Promise<{ ok: true; action: "deleted" | "kept" } | { ok: false; error: string }> {
  if (opts.stillInUse) return { ok: true, action: "kept" };
  const url = `${GRAPH_BASE}/${graphVersion}/${encodeURIComponent(pageId)}/subscribed_apps`;
  try {
    await graphDelete(url, pageAccessToken);
    return { ok: true, action: "deleted" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
