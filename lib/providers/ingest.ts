import "server-only";

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { ensureDefaultStage } from "@/lib/queries";
import { dispatch } from "@/lib/automations/dispatcher";
import type {
  AutomationContactSnapshot,
  AutomationConversationSnapshot,
  AutomationMessageSnapshot,
} from "@/lib/automations/events";
import type {
  NormalizedEvent,
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
} from "@/lib/providers/types";
import { emitToTeam } from "@/lib/socket-server";
import type {
  Contact,
  Conversation,
  ConversationStatus,
  ConversationWithRefs,
  MediaKind,
  Message,
  ProviderName,
  ReplySnapshot,
} from "@/lib/types";

/**
 * Provider-agnostic ingest pipeline.
 *
 *   normalized event → dedupe → upsert contact/conversation → create message
 *                    → bump conversation summary → emit `message:new`
 *
 * One entry point per route. Routes never touch the DB or Socket.io directly.
 *
 * `teamId` is resolved by the caller (the per-team webhook URL contains it,
 * so the route trusts it). Status updates ignore teamId — they look up the
 * existing message row by externalId, which already carries its own team.
 */

export async function ingestEvents(
  teamId: string,
  provider: ProviderName,
  events: NormalizedEvent[],
): Promise<void> {
  if (events.length === 0) return;

  for (const evt of events) {
    if (evt.kind === "message") {
      await ingestInboundMessage(teamId, provider, evt);
    } else {
      await ingestStatusUpdate(evt);
    }
  }
}

async function ingestStatusUpdate(evt: NormalizedStatusUpdate): Promise<void> {
  const existing = await db.message.findUnique({
    where: { externalId: evt.externalId },
    select: { id: true, teamId: true, conversationId: true, status: true },
  });
  // Status arriving for an unknown message is normal during dev (e.g. you
  // wiped the DB but Meta still has the wamid). Drop silently.
  if (!existing) return;

  // Don't downgrade — Meta sometimes delivers `sent` after `delivered`/`read`
  // due to per-recipient-device fan-out.
  if (statusRank(evt.status) <= statusRank(existing.status as Message["status"])) {
    return;
  }

  await db.message.update({
    where: { id: existing.id },
    data: { status: evt.status },
  });

  emitToTeam(existing.teamId, "message:status", {
    teamId: existing.teamId,
    conversationId: existing.conversationId,
    messageId: existing.id,
    status: evt.status,
  });
}

/** Conversation-list preview text for media-only messages (no caption). */
export function mediaPreview(kind: import("@/lib/types").MediaKind | undefined): string {
  switch (kind) {
    case "image":
      return "📷 Photo";
    case "video":
      return "🎥 Video";
    case "audio":
      return "🎤 Voice message";
    case "document":
      return "📄 Document";
    case "sticker":
      return "🌟 Sticker";
    default:
      return "";
  }
}

function statusRank(s: Message["status"]): number {
  switch (s) {
    case "failed":
      return -1;
    case "sent":
      return 0;
    case "delivered":
      return 1;
    case "read":
      return 2;
  }
}

