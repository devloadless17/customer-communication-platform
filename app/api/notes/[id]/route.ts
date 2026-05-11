import { NextResponse } from "next/server";

import { getSession } from "@/lib/current-user";
import { db } from "@/lib/db";
import { emitToTeam } from "@/lib/socket-server";

/**
 * Delete an internal note. Team-scoped — confirm the parent conversation
 * belongs to the caller's team before nuking the row. Anyone on the team
 * can delete any note (matches the "any agent can edit anyone's contact"
 * permission model in CLAUDE.md for the pilot's trust level).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { teamId } = await getSession();
  const { id } = await ctx.params;

  const note = await db.internalNote.findFirst({
    where: { id, conversation: { teamId } },
    select: { id: true, conversationId: true },
  });
  if (!note) {
    return NextResponse.json({ error: "note not found" }, { status: 404 });
  }

  await db.internalNote.delete({ where: { id } });

  emitToTeam(teamId, "note:deleted", {
    teamId,
    conversationId: note.conversationId,
    noteId: id,
  });

  return NextResponse.json({ ok: true });
}
