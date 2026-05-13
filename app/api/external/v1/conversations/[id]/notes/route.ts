import "server-only";

import { NextResponse } from "next/server";

import { authenticateApiKey } from "@/lib/external-auth";
import { db } from "@/lib/db";
import { emitToTeam } from "@/lib/socket-server";

/**
 * POST /api/external/v1/conversations/[id]/notes
 *
 * Add an internal note. Body: `{ body: string, authorUserId?: string }`.
 *
 * `authorUserId` is optional and must belong to the team if provided — that
 * lets n8n attribute "AI flagged this conversation" to a synthetic bot user
 * the team has set up. Without it the note is unattributed (we pick the
 * oldest admin as the author since the schema requires one).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  body?: unknown;
  authorUserId?: unknown;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateApiKey(req);
  if (auth instanceof NextResponse) return auth;
  const { id: conversationId } = await ctx.params;

  let raw: Body;
  try {
    raw = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  if (!body) {
    return NextResponse.json({ error: "body required" }, { status: 400 });
  }

  const conv = await db.conversation.findFirst({
    where: { id: conversationId, teamId: auth.teamId },
    select: { id: true },
  });
  if (!conv) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }

  let authorUserId: string | null = null;
  if (typeof raw.authorUserId === "string" && raw.authorUserId) {
    const u = await db.user.findFirst({
      where: { id: raw.authorUserId, teamId: auth.teamId },
      select: { id: true },
    });
    if (!u) {
      return NextResponse.json(
        { error: "authorUserId is not a member of this team" },
        { status: 400 },
      );
    }
    authorUserId = u.id;
  }

  if (!authorUserId) {
    // Fall back to the oldest admin on the team — InternalNote.authorUserId
    // is non-nullable, so notes from automations have to attach to someone.
    // Surfacing this in the UI as "via automation" is a future enhancement.
    const fallback = await db.user.findFirst({
      where: { teamId: auth.teamId, role: { in: ["admin", "superAdmin"] } },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!fallback) {
      return NextResponse.json(
        { error: "team has no admin to attribute the note to" },
        { status: 409 },
      );
    }
    authorUserId = fallback.id;
  }

  const note = await db.internalNote.create({
    data: { conversationId, authorUserId, body },
  });

  emitToTeam(auth.teamId, "note:new", {
    teamId: auth.teamId,
    conversationId,
    note: {
      id: note.id,
      conversationId,
      authorUserId,
      body,
      timestamp: note.timestamp.toISOString(),
    },
  });

  return NextResponse.json({
    ok: true,
    note: {
      id: note.id,
      conversationId,
      authorUserId,
      body,
      timestamp: note.timestamp.toISOString(),
    },
  });
}