async function ingestInboundMessage(
  teamId: string,
  provider: ProviderName,
  evt: NormalizedInboundMessage,
): Promise<void> {
  // Rule #3 dedupe gate. Cheap pre-check; the unique index on externalId is
  // the actual race guard via the P2002 catch below.
  const existing = await db.message.findUnique({
    where: { externalId: evt.externalId },
    select: { id: true },
  });
  if (existing) return;

  // Resolve the quoted-reply target (if any). We only set the FK when the
  // original lives in OUR DB — Meta sometimes references messages older than
  // our subscription (no history sync, CLAUDE.md), in which case the reply
  // arrives without a quote anchor and we just drop the link.
  let replySnapshot: ReplySnapshot | null = null;
  if (evt.replyToExternalId) {
    replySnapshot = await loadReplySnapshotByExternalId(evt.replyToExternalId);
  }

  // Name policy: set on CREATE, sticky after.
  //
  // We used to refresh the name from Meta's wa profile on every inbound, but
  // that clobbered names an agent had typed in manually ("Ahmad" got
  // overwritten by the customer's WhatsApp display name "احمد م." or
  // similar). The right semantic for a CRM-style inbox is: the agent owns
  // the contact name; if Meta sends a profile name on first contact we use
  // it as a sensible default, but subsequent profile changes don't override.
  // Resolved on every inbound — the helper short-circuits to a cheap
  // findFirst when a default already exists, so the cost is one indexed
  // lookup. We pass it as the `create` stageId so brand-new contacts land
  // in the team's default; existing rows pass through `update` (empty) and
  // keep whatever stage they're already in.
  const defaultStageId = await ensureDefaultStage(teamId);

  const contact = await db.contact.upsert({
    where: { teamId_phoneNumber: { teamId, phoneNumber: evt.contactPhone } },
    create: {
      teamId,
      phoneNumber: evt.contactPhone,
      name: evt.contactName ?? evt.contactPhone,
      stageId: defaultStageId,
    },
    update: {
      // Intentionally empty: do NOT touch the name OR the stage. The agent's
      // manually entered name (or the first-contact profile name) stays put,
      // and a contact who progressed past the default stage isn't pulled
      // back to it just because they sent another message.
    },
  });

  // Reuse the most recent non-closed conversation; otherwise open a new one.
  // Closed threads stay closed — a fresh inbound is treated as a new ticket.
  const openConvo = await db.conversation.findFirst({
    where: { teamId, contactId: contact.id, status: { not: "closed" } },
    orderBy: { lastMessageAt: "desc" },
  });
  const isNewConversation = !openConvo;
  const conversation = openConvo ?? (await db.conversation.create({
    data: {
      teamId,
      contactId: contact.id,
      // New chats land in `pending` so they sit in the triage column until
      // an agent claims them (→ open) or closes them out. Re-using an
      // existing non-closed conversation keeps that conversation's current
      // status (the `openConvo` branch above).
      status: "pending",
      lastMessageAt: evt.timestamp,
      lastMessagePreview: "",
    },
  }));

  const preview = (evt.body.trim() || mediaPreview(evt.media?.kind)).slice(0, 200);

  let createdId: string;
  try {
    const created = await db.message.create({
      data: {
        teamId,
        conversationId: conversation.id,
        externalId: evt.externalId,
        senderUserId: null,
        body: evt.body,
        direction: "in",
        provider,
        status: "delivered",
        rawPayload: evt.rawPayload as Prisma.InputJsonValue,
        timestamp: evt.timestamp,
        ...(replySnapshot ? { replyToMessageId: replySnapshot.id } : {}),
        ...(evt.media && evt.media.storageKey && evt.media.storageUrl
          ? {
              mediaKind: evt.media.kind,
              mediaKey: evt.media.storageKey,
              mediaUrl: evt.media.storageUrl,
              mediaMimeType: evt.media.mimeType,
              mediaCaption: evt.body || null,
              mediaFilename: evt.media.filename ?? null,
              mediaSizeBytes: evt.media.sizeBytes ?? null,
              mediaDurationMs: evt.media.durationMs ?? null,
            }
          : {}),
      },
    });
    createdId = created.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Race: another worker won the insert. Drop without side effects.
      return;
    }
    throw err;
  }

  await db.conversation.update({
    where: { id: conversation.id },
    data: {
      lastMessageAt: evt.timestamp,
      lastMessagePreview: preview,
      unreadCount: { increment: 1 },
    },
  });

  const message: Message = {
    id: createdId,
    teamId,
    conversationId: conversation.id,
    externalId: evt.externalId,
    senderUserId: null,
    body: evt.body,
    direction: "in",
    provider,
    status: "delivered",
    // raw_payload stays in the DB row (created above) but is deliberately
    // left off the socket payload — no client needs the verbatim Meta body.
    timestamp: evt.timestamp.toISOString(),
    ...(replySnapshot
      ? { replyToMessageId: replySnapshot.id, replyTo: replySnapshot }
      : {}),
    ...(evt.media && evt.media.storageKey && evt.media.storageUrl
      ? {
          media: {
            kind: evt.media.kind,
            // Still served through our route so the team-ownership check
            // runs before the 302 to the CDN.
            url: `/api/media/${createdId}`,
            mimeType: evt.media.mimeType,
            sizeBytes: evt.media.sizeBytes ?? 0,
            ...(evt.body ? { caption: evt.body } : {}),
            ...(evt.media.filename ? { filename: evt.media.filename } : {}),
            ...(evt.media.durationMs != null ? { durationMs: evt.media.durationMs } : {}),
          },
        }
      : {}),
  };

  // Build the ConversationWithRefs payload only when the convo is brand-new,
  // so clients that don't yet have it can splice the row in without refetch.
  const newConversation: ConversationWithRefs | undefined = isNewConversation
    ? {
        conversation: toDomainConversation({
          ...conversation,
          lastMessageAt: evt.timestamp,
          lastMessagePreview: preview,
          unreadCount: 1,
        }),
        contact: toDomainContact(contact),
        assignedUser: null,
        messages: [],
        notes: [],
        // The webhook event we're processing IS an inbound, so the 24h
        // window opens right now.
        lastInboundAt: evt.timestamp.toISOString(),
      }
    : undefined;

  emitToTeam(teamId, "message:new", {
    teamId,
    conversationId: conversation.id,
    message,
    preview,
    lastMessageAt: evt.timestamp.toISOString(),
    unreadDelta: 1,
    ...(newConversation ? { newConversation } : {}),
  });

  // Fire automations. Awaited but the dispatcher is fast (one indexed query
  // + sync condition eval + enqueue); actual webhook delivery happens in the
  // BullMQ worker so a slow n8n endpoint can't delay Meta's 200 here. Dispatch
  // never throws — failures are logged and swallowed.
  await dispatch(teamId, "message_received", {
    message: toAutomationMessage({
      id: createdId,
      conversationId: conversation.id,
      externalId: evt.externalId,
      senderUserId: null,
      body: evt.body,
      direction: "in",
      mediaKind: evt.media?.kind ?? null,
      mediaCaption: evt.media && evt.body ? evt.body : null,
      timestamp: evt.timestamp,
    }),
    conversation: toAutomationConversation({
      ...conversation,
      lastMessageAt: evt.timestamp,
      unreadCount: (conversation.unreadCount ?? 0) + 1,
    }),
    contact: toAutomationContact(contact),
    recentMessages: await loadRecentForAutomation(conversation.id, createdId),
  });
}

