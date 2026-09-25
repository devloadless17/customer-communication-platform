/**
 * What a template send ACTUALLY put on the customer's screen, captured onto the
 * outbound `Message` so the agent's own thread shows the same thing.
 *
 * A WhatsApp template is up to four parts — header, body, footer, buttons — and
 * the row used to keep only the body. So a promo the customer received as an
 * image, a paragraph, a grey footer and a "Get free delivery" button read in the
 * inbox as one line of text, and the agent could not see what they had sent.
 *
 * Two send paths write template rows — `send-template-internal` (inbox, the
 * `send_template` workflow step, /v1) and the broadcast runner — and both call
 * THIS module, so the two rules below exist exactly once.
 *
 * Snapshot, not a lookup. The footer and buttons are read from the template at
 * send time and stored on the message. Re-reading the template at render time
 * would be simpler and wrong: templates are edited after they are sent, and a
 * thread must keep showing what was actually delivered.
 */
import type { TemplateSentButton } from "@ccp/shared/types";
import { blobStorage } from "@/lib/blob-storage";

/**
 * The `template` member of `MessageStructured`. A type alias so it is directly
 * assignable to a Prisma JSON column — see `TemplateSentButton` for why.
 */
export type TemplateSentSnapshot = {
  kind: "template";
  footer?: string;
  buttons?: TemplateSentButton[];
};

/** A send-time button parameter, as both send paths already carry it. */
export interface SentButtonParam {
  /** Position in the template's BUTTONS component — Meta's own index. */
  index: number;
  subType: string;
  /** The wire value: a URL suffix (already percent-encoded), a coupon code, … */
  text: string;
}

const BUTTON_TYPE: Readonly<Record<string, TemplateSentButton["type"]>> = {
  URL: "url",
  PHONE_NUMBER: "phone",
  QUICK_REPLY: "quick_reply",
  COPY_CODE: "copy_code",
  OTP: "otp",
  VOICE_CALL: "voice_call",
  CATALOG: "catalog",
  MPM: "catalog",
  SPM: "catalog",
  FLOW: "flow",
};

/**
 * Only http(s) is rendered as a link. The url comes from an approved template,
 * but it becomes an `href` in the agent's browser, so the scheme is checked
 * rather than trusted.
 */
function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Context the snapshot needs beyond the components themselves. */
export interface SnapshotOptions {
  /**
   * The template's category. An AUTHENTICATION template's one-time-code button
   * is REWRITTEN by Meta to type `URL` at creation, so the stored component
   * no longer says `OTP` — the category is the only thing that still does.
   */
  category?: string | null;
}

/**
 * The footer + buttons a send showed, or `null` when the template has neither —
 * in which case the row carries no `structured` at all and renders exactly as it
 * always did.
 *
 * NO SEND-TIME SECRET IS KEPT. The row outlives the send by months and every
 * agent who can open the thread can read it, so:
 *
 *  - A DYNAMIC url button (one with a `{{…}}` placeholder) keeps its label
 *    only. Its suffix is a send-time value — an order id, or just as often a
 *    password-reset or magic-login token — and the resolved link would be both
 *    readable and CLICKABLE for everyone. Only a STATIC url, written in full in
 *    the approved template and therefore public by construction, is kept.
 *  - Every button of an AUTHENTICATION template keeps its label only: its code
 *    is a login secret, and Meta disguises the button as a plain URL (see
 *    `SnapshotOptions.category`).
 *  - A coupon (copy-code) button DOES keep its code: a promo code is meant to be
 *    shared, and the agent needs it to answer "my code doesn't work".
 *
 * Never throws. It runs AFTER Meta has accepted — and billed — the send, so a
 * malformed stored template must cost the snapshot, never the message row.
 */
