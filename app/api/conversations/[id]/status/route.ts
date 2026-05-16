import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { dispatch } from "@/lib/automations/dispatcher";
import { automationContactSnapshot } from "@/lib/automations/events";
import { db } from "@/lib/db";
import { recordConversationEvent } from "@/lib/inbox/events";
import { emitToTeam } from "@/lib/socket/server";
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
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { userId, teamId } = session;
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
    include: { contact: true },
  });
  if (!conversation) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }
  const previousStatus = conversation.status as ConversationStatus;

  // Compare-and-set on the previous status. Two tabs racing "Close" + "Open"
  // would otherwise let the later write silently clobber the earlier; with
  // CAS, the loser gets a 409 and refetches so the UI matches reality.
  try {
    await db.conversation.update({
      where: { id: conversationId, teamId, status: previousStatus },
      data: { status },
    });
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2025"
    ) {
      return NextResponse.json(
        { error: "conversation status changed by someone else" },
        { status: 409 },
      );
    }
    throw err;
  }

  emitToTeam(teamId, "conversation:status", {
    teamId,
    conversationId,
    status,
  });

  // Audit. No-op for self-transitions so re-saves of the same status don't
  // bloat the timeline.
  if (previousStatus !== status) {
    await recordConversationEvent({
      conversationId,
      teamId,
      userId,
      kind: "status_changed",
      before: { status: previousStatus },
      after: { status },
    });
  }

  // Fire automations. No-op for self-transitions (e.g. clicking "Open" while
  // already open) so workflows don't trigger on UI re-renders.
  if (previousStatus !== status) {
    await dispatch(teamId, "conversation_status_changed", {
      conversation: {
        id: conversation.id,
        status,
        assignedUserId: conversation.assignedUserId,
        unreadCount: conversation.unreadCount,
        lastMessageAt: conversation.lastMessageAt.toISOString(),
      },
      contact: automationContactSnapshot(conversation.contact),
      previousStatus,
      newStatus: status,
      changedByUserId: userId,
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
