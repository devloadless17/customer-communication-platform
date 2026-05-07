import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { getSession } from "@/lib/current-user";
import { db } from "@/lib/db";
import { getProvider } from "@/lib/providers";
import { MetaSendError } from "@/lib/providers/meta";
import { emitToTeam } from "@/lib/socket-server";
import type { Message } from "@/lib/types";

/**
 * Outbound message endpoint.
 *
 * Body: `{ conversationId, body }`. Looks up the conversation, calls
 * Meta's sendText, persists the row, and emits `message:new`.
 *
 * Provider failures bubble up as 4xx so the agent sees the real error
 * (24h-window, template required, etc.) — silently swallowing them would
 * be the worst possible UX.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  conversationId?: unknown;
  body?: unknown;
}

export async function POST(req: Request) {
  const { user, teamId } = await getSession();

  let raw: Body;
  try {
    raw = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const conversationId = typeof raw.conversationId === "string" ? raw.conversationId : null;
  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  if (!conversationId || !body) {
    return NextResponse.json({ error: "conversationId and body required" }, { status: 400 });
  }

  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, teamId },
    include: { contact: true },
  });
  if (!conversation) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }

  const messagingProvider = getProvider("meta_cloud");

  let send;
  try {
    send = await messagingProvider.sendText({
      to: conversation.contact.phoneNumber,
      body,
    });
  } catch (err) {
    if (err instanceof MetaSendError) {
      // Pass Meta's error code/body through verbatim — the agent needs it.
      return NextResponse.json(
        { error: "provider rejected send", status: err.httpStatus, detail: err.body },
        { status: 422 },
      );
    }
    console.error("[api/messages] sendText failed", err);
    return NextResponse.json(
      { error: "send failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const created = await db.message.create({
    data: {
      teamId,
      conversationId,
      externalId: send.externalId,
      senderUserId: user.id,
      body,
      direction: "out",
      provider: "meta_cloud",
      status: "sent",
      rawPayload: { sentVia: "api/messages" } as Prisma.InputJsonValue,
      timestamp: send.timestamp,
    },
  });

  const preview = body.slice(0, 200);
  await db.conversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: send.timestamp,
      lastMessagePreview: preview,
      // Outbound doesn't bump unread.
    },
  });

  const message: Message = {
    id: created.id,
    teamId,
    conversationId,
    externalId: send.externalId,
    senderUserId: user.id,
    body,
    direction: "out",
    provider: "meta_cloud",
    status: "sent",
    rawPayload: { sentVia: "api/messages" },
    timestamp: send.timestamp.toISOString(),
  };

  emitToTeam(teamId, "message:new", {
    teamId,
    conversationId,
    message,
    preview,
    lastMessageAt: send.timestamp.toISOString(),
    unreadDelta: 0,
  });

  return NextResponse.json({ ok: true, messageId: created.id });
}
