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
import type { TemplateComponent } from "@ccp/shared/providers/types";
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

/**
 * The footer + buttons a send showed, or `null` when the template has neither —
 * in which case the row carries no `structured` at all and renders exactly as it
 * always did.
 *
 * `buttonParams` are the values the send actually put on the wire, so a URL
 * button's link is the RESOLVED one the customer taps (base + dynamic suffix),
 * and a coupon button carries the code this send delivered.
 *
 * An OTP button deliberately keeps its label only. Its parameter is a login
 * code — a secret the customer uses once — and this row outlives the moment by
 * months, readable by every agent in the workspace.
 */
export function buildTemplateSentSnapshot(
  components: unknown,
  buttonParams: readonly SentButtonParam[],
): TemplateSentSnapshot | null {
  const comps = Array.isArray(components) ? (components as TemplateComponent[]) : [];
  const footer = comps.find((c) => c.type === "FOOTER")?.text?.trim() || undefined;
  const defs = comps.find((c) => c.type === "BUTTONS")?.buttons ?? [];

  const param = (index: number, subType: string): string | undefined =>
    buttonParams.find((p) => p.index === index && p.subType === subType)?.text;

  const buttons: TemplateSentButton[] = [];
  defs.forEach((def, index) => {
    const type = BUTTON_TYPE[def.type] ?? "other";
    const text = def.text?.trim() ?? "";
    if (type === "url") {
      const base = def.url ?? "";
      const suffix = param(index, "url");
      // One placeholder at most — Meta allows a single variable per URL button,
      // positional `{{1}}` or named `{{order_id}}`.
      const url = suffix !== undefined ? base.replace(/\{\{[^}]*\}\}/, suffix) : base;
      buttons.push({ type, text, ...(isHttpUrl(url) ? { url } : {}) });
      return;
    }
    if (type === "phone") {
      buttons.push({ type, text, ...(def.phone_number ? { phone: def.phone_number } : {}) });
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
  return {
    mediaKind: headerKind,
    mediaKey: key,
    mediaUrl: media.link,
    mediaMimeType: media.mimeType,
    ...(media.filename ? { mediaFilename: media.filename } : {}),
    ...(media.sizeBytes !== undefined ? { mediaSizeBytes: media.sizeBytes } : {}),
  };
}
