/**
 * Messenger Sticker API (GA 2026-06-01) — browse, search and send Meta's
 * first-party sticker catalog.
 *
 * Three reads and one send:
 *   GET  /sticker_packs                        — the packs (~105, free + first-party)
 *   GET  /sticker_packs/{id}/stickers          — the stickers in one pack
 *   GET  /sticker_search?q=…                   — keyword search across every pack
 *   POST /{PAGE_ID}/messages {sticker_id: …}   — send one
 *
 * ## The token split is the thing to get right
 *
 * The three CATALOG reads take an **App Access Token**, spelled as the literal
 * concatenation `<APP_ID>|<APP_SECRET>` — not a Page token, and not a Bearer
 * header the way every other call in this codebase authenticates. The SEND takes
 * an ordinary Page access token with `pages_messaging`, like the rest of the Send
 * API. Handing a Page token to the catalog fails, so the catalog functions take
 * an app-credential pair and the send takes a `SocialSendTarget`; they cannot be
 * called with each other's arguments by accident.
 *
 * The app token is a bearer-equivalent secret, so it travels in the Authorization
 * header rather than the query string Meta's own curl examples use — same posture
 * as every other Graph call here (see meta-graph.ts).
 *
 * ## Locale is not optional in practice
 *
 * Meta: "If your users search in a non-English language, you must pass the locale
 * parameter." Without it the API defaults to `en_US` and matches only English
 * sticker tags, so a Vietnamese or Korean query silently returns an empty list
 * rather than an error. Callers pass the agent's locale through.
 *
 * ## Sending
 *
 * "Stickers can only be sent within the standard messaging window, following the
 * same rules as other Send API message types" — so a sticker send carries the
 * same `messaging_type` decision as text, and the composer must gate it on the
 * window exactly like a free-form message.
 *
 * "Only public, free, first-party stickers can be sent — the same set returned by
 * the Sticker Catalog API." The one documented exception is the thumbs-up/like
 * sticker `369239263222822`, which is always sendable and is NOT in the catalog,
 * so it is exported here rather than discovered.
 */

import { GRAPH_BASE, graphGetJson, graphPostJson } from "@/lib/providers/meta-graph";
import type { SocialSendTarget } from "@/lib/providers/meta-social";
import type { SendTextResult } from "@ccp/shared/providers/types";

/**
 * The like/thumbs-up sticker. Documented as always available for sending and
 * deliberately absent from the catalog endpoints, so a picker that only lists
 * `/sticker_packs` would never offer the single most-used sticker on Messenger.
 */
export const LIKE_STICKER_ID = "369239263222822";

export interface MessengerStickerPack {
  id: string;
  name: string;
  description: string | null;
  previewImageUrl: string | null;
  stickerCount: number | null;
}

export interface MessengerSticker {
  id: string;
  name: string | null;
  imageUrl: string | null;
  width: number | null;
  height: number | null;
  isAnimated: boolean;
}

/** App-level credentials for the catalog reads. See the header on the token split. */
export interface StickerCatalogAuth {
  appId: string;
  appSecret: string;
  graphVersion: string;
}

/** Meta's app access token is the literal `app_id|app_secret` pair. The catalog
 *  reads below also SIGN with `appsecret_proof` (proof of this token, keyed by
 *  the same secret — the pattern meta.service's debug_token uses): an app with
 *  "Require app secret" ON rejects unsigned server calls, app token or not. */
function appAccessToken(auth: StickerCatalogAuth): string {
  return `${auth.appId}|${auth.appSecret}`;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function toSticker(row: Record<string, unknown>): MessengerSticker | null {
  const id = str(row.id);
  if (!id) return null;
  return {
    id,
    name: str(row.name),
    imageUrl: str(row.image_url),
    width: num(row.width),
    height: num(row.height),
    isAnimated: row.is_animated === true,
  };
}

/** The available first-party sticker packs. */
export async function listStickerPacks(
  auth: StickerCatalogAuth,
  locale?: string,
): Promise<MessengerStickerPack[]> {
  const qs = locale ? `?locale=${encodeURIComponent(locale)}` : "";
  const res = await graphGetJson(
    `${GRAPH_BASE}/${auth.graphVersion}/sticker_packs${qs}`,
    appAccessToken(auth),
    { retry: true },
    auth.appSecret,
  );
  const data = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];
  return data.flatMap((row) => {
    const id = str(row.id);
    if (!id) return [];
    return [
      {
        id,
        name: str(row.name) ?? id,
        description: str(row.description),
        previewImageUrl: str(row.preview_image_url),
        stickerCount: num(row.sticker_count),
      },
    ];
  });
}

/** The stickers inside one pack. */
export async function listStickersInPack(
  packId: string,
  auth: StickerCatalogAuth,
  locale?: string,
): Promise<MessengerSticker[]> {
  const qs = locale ? `?locale=${encodeURIComponent(locale)}` : "";
  const res = await graphGetJson(
    `${GRAPH_BASE}/${auth.graphVersion}/${encodeURIComponent(packId)}/stickers${qs}`,
    appAccessToken(auth),
    { retry: true },
    auth.appSecret,
  );
  const data = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];
  return data.flatMap((row) => {
    const s = toSticker(row);
    return s ? [s] : [];
  });
}

/** Meta's documented minimum query length. Shorter queries are rejected upstream. */
export const STICKER_SEARCH_MIN_CHARS = 2;

/**
 * Keyword search across every pack. `locale` is forwarded whenever the caller has
 * one — see the header: omitting it silently returns nothing for a non-English
 * query rather than erroring, which reads to a user as "there are no stickers".
 */
export async function searchStickers(
  query: string,
  auth: StickerCatalogAuth,
  locale?: string,
): Promise<MessengerSticker[]> {
  const q = query.trim();
  if (q.length < STICKER_SEARCH_MIN_CHARS) return [];
  const params = new URLSearchParams({ q });
  if (locale) params.set("locale", locale);
  const res = await graphGetJson(
    `${GRAPH_BASE}/${auth.graphVersion}/sticker_search?${params.toString()}`,
    appAccessToken(auth),
    { retry: true },
    auth.appSecret,
  );
  const data = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];
  return data.flatMap((row) => {
    const s = toSticker(row);
    return s ? [s] : [];
  });
}

/**
 * Send a sticker.
 *
 * `message.sticker_id` is its own message shape — it is NOT an attachment, so it
 * carries no `type`/`payload` envelope and cannot be combined with text. The
 * `messaging_type` decision is identical to a text send, which is why it is passed
 * in rather than assumed: Meta gates stickers on the standard messaging window
 * like any other Send API type.
 */
export async function sendMessengerSticker(
  args: { to: string; stickerId: string; useHumanAgentTag?: boolean },
  opts: SocialSendTarget,
  messagingTypeFields: object,
): Promise<SendTextResult> {
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messages`;
  const res = await graphPostJson(
    url,
    opts.accessToken,
    {
      recipient: { id: args.to },
      ...messagingTypeFields,
      message: { sticker_id: args.stickerId },
    },
    opts.appSecret,
  );
  const messageId = typeof res.message_id === "string" ? res.message_id : "";
  if (!messageId) {
    throw new Error(`${opts.label} sendSticker: response missing message_id`);
  }
  return { externalId: messageId, timestamp: new Date() };
}
