import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
import { emitToTeam } from "@/lib/socket/server";

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
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { userId, teamId } = session;
  const { id: conversationId } = await ctx.params;

  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, teamId },
    select: { id: true, unreadCount: true, lastMessageAt: true },
  });
  if (!conversation) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }

  // Per-agent read receipt: stamp the lastMessageAt we just saw so the
  // sidebar's "unread for me" badge computes against the agent's own
  // baseline, not a team-wide counter that any teammate can zero out.
  // Idempotent — upsert ensures repeated reads of the same thread don't
  // create new rows, just refresh the timestamp.
  await db.conversationReadReceipt.upsert({
    where: { userId_conversationId: { userId, conversationId } },
    create: { userId, conversationId, lastReadAt: conversation.lastMessageAt },
    update: { lastReadAt: conversation.lastMessageAt },
  });

  // Always look up the latest inbound, even when local unread is already 0 —
  // a teammate may have local-marked-read without ever notifying Meta. We
  // skip the provider call only when there's no inbound at all.
  const latestInbound = await db.message.findFirst({
    where: { conversationId, direction: "in" },
    orderBy: { timestamp: "desc" },
    select: { externalId: true, provider: true },
  });

  if (conversation.unreadCount > 0) {
    // CAS on the observed unreadCount. The race we're guarding:
    //   T0  agent clicks read → we read unread = 2
    //   T1  inbound webhook lands → ingest does increment(1) → unread = 3
    //   T2  unconditional `set 0` would clobber the new message's bump
    // With WHERE unreadCount = observed, the bump invalidates the predicate
    // and updateMany matches 0 rows; we skip the emit and let the next
    // `message:new` event re-sync the badge to the real count.
    const result = await db.conversation.updateMany({
      where: {
        id: conversationId,
        teamId,
        unreadCount: conversation.unreadCount,
      },
      data: { unreadCount: 0 },
    });

    if (result.count > 0) {
      emitToTeam(teamId, "conversation:read", {
        teamId,
        conversationId,
        readByUserId: userId,
      });
    }
  }

  // Fire-and-forget the provider ack so the customer's WhatsApp lights up
  // blue ticks. Errors are logged inside the provider, never bubbled.
  // We also swallow ProviderNotConfigured here — a team that hasn't connected
  // WhatsApp yet can't have inbound messages anyway, and we don't want a
  // stale row from a disconnected number to break the read flow.
  if (latestInbound && latestInbound.provider === "meta_cloud") {
    void (async () => {
      try {
        const config = await getMetaSendConfig(teamId);
        await getMetaProvider().markIncomingRead?.(latestInbound.externalId, config);
      } catch (err) {
        if (err instanceof ProviderNotConfiguredError) return;
        console.warn("[api/conversations/read] mark-read failed", err);
      }
    })();
  }

  return NextResponse.json({ ok: true });
}
