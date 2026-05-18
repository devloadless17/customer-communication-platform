import { db } from "@/lib/db";
import type {
  Contact,
  Conversation,
  ConversationStatus,
  InternalNote,
  MediaAttachment,
  MediaKind,
  Message,
  MessageDirection,
  MessageStatus,
  ProviderName,
  ReplySnapshot,
  Role,
  User,
} from "@ccp/shared/types";

export const MAX_TAKE = 100;

export function clampTake(requested: number | undefined, fallback: number): number {
  if (!requested || !Number.isFinite(requested) || requested <= 0) return fallback;
  return Math.min(Math.floor(requested), MAX_TAKE);
}

// ---------------------------------------------------------------------------
// Prisma row types — used by the mappers below.
// ---------------------------------------------------------------------------

type PrismaConversation = Awaited<
  ReturnType<typeof db.conversation.findUniqueOrThrow>
>;
type PrismaContact = Awaited<ReturnType<typeof db.contact.findUniqueOrThrow>>;
type PrismaUser = Awaited<ReturnType<typeof db.user.findUniqueOrThrow>>;
type PrismaMessage = Awaited<ReturnType<typeof db.message.findUniqueOrThrow>>;
type PrismaNote = Awaited<ReturnType<typeof db.internalNote.findUniqueOrThrow>>;

/**
 * Selector snippet used wherever we render a quoted-reply preview. Centralised
 * so message-list, single-thread, and ingest all pull the same fields.
 */
export const REPLY_TO_INCLUDE = {
  select: {
    id: true,
    body: true,
    direction: true,
    mediaKind: true,
    sender: { select: { name: true } },
  },
} as const;

type ReplyToRow = {
  id: string;
  body: string;
  direction: string;
  mediaKind: string | null;
  sender: { name: string } | null;
};

export function mapReplySnapshot(row: ReplyToRow | null | undefined): ReplySnapshot | null {
  if (!row) return null;
  return {
    id: row.id,
    body: row.body.slice(0, 200),
    direction: row.direction as MessageDirection,
    senderName: row.sender?.name ?? null,
    ...(row.mediaKind ? { mediaKind: row.mediaKind as MediaKind } : {}),
  };
}

export function mapUser(u: PrismaUser): User {
  return {
    id: u.id,
    teamId: u.teamId,
    role: u.role as Role,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatarUrl ?? undefined,
    createdAt: u.createdAt.toISOString(),
    isActive: u.deactivatedAt === null,
  };
}

export function mapContact(c: PrismaContact): Contact {
  return {
    id: c.id,
    teamId: c.teamId,
    phoneNumber: c.phoneNumber,
    identityProvider: c.identityProvider as ProviderName | null,
    externalContactId: c.externalContactId,
    name: c.name,
    firstName: c.firstName,
    lastName: c.lastName,
    language: c.language,
    countryCode: c.countryCode,
    assignedUserId: c.assignedUserId,
    avatarUrl: c.avatarUrl ?? undefined,
    email: c.email ?? undefined,
    location: c.location ?? undefined,
    customFields: normalizeCustomFields(c.customFields),
    source: c.source,
    stageId: c.stageId,
    createdAt: c.createdAt.toISOString(),
  };
}

/**
 * Narrower mapper for the inbox list. The conversation list row only renders
 * `name` + the avatar gradient + stage chip + tag chip filter — it never
 * surfaces customFields / email / location. Dropping `customFields` from the
 * SELECT removes the JSONB column read from every list page; the rest stay
 * because they're cheap VARCHARs.
 *
 * Returns a full `Contact` so downstream UI types don't have to branch — the
 * dropped JSONB is synthesized as `{}`. When the agent opens a thread the
 * full record is re-fetched via the per-conversation query which DOES select
 * customFields.
 */
