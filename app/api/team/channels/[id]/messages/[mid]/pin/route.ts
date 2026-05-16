import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { emitToTeam } from "@/lib/socket/server";
import { canPinMessage } from "@/lib/team-chat/permissions";

/**
 * POST   /api/team/channels/[id]/messages/[mid]/pin   — pin (admin/manager)
 * DELETE /api/team/channels/[id]/messages/[mid]/pin   — unpin
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  if (!canPinMessage(session.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id: channelId, mid: messageId } = await params;

  const msg = await db.teamChannelMessage.findFirst({
    where: { id: messageId, channelId, teamId: session.teamId },
    select: { id: true, threadRootId: true },
  });
  if (!msg) {
    return NextResponse.json({ error: "message not found" }, { status: 404 });
  }
  if (msg.threadRootId !== null) {
    return NextResponse.json(
      { error: "thread_reply_unpinnable", detail: "Only top-level messages can be pinned." },
      { status: 400 },
    );
  }

  // Upsert — race-safe via the @unique on messageId.
  try {
    await db.teamChannelPin.create({
      data: {
        channelId,
        messageId,
        pinnedById: session.userId,
      },
    });
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      // Already pinned — idempotent success.
    } else {
      throw err;
    }
  }

  emitToTeam(session.teamId, "team:channel:pin:changed", {
    teamId: session.teamId,
    channelId,
    messageId,
    pinned: true,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  if (!canPinMessage(session.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id: channelId, mid: messageId } = await params;

  // Tenant guard via the message — keeps an unpin call from teaching the
  // caller about another team's message ids.
  const msg = await db.teamChannelMessage.findFirst({
    where: { id: messageId, channelId, teamId: session.teamId },
    select: { id: true },
  });
  if (!msg) {
    return NextResponse.json({ error: "message not found" }, { status: 404 });
  }

  await db.teamChannelPin.deleteMany({ where: { messageId } });

  emitToTeam(session.teamId, "team:channel:pin:changed", {
    teamId: session.teamId,
    channelId,
    messageId,
    pinned: false,
  });
  return NextResponse.json({ ok: true });
}
