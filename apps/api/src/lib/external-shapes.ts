import { normalizeStringMap } from "@/lib/normalize-string-map";
import type {
  Channel,
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
  identityChannel: Channel | null;
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
   * Channel the thread lives on — "whatsapp", "instagram", "messenger",
   * "webchatwidget", …. A conversation is bound to one contact and therefore
   * one channel; route / filter threads on this.
   */
  channel: string;
  /**
   * Which ACCOUNT on that channel — a workspace may connect several WhatsApp
   * numbers, Pages or handles, and this names the one the customer is talking
   * to (and therefore the one a reply goes out from). Re-stamped on every
   * inbound. Resolve the id against `GET /v1/channel-accounts`. Null when the
   * thread has never been bound, or its account was disconnected.
   */
  channelConnectionId: string | null;
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

/**
 * When a contact is created without a profile name, both ingest and /v1 create
 * fall back to `name = phoneNumber`. Returning that verbatim through the
 * redaction would leak the exact phone the `read:contacts` gate withholds via a
 * `read:conversations`-only key, so mask a name that is (digit-for-digit) the
 * contact's phone number down to a partial form that still distinguishes threads.
 */
export function maskPhoneLikeName(name: string, phoneNumber: string | null): string {
  if (!phoneNumber) return name;
  const digits = (s: string) => s.replace(/\D/g, "");
  const phoneDigits = digits(phoneNumber);
  if (phoneDigits === "" || digits(name) !== phoneDigits) return name;
  // "+96170123456" -> "+9617•••456"; too short to partially mask -> generic.
  return phoneNumber.length > 8
    ? `${phoneNumber.slice(0, 5)}•••${phoneNumber.slice(-3)}`
    : "WhatsApp contact";
}

/**
 * Redact an embedded contact to the minimal identity when the caller's API key
 * lacks `read:contacts` but reaches the contact via a conversation/message read
 * (where it's always embedded). Keeps id + display name + channel — enough to
 * know who a thread is with — and drops every other PII field (phone, email,
 * location, language, country, custom fields, tags). Without this,
 * `read:conversations` / `read:messages` become a side door onto the contact
 * directory that `read:contacts` is supposed to gate.
 */
export function redactExternalContactPii(c: ExternalContact): ExternalContact {
  return {
    id: c.id,
    name: maskPhoneLikeName(c.name, c.phoneNumber),
    identityChannel: c.identityChannel,
    phoneNumber: null,
    externalContactId: null,
    firstName: null,
    lastName: null,
    language: null,
    countryCode: null,
    avatarUrl: null,
    email: null,
    location: null,
    customFields: {},
    stageId: null,
    tagIds: [],
    createdAt: c.createdAt,
  };
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
    // Which of the workspace's accounts this thread is on — the WhatsApp
    // number / Page / IG handle a reply goes out from. Resolve it against
    // `GET /v1/channel-accounts`. Null on a thread that has never been bound to
    // an account (or whose account was disconnected).
    channelConnectionId: c.channelConnectionId ?? null,
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

/**
 * Exactly the columns `toExternalMessage` reads. Declaring it lets callers
 * `select` this narrow set instead of fetching every Message column (or even
 * `omit: rawPayload`, which still ships ~15 unused columns per row on a
 * partner-pollable list endpoint). A full row satisfies this structurally, so
 * existing callers that pass a whole Message keep compiling.
 */
export type MessageWireColumns = MediaColumns &
  Pick<
    DbMessage,
    | "id"
    | "conversationId"
    | "externalId"
    | "channel"
    | "direction"
    | "body"
    | "status"
    | "timestamp"
    | "senderUserId"
  >;

export function toExternalMessage(m: MessageWireColumns): ExternalMessage {
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


/**
 * A WhatsApp template on the `/v1` wire.
 *
 * `id` is OURS — it is what `POST /messages/template` and
 * `GET /templates/:id/analytics` take. `externalId` is Meta's, exposed because
 * anyone reconciling against WhatsApp Manager needs it.
 */
export interface ExternalTemplate {
  id: string;
  externalId: string | null;
  wabaId: string;
  name: string;
  language: string;
  category: string;
  /** The category Meta will move this to next month, when it disagrees. */
  correctCategory: string | null;
  status: string;
  statusReason: string | null;
  /**
   * The status webhook's rich detail, when Meta sent one: rejection
   * explanation + fix recommendation (INVALID_FORMAT), pause instance title,
   * disable timestamp. Null otherwise.
   */
  statusDetail: unknown;
  /** "positional" (`{{1}}`) or "named" (`{{order_id}}`) — decides the send shape. */
  parameterFormat: string;
  messageSendTtlSeconds: number | null;
  bodyText: string;
  components: unknown;
  /**
   * Meta's quality band: GREEN | YELLOW | RED | UNKNOWN, verbatim. Null when
   * never reported. This is the signal worth alerting on — quality drives
   * Meta's template pausing, so RED is a template about to stop sending.
   */
  qualityScore: string | null;
  qualityScoreAt: string | null;
  archivedAt: string | null;
  lastUsedAt: string | null;
  syncedAt: string;
}

export function externalTemplate(t: {
  id: string;
  externalId: string | null;
  wabaId: string;
  name: string;
  language: string;
  category: string;
  correctCategory: string | null;
  status: string;
  statusReason: string | null;
  statusDetail: unknown;
  parameterFormat: string;
  messageSendTtlSeconds: number | null;
  bodyText: string;
  components: unknown;
  qualityScore: string | null;
  qualityScoreAt: Date | null;
  archivedAt: Date | null;
  lastUsedAt: Date | null;
  syncedAt: Date;
}): ExternalTemplate {
  return {
    id: t.id,
    externalId: t.externalId,
    wabaId: t.wabaId,
    name: t.name,
    language: t.language,
    category: t.category,
    // Only a category that DIFFERS is a pending move — same rule the internal
    // DTO applies, so the two surfaces can't disagree about what's pending.
    correctCategory:
      t.correctCategory && t.correctCategory !== t.category ? t.correctCategory : null,
    status: t.status,
    statusReason: t.statusReason,
    statusDetail: t.statusDetail ?? null,
    parameterFormat: t.parameterFormat,
    messageSendTtlSeconds: t.messageSendTtlSeconds,
    bodyText: t.bodyText,
    components: t.components,
    qualityScore: t.qualityScore,
    qualityScoreAt: t.qualityScoreAt?.toISOString() ?? null,
    archivedAt: t.archivedAt?.toISOString() ?? null,
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    syncedAt: t.syncedAt.toISOString(),
  };
}
