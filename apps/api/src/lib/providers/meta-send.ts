import { readLimitedBody } from "@/lib/http/safe-fetch";
export const META_ERROR_BODY_CAP = 8192;

export async function safeMetaText(res: Response): Promise<string> {
  try {
    const truncated = await readLimitedBody(res, META_ERROR_BODY_CAP);
    return truncated ?? "";
  } catch {
    return "";
  }
}

import { parseBlockUsersResponse } from "./meta-webhook-parse";
import { metaFetch } from "./meta-transport";
import { SendTextResult } from "@ccp/shared/providers/types";
import { SendInteractiveArgs } from "@ccp/shared/providers/types";
import { MetaSendError } from "./meta-send-error";
import { MetaSendConfig } from "@/lib/providers/config";
import { MetaBlockUsersResponse } from "./meta-webhook-parse";
import { GRAPH_BASE } from "./meta-transport";
import { BlockUsersResult } from "@ccp/shared/providers/types";
/**
 * WhatsApp SEND functions — stage 3 of the meta.ts split (2026-07-31).
 * The interactive/special-message senders and the shared POST body helpers.
 * Imports transport from meta-transport.ts.
 */

/**
 * Address a WhatsApp `/messages` send: a phone rides `to`; a BSUID rides the
 * top-level `recipient` field. Per the BSUID page + Send Marketing Messages
 * reference (2026-07): "recipient — User BSUID or parent BSUID for individual
 * messages. Used only when `to` is omitted"; when both are present Meta uses
 * `to` and ignores `recipient`. This SUPERSEDES the 2026-07-30 reading that a
 * BSUID rides `to` — `postWhatsappMessages` keeps that legacy form working as
 * a one-shot retry while Meta's rollout completes, so either server behavior
 * is handled.
 */
export function whatsappDestination(args: { to: string; viaBsuid?: boolean }): Record<string, string> {
  return args.viaBsuid ? { recipient: args.to } : { to: args.to };
}


/**
 * POST a `/messages` body. When the body addresses a BSUID via `recipient` and
 * Meta rejects the FIELD itself (#100 naming the param, or the documented
 * misleading "The parameter to is required" that means `recipient` was
 * ignored), retry ONCE with the pre-July form — the BSUID in `to`. Safe: a 400
 * rejection created no message, so the retry cannot double-send. Every other
 * response (including every failure of a phone-addressed send) passes through
 * untouched, preserving each caller's own error handling.
 */
export async function postWhatsappMessages(
  url: string,
  config: MetaSendConfig,
  bodyObj: Record<string, unknown>,
): Promise<Response> {
  const post = (b: Record<string, unknown>) =>
    metaFetch(url, {
      method: "POST",
      appSecret: config.appSecret,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify(b),
    });
  const res = await post(bodyObj);
  if (res.ok || typeof bodyObj.recipient !== "string") return res;
  const text = await res.clone().text().catch(() => "");
  const rejectsRecipientField =
    /"code"\s*:\s*100\b/.test(text) &&
    (/recipient/i.test(text) || /parameter to is required/i.test(text));
  if (!rejectsRecipientField) return res;
  console.warn(
    JSON.stringify({
      event: "meta.bsuid_recipient_fallback",
      severity: "info",
      phoneNumberId: config.phoneNumberId,
      note: "Meta rejected the `recipient` param — retried with the BSUID in `to` (pre-July form)",
    }),
  );
  const { recipient, ...rest } = bodyObj;
  return post({ ...rest, to: recipient });
}


/**
 * `interactive.type: "location_request_message"` — body text + WhatsApp's own
 * "send location" button (location-request-messages doc). The action name is
 * the fixed literal `send_location`; there is nothing else to configure. Body
 * cap (1024) is enforced by the schemas upstream, same as buttons/list.
 */
