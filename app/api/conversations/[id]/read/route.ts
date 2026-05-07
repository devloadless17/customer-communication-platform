import { NextResponse } from "next/server";

import { getSession } from "@/lib/current-user";
import { db } from "@/lib/db";
import { getProvider } from "@/lib/providers";
import { emitToTeam } from "@/lib/socket-server";

/**
 * Mark a conversation as read for the team — zeros the team-wide unread
 * counter, broadcasts `conversation:read` so every connected client clears
 * the badge, AND tells the underlying provider to mark inbound as read so
 * the customer sees blue ticks on their WhatsApp.
 *
 * Provider call is best-effort: a Meta failure (expired wamid, network)
 * must not block the local read state.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { user, teamId } = await getSession();
  const { id: conversationId } = await ctx.params;

  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, teamId },
    select: { id: true, unreadCount: true },
  });
  if (!conversation) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }

  // Always look up the latest inbound, even when local unread is already 0 —
  // a teammate may have local-marked-read without ever notifying Meta. We
  // skip the provider call only when there's no inbound at all.
  const latestInbound = await db.message.findFirst({
    where: { conversationId, direction: "in" },
    orderBy: { timestamp: "desc" },
    select: { externalId: true, provider: true },
  });

  if (conversation.unreadCount > 0) {
    await db.conversation.update({
      where: { id: conversationId },
      data: { unreadCount: 0 },
    });

    emitToTeam(teamId, "conversation:read", {
      teamId,
      conversationId,
      readByUserId: user.id,
    });
  }

  // Fire-and-forget the provider ack so the customer's WhatsApp lights up
  // blue ticks. Errors are logged inside the provider, never bubbled.
  if (latestInbound) {
    const provider = getProvider(latestInbound.provider);
    if (provider.markIncomingRead) {
      void provider.markIncomingRead(latestInbound.externalId);
    }
  }

  return NextResponse.json({ ok: true });
}
