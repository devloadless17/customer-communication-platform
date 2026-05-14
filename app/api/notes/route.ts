import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { emitToTeam } from "@/lib/socket/server";
import type { InternalNote } from "@/lib/types";

/**
 * Internal note endpoint. Notes never leave the platform — no provider call,
 * no externalId, no WhatsApp message. CLAUDE.md week 3 deliverable.
 *
 * Body: `{ conversationId, body }`.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  conversationId?: unknown;
  body?: unknown;
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { userId, teamId } = session;

  let raw: Body;
  try {
    raw = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const conversationId = typeof raw.conversationId === "string" ? raw.conversationId : null;
  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  if (!conversationId || !body) {
    return NextResponse.json({ error: "conversationId and body required" }, { status: 400 });
  }

  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, teamId },
    select: { id: true },
  });
  if (!conversation) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }

  const created = await db.internalNote.create({
    data: {
      conversationId,
      authorUserId: userId,
      body,
    },
  });

  const note: InternalNote = {
    id: created.id,
    conversationId: created.conversationId,
    authorUserId: created.authorUserId,
    body: created.body,
    timestamp: created.timestamp.toISOString(),
  };

  emitToTeam(teamId, "note:new", { teamId, conversationId, note });

  return NextResponse.json({ ok: true, noteId: created.id });
}
