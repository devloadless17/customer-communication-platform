/**
 * STRUCTURED TEMPLATES — the button and generic (carousel) message types.
 *
 * These are Meta's *structured message* templates, and they are a completely
 * different thing from the approved-template catalog that `templates: true`
 * means everywhere else in this codebase. There is no submission, no review and
 * no `name`: the whole message is authored inline at send time and rendered by
 * the Messenger client. Conflating the two is the single most likely misreading
 * of this file, which is why it is not called `templates.ts`.
 *
 * Six are implemented, each fully specified by Meta's current reference:
 *
 *   button     — text plus up to three buttons.
 *   generic    — 1-10 horizontally scrollable cards, each with a title, optional
 *                subtitle and image, up to three buttons, and a `default_action`
 *                (the whole card becomes tappable).
 *   media      — one image or video, playable in-conversation, with buttons.
 *   image_grid — 2-6 images in one message, each independently tappable.
 *   receipt    — an order confirmation with line items, totals and an address.
 *   coupon     — a discount with a Reveal-code button.
 *
 * ## The three that are NOT here, and why each is a decision rather than a gap
 *
 *   product                — renders items from a FACEBOOK PRODUCT CATALOG by
 *                            retailer id. There is no catalog integration in this
 *                            platform, so every field would be a guess about data
 *                            we do not hold.
 *   customer_feedback      — Meta's own page carries a standing warning: "This
 *                            functionality is in development. Meta can change or
 *                            remove this functionality at any time." It is also
 *                            the one template locked to a message TAG —
 *                            `CUSTOMER_FEEDBACK`, where "use in any other form is
 *                            prohibited and will fail" — and it needs the
 *                            `messaging_feedback` webhook subscribed to collect a
 *                            single answer. Building against an in-development
 *                            surface that can be removed is how you ship a
 *                            feature that breaks itself.
 *   instant_form,
 *   structured_information — lead-capture and shipping-detail collection flows
 *                            whose submissions arrive on webhooks
 *                            (`messaging_in_thread_lead_form_submit`,
 *                            `messaging_customer_information`) that nothing here
 *                            subscribes to or stores. Sending the form without
 *                            somewhere to put the answer is worse than not
 *                            sending it.
 *
 * Each is additive when the missing half exists — a new member of
 * {@link MessengerTemplate} and a branch in {@link buildTemplatePayload}.
 *
 * ## Buttons
 *
 * Meta's Buttons reference (re-read 2026-07-30) documents exactly six types:
 * `web_url`, `postback`, `phone_number`, `account_link`, `account_unlink` and
 * `game_play`. Three are modelled below. The other three are excluded on
 * purpose: the two account-linking buttons only mean anything inside an Account
 * Linking flow this product does not implement, and `game_play` launches an
 * Instant Game.
 *
 * `audio_call` is ALSO excluded, and that one is worth a note because the docs
 * disagree with each other. The 2026-02-11 calling changelog announces an
 * "`audio_call` button type in generic and button message templates", but the
 * Buttons reference — updated later, on 2026-04-22 — does not list it among the
 * six. Since `CHANNEL_CAPABILITIES.messenger.calling` is false, offering a button
 * that starts a call the product doesn't support would be wrong regardless of
 * which document is right. Revisit both together.
 */

import { GRAPH_BASE, graphPostJson } from "@/lib/providers/meta-graph";
import type { SocialSendTarget } from "@/lib/providers/meta-social";
import type { SendTextResult } from "@ccp/shared/providers/types";

