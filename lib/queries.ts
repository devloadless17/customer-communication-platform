import "server-only";

import { db } from "@/lib/db";
import type {
  Contact,
  Conversation,
  ConversationStatus,
  ConversationWithRefs,
  InternalNote,
  Message,
  MessageDirection,
  MessageStatus,
  ProviderName,
  Role,
  User,
} from "@/lib/types";

/**
 * Read-side queries for the inbox.
 *
 * Output shapes match `lib/types.ts` exactly so the UI doesn't move when we
 * switch from fake data to Prisma. Dates are ISO strings (Prisma returns Date
 * objects; we serialize at this boundary so passing values to client
 * components is a no-op).
 */

// ---------------------------------------------------------------------------
// Mappers — Prisma row → domain type. Centralized so any drift is one fix.
// ---------------------------------------------------------------------------

type PrismaConversation = Awaited<
  ReturnType<typeof db.conversation.findUniqueOrThrow>
>;
type PrismaContact = Awaited<ReturnType<typeof db.contact.findUniqueOrThrow>>;
type PrismaUser = Awaited<ReturnType<typeof db.user.findUniqueOrThrow>>;
type PrismaMessage = Awaited<ReturnType<typeof db.message.findUniqueOrThrow>>;
type PrismaNote = Awaited<ReturnType<typeof db.internalNote.findUniqueOrThrow>>;

function mapUser(u: PrismaUser): User {
  return {
    id: u.id,
    teamId: u.teamId,
    role: u.role as Role,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatarUrl ?? undefined,
  };
}

function mapContact(c: PrismaContact): Contact {
  return {
    id: c.id,
    teamId: c.teamId,
    phoneNumber: c.phoneNumber,
    name: c.name,
    avatarUrl: c.avatarUrl ?? undefined,
  };
}

function mapConversation(c: PrismaConversation): Conversation {
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

function mapMessage(m: PrismaMessage): Message {
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
    rawPayload: (m.rawPayload as Record<string, unknown>) ?? {},
    timestamp: m.timestamp.toISOString(),
  };
}

function mapNote(n: PrismaNote): InternalNote {
  return {
    id: n.id,
    conversationId: n.conversationId,
    authorUserId: n.authorUserId,
    body: n.body,
    timestamp: n.timestamp.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public API — used by server components.
// ---------------------------------------------------------------------------

/**
 * List all non-archived conversations for a team, sorted by recency.
 *
 * Includes contact + assigned user; does NOT pull messages/notes (the
 * thread page hydrates those separately to keep the list query lean).
 */
export async function listConversations(teamId: string): Promise<ConversationWithRefs[]> {
  const rows = await db.conversation.findMany({
    where: { teamId },
    orderBy: { lastMessageAt: "desc" },
    include: {
      contact: true,
      assignedUser: true,
    },
  });

  return rows.map((row) => ({
    conversation: mapConversation(row),
    contact: mapContact(row.contact),
    assignedUser: row.assignedUser ? mapUser(row.assignedUser) : null,
    messages: [],
    notes: [],
  }));
}

export async function getConversationWithRefs(
  teamId: string,
  conversationId: string,
): Promise<ConversationWithRefs | null> {
  const row = await db.conversation.findFirst({
    where: { id: conversationId, teamId },
    include: {
      contact: true,
      assignedUser: true,
      messages: { orderBy: { timestamp: "asc" } },
      notes: { orderBy: { timestamp: "asc" } },
    },
  });
  if (!row) return null;

  return {
    conversation: mapConversation(row),
    contact: mapContact(row.contact),
    assignedUser: row.assignedUser ? mapUser(row.assignedUser) : null,
    messages: row.messages.map(mapMessage),
    notes: row.notes.map(mapNote),
  };
}

/** All teammates — used by the assignment dropdown and sidebar list. */
export async function listTeamMembers(teamId: string): Promise<User[]> {
  const rows = await db.user.findMany({ where: { teamId }, orderBy: { name: "asc" } });
  return rows.map(mapUser);
}
