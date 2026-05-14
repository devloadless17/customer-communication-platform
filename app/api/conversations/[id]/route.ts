import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { blobStorage } from "@/lib/blob-storage";
import { emitToTeam } from "@/lib/socket/server";

/**
 * Delete a single conversation. Schema cascades take care of Message +
 * InternalNote rows; we collect any blob-stored media keys first and
 * best-effort delete after the commit (same pattern as contact delete).
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
        where: { mediaKey: { not: null } },
        select: { mediaKey: true },
      },
    },
  });
  if (!conversation) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }

  const mediaKeys = conversation.messages
    .map((m) => m.mediaKey)
    .filter((k): k is string => Boolean(k));

  await db.conversation.delete({ where: { id: conversationId } });

  // Batched delete — UploadThing accepts an array; saves a round trip per
  // file. blobStorage.delete is idempotent and swallows individual errors.
  if (mediaKeys.length > 0) {
    await blobStorage.delete(mediaKeys);
  }

  // Tell every connected agent the thread is gone so their inbox list
  // splices the row out without a refetch.
  emitToTeam(teamId, "conversation:deleted", {
    teamId,
    conversationId,
  });

  return NextResponse.json({ ok: true });
}
