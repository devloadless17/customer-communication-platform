import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { emitToTeam } from "@/lib/socket-server";
import type {
  ConversationStatus,
  InternalNote,
  Message,
  MessageStatus,
  User,
} from "@/lib/types";

/**
 * Dev-only event firehose. Used by the floating DevTools widget to simulate
 * inbound messages, status changes, etc. without needing Evolution paired.
 *
 * 404s in production. NEVER expose this on a deployed instance.
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
  authorUserId: string;
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

export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not Found", { status: 404 });
  }

  const body = (await req.json()) as Body;

  switch (body.kind) {
    case "fake-inbound-message":
      return handleFakeInbound(body);
    case "mark-last-read":
      return handleMarkLastRead(body);
    case "add-fake-note":
      return handleAddNote(body);
    case "toggle-status":
      return handleToggleStatus(body);
    case "assign":
      return handleAssign(body);
    default: {
      const _exhaustive: never = body;
      void _exhaustive;
      return NextResponse.json({ error: "unknown kind" }, { status: 400 });
    }
  }
}

// ---------------------------------------------------------------------------

async function handleFakeInbound({ conversationId, body }: FakeInboundMessageBody) {
  const convo = await db.conversation.findUniqueOrThrow({
    where: { id: conversationId },
  });

  const externalId = `fake_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();

  const created = await db.message.create({
    data: {
      teamId: convo.teamId,
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
  emitToTeam(convo.teamId, "message:new", {
    teamId: convo.teamId,
    conversationId,
    message,
    preview: body,
    lastMessageAt: now.toISOString(),
    unreadDelta: 1,
  });

  return NextResponse.json({ ok: true, messageId: created.id });
}

async function handleMarkLastRead({ conversationId }: MarkLastReadBody) {
  const lastOutbound = await db.message.findFirst({
    where: { conversationId, direction: "out" },
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

  emitToTeam(lastOutbound.teamId, "message:status", {
    teamId: lastOutbound.teamId,
    conversationId,
    messageId: lastOutbound.id,
    status: next,
  });

  return NextResponse.json({ ok: true, status: next });
}

async function handleAddNote({ conversationId, body, authorUserId }: AddNoteBody) {
  const created = await db.internalNote.create({
    data: { conversationId, authorUserId, body },
  });
  const convo = await db.conversation.findUniqueOrThrow({
    where: { id: conversationId },
  });

  const note: InternalNote = {
    id: created.id,
    conversationId: created.conversationId,
    authorUserId: created.authorUserId,
    body: created.body,
    timestamp: created.timestamp.toISOString(),
  };

  emitToTeam(convo.teamId, "note:new", {
    teamId: convo.teamId,
    conversationId,
    note,
  });

  return NextResponse.json({ ok: true, noteId: created.id });
}

async function handleToggleStatus({ conversationId, status }: ToggleStatusBody) {
  const updated = await db.conversation.update({
    where: { id: conversationId },
    data: { status },
  });

  emitToTeam(updated.teamId, "conversation:status", {
    teamId: updated.teamId,
    conversationId,
    status,
  });

  return NextResponse.json({ ok: true });
}

async function handleAssign({ conversationId, assignedUserId }: AssignBody) {
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
      }
    : null;

  emitToTeam(updated.teamId, "conversation:assigned", {
    teamId: updated.teamId,
    conversationId,
    assignedUser,
  });

  return NextResponse.json({ ok: true });
}