/** Meta's caps, quoted from the reference and enforced before the wire. */
export const MAX_TEMPLATE_BUTTONS = 3;
export const MAX_GENERIC_ELEMENTS = 10;
export const MAX_BUTTON_TITLE_CHARS = 20;
export const MAX_POSTBACK_PAYLOAD_CHARS = 1000;
export const MAX_ELEMENT_TITLE_CHARS = 80;
export const MAX_ELEMENT_SUBTITLE_CHARS = 80;
/** Image grid: 2-6 images, and its title cap is 45 — NOT the generic's 80. */
export const MIN_GRID_IMAGES = 2;
export const MAX_GRID_IMAGES = 6;
export const MAX_GRID_TITLE_CHARS = 45;
export const MAX_GRID_SUBTITLE_CHARS = 80;
/** Button-template body text. */
export const MAX_BUTTON_TEMPLATE_TEXT_CHARS = 640;
/** Receipt: "Maximum of 100 element objects". */
export const MAX_RECEIPT_ELEMENTS = 100;
/** Coupon title + subtitle. */
export const MAX_COUPON_TITLE_CHARS = 80;
export const MAX_COUPON_SUBTITLE_CHARS = 80;

/**
 * A template button.
 *
 * `web_url` carries the webview controls Meta documents; they are optional and
 * omitted entirely when unset, because `messenger_extensions: false` is not the
 * same as absent (the former requires the domain to be allowlisted).
 */
export type MessengerTemplateButton =
  | {
      type: "web_url";
      title: string;
      url: string;
      webviewHeightRatio?: "compact" | "tall" | "full";
      /** Requires the domain in `whitelisted_domains` on the Messenger Profile. */
      messengerExtensions?: boolean;
      /** Only valid when `messengerExtensions` is true. */
      fallbackUrl?: string;
      /** Hide the webview share button — for a page showing sensitive info. */
      hideShareButton?: boolean;
    }
  | { type: "postback"; title: string; payload: string }
  /** `payload` must be `+<country><number>`, e.g. `+16505551234`. */
  | { type: "phone_number"; title: string; payload: string };

/** One card of a generic template. */
export interface MessengerGenericElement {
  title: string;
  subtitle?: string;
  /** Meta renders at 1.91:1; other ratios are scaled or cropped by the client. */
  imageUrl?: string;
  /**
   * Makes the whole card tappable. Meta: "the same properties as URL button,
   * except `title`" — so it is deliberately typed as the url button minus its
   * title rather than as a free-form object.
   */
  defaultActionUrl?: string;
  buttons?: MessengerTemplateButton[];
}

/**
 * One image in an `image_grid`.
 *
 * `action` is at most ONE per image and its two shapes are mutually exclusive at
 * the field level, not just the type level: `web_url` requires `url` and forbids
 * `payload`/`text`; `postback` requires BOTH `payload` and `text` and forbids
 * `url`. The `text` is what Meta posts into the conversation as the recipient's
 * reply, so a postback action without it renders a tap that appears to do nothing.
 */
export type MessengerGridImageAction =
  | { type: "web_url"; url: string }
  | { type: "postback"; payload: string; text: string };

export interface MessengerGridImage {
  url: string;
  /** At most ONE image per grid may set this — more than one fails on Meta. */
  isHeroImage?: boolean;
  action?: MessengerGridImageAction;
}

/** One line item on a receipt. `title` and `price` are the required pair. */
export interface MessengerReceiptElement {
  title: string;
  subtitle?: string;
  quantity?: number;
  price: number;
  /** Per-item currency; defaults to the receipt's when omitted. */
  currency?: string;
  imageUrl?: string;
}

/** A shipping address on a receipt. Every field except `street2` is required. */
export interface MessengerReceiptAddress {
  street1: string;
  street2?: string;
  city: string;
  postalCode: string;
  state: string;
  country: string;
}

/** A discount or credit line. */
export interface MessengerReceiptAdjustment {
  name: string;
  amount: number;
}

export interface MessengerReceiptSummary {
  subtotal?: number;
  shippingCost?: number;
  totalTax?: number;
  /** Required. Includes subtotal, shipping and tax. */
  totalCost: number;
}