// ---------------------------------------------------------------------------
// Automation payload mappers — kept local. Each maps a DB-shaped object to
// the trimmed snapshot the automations subsystem consumes. Three mappers, no
// hidden behavior — fine to copy here vs. building a shared utility.
// ---------------------------------------------------------------------------

function toAutomationMessage(m: {
  id: string;
  conversationId: string;
  externalId: string;
  direction: "in" | "out";
  body: string;
  mediaKind: import("@/lib/types").MediaKind | null;
  mediaCaption: string | null;
  timestamp: Date;
  senderUserId: string | null;
}): AutomationMessageSnapshot {
  return {
    id: m.id,
    conversationId: m.conversationId,
    externalId: m.externalId,
    direction: m.direction,
    body: m.body,
    mediaKind: m.mediaKind,
    mediaCaption: m.mediaCaption,
    timestamp: m.timestamp.toISOString(),
    senderUserId: m.senderUserId,
  };
}

function toAutomationConversation(c: {
  id: string;
  status: string;
  assignedUserId: string | null;
  unreadCount: number;
  lastMessageAt: Date;
}): AutomationConversationSnapshot {
  return {
    id: c.id,
    status: c.status as AutomationConversationSnapshot["status"],
    assignedUserId: c.assignedUserId,
    unreadCount: c.unreadCount,
    lastMessageAt: c.lastMessageAt.toISOString(),
  };
}

function toAutomationContact(c: {
  id: string;
  phoneNumber: string;
  name: string;
  email?: string | null;
  customFields?: unknown;
}): AutomationContactSnapshot {
  return {
    id: c.id,
    phoneNumber: c.phoneNumber,
    name: c.name,
    email: c.email ?? null,
    customFields: normalizeCustomFields(c.customFields),
  };
}