export async function sendLocationRequest(
  args: SendInteractiveArgs,
  config: MetaSendConfig,
): Promise<SendTextResult> {
  const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
  const res = await postWhatsappMessages(url, config, {
      messaging_product: "whatsapp",
      ...messagingAccountField(config),
      recipient_type: "individual",
      ...whatsappDestination(args),
      type: "interactive",
      interactive: {
        type: "location_request_message",
        body: { text: args.bodyText },
        action: { name: "send_location" },
      },
      ...(args.replyToExternalId
        ? { context: { message_id: args.replyToExternalId } }
        : {}),
    });
  if (!res.ok) {
    const text = await safeMetaText(res);
    throw new MetaSendError(
      `meta sendLocationRequest failed: ${res.status} ${text}`,
      res.status,
      text,
    );
  }
  const json = (await res.json()) as { messages?: Array<{ id?: string }> };
  const externalId = json.messages?.[0]?.id;
  if (!externalId) {
    throw new Error(
      `meta sendLocationRequest missing message id: ${JSON.stringify(json)}`,
    );
  }
  return { externalId, timestamp: new Date() };
}


/**
 * `interactive.type: "request_contact_info"` — body text + WhatsApp's own
 * "share contact info" button (renamed from `contact_request` 2026-05-28; the
 * button label is fixed by WhatsApp, nothing else to configure). The action
 * name is the same fixed literal `request_contact_info`. The reply arrives as
 * a normal inbound `contacts` message with `contacts[].origin:
 * "contact_request"` — ingest already reads that origin, so this is purely
 * the outbound half. Body cap (1024) is enforced by the schemas upstream,
 * same as location_request.
 */
export async function sendRequestContactInfo(
  args: SendInteractiveArgs,
  config: MetaSendConfig,
): Promise<SendTextResult> {
  const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
  const res = await postWhatsappMessages(url, config, {
      messaging_product: "whatsapp",
      ...messagingAccountField(config),
      recipient_type: "individual",
      ...whatsappDestination(args),
      type: "interactive",
      interactive: {
        type: "request_contact_info",
        body: { text: args.bodyText },
        action: { name: "request_contact_info" },
      },
      ...(args.replyToExternalId
        ? { context: { message_id: args.replyToExternalId } }
        : {}),
    });
  if (!res.ok) {
    const text = await safeMetaText(res);
    throw new MetaSendError(
      `meta sendRequestContactInfo failed: ${res.status} ${text}`,
      res.status,
      text,
    );
  }
  const json = (await res.json()) as { messages?: Array<{ id?: string }> };
  const externalId = json.messages?.[0]?.id;
  if (!externalId) {
    throw new Error(
      `meta sendRequestContactInfo missing message id: ${JSON.stringify(json)}`,
    );
  }
  return { externalId, timestamp: new Date() };
}


/**
 * `interactive.type: "carousel"` — 2-10 horizontally-scrollable media cards
 * (interactive-carousel doc). Doc quirks reproduced deliberately:
 *   - every card carries `type: "cta_url"` — Meta's OWN examples set that
 *     literal even on quick-reply cards, so we copy their wire exactly;
 *   - a card's action is EITHER `{name:"cta_url", parameters}` (URL button)
 *     or `{buttons:[{type:"quick_reply", quick_reply:{id,title}}]}` — the
 *     schemas guarantee the variant is uniform across cards before we get
 *     here (Meta rejects mixed carousels).
 * Caps truncated defensively: button labels 20, card body 160. Card media is
 * link-only per the doc ("publicly available media asset URL").
 */
export async function sendInteractiveCarousel(
  args: SendInteractiveArgs,
  config: MetaSendConfig,
): Promise<SendTextResult> {
  const cards = args.carouselCards;
  if (!cards || cards.length < 2) {
    throw new MetaSendError("sendInteractiveCarousel: 2-10 carouselCards required", 400, "");
  }
  const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
  const res = await postWhatsappMessages(url, config, {
      messaging_product: "whatsapp",
      ...messagingAccountField(config),
      recipient_type: "individual",
      ...whatsappDestination(args),
      type: "interactive",
      interactive: {
        type: "carousel",
        body: { text: args.bodyText },
        action: {
          cards: cards.map((card, i) => ({
            card_index: i,
            type: "cta_url",
            header: {
              type: card.headerMedia.kind,
              [card.headerMedia.kind]: { link: card.headerMedia.link },
            },
            ...(card.body ? { body: { text: card.body.slice(0, 160) } } : {}),
            action: card.ctaUrl
              ? {
                  name: "cta_url",
                  parameters: {
                    display_text: card.ctaUrl.displayText.slice(0, 20),
                    url: card.ctaUrl.url,
                  },
                }
              : {
                  buttons: (card.quickReplies ?? []).map((qr) => ({
                    type: "quick_reply",
                    quick_reply: { id: qr.id.slice(0, 256), title: qr.title.slice(0, 20) },
                  })),
                },
          })),
        },
      },
      ...(args.replyToExternalId
        ? { context: { message_id: args.replyToExternalId } }
        : {}),
    });
  if (!res.ok) {
    const text = await safeMetaText(res);
    throw new MetaSendError(
      `meta sendInteractiveCarousel failed: ${res.status} ${text}`,
      res.status,
      text,
    );
  }
  const json = (await res.json()) as { messages?: Array<{ id?: string }> };
  const externalId = json.messages?.[0]?.id;
  if (!externalId) {
    throw new Error(
      `meta sendInteractiveCarousel missing message id: ${JSON.stringify(json)}`,
    );
  }
  return { externalId, timestamp: new Date() };
}