export type MessengerTemplate =
  | { kind: "button"; text: string; buttons: MessengerTemplateButton[] }
  | { kind: "generic"; elements: MessengerGenericElement[]; sharable?: boolean }
  | {
      /**
       * ONE image or video. Meta: "The media template only supports sending
       * images and video. Audio is not supported."
       */
      kind: "media";
      mediaType: "image" | "video";
      /** Reusable id from the Attachment Upload API. Mutually exclusive with `url`. */
      attachmentId?: string;
      /** MUST be a Facebook-hosted URL — see the validation for why. */
      url?: string;
      buttons?: MessengerTemplateButton[];
    }
  | {
      kind: "image_grid";
      images: MessengerGridImage[];
      title?: string;
      subtitle?: string;
      /** Only `web_url` and `postback` are accepted below a grid. */
      buttons?: MessengerTemplateButton[];
    }
  | {
      kind: "receipt";
      recipientName: string;
      /** Meta: "Must be unique." */
      orderNumber: string;
      currency: string;
      /** Free text identifying the method + account, e.g. "Visa 1234". */
      paymentMethod: string;
      summary: MessengerReceiptSummary;
      merchantName?: string;
      orderUrl?: string;
      /** Order time. Meta wants SECONDS as a string; pass a Date. */
      orderedAt?: Date;
      elements?: MessengerReceiptElement[];
      address?: MessengerReceiptAddress;
      adjustments?: MessengerReceiptAdjustment[];
      /** Enables Meta's native share button. Defaults false. */
      sharable?: boolean;
    }
  | {
      kind: "coupon";
      title: string;
      subtitle?: string;
      /** Required unless `couponUrl` is set. Meta: "Can not have spaces." */
      couponCode?: string;
      /** Required unless `couponCode` is set. */
      couponUrl?: string;
      couponUrlButtonTitle?: string;
      /** A message sent BEFORE the coupon card. */
      couponPreMessage?: string;
      imageUrl?: string;
      /** Echoed back on the webhook when Reveal code is tapped. */
      payload?: string;
    };

/** Thrown for a template Meta would reject, so the caller 400s instead of 502s. */
export class MessengerTemplateError extends Error {}

function wireButton(b: MessengerTemplateButton): Record<string, unknown> {
  const title = b.title.slice(0, MAX_BUTTON_TITLE_CHARS);
  if (b.type === "web_url") {
    return {
      type: "web_url",
      title,
      url: b.url,
      ...(b.webviewHeightRatio ? { webview_height_ratio: b.webviewHeightRatio } : {}),
      ...(b.messengerExtensions ? { messenger_extensions: true } : {}),
      // Meta: "may only be specified if messenger_extensions is true". Sending it
      // otherwise is a rejection, so the flag gates the field rather than the
      // caller being trusted to pair them.
      ...(b.messengerExtensions && b.fallbackUrl ? { fallback_url: b.fallbackUrl } : {}),
      ...(b.hideShareButton ? { webview_share_button: "hide" } : {}),
    };
  }
  return { type: b.type, title, payload: b.payload };
}

/** Validate against Meta's caps. Throws {@link MessengerTemplateError}. */
function assertButtons(buttons: MessengerTemplateButton[], where: string): void {
  if (buttons.length > MAX_TEMPLATE_BUTTONS) {
    throw new MessengerTemplateError(
      `${where}: at most ${MAX_TEMPLATE_BUTTONS} buttons (got ${buttons.length}).`,
    );
  }
  for (const b of buttons) {
    if (!b.title.trim()) throw new MessengerTemplateError(`${where}: a button needs a title.`);
    if (b.type === "postback" && b.payload.length > MAX_POSTBACK_PAYLOAD_CHARS) {
      throw new MessengerTemplateError(
        `${where}: a postback payload is limited to ${MAX_POSTBACK_PAYLOAD_CHARS} characters.`,
      );
    }
    if (b.type === "phone_number" && !/^\+\d{6,}$/.test(b.payload)) {
      // Meta: "Format must have '+' prefix followed by the country code, area
      // code and local number." A bare national number is accepted by the API and
      // then fails to dial on the recipient's phone — worse than a 400 here.
      throw new MessengerTemplateError(
        `${where}: a call button's number must be E.164 with a leading '+', e.g. +16505551234.`,
      );
    }
    if (b.type === "web_url" && !/^https?:\/\//i.test(b.url)) {
      throw new MessengerTemplateError(`${where}: a URL button needs an http(s) URL.`);
    }
  }
}