/** Pull the most recent N messages on the conversation, excluding the trigger
 *  message itself. Surfaced in MessageReceivedPayload.recentMessages so a
 *  downstream AI flow has short-term context without a callback. */
async function loadRecentForAutomation(
  conversationId: string,
  excludeMessageId: string,
): Promise<AutomationMessageSnapshot[]> {
  const rows = await db.message.findMany({
    where: { conversationId, NOT: { id: excludeMessageId } },
    orderBy: { timestamp: "desc" },
    take: 10,
    select: {
      id: true,
      conversationId: true,
      externalId: true,
      direction: true,
      body: true,
      mediaKind: true,
      mediaCaption: true,
      timestamp: true,
      senderUserId: true,
    },
  });
  return rows
    .map((r) => toAutomationMessage({
      id: r.id,
      conversationId: r.conversationId,
      externalId: r.externalId,
      direction: r.direction as "in" | "out",
      body: r.body,
      mediaKind: r.mediaKind as import("@/lib/types").MediaKind | null,
      mediaCaption: r.mediaCaption,
      timestamp: r.timestamp,
      senderUserId: r.senderUserId,
    }))
    .reverse(); // newest last
}

// ---------------------------------------------------------------------------
// Local mappers — duplicated from lib/queries.ts on purpose. queries.ts is
// `server-only` and concerned with read paths; ingest is also server-only,
// but pulling that import would couple two modules that should evolve
// independently. Three lines each, no risk of drift.
// ---------------------------------------------------------------------------

function toDomainConversation(c: {
  id: string;
  teamId: string;
  contactId: string;
  assignedUserId: string | null;
  status: string;
  unreadCount: number;
  lastMessageAt: Date;
  lastMessagePreview: string;
}): Conversation {
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

function toDomainContact(c: {
  id: string;
  teamId: string;
  phoneNumber: string;
  name: string;
  avatarUrl: string | null;
  email?: string | null;
  location?: string | null;
  customFields?: unknown;
  source?: "inbound" | "manual";
}): Contact {
  return {
    id: c.id,
    teamId: c.teamId,
    phoneNumber: c.phoneNumber,
    name: c.name,
    avatarUrl: c.avatarUrl ?? undefined,
    email: c.email ?? undefined,
    location: c.location ?? undefined,
    customFields: normalizeCustomFields(c.customFields),
    // Webhook-driven contacts default to 'inbound' on the schema; the row
    // we read back may not always include it (legacy callers), so treat
    // missing as inbound.
    source: c.source ?? "inbound",
  };
}

function normalizeCustomFields(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Build a ReplySnapshot from the original message (looked up by externalId or
 * id). Used by ingest (inbound replies, externalId lookup) and the outbound
 * routes (where the caller already has the local id).
 */
export async function loadReplySnapshotByExternalId(
  externalId: string,
): Promise<ReplySnapshot | null> {
  const row = await db.message.findUnique({
    where: { externalId },
    select: replySnapshotSelect,
  });
  return row ? toReplySnapshot(row) : null;
}

export async function loadReplySnapshotById(
  id: string,
): Promise<ReplySnapshot | null> {
  const row = await db.message.findUnique({
    where: { id },
    select: replySnapshotSelect,
  });
  return row ? toReplySnapshot(row) : null;
}

const replySnapshotSelect = {
  id: true,
  body: true,
  direction: true,
  mediaKind: true,
  sender: { select: { name: true } },
} as const;

function toReplySnapshot(row: {
  id: string;
  body: string;
  direction: string;
  mediaKind: string | null;
  sender: { name: string } | null;
}): ReplySnapshot {
  return {
    id: row.id,
    // Truncate so a giant pasted body doesn't bloat every reply emission.
    body: row.body.slice(0, 200),
    direction: row.direction as ReplySnapshot["direction"],
    senderName: row.sender?.name ?? null,
    ...(row.mediaKind ? { mediaKind: row.mediaKind as MediaKind } : {}),
  };
}