export function buildTemplateSentSnapshot(
  components: unknown,
  buttonParams: readonly SentButtonParam[],
  opts: SnapshotOptions = {},
): TemplateSentSnapshot | null {
  try {
    return buildSnapshot(components, buttonParams, opts);
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function buildSnapshot(
  components: unknown,
  buttonParams: readonly SentButtonParam[],
  opts: SnapshotOptions,
): TemplateSentSnapshot | null {
  // Narrowed field by field rather than cast to TemplateComponent[]: this is a
  // JSON column, and every read below must survive a row that is not the shape
  // its type claims.
  const comps = (Array.isArray(components) ? components : []).filter(isObject);
  const footerText = comps.find((c) => c.type === "FOOTER")?.text;
  const footer = typeof footerText === "string" ? footerText.trim() || undefined : undefined;
  const rawDefs = comps.find((c) => c.type === "BUTTONS")?.buttons;
  const defs = (Array.isArray(rawDefs) ? rawDefs : []).filter(isObject);
  const isAuthentication = opts.category?.toUpperCase() === "AUTHENTICATION";

  const param = (index: number, subType: string): string | undefined =>
    buttonParams.find((p) => p.index === index && p.subType === subType)?.text;

  const buttons: TemplateSentButton[] = [];
  defs.forEach((def, index) => {
    const text = typeof def.text === "string" ? def.text.trim() : "";
    if (isAuthentication) {
      buttons.push({ type: "otp", text: text || "Copy code" });
      return;
    }
    // `Object.hasOwn`: the type comes out of stored JSON, so a value like
    // `constructor` must miss rather than resolve down the prototype chain.
    const type =
      typeof def.type === "string" && Object.hasOwn(BUTTON_TYPE, def.type)
        ? BUTTON_TYPE[def.type]!
        : "other";
    if (type === "url") {
      const url = typeof def.url === "string" ? def.url : "";
      const dynamic = /\{\{[^}]*\}\}/.test(url);
      buttons.push({ type, text, ...(!dynamic && isHttpUrl(url) ? { url } : {}) });
      return;
    }
    if (type === "phone") {
      const phone = typeof def.phone_number === "string" ? def.phone_number : undefined;
      buttons.push({ type, text, ...(phone ? { phone } : {}) });
      return;
    }
    if (type === "copy_code") {
      const code = param(index, "copy_code");
      // Meta renders this button's label itself, so the component often has none.
      buttons.push({ type, text: text || "Copy offer code", ...(code ? { code } : {}) });
      return;
    }
    if (text) buttons.push({ type, text });
  });

  if (!footer && buttons.length === 0) return null;
  return {
    kind: "template",
    ...(footer ? { footer } : {}),
    ...(buttons.length > 0 ? { buttons } : {}),
  };
}

/**
 * The media kind a template's HEADER declares, or null for a text / location /
 * absent header. Read from the stored components, tolerant of a malformed row.
 */
export function templateHeaderMediaKind(
  components: unknown,
): "image" | "video" | "document" | null {
  const header = (Array.isArray(components) ? components : []).find(
    (c) => isObject(c) && c.type === "HEADER",
  ) as { format?: unknown } | undefined;
  switch (header?.format) {
    case "IMAGE":
      return "image";
    case "VIDEO":
      return "video";
    case "DOCUMENT":
      return "document";
    default:
      return null;
  }
}

/** The header asset a send supplied, in the shape both send paths hold it. */
export interface SentHeaderMedia {
  link?: string;
  id?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface HeaderMediaColumns {
  mediaKind?: "image" | "video" | "document";
  mediaKey?: string;
  mediaUrl?: string;
  mediaFilename?: string;
  mediaMimeType?: string;
  mediaSizeBytes?: number;
}

/**
 * The header asset as REAL media columns, so the bubble can render it — or `{}`.
 *
 * Three gates, each load-bearing:
 *
 *  1. Our own bucket AND under `media/{workspaceId}/`. `isOwnUrl` vets only the
 *     HOST, and `/api/media/:id` scopes the MESSAGE, never the key. The link is
 *     caller-supplied (a send body, a campaign, a template default an admin
 *     set), so without the team-prefix check a workspace could point at a
 *     sibling tenant's object and read it same-origin.
 *  2. The STABLE url, never a presigned one — those are minted for Meta and
 *     expire, which would leave a broken image in the thread days later.
 *  3. A known mimeType. `mapMessage` emits the media DTO only when `mediaKind &&
 *     mediaMimeType`, so a row without one renders NOWHERE while still taking a
 *     Files-tab slot and drawing a quoted-reply thumbnail. Both or neither.
 *
 * The key is SHARED — one object for the template's default and every message
 * sent with it — which is why the conversation-delete path and the blob-orphan
 * sweeper both skip `/tpl-hdr-` keys. Do not loosen one without the other.
 */
export function headerMediaColumns(
  workspaceId: string,
  headerKind: "image" | "video" | "document" | null,
  media: SentHeaderMedia | null | undefined,
): HeaderMediaColumns {
  if (!headerKind || !media || media.id || !media.link || !media.mimeType) return {};
  if (!blobStorage.isOwnUrl(media.link)) return {};
  const key = blobStorage.keyFromUrl(media.link);
  if (!key || !key.startsWith(`media/${workspaceId}/`)) return {};
  // Template-header assets ONLY. Any object the workspace owns would pass the
  // gates above — including a customer's inbound photo, whose url /v1 and the
  // webhooks hand out — and this key goes onto EVERY row the send writes (a
  // whole broadcast's worth). The conversation-delete path spares exactly the
  // `/tpl-hdr-` marker and deletes every other key, so a caller pointing a
  // header at that photo would have made one deleted chat destroy the
  // customer's original and every other thread's copy of it. Anything else
  // still SENDS fine; it just isn't pinned to the rows.
  if (!isSharedTemplateAsset(key)) return {};
  const size = media.sizeBytes;
  return {
    mediaKind: headerKind,
    mediaKey: key,
    mediaUrl: media.link,
    mediaMimeType: media.mimeType,
    ...(media.filename ? { mediaFilename: media.filename } : {}),
    // `Message.mediaSizeBytes` is an int4, and this insert runs AFTER Meta
    // accepted the send. An out-of-range value would throw P2020 there and
    // cost the whole campaign its inbox rows — so it is dropped, not stored.
    ...(typeof size === "number" && Number.isInteger(size) && size >= 0 && size <= INT4_MAX
      ? { mediaSizeBytes: size }
      : {}),
  };
}

const INT4_MAX = 2_147_483_647;

/**
 * A template-header asset: uploaded through `uploadTemplateHeaderMedia`, whose
 * key segment is `tpl-hdr-<uuid>`. The ONE predicate for "this object is shared
 * by a template and every message sent with it" — the conversation-delete path
 * and the blob-orphan sweeper key on the same marker. Change them together.
 */
export function isSharedTemplateAsset(key: string): boolean {
  return key.includes("/tpl-hdr-");
}