type PrismaContactListItem = Omit<PrismaContact, "customFields">;
export function mapContactListItem(c: PrismaContactListItem): Contact {
  return {
    id: c.id,
    teamId: c.teamId,
    phoneNumber: c.phoneNumber,
    identityProvider: c.identityProvider as ProviderName | null,
    externalContactId: c.externalContactId,
    name: c.name,
    firstName: c.firstName,
    lastName: c.lastName,
    language: c.language,
    countryCode: c.countryCode,
    assignedUserId: c.assignedUserId,
    avatarUrl: c.avatarUrl ?? undefined,
    email: c.email ?? undefined,
    location: c.location ?? undefined,
    customFields: {},
    source: c.source,
    stageId: c.stageId,
    createdAt: c.createdAt.toISOString(),
  };
}

/**
 * The customFields column is `Json` so Prisma types it as `JsonValue`.
 * Coerce to a flat string-map at this boundary so the rest of the app can
 * just do `contact.customFields[key]` without runtime checks. Anything
 * non-string is dropped (defensive — should never happen since the API
 * validates writes, but keeps the UI from crashing on legacy data).
 */
export function normalizeCustomFields(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function mapConversation(c: PrismaConversation): Conversation {
  return {
    id: c.id,
    teamId: c.teamId,
    contactId: c.contactId,
    assignedUserId: c.assignedUserId,
    status: c.status as ConversationStatus,
    unreadCount: c.unreadCount,
    lastMessageAt: c.lastMessageAt.toISOString(),
    lastMessagePreview: c.lastMessagePreview,
  };
}

// Read paths never need `raw_payload` — it's the verbatim Meta webhook body,
// kept in the DB for debugging only (CLAUDE.md rule #4). Pulling it would
// drag a full JSONB blob per row through Postgres → Node → the browser on
// every thread open, so we `omit` it from every message read and the domain
// type doesn't carry it.
export type PrismaMessageWithReply = Omit<PrismaMessage, "rawPayload"> & {
  replyTo?: ReplyToRow | null;
};

export function mapMessage(m: PrismaMessageWithReply): Message {
  return {
    id: m.id,
    teamId: m.teamId,
    conversationId: m.conversationId,
    externalId: m.externalId,
    senderUserId: m.senderUserId,
    body: m.body,
    direction: m.direction as MessageDirection,
    provider: m.provider as ProviderName,
    status: m.status as MessageStatus,
    timestamp: m.timestamp.toISOString(),
    ...(m.replyToMessageId
      ? {
          replyToMessageId: m.replyToMessageId,
          replyTo: mapReplySnapshot(m.replyTo) ?? undefined,
        }
      : {}),
    ...(m.mediaKind && m.mediaMimeType
      ? {
          media: {
            kind: m.mediaKind as MediaAttachment["kind"],
            // Authenticated stream — never leaks the on-disk path.
            url: `/api/media/${m.id}`,
            mimeType: m.mediaMimeType,
            sizeBytes: m.mediaSizeBytes ?? 0,
            ...(m.mediaCaption ? { caption: m.mediaCaption } : {}),
            ...(m.mediaFilename ? { filename: m.mediaFilename } : {}),
            ...(m.mediaDurationMs != null ? { durationMs: m.mediaDurationMs } : {}),
            // Video poster — only set when the inbound ingest extracted +
            // uploaded a first-frame JPEG via ffmpeg. Older rows + outbound
            // video sends leave mediaThumbnailUrl NULL; the VideoBlock
            // gracefully falls back to bg-black when thumbnailUrl is absent.
            ...(m.mediaThumbnailUrl
              ? { thumbnailUrl: `/api/media/${m.id}/thumb` }
              : {}),
          },
          // Row was inserted before the binary finished downloading — the
          // bubble renders a placeholder until the message:media:ready event
          // (or a later page load) fills it in. Inbound-only: outbound has
          // no background-download path that could ever clear the flag, so
          // a missing mediaUrl on outbound is a hard failure (caption-only
          // row), not pending state.
          ...(m.direction === "in" && !m.mediaUrl ? { mediaPending: true } : {}),
        }
      : {}),
  };
}

export function mapNote(n: PrismaNote): InternalNote {
  return {
    id: n.id,
    conversationId: n.conversationId,
    authorUserId: n.authorUserId,
    body: n.body,
    timestamp: n.timestamp.toISOString(),
  };
}
