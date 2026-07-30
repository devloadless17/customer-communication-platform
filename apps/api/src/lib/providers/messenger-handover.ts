/**
 * HANDOVER PROTOCOL — who is allowed to answer this thread right now.
 *
 * A Page can have several apps attached to it: one PRIMARY receiver and any
 * number of SECONDARY receivers. Exactly one holds "thread control" for a given
 * conversation at a time, and only that one may send. Everyone else receives the
 * same traffic passively on the `standby` webhook.
 *
 * ## Why a shared inbox needs this even though it never asked for it
 *
 * This product onboards as the sole Customer-Care app and does not enable
 * routing, so in the common case none of this fires. The failure it protects
 * against is not ours to prevent though: a customer can attach a chatbot,
 * an agency tool, or Meta's own Page Inbox automations to the same Page at any
 * time, without telling us. The moment they do, OUR inbound arrives only on
 * `standby`, every reply fails with `2018300` ("another app is controlling this
 * thread now"), and from the operator's seat the inbox has simply gone quiet.
 *
 * `normalizeMetaSendError` already classifies that error as
 * `thread_control_lost` and buckets it retryable. This module is what makes the
 * retry actually possible: a PRIMARY receiver can TAKE control back, and a
 * SECONDARY one can REQUEST it.
 *
 * ## Deliberately not automatic
 *
 * Taking control is exposed as an explicit action, not wired into the send path
 * as a silent retry. Thread control is a real handoff — seizing it mid-flow from
 * a bot that is collecting a customer's order would look, from the customer's
 * side, like the business interrupting itself. An agent choosing to take over is
 * a decision; a `catch` block doing it is a race.
 *
 * ## The two inbox app ids
 *
 * Passing control "to the inbox" means passing to one of Meta's own first-party
 * apps, whose ids are documented constants rather than something discoverable:
 * `263902037430900` for the Page Inbox and `1217981644879628` for the Instagram
 * Inbox. Handing a thread back to the human staffing Business Suite is the most
 * common pass there is, so they are named here rather than left as magic numbers
 * at a call site.
 */

import { GRAPH_BASE, graphGetJson, graphPostJson } from "@/lib/providers/meta-graph";
import type { SocialSendTarget } from "@/lib/providers/meta-social";

/** Meta's own Page Inbox app — the target for "hand this back to Business Suite". */
export const PAGE_INBOX_APP_ID = "263902037430900";
/** Meta's own Instagram Inbox app. */
export const INSTAGRAM_INBOX_APP_ID = "1217981644879628";

/** One app attached to the Page as a secondary receiver. */
export interface SecondaryReceiver {
  id: string;
  name: string | null;
}

function url(opts: SocialSendTarget, edge: string, query = ""): string {
  const base = `${GRAPH_BASE}/${opts.graphVersion}/${encodeURIComponent(opts.accountId)}/${edge}`;
  return query ? `${base}?${query}` : base;
}

/**
 * Which app currently owns this conversation.
 *
 * Only a PRIMARY receiver may call this — Meta's reference is explicit ("Allows a
 * Primary Receiver app, if one is set, to retrieve the app ID"). Returns null
 * rather than throwing when the answer is unavailable, because "we are not
 * primary" and "no one owns it" are both ordinary states for a Page that has
 * never used routing, and neither should surface to an operator as an error.
 */
export async function getThreadOwner(
  psid: string,
  opts: SocialSendTarget,
): Promise<string | null> {
  try {
    const res = await graphGetJson(
      url(opts, "thread_owner", `recipient=${encodeURIComponent(psid)}`),
      opts.accessToken,
      { retry: true },
      opts.appSecret,
    );
    // Meta nests this one: `data[0].thread_owner.app_id`.
    const data = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];
    const owner = data[0]?.thread_owner as { app_id?: unknown } | undefined;
    return typeof owner?.app_id === "string"
      ? owner.app_id
      : typeof owner?.app_id === "number"
        ? String(owner.app_id)
        : null;
  } catch {
    return null;
  }
}

/** Every app attached to the Page as a secondary receiver. Primary-only, fails soft. */
export async function getSecondaryReceivers(
  opts: SocialSendTarget,
): Promise<SecondaryReceiver[]> {
  try {
    const res = await graphGetJson(
      url(opts, "secondary_receivers", "fields=id,name"),
      opts.accessToken,
      { retry: true },
      opts.appSecret,
    );
    const data = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];
    return data.flatMap((row) => {
      const id = typeof row.id === "string" ? row.id : null;
      return id ? [{ id, name: typeof row.name === "string" ? row.name : null }] : [];
    });
  } catch {
    return [];
  }
}

/**
 * TAKE control back. Primary receiver only — this is the move that unblocks an
 * agent whose reply failed with `2018300`.
 */
export async function takeThreadControl(
  psid: string,
  opts: SocialSendTarget,
  metadata?: string,
): Promise<void> {
  await graphPostJson(
    url(opts, "take_thread_control"),
    opts.accessToken,
    { recipient: { id: psid }, ...(metadata ? { metadata } : {}) },
    opts.appSecret,
  );
}

/**
 * PASS control to another app. `targetAppId` is required by Meta when passing
 * between apps; use {@link PAGE_INBOX_APP_ID} to hand the thread to the humans in
 * Business Suite, which is what "I'm done, the bot/inbox can have it" means.
 */
export async function passThreadControl(
  psid: string,
  targetAppId: string,
  opts: SocialSendTarget,
  metadata?: string,
): Promise<void> {
  await graphPostJson(
    url(opts, "pass_thread_control"),
    opts.accessToken,
    {
      recipient: { id: psid },
      target_app_id: targetAppId,
      ...(metadata ? { metadata } : {}),
    },
    opts.appSecret,
  );
}

/**
 * REQUEST control as a secondary receiver. The primary receiver gets a
 * `request_thread_control` webhook and "may then choose to honor the request and
 * pass thread control, or ignore the request" — so this is a message, not a
 * guarantee, and callers must not treat a 200 here as having the thread.
 */
export async function requestThreadControl(
  psid: string,
  opts: SocialSendTarget,
  metadata?: string,
): Promise<void> {
  await graphPostJson(
    url(opts, "request_thread_control"),
    opts.accessToken,
    { recipient: { id: psid }, ...(metadata ? { metadata } : {}) },
    opts.appSecret,
  );
}

/** RELEASE control before it expires, returning the thread to the primary receiver. */
export async function releaseThreadControl(
  psid: string,
  opts: SocialSendTarget,
): Promise<void> {
  await graphPostJson(
    url(opts, "release_thread_control"),
    opts.accessToken,
    { recipient: { id: psid } },
    opts.appSecret,
  );
}