/** Build the `message.attachment` payload for a template. Validates first. */
export function buildTemplatePayload(template: MessengerTemplate): Record<string, unknown> {
  if (template.kind === "button") {
    if (!template.text.trim()) {
      throw new MessengerTemplateError("button template: `text` is required.");
    }
    if (template.text.length > MAX_BUTTON_TEMPLATE_TEXT_CHARS) {
      throw new MessengerTemplateError(
        `button template: text is limited to ${MAX_BUTTON_TEMPLATE_TEXT_CHARS} characters.`,
      );
    }
    if (template.buttons.length === 0) {
      throw new MessengerTemplateError("button template: at least one button is required.");
    }
    assertButtons(template.buttons, "button template");
    return {
      template_type: "button",
      text: template.text,
      buttons: template.buttons.map(wireButton),
    };
  }

  if (template.kind === "media") {
    // Exactly one of the two sources. Both set, or neither, is a rejection —
    // Meta documents each as "cannot be used if the other is set".
    const hasAttachment = Boolean(template.attachmentId);
    const hasUrl = Boolean(template.url);
    if (hasAttachment === hasUrl) {
      throw new MessengerTemplateError(
        "media template: set exactly one of `attachmentId` or `url`.",
      );
    }
    if (template.url) {
      // Meta: "the media template does not allow any external URL" — only
      // Facebook-hosted media. An external URL is accepted by the request and
      // then renders as a broken card, so it is refused here with the actual
      // remedy rather than left to fail silently in the customer's thread.
      let host: string;
      try {
        host = new URL(template.url).hostname;
      } catch {
        throw new MessengerTemplateError("media template: `url` is not a valid URL.");
      }
      const facebookHosted =
        host === "facebook.com" ||
        host.endsWith(".facebook.com") ||
        host.endsWith(".fbcdn.net");
      if (!facebookHosted) {
        throw new MessengerTemplateError(
          "media template: Meta allows only Facebook-hosted media URLs here — " +
            "upload the file with the Attachment Upload API and pass `attachmentId` instead.",
        );
      }
    }
    if (template.buttons) assertButtons(template.buttons, "media template");
    return {
      template_type: "media",
      elements: [
        {
          media_type: template.mediaType,
          ...(template.attachmentId
            ? { attachment_id: template.attachmentId }
            : { url: template.url }),
          ...(template.buttons?.length ? { buttons: template.buttons.map(wireButton) } : {}),
        },
      ],
    };
  }

  if (template.kind === "image_grid") {
    const { images } = template;
    if (images.length < MIN_GRID_IMAGES || images.length > MAX_GRID_IMAGES) {
      throw new MessengerTemplateError(
        `image grid: ${MIN_GRID_IMAGES}-${MAX_GRID_IMAGES} images (got ${images.length}).`,
      );
    }
    // "At most one image in the grid can have is_hero_image set to true; sending
    // more than one fails with an error."
    if (images.filter((i) => i.isHeroImage).length > 1) {
      throw new MessengerTemplateError("image grid: at most one image may be the hero.");
    }
    images.forEach((img, i) => {
      if (!/^https?:\/\//i.test(img.url)) {
        throw new MessengerTemplateError(`image grid: image ${i + 1} needs an http(s) URL.`);
      }
    });
    // Only URL and postback buttons are supported below a grid — a phone_number
    // button is accepted by the shared button validator but not by this template.
    if (template.buttons) {
      assertButtons(template.buttons, "image grid");
      for (const b of template.buttons) {
        if (b.type === "phone_number") {
          throw new MessengerTemplateError(
            "image grid: only URL and postback buttons are supported below the grid.",
          );
        }
      }
    }
    return {
      template_type: "image_grid",
      elements: [
        {
          ...(template.title
            ? { title: template.title.slice(0, MAX_GRID_TITLE_CHARS) }
            : {}),
          ...(template.subtitle
            ? { subtitle: template.subtitle.slice(0, MAX_GRID_SUBTITLE_CHARS) }
            : {}),
          images: images.map((img) => ({
            url: img.url,
            ...(img.isHeroImage ? { is_hero_image: true } : {}),
            ...(img.action
              ? {
                  action:
                    img.action.type === "web_url"
                      ? { type: "web_url", url: img.action.url }
                      : {
                          type: "postback",
                          payload: img.action.payload,
                          // Required on a postback action: it is what Meta posts
                          // into the thread as the recipient's reply, so without
                          // it the tap looks like it did nothing.
                          text: img.action.text,
                        },
                }
              : {}),
          })),
          ...(template.buttons?.length ? { buttons: template.buttons.map(wireButton) } : {}),
        },
      ],
    };
  }

  if (template.kind === "receipt") {
    if (!template.recipientName.trim() || !template.orderNumber.trim()) {
      throw new MessengerTemplateError(
        "receipt template: `recipientName` and `orderNumber` are required.",
      );
    }
    if (!template.currency.trim() || !template.paymentMethod.trim()) {
      throw new MessengerTemplateError(
        "receipt template: `currency` and `paymentMethod` are required.",
      );
    }
    if (typeof template.summary.totalCost !== "number") {
      throw new MessengerTemplateError("receipt template: `summary.totalCost` is required.");
    }
    if ((template.elements?.length ?? 0) > MAX_RECEIPT_ELEMENTS) {
      throw new MessengerTemplateError(
        `receipt template: at most ${MAX_RECEIPT_ELEMENTS} line items.`,
      );
    }
    template.elements?.forEach((el, i) => {
      if (!el.title.trim()) {
        throw new MessengerTemplateError(`receipt template: line item ${i + 1} needs a title.`);
      }
      if (typeof el.price !== "number") {
        throw new MessengerTemplateError(`receipt template: line item ${i + 1} needs a price.`);
      }
    });
    return {
      template_type: "receipt",
      recipient_name: template.recipientName,
      order_number: template.orderNumber,
      currency: template.currency,
      payment_method: template.paymentMethod,
      ...(template.sharable ? { sharable: true } : {}),
      ...(template.merchantName ? { merchant_name: template.merchantName } : {}),
      ...(template.orderUrl ? { order_url: template.orderUrl } : {}),
      // Meta wants SECONDS, as a string. Milliseconds here renders a date ~50,000
      // years out — accepted by the API and obviously wrong only to the customer.
      ...(template.orderedAt
        ? { timestamp: String(Math.floor(template.orderedAt.getTime() / 1000)) }
        : {}),
      ...(template.elements?.length
        ? {
            elements: template.elements.map((el) => ({
              title: el.title,
              ...(el.subtitle ? { subtitle: el.subtitle } : {}),
              ...(el.quantity != null ? { quantity: el.quantity } : {}),
              price: el.price,
              ...(el.currency ? { currency: el.currency } : {}),
              ...(el.imageUrl ? { image_url: el.imageUrl } : {}),
            })),
          }
        : {}),
      ...(template.address
        ? {
            address: {
              street_1: template.address.street1,
              ...(template.address.street2 ? { street_2: template.address.street2 } : {}),
              city: template.address.city,
              postal_code: template.address.postalCode,
              state: template.address.state,
              country: template.address.country,
            },
          }
        : {}),
      summary: {
        ...(template.summary.subtotal != null ? { subtotal: template.summary.subtotal } : {}),
        ...(template.summary.shippingCost != null
          ? { shipping_cost: template.summary.shippingCost }
          : {}),
        ...(template.summary.totalTax != null ? { total_tax: template.summary.totalTax } : {}),
        total_cost: template.summary.totalCost,
      },
      ...(template.adjustments?.length
        ? {
            adjustments: template.adjustments.map((a) => ({
              name: a.name,
              amount: a.amount,
            })),
          }
        : {}),
    };
  }

  if (template.kind === "coupon") {
    if (!template.title.trim()) {
      throw new MessengerTemplateError("coupon template: `title` is required.");
    }
    // "Required unless coupon_url is set" / "Required unless coupon_code is set"
    // — so neither present is the one combination Meta rejects.
    if (!template.couponCode && !template.couponUrl) {
      throw new MessengerTemplateError(
        "coupon template: set `couponCode` or `couponUrl` (at least one).",
      );
    }
    // Meta: the code "Can not have spaces." A code with one is accepted and then
    // fails to redeem, which the customer discovers and the business does not.
    if (template.couponCode && /\s/.test(template.couponCode)) {
      throw new MessengerTemplateError("coupon template: a coupon code cannot contain spaces.");
    }
    return {
      template_type: "coupon",
      title: template.title.slice(0, MAX_COUPON_TITLE_CHARS),
      ...(template.subtitle
        ? { subtitle: template.subtitle.slice(0, MAX_COUPON_SUBTITLE_CHARS) }
        : {}),
      ...(template.couponCode ? { coupon_code: template.couponCode } : {}),
      ...(template.couponUrl ? { coupon_url: template.couponUrl } : {}),
      ...(template.couponUrlButtonTitle
        ? { coupon_url_button_title: template.couponUrlButtonTitle }
        : {}),
      ...(template.couponPreMessage ? { coupon_pre_message: template.couponPreMessage } : {}),
      ...(template.imageUrl ? { image_url: template.imageUrl } : {}),
      ...(template.payload ? { payload: template.payload } : {}),
    };
  }

  const { elements } = template;
  if (elements.length === 0) {
    throw new MessengerTemplateError("generic template: at least one card is required.");
  }
  if (elements.length > MAX_GENERIC_ELEMENTS) {
    throw new MessengerTemplateError(
      `generic template: at most ${MAX_GENERIC_ELEMENTS} cards (got ${elements.length}).`,
    );
  }
  elements.forEach((el, i) => {
    if (!el.title.trim()) {
      throw new MessengerTemplateError(`generic template: card ${i + 1} needs a title.`);
    }
    if (el.buttons) assertButtons(el.buttons, `generic template card ${i + 1}`);
  });

  return {
    template_type: "generic",
    ...(template.sharable === false ? { sharable: false } : {}),
    elements: elements.map((el) => ({
      // Truncate rather than reject: an over-long title is Meta's own display
      // limit, not a malformed request, and losing the tail of a subtitle beats
      // failing an agent's whole message.
      title: el.title.slice(0, MAX_ELEMENT_TITLE_CHARS),
      ...(el.subtitle ? { subtitle: el.subtitle.slice(0, MAX_ELEMENT_SUBTITLE_CHARS) } : {}),
      ...(el.imageUrl ? { image_url: el.imageUrl } : {}),
      // "the same properties as URL button, except title".
      ...(el.defaultActionUrl
        ? { default_action: { type: "web_url", url: el.defaultActionUrl } }
        : {}),
      ...(el.buttons?.length ? { buttons: el.buttons.map(wireButton) } : {}),
    })),
  };
}

/**
 * Send a structured template. `messagingTypeFields` is threaded in for the same
 * reason the sticker send threads it: a template is gated on the standard
 * messaging window exactly like text, and the RESPONSE-vs-HUMAN_AGENT decision
 * must stay in one place.
 */
export async function sendMessengerTemplate(
  args: { to: string; template: MessengerTemplate; personaId?: string },
  opts: SocialSendTarget,
  messagingTypeFields: object,
): Promise<SendTextResult> {
  const payload = buildTemplatePayload(args.template);
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messages`;
  const res = await graphPostJson(
    url,
    opts.accessToken,
    {
      recipient: { id: args.to },
      ...messagingTypeFields,
      // `persona_id` is a TOP-LEVEL field, a sibling of `message` — not part of
      // it. Nesting it inside `message` is silently ignored, and the reply goes
      // out under the Page's identity with no error to notice.
      ...(args.personaId ? { persona_id: args.personaId } : {}),
      message: { attachment: { type: "template", payload } },
    },
    opts.appSecret,
  );
  const messageId = typeof res.message_id === "string" ? res.message_id : "";
  if (!messageId) {
    throw new Error(`${opts.label} sendTemplate: response missing message_id`);
  }
  return { externalId: messageId, timestamp: new Date() };
}
