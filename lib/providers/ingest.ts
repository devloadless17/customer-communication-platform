import "server-only";

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
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
  Message,
  ProviderName,
} from "@/lib/types";

/**
 * Provider-agnostic ingest pipeline.
 *
 *   normalized event → dedupe → upsert contact/conversation → create message
 *                    → bump conversation summary → emit `message:new`
 *
 * One entry point per route. Routes never touch the DB or Socket.io directly.
 */

export async function ingestEvents(
  provider: ProviderName,
  events: NormalizedEvent[],
): Promise<void> {
  if (events.length === 0) return;

  const teamId = await getDefaultTeamId();
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

  const contact = await db.contact.upsert({
    where: { teamId_phoneNumber: { teamId, phoneNumber: evt.contactPhone } },
    create: {
      teamId,
      phoneNumber: evt.contactPhone,
      name: evt.contactName ?? evt.contactPhone,
    },
    update: {
      // Refresh display name only when we previously had nothing useful.
      ...(evt.contactName ? { name: evt.contactName } : {}),
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
      status: "open",
      lastMessageAt: evt.timestamp,
      lastMessagePreview: "",
    },
  }));

  const preview = evt.body.slice(0, 200);

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
    rawPayload: evt.rawPayload,
    timestamp: evt.timestamp.toISOString(),
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
}): Contact {
  return {
    id: c.id,
    teamId: c.teamId,
    phoneNumber: c.phoneNumber,
    name: c.name,
    avatarUrl: c.avatarUrl ?? undefined,
  };
}

/**
 * MVP single-tenant routing. Phase 2 will key off the provider's instance
 * identifier (Evolution `instance` / Meta `phone_number_id`) to pick a team.
 */
async function getDefaultTeamId(): Promise<string> {
  const team = await db.team.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!team) {
    throw new Error("No team in DB. Seed at least one team before accepting webhooks.");
  }
  return team.id;
}
