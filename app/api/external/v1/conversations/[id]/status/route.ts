import "server-only";

import { NextResponse } from "next/server";

import { dispatch } from "@/lib/automations/dispatcher";
import { authenticateApiKey } from "@/lib/auth/external";
import { db } from "@/lib/db";
import { emitToTeam } from "@/lib/socket/server";
import type { ConversationStatus } from "@/lib/types";

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
    include: { contact: true },
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
    await dispatch(auth.teamId, "conversation_status_changed", {
      conversation: {
        id: conversation.id,
        status,
        assignedUserId: conversation.assignedUserId,
        unreadCount: conversation.unreadCount,
        lastMessageAt: conversation.lastMessageAt.toISOString(),
      },
      contact: {
        id: conversation.contact.id,
        phoneNumber: conversation.contact.phoneNumber,
        name: conversation.contact.name,
        email: conversation.contact.email ?? null,
        customFields: cf(conversation.contact.customFields),
      },
      previousStatus,
      newStatus: status,
      // External API has no acting user — record the API key id in a future
      // audit table, but for now leave this null so n8n-driven transitions
      // don't claim to be from a person.
      changedByUserId: null,
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
