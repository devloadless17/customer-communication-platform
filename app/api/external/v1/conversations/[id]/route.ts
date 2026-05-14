import "server-only";

import { NextResponse } from "next/server";

import { authenticateApiKey } from "@/lib/auth/external";
import { db } from "@/lib/db";
import {
  toExternalContact,
  toExternalConversation,
} from "@/lib/external-shapes";

/**
 * GET /api/external/v1/conversations/[id]
 *
 * Returns conversation + contact. n8n can call this from a webhook flow when
 * it needs more fields than the trigger envelope carried.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateApiKey(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await ctx.params;

  const row = await db.conversation.findFirst({
    where: { id, teamId: auth.teamId },
    include: { contact: true },
  });
  if (!row) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }

  return NextResponse.json({
    conversation: toExternalConversation(row),
    contact: toExternalContact(row.contact),
  });
}
