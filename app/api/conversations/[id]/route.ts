import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { deleteMedia } from "@/lib/media-storage";
import { emitToTeam } from "@/lib/socket-server";

/**
 * Delete a single conversation. Schema cascades take care of Message +
 * InternalNote rows; we collect any disk-backed media first and best-effort
 * unlink after the commit (same pattern as contact delete).
 *
 * Meta-side note: this only removes the thread from OUR inbox. Outbound
 * messages stay delivered on the customer's WhatsApp — there's no
 * unsend-from-Meta API. The contact row itself is preserved.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;
  const { id: conversationId } = await ctx.params;

  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, teamId },
    select: {
      id: true,
      messages: {
        where: { mediaPath: { not: null } },
        select: { mediaPath: true },
      },
    },
  });
  if (!conversation) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }

  const mediaPaths = conversation.messages
    .map((m) => m.mediaPath)
    .filter((p): p is string => Boolean(p));

  await db.conversation.delete({ where: { id: conversationId } });

  for (const p of mediaPaths) {
    try {
      await deleteMedia(p);
    } catch (err) {
      console.warn(`[api/conversations DELETE] media cleanup failed for ${p}`, err);
    }
  }

  // Tell every connected agent the thread is gone so their inbox list
  // splices the row out without a refetch.
  emitToTeam(teamId, "conversation:deleted", {
    teamId,
    conversationId,
  });

  return NextResponse.json({ ok: true });
}
