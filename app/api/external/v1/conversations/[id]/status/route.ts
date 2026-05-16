import "server-only";

import { NextResponse } from "next/server";

import { authenticateApiKey } from "@/lib/auth/external";
import { trackOnStatusChanged } from "@/lib/conversations/analytics";
import { db } from "@/lib/db";
import { emitToTeam } from "@/lib/socket/server";
import type { ConversationStatus } from "@/lib/types";
import { dispatch } from "@/lib/workflows/dispatcher";
import {
  workflowContactSnapshot,
  workflowConversationSnapshot,
} from "@/lib/workflows/events";

/**
 * POST /api/external/v1/conversations/[id]/status
 *
 * Body: `{ status: "open" | "pending" | "closed" }`.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID: readonly ConversationStatus[] = ["open", "pending", "closed"];

interface Body {
  status?: unknown;
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
  const status = raw.status as ConversationStatus | undefined;
  if (!status || !VALID.includes(status)) {
    return NextResponse.json(
      { error: `status must be one of ${VALID.join(", ")}` },
      { status: 400 },
    );
  }

  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, teamId: auth.teamId },
    include: { contact: { include: { tags: { select: { id: true } } } } },
  });
  if (!conversation) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }
  const previousStatus = conversation.status as ConversationStatus;

  await db.conversation.update({
    where: { id: conversationId },
    data: { status },
  });

  emitToTeam(auth.teamId, "conversation:status", {
    teamId: auth.teamId,
    conversationId,
    status,
  });

  if (previousStatus !== status) {
    await trackOnStatusChanged({
      conversationId,
      teamId: auth.teamId,
      previousStatus,
      newStatus: status,
      // External API has no acting user — leave null.
      changedByUserId: null,
    });

    const fresh = await db.conversation.findFirst({
      where: { id: conversationId, teamId: auth.teamId },
    });
    if (fresh) {
      const conversationSnap = workflowConversationSnapshot(fresh);
      const contactSnap = workflowContactSnapshot(conversation.contact);

      await dispatch(auth.teamId, "conversation_status_changed", {
        conversation: conversationSnap,
        contact: contactSnap,
        previousStatus,
        newStatus: status,
        changedByUserId: null,
      });
      if (status === "open") {
        await dispatch(auth.teamId, "conversation_opened", {
          conversation: conversationSnap,
          contact: contactSnap,
          previousStatus,
          openedByUserId: null,
        });
      } else if (status === "closed") {
        await dispatch(auth.teamId, "conversation_closed", {
          conversation: conversationSnap,
          contact: contactSnap,
          previousStatus,
          closedByUserId: null,
          closedCategory: fresh.closedCategory,
          closedSummary: fresh.closedSummary,
        });
      }
    }
  }

  return NextResponse.json({ ok: true });
}