/**
 * `interactive.type: "cta_url"` — body + one URL-opening button, so a long
 * tracking link never appears raw in the message (cta-url-messages doc).
 * Optional text header (≤60) and footer (≤60); `display_text` caps at 20.
 * All three truncated defensively, same posture as the buttons/list caps.
 * Media headers are deliberately not modeled yet — see SendInteractiveArgs.
 */
export async function sendCtaUrlButton(
  args: SendInteractiveArgs,
  config: MetaSendConfig,
): Promise<SendTextResult> {
  const cta = args.ctaUrl;
  if (!cta?.displayText || !cta.url) {
    throw new MetaSendError("sendCtaUrlButton: ctaUrl.displayText + url are required", 400, "");
  }
  const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
  const res = await postWhatsappMessages(url, config, {
      messaging_product: "whatsapp",
      ...messagingAccountField(config),
      recipient_type: "individual",
      ...whatsappDestination(args),
      type: "interactive",
      interactive: {
        type: "cta_url",
        ...(cta.headerText
          ? { header: { type: "text", text: cta.headerText.slice(0, 60) } }
          : {}),
        body: { text: args.bodyText },
        action: {
          name: "cta_url",
          parameters: {
            display_text: cta.displayText.slice(0, 20),
            url: cta.url,
          },
        },
        ...(cta.footerText
          ? { footer: { text: cta.footerText.slice(0, 60) } }
          : {}),
      },
      ...(args.replyToExternalId
        ? { context: { message_id: args.replyToExternalId } }
        : {}),
    });
  if (!res.ok) {
    const text = await safeMetaText(res);
    throw new MetaSendError(
      `meta sendCtaUrlButton failed: ${res.status} ${text}`,
      res.status,
      text,
    );
  }
  const json = (await res.json()) as { messages?: Array<{ id?: string }> };
  const externalId = json.messages?.[0]?.id;
  if (!externalId) {
    throw new Error(`meta sendCtaUrlButton missing message id: ${JSON.stringify(json)}`);
  }
  return { externalId, timestamp: new Date() };
}


export async function sendVoiceCallButton(
  args: SendInteractiveArgs,
  config: MetaSendConfig,
): Promise<SendTextResult> {
  const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
  const params: Record<string, unknown> = {};
  // Meta caps the label at 20 chars and defaults it to "Call Now".
  if (args.voiceCall?.displayText) {
    params.display_text = args.voiceCall.displayText.slice(0, 20);
  }
  if (args.voiceCall?.ttlMinutes != null) {
    // 1 minute to 30 days. Clamp rather than reject: a caller asking for a
    // longer-lived button wants the longest one available, not an error.
    params.ttl_minutes = Math.min(
      43_200,
      Math.max(1, Math.trunc(args.voiceCall.ttlMinutes)),
    );
  }
  if (args.voiceCall?.payload) {
    params.payload = args.voiceCall.payload.slice(0, 512);
  }
  const res = await postWhatsappMessages(url, config, {
      messaging_product: "whatsapp",
      ...messagingAccountField(config),
      recipient_type: "individual",
      ...whatsappDestination(args),
      type: "interactive",
      interactive: {
        type: "voice_call",
        body: { text: args.bodyText },
        action: {
          name: "voice_call",
          ...(Object.keys(params).length ? { parameters: params } : {}),
        },
      },
      ...(args.replyToExternalId
        ? { context: { message_id: args.replyToExternalId } }
        : {}),
    });
  if (!res.ok) {
    const text = await safeMetaText(res);
    throw new MetaSendError(
      `meta sendVoiceCallButton failed: ${res.status} ${text}`,
      res.status,
      text,
    );
  }
  const json = (await res.json()) as { messages?: Array<{ id?: string }> };
  const externalId = json.messages?.[0]?.id;
  if (!externalId) {
    throw new Error(
      `meta sendVoiceCallButton missing message id: ${JSON.stringify(json)}`,
    );
  }
  return { externalId, timestamp: new Date() };
}


