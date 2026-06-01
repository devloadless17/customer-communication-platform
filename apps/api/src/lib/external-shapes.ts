import { normalizeStringMap } from "@/lib/normalize-string-map";
import type {
  Contact as DbContact,
  Conversation as DbConversation,
  Message as DbMessage,
} from "@prisma/client";


/**
 * Wire shapes the external API (/api/external/v1) returns. Stable contract
 * for n8n / partner integrations — once consumers start parsing these, the
 * shapes are versioned.
 *
 * They're slightly different from the internal `lib/types.ts` shapes:
 *   - No `rawPayload` (huge JSON, not useful to integrators)
 *   - No optimistic-UI fields (`pending`, `failed`, `clientTempId`)
 *   - All timestamps are ISO strings, never Date — JSON-stable
 */

/**
 * A team member referenced from a payload (the per-thread conversation
 * assignee). Hydrated so integrators don't have to call GET /v1/users/:id to
 * label a row "assigned to Sara" — they get the name + email inline. `null`
 * means unassigned. We deliberately do NOT carry a bare `assignedUserId`
 * alongside this — the object IS the reference; `assignee.id` is the id.
 */
export interface ExternalAssignee {
  id: string;
  name: string;
  email: string;
}

/**
 * Media attached to a message. Replaces the old flat `mediaKind` /
 * `mediaCaption` pair so an integrator can actually fetch + label the file:
 *   - `url`        — public CDN URL, directly downloadable by the integrator
 *                    (no session auth needed; API-key holders are trusted).
 *   - `mimeType`   — e.g. "image/png", "application/pdf" → derive the extension.
 *   - `filename`   — original filename (documents); null for camera media.
 * `null` on the message means it's text-only.
 */
export interface ExternalMedia {
  /** "image" | "video" | "audio" | "document" | "sticker". */
  kind: string;
  url: string | null;
  mimeType: string | null;
  filename: string | null;
  sizeBytes: number | null;
  /** Audio / video only. */
  durationMs: number | null;
  thumbnailUrl: string | null;
  caption: string | null;
}

export interface ExternalContact {
  id: string;
  /**
   * Null for non-phone channels (Instagram/Telegram). Integrators that key
   * by phone should fall back to identityChannel+externalContactId or skip
   * the row.
   */
  phoneNumber: string | null;
  identityChannel: "whatsapp" | null;
  externalContactId: string | null;
  /** Canonical display name. Derived from firstName + lastName when both set. */
  name: string;
  /** Split off `name` on first space at create/migration time. */
  firstName: string | null;
  lastName: string | null;
  /** BCP-47 tag, e.g. "ar", "en". Used by template-language selection. */
  language: string | null;
  /** ISO 3166-1 alpha-2, derived from phone number on inbound + /v1 writes. */
  countryCode: string | null;
  /** Avatar URL — usually null today; populated when an avatar is uploaded. */
  avatarUrl: string | null;
  email: string | null;
  location: string | null;
  customFields: Record<string, string>;
  stageId: string | null;
  tagIds: string[];
  createdAt: string;
}

export interface ExternalConversation {
  id: string;
  contactId: string;
  /**
   * Channel the thread lives on — "whatsapp", "instagram", "telegram", …. A
   * conversation is bound to one contact and therefore one channel; route /
   * filter threads on this. Today always "whatsapp".
   */
  channel: string;
  status: "open" | "pending" | "closed";
  /** Per-thread assignee. Hydrated; null when unassigned. */
  assignee: ExternalAssignee | null;
  unreadCount: number;
  lastMessageAt: string;
  lastMessagePreview: string;
  /**
   * The contact this conversation is with — always embedded. A conversation
   * without its contact forced every integrator into a second GET; carrying
   * it inline is the single biggest "contact info is missing" fix.
   */
  contact: ExternalContact;
}

export interface ExternalMessage {
  id: string;
  conversationId: string;
  externalId: string;
  /**
   * Channel this message was sent/received on — "whatsapp", "instagram", … .
   * Always present; key off this when handling multiple channels. Today always
   * "whatsapp".
   */
  channel: string;
  direction: "in" | "out";
  body: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  senderUserId: string | null;
  /** Attachment details, or null for a text-only message. */
  media: ExternalMedia | null;
}

