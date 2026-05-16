import "server-only";

import { NextResponse } from "next/server";

import { dispatch } from "@/lib/automations/dispatcher";
import { automationContactSnapshot } from "@/lib/automations/events";
import { authenticateApiKey } from "@/lib/auth/external";
import { db } from "@/lib/db";
import { emitToTeam } from "@/lib/socket/server";

/**
 * POST /api/external/v1/conversations/[id]/assign
 *
 * Body: `{ assignedUserId: string | null }`.
 *
 * Mirrors /api/conversations/[id]/assign exactly — same socket emit, same
 * automation dispatch — so an external assignment is indistinguishable from
 * an in-app one for downstream listeners.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  assignedUserId?: unknown;
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
  const assignedUserId =
    raw.assignedUserId === null
      ? null
      : typeof raw.assignedUserId === "string"
        ? raw.assignedUserId
        : undefined;
  if (assignedUserId === undefined) {
    return NextResponse.json(
      { error: "assignedUserId must be a string or null" },
      { status: 400 },
    );
  }

  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, teamId: auth.teamId },
    select: { id: true, assignedUserId: true },
  });
  if (!conversation) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }
  const previousAssignedUserId = conversation.assignedUserId;

  if (assignedUserId !== null) {
    const member = await db.user.findFirst({
      where: { id: assignedUserId, teamId: auth.teamId },
      select: { id: true },
    });
    if (!member) {
      return NextResponse.json({ error: "user not in team" }, { status: 400 });
    }
  }

  const updated = await db.conversation.update({
    where: { id: conversationId },
    data: { assignedUserId },
    include: { assignedUser: true, contact: true },
  });

  const assignedUser = updated.assignedUser
    ? {
        id: updated.assignedUser.id,
        teamId: updated.assignedUser.teamId,
        role: updated.assignedUser.role,
        name: updated.assignedUser.name,
        email: updated.assignedUser.email,
        avatarUrl: updated.assignedUser.avatarUrl ?? undefined,
        isActive: updated.assignedUser.deactivatedAt === null,
      }
    : null;

  emitToTeam(auth.teamId, "conversation:assigned", {
    teamId: auth.teamId,
    conversationId,
    assignedUser,
  });

  if (previousAssignedUserId !== assignedUserId) {
    await dispatch(auth.teamId, "conversation_assigned", {
      conversation: {
        id: updated.id,
        status: updated.status,
        assignedUserId: updated.assignedUserId,
        unreadCount: updated.unreadCount,
        lastMessageAt: updated.lastMessageAt.toISOString(),
      },
      contact: automationContactSnapshot(updated.contact),
      assignedUser: assignedUser
        ? { id: assignedUser.id, name: assignedUser.name, email: assignedUser.email }
        : null,
      previousAssignedUserId,
    });
  }

  return NextResponse.json({ ok: true });
}

function cf(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
