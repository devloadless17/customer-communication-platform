import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { emitToTeam } from "@/lib/socket/server";
import type {
  ConversationStatus,
  InternalNote,
  Message,
  MessageStatus,
  User,
} from "@/lib/types";

/**
 * Dev-only event firehose. Used by the floating DevTools widget to simulate
 * inbound messages, status changes, etc. without going through Meta.
 *
 * Three layers of defence so a single misconfiguration doesn't expose this:
 *   1) `NODE_ENV !== "production"` — refuses prod builds outright.
 *   2) `ENABLE_DEV_TOOLS=1` — opt-in env flag; defaults off even in dev.
 *   3) `requireSession()` + every lookup scoped to `teamId` — even with the
 *      flag on, an unauthenticated caller can't touch anything, and a
 *      logged-in user can't reach into another team.
 */

interface FakeInboundMessageBody {
  kind: "fake-inbound-message";
  conversationId: string;
  body: string;
}

interface MarkLastReadBody {
  kind: "mark-last-read";
  conversationId: string;
}

interface AddNoteBody {
  kind: "add-fake-note";
  conversationId: string;
  body: string;
}

interface ToggleStatusBody {
  kind: "toggle-status";
  conversationId: string;
  status: ConversationStatus;
}

interface AssignBody {
  kind: "assign";
  conversationId: string;
  assignedUserId: string | null;
}

type Body =
  | FakeInboundMessageBody
  | MarkLastReadBody
  | AddNoteBody
  | ToggleStatusBody
  | AssignBody;

function devToolsEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.ENABLE_DEV_TOOLS === "1";
}

export async function POST(req: Request) {
  if (!devToolsEnabled()) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId, userId } = session;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  switch (body.kind) {
    case "fake-inbound-message":
      return handleFakeInbound(body, teamId);
    case "mark-last-read":
      return handleMarkLastRead(body, teamId);
    case "add-fake-note":
      return handleAddNote(body, teamId, userId);
    case "toggle-status":
      return handleToggleStatus(body, teamId);
    case "assign":
      return handleAssign(body, teamId);
    default: {
      const _exhaustive: never = body;
      void _exhaustive;
      return NextResponse.json({ error: "unknown kind" }, { status: 400 });
    }
  }
}

async function loadOwnedConversation(conversationId: string, teamId: string) {
  return db.conversation.findFirst({ where: { id: conversationId, teamId } });
}

// ---------------------------------------------------------------------------

async function handleFakeInbound(
  { conversationId, body }: FakeInboundMessageBody,
  teamId: string,
) {
  const convo = await loadOwnedConversation(conversationId, teamId);
  if (!convo) return NextResponse.json({ error: "conversation not found" }, { status: 404 });

  const externalId = `fake_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();

  const created = await db.message.create({
    data: {
      teamId,
      conversationId,
      externalId,
      direction: "in",
      provider: "meta_cloud",
      status: "delivered",
      body,
      rawPayload: { fake: true, devTools: true },
      timestamp: now,
    },
  });

  await db.conversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: now,
      lastMessagePreview: body,
      unreadCount: { increment: 1 },
    },
  });

  const message: Message = {
    id: created.id,
    teamId: created.teamId,
    conversationId: created.conversationId,
    externalId: created.externalId,
    senderUserId: null,
    body: created.body,
    direction: "in",
    provider: "meta_cloud",
    status: "delivered",
    rawPayload: created.rawPayload as Record<string, unknown>,
    timestamp: created.timestamp.toISOString(),
  };

  // Emit to the team room only. Subscribers in conversation rooms also see
  // it (same socket is in both rooms) and filter by conversationId. Single
  // emit avoids double-fire for clients in both rooms.
  emitToTeam(teamId, "message:new", {
    teamId,
    conversationId,
    message,
    preview: body,
    lastMessageAt: now.toISOString(),
    unreadDelta: 1,
  });

  return NextResponse.json({ ok: true, messageId: created.id });
}

async function handleMarkLastRead({ conversationId }: MarkLastReadBody, teamId: string) {
  const convo = await loadOwnedConversation(conversationId, teamId);
  if (!convo) return NextResponse.json({ error: "conversation not found" }, { status: 404 });

  const lastOutbound = await db.message.findFirst({
    where: { conversationId, teamId, direction: "out" },
    orderBy: { timestamp: "desc" },
  });
  if (!lastOutbound) {
    return NextResponse.json({ error: "no outbound message" }, { status: 404 });
  }
  const next: MessageStatus =
    lastOutbound.status === "sent"
      ? "delivered"
      : lastOutbound.status === "delivered"
        ? "read"
        : "read";

  await db.message.update({
    where: { id: lastOutbound.id },
    data: { status: next },
  });

  emitToTeam(teamId, "message:status", {
    teamId,
    conversationId,
    messageId: lastOutbound.id,
    status: next,
  });

  return NextResponse.json({ ok: true, status: next });
}

async function handleAddNote(
  { conversationId, body }: AddNoteBody,
  teamId: string,
  userId: string,
) {
  const convo = await loadOwnedConversation(conversationId, teamId);
  if (!convo) return NextResponse.json({ error: "conversation not found" }, { status: 404 });

  const created = await db.internalNote.create({
    // Always attribute to the calling user — the request body has no say in this.
    data: { conversationId, authorUserId: userId, body },
  });

  const note: InternalNote = {
    id: created.id,
    conversationId: created.conversationId,
    authorUserId: created.authorUserId,
    body: created.body,
    timestamp: created.timestamp.toISOString(),
  };

  emitToTeam(teamId, "note:new", {
    teamId,
    conversationId,
    note,
  });

  return NextResponse.json({ ok: true, noteId: created.id });
}

async function handleToggleStatus(
  { conversationId, status }: ToggleStatusBody,
  teamId: string,
) {
  const convo = await loadOwnedConversation(conversationId, teamId);
  if (!convo) return NextResponse.json({ error: "conversation not found" }, { status: 404 });

  await db.conversation.update({
    where: { id: conversationId },
    data: { status },
  });

  emitToTeam(teamId, "conversation:status", {
    teamId,
    conversationId,
    status,
  });

  return NextResponse.json({ ok: true });
}

async function handleAssign(
  { conversationId, assignedUserId }: AssignBody,
  teamId: string,
) {
  const convo = await loadOwnedConversation(conversationId, teamId);
  if (!convo) return NextResponse.json({ error: "conversation not found" }, { status: 404 });

  // Don't let a dev-tools call assign across teams either.
  if (assignedUserId) {
    const assignee = await db.user.findFirst({
      where: { id: assignedUserId, teamId },
      select: { id: true },
    });
    if (!assignee) return NextResponse.json({ error: "assignee not in team" }, { status: 400 });
  }

  const updated = await db.conversation.update({
    where: { id: conversationId },
    data: { assignedUserId },
    include: { assignedUser: true },
  });

  const assignedUser: User | null = updated.assignedUser
    ? {
        id: updated.assignedUser.id,
        teamId: updated.assignedUser.teamId,
        role: updated.assignedUser.role,
        name: updated.assignedUser.name,
        email: updated.assignedUser.email,
        avatarUrl: updated.assignedUser.avatarUrl ?? undefined,
        isActive: updated.assignedUser.deactivatedAt === null,
      }
    : null;

  emitToTeam(teamId, "conversation:assigned", {
    teamId,
    conversationId,
    assignedUser,
  });

  return NextResponse.json({ ok: true });
}