/**
 * Prisma `include` fragments that hydrate everything the serializers need.
 * Reused across every /v1 read so assignee + tags are populated consistently
 * — the root cause of "contact info is missing on some endpoints" was each
 * query hand-picking a different include.
 */
export const EXTERNAL_CONTACT_INCLUDE = {
  tags: { select: { id: true } },
} as const;

export const EXTERNAL_CONVERSATION_INCLUDE = {
  assignedUser: { select: { id: true, name: true, email: true } },
  contact: { include: EXTERNAL_CONTACT_INCLUDE },
} as const;

/** Shape of the `assignedUser` relation when included on a row. */
type AssigneeRow = { id: string; name: string; email: string } | null | undefined;

export function toExternalAssignee(u: AssigneeRow): ExternalAssignee | null {
  return u ? { id: u.id, name: u.name, email: u.email } : null;
}

export function toExternalContact(
  c: DbContact,
  tagIds: string[] = [],
): ExternalContact {
  return {
    id: c.id,
    phoneNumber: c.phoneNumber,
    identityChannel: c.identityChannel,
    externalContactId: c.externalContactId,
    name: c.name,
    firstName: c.firstName ?? null,
    lastName: c.lastName ?? null,
    language: c.language ?? null,
    countryCode: c.countryCode ?? null,
    avatarUrl: c.avatarUrl ?? null,
    email: c.email ?? null,
    location: c.location ?? null,
    customFields: normalizeStringMap(c.customFields),
    stageId: c.stageId,
    tagIds,
    createdAt: c.createdAt.toISOString(),
  };
}

/**
 * Map a contact row fetched with `EXTERNAL_CONTACT_INCLUDE` straight to the
 * wire shape — reads tag ids + assignee off the included relations so call
 * sites don't repeat `.tags.map(...)`.
 */
export function contactRowToExternal(
  r: DbContact & { tags?: { id: string }[] },
): ExternalContact {
  return toExternalContact(r, (r.tags ?? []).map((t) => t.id));
}

/**
 * Map a conversation row fetched with `EXTERNAL_CONVERSATION_INCLUDE` to the
 * wire shape, embedding its contact. The contact relation is required by the
 * include, so this is always safe.
 */
export function conversationRowToExternal(
  r: DbConversation & {
    assignedUser?: AssigneeRow;
    contact: DbContact & { tags?: { id: string }[] };
  },
): ExternalConversation {
  return toExternalConversation(r, contactRowToExternal(r.contact));
}

export function toExternalConversation(
  c: DbConversation & { assignedUser?: AssigneeRow },
  contact: ExternalContact,
): ExternalConversation {
  return {
    id: c.id,
    contactId: c.contactId,
    // Channel is owned by the conversation row, not derived from the contact.
    channel: c.channel,
    status: c.status as ExternalConversation["status"],
    assignee: toExternalAssignee(c.assignedUser),
    unreadCount: c.unreadCount,
    lastMessageAt: c.lastMessageAt.toISOString(),
    lastMessagePreview: c.lastMessagePreview,
    contact,
  };
}

/** Media columns present on every Message row (text-only rows leave them null). */
type MediaColumns = Pick<
  DbMessage,
  | "mediaKind"
  | "mediaUrl"
  | "mediaMimeType"
  | "mediaFilename"
  | "mediaSizeBytes"
  | "mediaDurationMs"
  | "mediaThumbnailUrl"
  | "mediaCaption"
>;

export function toExternalMedia(m: MediaColumns): ExternalMedia | null {
  if (!m.mediaKind) return null;
  return {
    kind: m.mediaKind,
    url: m.mediaUrl ?? null,
    mimeType: m.mediaMimeType ?? null,
    filename: m.mediaFilename ?? null,
    sizeBytes: m.mediaSizeBytes ?? null,
    durationMs: m.mediaDurationMs ?? null,
    thumbnailUrl: m.mediaThumbnailUrl ?? null,
    caption: m.mediaCaption ?? null,
  };
}

export function toExternalMessage(
  m: Omit<DbMessage, "rawPayload"> | DbMessage,
): ExternalMessage {
  return {
    id: m.id,
    conversationId: m.conversationId,
    externalId: m.externalId,
    channel: m.channel,
    direction: m.direction as ExternalMessage["direction"],
    body: m.body,
    status: m.status as ExternalMessage["status"],
    timestamp: m.timestamp.toISOString(),
    senderUserId: m.senderUserId,
    media: toExternalMedia(m),
  };
}