/**
 * One block/unblock request against the business number's blocklist. The two
 * directions share everything except the HTTP method (POST blocks, DELETE
 * unblocks). Blocking is idempotent — re-blocking a blocked user succeeds — so
 * the transient-5xx retry is safe to keep on.
 */
export async function blockUsersCall(
  method: "POST" | "DELETE",
  users: string[],
  config: MetaSendConfig,
): Promise<BlockUsersResult> {
  // Meta caps one request at 1,000 users. Callers today send one; a future
  // bulk path must page, not truncate silently.
  if (users.length > 1000) {
    throw new Error(`meta block_users: ${users.length} users exceeds Meta's 1,000/request cap`);
  }
  const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/block_users`;
  const res = await metaFetch(url, {
    method,
    retry: true,
    appSecret: config.appSecret,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      block_users: users.map((user) => ({ user })),
    }),
  });
  const text = await safeMetaText(res);
  let json: MetaBlockUsersResponse | null = null;
  try {
    json = JSON.parse(text) as MetaBlockUsersResponse;
  } catch {
    // Non-JSON body — fall through to the status check below.
  }
  // Per-user ledger present → authoritative, even on a non-2xx status (a
  // mixed partial-failure response carries HTTP error + the ledger together).
  if (json?.block_users) return parseBlockUsersResponse(json);
  if (!res.ok || !json) {
    throw new Error(`meta block_users ${method} failed: ${res.status} ${text.slice(0, 500)}`);
  }
  // 2xx with no ledger — treat every requested user as succeeded (docs always
  // show the ledger, but an empty-object success must not read as failure).
  return {
    succeeded: users.map((input) => ({ input, externalUserId: null, error: null })),
    failed: [],
  };
}


/**
 * `messaging_account_id` for a Messages API call — or nothing at all.
 *
 * Meta's account-model split turns the legacy WABA into a **Messaging Account**
 * (templates + billing + webhook subscriptions, same id) plus a **WAAC** (the
 * phone number, 1:1). One phone number can carry several Messaging Accounts, one
 * per partner, and this names the one to BILL: "the charge goes to the Messaging
 * Account associated with your app".
 *
 * ⚠️ TWO NAMES EXIST, and the guide pages lag the changelog. Read this before
 * "fixing" the spelling:
 *
 *   - The account-model-evolution overview still reads *"a
 *     `paid_messaging_account_id` parameter becomes available on Messages API
 *     calls"*.
 *   - The **changelog entry of 2026-06-16 supersedes it**: *"Added
 *     `messaging_account_id` as the preferred Cloud API parameter, with
 *     `paid_messaging_account_id` kept as a deprecated backward-compatible alias."*
 *
 * So `messaging_account_id` is correct and `paid_messaging_account_id` is the
 * deprecated alias — the opposite of what the guide page implies. This was renamed
 * to the guide's spelling on 2026-07-30 and reverted the same day once the changelog
 * was checked. Graph rejects an unrecognised body field with `#100`, which fails the
 * ENTIRE send for every tenant, so the name is only safe to change against the
 * changelog, never against a guide page alone.
 *
 * Timeline (verified 2026-07-30): OPTIONAL at Phase 1 (H2 2026) — "no code changes
 * required, except for multiple Messaging Account scenarios"; REQUIRED from Phase 2
 * (H1 2027) for multi-Messaging-Account setups; required on ALL Messages API
 * versions at Phase 3 (H1 2028), when phone-number-id paths must become WAAC ids too.
 *
 * Returning `{}` when unset is the whole design: the wire stays byte-identical to
 * today until someone who actually needs it opts in.
 */
export function messagingAccountField(
  config: MetaSendConfig,
): { messaging_account_id?: string } {
  return config.messagingAccountId
    ? { messaging_account_id: config.messagingAccountId }
    : {};
}


