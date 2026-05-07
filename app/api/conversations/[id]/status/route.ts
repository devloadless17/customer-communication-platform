import { NextResponse } from "next/server";

import { getSession } from "@/lib/current-user";
import { db } from "@/lib/db";
import { emitToTeam } from "@/lib/socket-server";
import type { ConversationStatus } from "@/lib/types";

/**
 * Change conversation status (open / pending / closed). Emits
 * `conversation:status` so every connected client updates instantly.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_STATUSES: readonly ConversationStatus[] = ["open", "pending", "closed"];

interface Body {
  status?: unknown;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { teamId } = await getSession();
  const { id: conversationId } = await ctx.params;

  let raw: Body;
  try {
    raw = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const status = raw.status as ConversationStatus | undefined;
  if (!status || !VALID_STATUSES.includes(status)) {
    return NextResponse.json(
      { error: `status must be one of ${VALID_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }

  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, teamId },
    select: { id: true },
  });
  if (!conversation) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }

  await db.conversation.update({
    where: { id: conversationId },
    data: { status },
  });

  emitToTeam(teamId, "conversation:status", {
    teamId,
    conversationId,
    status,
  });

  return NextResponse.json({ ok: true });
}
