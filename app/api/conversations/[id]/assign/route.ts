import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth-helpers";
import { dispatch } from "@/lib/automations/dispatcher";
import { db } from "@/lib/db";
import { emitToTeam } from "@/lib/socket-server";
import type { User } from "@/lib/types";

/**
 * Assign / unassign a conversation. Body: `{ assignedUserId: string | null }`.
 * Emits `conversation:assigned` to the team room so all viewers update.
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
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;
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
    where: { id: conversationId, teamId },
    select: { id: true, assignedUserId: true },
  });
  if (!conversation) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }
  const previousAssignedUserId = conversation.assignedUserId;

  if (assignedUserId !== null) {
    const member = await db.user.findFirst({
      where: { id: assignedUserId, teamId },
      select: { id: true },
    });
    if (!member) {
      return NextResponse.json(
        { error: "user not in team" },
        { status: 400 },
      );
    }
  }

  const updated = await db.conversation.update({
    where: { id: conversationId },
    data: { assignedUserId },
    include: { assignedUser: true, contact: true },
  });

  const assignedUser: User | null = updated.assignedUser
    ? {
        id: updated.assignedUser.id,
        teamId: updated.assignedUser.teamId,
        role: updated.assignedUser.role,
        name: updated.assignedUser.name,
        email: updated.assignedUser.email,
        avatarUrl: updated.assignedUser.avatarUrl ?? undefined,
      }
    : null;

  emitToTeam(teamId, "conversation:assigned", {
    teamId,
    conversationId,
    assignedUser,
  });

  // Fire automations. Only emit on an actual change — pointless to retrigger
  // workflows when the same agent is reassigned to themselves.
  if (previousAssignedUserId !== assignedUserId) {
    await dispatch(teamId, "conversation_assigned", {
      conversation: {
        id: updated.id,
        status: updated.status,
        assignedUserId: updated.assignedUserId,
        unreadCount: updated.unreadCount,
        lastMessageAt: updated.lastMessageAt.toISOString(),
      },
      contact: {
        id: updated.contact.id,
        phoneNumber: updated.contact.phoneNumber,
        name: updated.contact.name,
        email: updated.contact.email ?? null,
        customFields: customFieldsFromJson(updated.contact.customFields),
      },
      assignedUser: assignedUser
        ? { id: assignedUser.id, name: assignedUser.name, email: assignedUser.email }
        : null,
      previousAssignedUserId,
    });
  }

  return NextResponse.json({ ok: true });
}

function customFieldsFromJson(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
