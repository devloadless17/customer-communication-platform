import { NextResponse } from "next/server";

import { getSession } from "@/lib/current-user";
import { db } from "@/lib/db";
import { deleteMedia } from "@/lib/media-storage";
import { emitToTeam } from "@/lib/socket-server";

/**
 * Bulk delete conversations.
 *
 *   POST body: { conversationIds: string[] }
 *
 * Schema cascades wipe the message + note rows; we gather media paths first
 * and best-effort unlink them after the commit. The contact rows stay —
 * deleting a conversation deletes the THREAD, not the person.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { teamId } = await getSession();

  let raw: { conversationIds?: unknown };
  try {
    raw = (await req.json()) as typeof raw;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const requestedIds = Array.isArray(raw.conversationIds)
    ? raw.conversationIds.filter((x): x is string => typeof x === "string")
    : [];
  if (requestedIds.length === 0) {
    return NextResponse.json({ error: "conversationIds required" }, { status: 400 });
  }

  const owned = await db.conversation.findMany({
    where: { teamId, id: { in: requestedIds } },
    select: {
      id: true,
      messages: {
        where: { mediaPath: { not: null } },
        select: { mediaPath: true },
      },
    },
  });
  if (owned.length === 0) {
    return NextResponse.json(
      { error: "no matching conversations in this team" },
      { status: 404 },
    );
  }

  const ownedIds = owned.map((c) => c.id);
  const mediaPaths = owned
    .flatMap((c) => c.messages)
    .map((m) => m.mediaPath)
    .filter((p): p is string => Boolean(p));

  await db.conversation.deleteMany({
    where: { teamId, id: { in: ownedIds } },
  });

  for (const p of mediaPaths) {
    try {
      await deleteMedia(p);
    } catch (err) {
      console.warn(`[api/conversations/bulk] media cleanup failed for ${p}`, err);
    }
  }

  for (const cid of ownedIds) {
    emitToTeam(teamId, "conversation:deleted", { teamId, conversationId: cid });
  }

  return NextResponse.json({ ok: true, count: ownedIds.length });
}
