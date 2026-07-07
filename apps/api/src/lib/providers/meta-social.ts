/**
 * Shared inbound-parse + outbound-send for the Meta SOCIAL channels (Facebook
 * Messenger, Instagram DM). Both are the same wire shape — the only real
 * differences are the webhook `object` discriminator and which business-account
 * id addresses the send — so the logic lives here once and each provider is a
 * thin wrapper (`messenger.ts`, `instagram.ts`). Two live channels make this a
 * real seam, not speculative abstraction.
 *
 *   - Inbound: `{ object, entry[].messaging[] }`. Identity = the opaque sender
 *     id (Messenger PSID / Instagram IGSID), NEVER a phone (never digit-stripped).
 *   - Outbound: `POST /{ACCOUNT_ID}/messages` with `recipient:{id}` and the
 *     Human Agent tag (valid across the 7-day support window; every send in an
 *     agent-operated shared inbox is a human agent reply).
 *
 * Scope (first increment): inbound TEXT + delivery status, outbound TEXT.
 * Attachments become a `[kind]` placeholder body; media in/out is a follow-up.
 */

import type {
  NormalizedEvent,
  NormalizedInboundMessage,
  NormalizedMediaRef,
  NormalizedStatusUpdate,
  SendMediaArgs,
  SendTextArgs,
  SendTextResult,
  UploadMediaArgs,
  UploadMediaResult,
} from "@ccp/shared/providers/types";
import type { MediaKind } from "@ccp/shared/types";
import {
  GRAPH_BASE,
  graphGetJson,
  graphPostForm,
  graphPostJson,
} from "@/lib/providers/meta-graph";

/** Shared identity of the Meta account addressing a send (Page id / IG id). */
export interface SocialSendTarget {
  accountId: string;
  accessToken: string;
  graphVersion: string;
  /** Provider name for error messages ("messenger" / "instagram"). */
  label: string;
}

/**
 * Map our channel-agnostic MediaKind (and, for uploads, a mime type) to Meta's
 * social attachment `type`. Meta uses `file` for documents and folds stickers
 * into `image`. Both the upload and the send must agree on the type, so both
 * derive it deterministically.
 */
function attachmentTypeFromKind(kind: MediaKind): "image" | "video" | "audio" | "file" {
  switch (kind) {
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "document":
      return "file";
    case "image":
    case "sticker":
    default:
      return "image";
  }
}
function attachmentTypeFromMime(mime: string): "image" | "video" | "audio" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

interface SocialEnvelope {
  object?: string;
  entry?: SocialEntry[];
}
interface SocialEntry {
  id?: string;
  time?: number;
  messaging?: MessagingEvent[];
}
interface MessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    attachments?: { type?: string; payload?: { url?: string } }[];
  };
  delivery?: { mids?: string[]; watermark?: number };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Map a Meta social attachment `type` to our channel-agnostic MediaKind. */
function attachmentKind(type: string | undefined): MediaKind | null {
  switch (type) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "file":
      return "document";
    // "location" | "template" | "fallback" carry no downloadable binary.
    default:
      return null;
  }
}

/** Provisional mime type before the download reads the real Content-Type. */
function provisionalMime(kind: MediaKind): string {
  switch (kind) {
    case "image":
      return "image/jpeg";
    case "video":
      return "video/mp4";
    case "audio":
      return "audio/mpeg";
    default:
      return "application/octet-stream";
  }
}

/**
 * Build a NormalizedMediaRef for the first downloadable attachment on a message,
 * or null if there is none (text-only, or a non-binary attachment). Social
 * channels deliver a direct CDN URL (`payload.url`), so we set `sourceUrl` and
 * leave `externalMediaId` empty — the inbound-media path fetches the URL.
 */
function attachmentMedia(
  atts: { type?: string; payload?: { url?: string } }[] | undefined,
): NormalizedMediaRef | null {
  const att = atts?.find((a) => attachmentKind(a.type) && a.payload?.url);
  if (!att) return null;
  const kind = attachmentKind(att.type)!;
  return {
    kind,
    externalMediaId: "",
    sourceUrl: att.payload!.url!,
    mimeType: provisionalMime(kind),
  };
}

/**
 * Parse a Messenger/Instagram webhook into normalized events. `expectedObject`
 * gates the envelope (`"page"` for Messenger, `"instagram"` for Instagram) so a
 * misrouted product silently yields `[]` rather than mis-ingesting.
 */
export function parseSocialMessaging(
  payload: unknown,
  expectedObject: string,
): NormalizedEvent[] {
  if (!isObject(payload)) return [];
  const env = payload as SocialEnvelope;
  if (env.object !== expectedObject || !Array.isArray(env.entry)) return [];

  const events: NormalizedEvent[] = [];
  for (const entry of env.entry) {
    if (!Array.isArray(entry.messaging)) continue;
    for (const m of entry.messaging) {
      // Inbound customer message. Skip echoes (our own sends mirrored back) —
      // the send path owns persistence; ingesting the echo would double-post.
      if (m.message && !m.message.is_echo) {
        const senderId = m.sender?.id;
        const mid = m.message.mid;
        if (!senderId || !mid) continue;
        const media = attachmentMedia(m.message.attachments);
        const text = m.message.text;
        // Body is the text (media caption if any); empty for media-only. When a
        // message has neither text nor a downloadable attachment, fall back to a
        // short label so the row isn't blank (e.g. a location/sticker/fallback).
        const body =
          text && text.length > 0
            ? text
            : media
              ? ""
              : m.message.attachments?.[0]?.type
                ? `[${m.message.attachments[0].type}]`
                : "";
        const msg: NormalizedInboundMessage = {
          kind: "message",
          externalId: mid,
          externalContactId: senderId,
          // No display name in the messaging event; ingest falls back to the id
          // (a later Graph name-enrichment pass fills it in).
          contactName: null,
          body,
          ...(media ? { media } : {}),
          timestamp: new Date(m.timestamp ?? entry.time ?? Date.now()),
          rawPayload: m as unknown as Record<string, unknown>,
        };
        events.push(msg);
        continue;
      }
      // Delivery receipts carry the mids Meta delivered.
      if (m.delivery && Array.isArray(m.delivery.mids)) {
        const ts = new Date(m.delivery.watermark ?? m.timestamp ?? Date.now());
        for (const mid of m.delivery.mids) {
          if (!mid) continue;
          const status: NormalizedStatusUpdate = {
            kind: "status",
            externalId: mid,
            status: "delivered",
            timestamp: ts,
            rawPayload: m as unknown as Record<string, unknown>,
          };
          events.push(status);
        }
      }
      // `read` watermarks (no per-message id) + reactions/postbacks: not this
      // increment.
    }
  }
  return events;
}

