import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { listChannelPins } from "@/lib/team-chat/queries";

/**
 * GET /api/team/channels/[id]/pins — pinned messages bar contents.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
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

  const items = await listChannelPins(channelId, session.teamId);
  return NextResponse.json({ items });
}
