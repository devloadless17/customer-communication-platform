import { db } from "@/lib/db";
import { normalizeStringMap } from "@/lib/normalize-string-map";
import type {
  ActivityActorKind,
  Contact,
  Conversation,
  ConversationActivityEvent,
  ConversationEventKind,
  ConversationStatus,
  InternalNote,
  MediaAttachment,
  MediaKind,
  Message,
  MessageDirection,
  MessageStatus,
  Channel,
  ReplySnapshot,
  Role,
  User,
  UserAvailabilityStatus,
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
    // Drives the quoted-reply video thumbnail — present only when ingest
    // extracted a poster frame (NULL on outbound/older video; absent then).
    mediaThumbnailUrl: true,
    sender: { select: { name: true } },
  },
} as const;

type ReplyToRow = {
  id: string;
  body: string;
  direction: string;
  mediaKind: string | null;
  mediaThumbnailUrl: string | null;
  sender: { name: string } | null;
};

export function mapReplySnapshot(row: ReplyToRow | null | undefined): ReplySnapshot | null {
  if (!row) return null;
  // Quoted-reply thumbnail — mirrors how mapMessage builds the main media
  // thumbnailUrl. Image: the authenticated stream itself doubles as its thumb.
  // Video: the extracted poster, only when mediaThumbnailUrl is set. Non-
  // image/video media (audio/document/sticker) carry no thumbnail.
  const thumbnailUrl =
    row.mediaKind === "image"
      ? `/api/media/${row.id}`
      : row.mediaKind === "video" && row.mediaThumbnailUrl
        ? `/api/media/${row.id}/thumb`
        : undefined;
  return {
    id: row.id,
    body: row.body.slice(0, 200),
    direction: row.direction as MessageDirection,
    senderName: row.sender?.name ?? null,
    ...(row.mediaKind ? { mediaKind: row.mediaKind as MediaKind } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
  };
}

/**
 * Exactly the User columns `mapUser` reads. Use as the `select` for an
 * `assignedUser` include on hot list paths so Prisma stops shipping every
 * User column (password hash, updatedAt, deactivatedAt timestamp value, …)
 * across Postgres → Node → wire on every conversation-list row. The full
 * `findUniqueOrThrow` row is structurally assignable to `MappableUser`, so
 * existing full-row callers of `mapUser` still type-check.
 */
export const ASSIGNED_USER_SELECT = {
  id: true,
  teamId: true,
  role: true,
  name: true,
  email: true,
  avatarUrl: true,
  createdAt: true,
  deactivatedAt: true,
  availabilityStatus: true,
  availabilityMessage: true,
} as const;

type MappableUser = Pick<PrismaUser, keyof typeof ASSIGNED_USER_SELECT>;

export function mapUser(u: MappableUser): User {
  // Availability comes off the same row when present (every inbox query that
  // includes `assignedUser` brings these columns along by default). Only
  // emit them when set so the wire shape stays terse for clients that
  // don't read availability. `users.service.ts` used to carry a
  // near-identical local mapper (`mapAvailabilityRow`) until 2026-05-26;
  // collapsed into here so a future "availability shows in one panel but
  // not another" drift can't happen.
  return {
    id: u.id,
    teamId: u.teamId,
    role: u.role as Role,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatarUrl ?? undefined,
    createdAt: u.createdAt.toISOString(),
    isActive: u.deactivatedAt === null,
    ...(u.availabilityStatus
      ? { availabilityStatus: u.availabilityStatus as UserAvailabilityStatus }
      : {}),
    ...(u.availabilityMessage ? { availabilityMessage: u.availabilityMessage } : {}),
  };
}

export function mapContact(c: PrismaContact): Contact {
  return {
    id: c.id,
    teamId: c.teamId,
    phoneNumber: c.phoneNumber,
    identityChannel: c.identityChannel as Channel | null,
    externalContactId: c.externalContactId,
    name: c.name,
    firstName: c.firstName,
    lastName: c.lastName,
    language: c.language,
    countryCode: c.countryCode,
    // Calling permission revocation — drives the inbox Phone-button gate so a
    // revoked contact doesn't show an enabled button the backend would reject.
    callPermissionRevokedUntil:
      c.callPermissionRevokedUntil?.toISOString() ?? null,
    avatarUrl: c.avatarUrl ?? undefined,
    email: c.email ?? undefined,
    location: c.location ?? undefined,
    customFields: normalizeStringMap(c.customFields),
    source: c.source,
    stageId: c.stageId,
    createdAt: c.createdAt.toISOString(),
  };
}

/**
 * THE single Prisma-row → Contact WIRE serializer for every `contact.created` /
 * `contact.updated` publisher (HTTP edit, CSV import, /v1 API, workflow steps,
 * inbound ingest). Use this instead of hand-rolling a `Contact` literal: those
 * hand-rolled copies drifted and dropped `callPermissionRevokedUntil`, so a
 * workflow/edit touching a call-revoked contact broadcast a frame that
 * re-enabled the inbox Phone button for every agent until the next full read.
 * `mapContact` is the field source of truth (incl. callPermissionRevokedUntil);
 * `tagIds` is wire-only (the cross-conversation tag union the list/panel reduce
 * against) and is opt-in because not every publisher JOINs the tags.
 */
export function toContactWire(
  c: PrismaContact,
  opts?: { tagIds?: string[] },
): Contact {
  return {
    ...mapContact(c),
    ...(opts?.tagIds ? { tagIds: opts.tagIds } : {}),
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
// `version` is the optimistic-concurrency token on the row — it never
// reaches the wire (clients don't need it; the server-side CAS handles
// races) so we omit it from the mapper's input type too. `deletedAt` is the
// soft-delete tombstone — likewise an internal column that never reaches the
// wire. Listing them alongside `customFields` keeps the strict shape's `Omit`
// tractable.
// `callPermissionRevokedUntil` + `consecutiveUnansweredOutCalls` are calling-
// state internals — never read by the list UI (the contact-panel can fetch
// them separately when needed), and excluding them keeps the contact-list
// select narrow.
type PrismaContactListItem = Omit<
  PrismaContact,
  | "customFields"
  | "version"
  | "deletedAt"
  | "callPermissionRevokedUntil"
  | "consecutiveUnansweredOutCalls"
  // customerId isn't part of the narrow list row — the unified profile is loaded
  // separately when a thread is opened, so the contact-list select omits it.
  | "customerId"
>;
export function mapContactListItem(c: PrismaContactListItem): Contact {
  return {
    id: c.id,
    teamId: c.teamId,
    phoneNumber: c.phoneNumber,
    identityChannel: c.identityChannel as Channel | null,
    externalContactId: c.externalContactId,
    name: c.name,
    firstName: c.firstName,
    lastName: c.lastName,
    language: c.language,
    countryCode: c.countryCode,
    avatarUrl: c.avatarUrl ?? undefined,
    email: c.email ?? undefined,
    location: c.location ?? undefined,
    customFields: {},
    source: c.source,
    stageId: c.stageId,
    createdAt: c.createdAt.toISOString(),
  };
}

// `normalizeCustomFields` is the canonical `normalizeStringMap` — re-exported
// under the contacts-domain name so existing import sites keep working while
// the implementation lives in exactly one place (see normalize-string-map.ts).
export { normalizeStringMap as normalizeCustomFields } from "@/lib/normalize-string-map";

export function mapConversation(c: PrismaConversation): Conversation {
  return {
    id: c.id,
    teamId: c.teamId,
    contactId: c.contactId,
    assignedUserId: c.assignedUserId,
    status: c.status as ConversationStatus,
    aiEnabled: c.aiEnabled,
    unreadCount: c.unreadCount,
    lastMessageAt: c.lastMessageAt.toISOString(),
    lastMessagePreview: c.lastMessagePreview,
    lastMessageDirection: c.lastMessageDirection,
    // The channel discriminator drives the per-row channel badge and the
    // channel-aware composer. Without it every thread reads as WhatsApp.
    channel: c.channel as Channel,
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
    channel: m.channel as Channel,
    // Coexistence provenance — only surfaced when it's a phone-app send, so the
    // bubble can render "· via WhatsApp app". `api` stays implicit (absent) to
    // keep the wire lean, matching the optional field on the Message type.
    ...(m.origin === "business_app" ? { origin: "business_app" as const } : {}),
    status: m.status as MessageStatus,
    timestamp: m.timestamp.toISOString(),
    // Persisted provider failure reason — only meaningful on a `failed` send,
    // and only set when Meta returned an `errors[0]`. Carried so a refresh
    // surfaces the same diagnostic the live `message:status` socket frame does
    // (the failed-bubble tooltip / muted line).
    ...(m.status === "failed" && m.statusErrorCode != null
      ? { statusErrorCode: m.statusErrorCode }
      : {}),
    ...(m.status === "failed" && m.statusErrorTitle != null
      ? { statusErrorTitle: m.statusErrorTitle }
      : {}),
    ...(m.status === "failed" && m.statusErrorDetail != null
      ? { statusErrorDetail: m.statusErrorDetail }
      : {}),
    // Customer's current emoji reaction (null/absent ⇒ none). Hydrated so a
    // refresh stays consistent with the live `message:reaction` socket frame.
    ...(m.reaction ? { reaction: m.reaction } : {}),
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
            ...(m.mediaVoice ? { voice: true } : {}),
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
          // (or a later page load) fills it in. Two sources have this
          // background-download path: inbound customer media AND Coexistence
          // echoes (a photo the owner sent from the phone app, downloaded like
          // inbound). A regular API-sent outbound uploads its media BEFORE the
          // row exists, so a missing mediaUrl there is a hard failure
          // (caption-only), not pending.
          ...((m.direction === "in" || m.origin === "business_app") && !m.mediaUrl
            ? { mediaPending: true }
            : {}),
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

// Activity-log mapper. The Prisma row joins `user`/`apiKey` for the actor
// name; `before`/`after` are the JSONB payloads the audit subscriber wrote.
// `assignedToName` (for the `assigned` kind) can't be joined off the audit row
// — it stores the assignee's *id* in `after.assignedUserId` — so the caller
// passes a pre-built id→name map (batched in getConversationWithRefs) rather
// than this mapper doing an N+1 lookup.
type PrismaActivityEventRow = {
  id: string;
  conversationId: string;
  kind: ConversationEventKind;
  before: unknown;
  after: unknown;
  at: Date;
  userId: string | null;
  apiKeyId: string | null;
  // Set when a workflow step (not a human/api-key) caused the change. There's
  // no FK to join (denormalized actor style — see the schema note), so the
  // caller batch-resolves the name into `workflowNameById`, mirroring the
  // `assigneeNameById` pattern.
  workflowId: string | null;
  user: { name: string } | null;
  apiKey: { name: string } | null;
};

function asJsonObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function mapActivityEvent(
  e: PrismaActivityEventRow,
  assigneeNameById?: Map<string, string>,
  workflowNameById?: Map<string, string>,
): ConversationActivityEvent {
  // Actor precedence: human user > API key > workflow (automation) > system
  // (retention sweeps / unattributed). These are mutually exclusive in practice
  // — a workflow-driven mutation carries `workflowId` and no userId/apiKeyId —
  // but the precedence keeps the resolution deterministic if a row ever set
  // more than one.
  const actorKind: ActivityActorKind = e.user
    ? "user"
    : e.apiKey
      ? "apiKey"
      : e.workflowId
        ? "workflow"
        : "system";
  const actorName = e.user?.name ?? e.apiKey?.name ?? null;
  // null = workflow since deleted (its `workflowId` row survives, but the name
  // can't be resolved) → the timeline renders the generic "Automation" label.
  const actorWorkflowName: string | null | undefined =
    actorKind === "workflow" && e.workflowId
      ? workflowNameById?.get(e.workflowId) ?? null
      : undefined;

  const after = asJsonObject(e.after);
  let assignedToName: string | null | undefined;
  if (e.kind === "assigned") {
    const toId = after?.assignedUserId;
    assignedToName =
      typeof toId === "string"
        ? assigneeNameById?.get(toId) ?? null
        : null; // explicit null = unassigned
  }

  return {
    id: e.id,
    conversationId: e.conversationId,
    kind: e.kind as ConversationEventKind,
    actorName,
    actorKind,
    before: asJsonObject(e.before),
    after,
    at: e.at.toISOString(),
    ...(assignedToName !== undefined ? { assignedToName } : {}),
    ...(actorWorkflowName !== undefined ? { actorWorkflowName } : {}),
  };
}
