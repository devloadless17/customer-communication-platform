import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { emitToTeam } from "@/lib/socket/server";

/**
 * POST /api/team/channels/[id]/messages/[mid]/reactions   { emoji }
 *
 * Toggle the caller's reaction with `emoji` on/off. Each (message, user,
 * emoji) is unique — a second POST removes the reaction. After mutating
 * we emit the FULL user-id list per the changed emoji so receivers don't
 * need to apply add/remove deltas correctly across reconnects.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PostBody {
  emoji?: unknown;
}

const MAX_EMOJI_BYTES = 32; // Loose cap — most emoji are 1–8 bytes UTF-8.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { id: channelId, mid: messageId } = await params;

  let raw: PostBody;
  try {
    raw = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const emoji = typeof raw.emoji === "string" ? raw.emoji.trim() : "";
  if (!emoji || Buffer.byteLength(emoji, "utf8") > MAX_EMOJI_BYTES) {
    return NextResponse.json({ error: "invalid emoji" }, { status: 400 });
  }

  // Tenant guard via the message.
  const message = await db.teamChannelMessage.findFirst({
    where: { id: messageId, channelId, teamId: session.teamId },
    select: { id: true },
  });
  if (!message) {
    return NextResponse.json({ error: "message not found" }, { status: 404 });
  }

  // Toggle: delete-if-exists, otherwise insert. Race between two of my own
  // tabs is irrelevant — the unique constraint makes the second create a
  // no-op via P2002, which we silently swallow.
  const existing = await db.teamChannelReaction.findUnique({
    where: {
      messageId_userId_emoji: {
        messageId,
        userId: session.userId,
        emoji,
      },
    },
    select: { id: true },
  });

  if (existing) {
    await db.teamChannelReaction.delete({ where: { id: existing.id } });
  } else {
    try {
      await db.teamChannelReaction.create({
        data: { messageId, userId: session.userId, emoji },
      });
    } catch (err) {
      // Already exists (raced with another tab) — treat as success.
      if (
        !(
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code?: string }).code === "P2002"
        )
      ) {
        throw err;
      }
    }
  }

  // Re-read the full set of user-ids for THIS emoji on THIS message. Cheap
  // (covered by the unique index) and avoids a client-side delta reducer.
  const reactions = await db.teamChannelReaction.findMany({
    where: { messageId, emoji },
    select: { userId: true },
  });
  const userIds = reactions.map((r) => r.userId);

  emitToTeam(session.teamId, "team:channel:reaction:changed", {
    teamId: session.teamId,
    channelId,
    messageId,
    emoji,
    userIds,
  });

  return NextResponse.json({ ok: true, emoji, userIds });
}
