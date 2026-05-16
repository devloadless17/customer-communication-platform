import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { trackOnAssigned } from "@/lib/conversations/analytics";
import { db } from "@/lib/db";
import { recordConversationEvent } from "@/lib/inbox/events";
import { emitToTeam } from "@/lib/socket/server";
import type { User } from "@/lib/types";
import { dispatch } from "@/lib/workflows/dispatcher";
import {
  workflowContactSnapshot,
  workflowConversationSnapshot,
} from "@/lib/workflows/events";

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
  const { teamId, userId: actorUserId } = session;
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

  // Compare-and-set on the previous assignee. Two agents both filtered to
  // "Unassigned" can race to "Assign to me" — without CAS, Prisma's
  // findFirst→update sequence lets both succeed and the second silently
  // overwrites the first. With CAS, the loser gets P2025 and we return 409
  // so their UI refreshes and sees the new owner.
  let updated;
  try {
    updated = await db.conversation.update({
      where: {
        id: conversationId,
        teamId,
        assignedUserId: previousAssignedUserId,
      },
      data: { assignedUserId },
      include: { assignedUser: true, contact: true },
    });
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2025"
    ) {
      return NextResponse.json(
        { error: "conversation was reassigned by someone else" },
        { status: 409 },
      );
    }
    throw err;
  }

  const assignedUser: User | null = updated.assignedUser
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

  emitToTeam(teamId, "conversation:assigned", {
    teamId,
    conversationId,
    assignedUser,
  });

  // Audit. Only on actual change so "Assign to me" clicks on an already-self-
  // assigned thread don't churn the timeline.
  if (previousAssignedUserId !== assignedUserId) {
    await recordConversationEvent({
      conversationId,
      teamId,
      userId: actorUserId,
      kind: "assigned",
      before: { assignedUserId: previousAssignedUserId },
      after: { assignedUserId },
    });
  }

  // Fire workflows. Only emit on an actual change — pointless to retrigger
  // workflows when the same agent is reassigned to themselves.
  if (previousAssignedUserId !== assignedUserId) {
    // Analytics first (so the snapshot we ship to workflows already reflects
    // the bumped counters and the freshly-set firstAssignedAt).
    await trackOnAssigned({
      conversationId,
      teamId,
      assignedUserId,
      previousAssignedUserId,
    });
    const fresh = await db.conversation.findFirst({
      where: { id: conversationId, teamId },
    });
    if (fresh) {
      await dispatch(teamId, "conversation_assigned", {
        conversation: workflowConversationSnapshot(fresh),
        contact: workflowContactSnapshot(updated.contact),
        assignedUser: assignedUser
          ? { id: assignedUser.id, name: assignedUser.name, email: assignedUser.email }
          : null,
        previousAssignedUserId,
      });
    }
  }

  return NextResponse.json({ ok: true });
}
