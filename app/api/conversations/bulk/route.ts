import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { blobStorage } from "@/lib/blob-storage";
import { emitToTeam } from "@/lib/socket/server";

/**
 * Bulk delete conversations.
 *
 *   POST body: { conversationIds: string[] }
 *
 * Schema cascades wipe the message + note rows; we gather blob keys first
 * and best-effort delete them after the commit. The contact rows stay —
 * deleting a conversation deletes the THREAD, not the person.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;

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
        where: { mediaKey: { not: null } },
        select: { mediaKey: true },
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
  const mediaKeys = owned
    .flatMap((c) => c.messages)
    .map((m) => m.mediaKey)
    .filter((k): k is string => Boolean(k));

  await db.conversation.deleteMany({
    where: { teamId, id: { in: ownedIds } },
  });

  if (mediaKeys.length > 0) {
    await blobStorage.delete(mediaKeys);
  }

  for (const cid of ownedIds) {
    emitToTeam(teamId, "conversation:deleted", { teamId, conversationId: cid });
  }

  return NextResponse.json({ ok: true, count: ownedIds.length });
}
