import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { emitToTeam } from "@/lib/socket/server";

/**
 * POST /api/team/channels/[id]/read
 *
 * Stamps the caller's read receipt for this channel to `now`. Broadcasts a
 * `team:channel:read` event so every other tab of the same user can clear
 * its sidebar badge in lock-step.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { id: channelId } = await params;

  const channel = await db.teamChannel.findFirst({
    where: { id: channelId, teamId: session.teamId },
    select: { id: true },
  });
  if (!channel) {
    return NextResponse.json({ error: "channel not found" }, { status: 404 });
  }

  const now = new Date();
  await db.teamChannelReadReceipt.upsert({
    where: {
      userId_channelId: {
        userId: session.userId,
        channelId,
      },
    },
    create: {
      userId: session.userId,
      channelId,
      lastReadAt: now,
    },
    update: { lastReadAt: now },
  });

  emitToTeam(session.teamId, "team:channel:read", {
    teamId: session.teamId,
    channelId,
    readByUserId: session.userId,
    lastReadAt: now.toISOString(),
  });

  return NextResponse.json({ ok: true, lastReadAt: now.toISOString() });
}