/**
 * Send a text message on a Meta social channel. `accountId` is the Page id
 * (Messenger) or IG business id (Instagram); `accessToken` is that account's
 * token. Human Agent tag = valid for the 7-day support window. Quoted replies
 * aren't supported by these Send APIs, so `replyToExternalId` is ignored.
 */
export async function sendSocialText(
  args: SendTextArgs,
  opts: SocialSendTarget,
): Promise<SendTextResult> {
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messages`;
  const res = await graphPostJson(url, opts.accessToken, {
    recipient: { id: args.to },
    messaging_type: "MESSAGE_TAG",
    tag: "HUMAN_AGENT",
    message: { text: args.body },
  });
  const messageId = typeof res.message_id === "string" ? res.message_id : "";
  if (!messageId) {
    throw new Error(`${opts.label} sendText: response missing message_id`);
  }
  return { externalId: messageId, timestamp: new Date() };
}

/**
 * Upload a media binary to the social Attachment Upload API
 * (`/{accountId}/message_attachments`) and return a reusable attachment id.
 * Works for image / video / audio / file on BOTH Messenger and Instagram. The
 * attachment `type` is derived from the mime type and must match the `type` the
 * later send uses (both derive it deterministically). Mirrors WhatsApp's
 * `uploadMedia` (bytes → provider id), so the generic send path is unchanged.
 */
export async function uploadSocialMedia(
  args: UploadMediaArgs,
  opts: SocialSendTarget,
): Promise<UploadMediaResult> {
  const type = attachmentTypeFromMime(args.mimeType);
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/message_attachments`;
  const form = new FormData();
  form.append(
    "message",
    JSON.stringify({ attachment: { type, payload: { is_reusable: true } } }),
  );
  // Meta reads the bytes from the `filedata` part. Blob carries the mime type;
  // the filename helps Meta render document names on the recipient side.
  form.append(
    "filedata",
    new Blob([args.bytes], { type: args.mimeType }),
    args.filename,
  );
  const res = await graphPostForm(url, opts.accessToken, form);
  const attachmentId = typeof res.attachment_id === "string" ? res.attachment_id : "";
  if (!attachmentId) {
    throw new Error(`${opts.label} uploadMedia: response missing attachment_id`);
  }
  return { mediaId: attachmentId };
}

/**
 * Send a previously-uploaded media attachment on a social channel. Meta social
 * messages can't carry BOTH an attachment and text in one call, so a caption is
 * delivered as a best-effort follow-up text message (the media row still stores
 * the caption for the agent's view). Returns the ATTACHMENT message's id — the
 * one the app persists. Human Agent tag, same as text.
 */
export async function sendSocialMedia(
  args: SendMediaArgs,
  opts: SocialSendTarget,
): Promise<SendTextResult> {
  const type = attachmentTypeFromKind(args.kind);
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messages`;
  const res = await graphPostJson(url, opts.accessToken, {
    recipient: { id: args.to },
    messaging_type: "MESSAGE_TAG",
    tag: "HUMAN_AGENT",
    message: { attachment: { type, payload: { attachment_id: args.mediaId } } },
  });
  const messageId = typeof res.message_id === "string" ? res.message_id : "";
  if (!messageId) {
    throw new Error(`${opts.label} sendMedia: response missing message_id`);
  }
  // Caption → follow-up text. Best-effort: a failed caption must not fail the
  // media send (which already went out and bills nothing extra to retry).
  if (args.caption && args.caption.trim().length > 0) {
    try {
      await sendSocialText({ to: args.to, body: args.caption }, opts);
    } catch {
      // Swallow — the media landed; the caption is a nice-to-have.
    }
  }
  return { externalId: messageId, timestamp: new Date() };
}

/**
 * Best-effort display name for a social contact — the messaging webhook carries
 * no name, so we read the profile node (`/{id}?fields=…`). `fields` differs per
 * channel (Messenger: `name`; Instagram: `name,username`). Returns the first
 * non-empty of the requested fields, else null. Never throws — the caller
 * enriches opportunistically and keeps the id-as-name fallback on any failure.
 */
export async function fetchSocialProfileName(
  externalId: string,
  opts: { accessToken: string; graphVersion: string; fields: string },
): Promise<string | null> {
  try {
    const url = `${GRAPH_BASE}/${opts.graphVersion}/${encodeURIComponent(externalId)}?fields=${encodeURIComponent(opts.fields)}`;
    const res = await graphGetJson(url, opts.accessToken, { retry: true });
    const name = typeof res.name === "string" ? res.name.trim() : "";
    const username = typeof res.username === "string" ? res.username.trim() : "";
    return name || username || null;
  } catch {
    return null;
  }
}
