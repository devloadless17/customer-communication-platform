import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { trackOnStatusChanged } from "@/lib/conversations/analytics";
import { db } from "@/lib/db";
import { recordConversationEvent } from "@/lib/inbox/events";
import { emitToTeam } from "@/lib/socket/server";
import type { ConversationStatus } from "@/lib/types";
import { dispatch } from "@/lib/workflows/dispatcher";
import {
  workflowContactSnapshot,
  workflowConversationSnapshot,
} from "@/lib/workflows/events";

/**
 * Change conversation status (open / pending / closed). Emits
 * `conversation:status` so every connected client updates instantly.
 *
 * Workflow dispatch fires THREE triggers per change so authors can pick the
 * granularity they want:
 *   - conversation_status_changed (every transition)
 *   - conversation_opened (any status → open)
 *   - conversation_closed (any status → closed)
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
    include: { contact: { include: { tags: { select: { id: true } } } } },
  });
  if (!conversation) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }
  const previousStatus = conversation.status as ConversationStatus;

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

  emitToTeam(teamId, "conversation:status", { teamId, conversationId, status });

  if (previousStatus !== status) {
    await recordConversationEvent({
      conversationId,
      teamId,
      userId,
      kind: "status_changed",
      before: { status: previousStatus },
      after: { status },
    });

    // Analytics tracking happens before workflow dispatch so the snapshot
    // carries the freshly-stamped closedAt / closedByUserId.
    await trackOnStatusChanged({
      conversationId,
      teamId,
      previousStatus,
      newStatus: status,
      changedByUserId: userId,
    });

    const fresh = await db.conversation.findFirst({
      where: { id: conversationId, teamId },
    });
    if (fresh) {
      const conversationSnap = workflowConversationSnapshot(fresh);
      const contactSnap = workflowContactSnapshot(conversation.contact);

      // Three dispatches — workflows can listen to whichever granularity
      // they need. Fire-and-forget per existing dispatcher contract.
      await dispatch(teamId, "conversation_status_changed", {
        conversation: conversationSnap,
        contact: contactSnap,
        previousStatus,
        newStatus: status,
        changedByUserId: userId,
      });
      if (status === "open") {
        await dispatch(teamId, "conversation_opened", {
          conversation: conversationSnap,
          contact: contactSnap,
          previousStatus,
          openedByUserId: userId,
        });
      } else if (status === "closed") {
        await dispatch(teamId, "conversation_closed", {
          conversation: conversationSnap,
          contact: contactSnap,
          previousStatus,
          closedByUserId: userId,
          closedCategory: fresh.closedCategory,
          closedSummary: fresh.closedSummary,
        });
      }
    }
  }

  return NextResponse.json({ ok: true });
}
