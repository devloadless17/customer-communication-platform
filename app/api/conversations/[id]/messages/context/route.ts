import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { loadMessageContextWindow } from "@/lib/queries";

/**
 * GET /api/conversations/<id>/messages/context?messageId=<id>&before=25&after=25
 *
 * Loads a slice of messages CENTERED on the target so the inbox can jump
 * to a search hit without paginating through every older page first.
 *
 * Returns:
 *   { messages: Message[] (chronological), hasMoreOlder: boolean,
 *     nextOlderCursor: string | null }
 *
 * 404 when the target message doesn't belong to a conversation on this
 * team — same shape (no body leak), the UI surfaces "couldn't load
 * context" and re-fetches the default thread slice.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const { id: conversationId } = await ctx.params;
  const url = new URL(req.url);
  const messageId = url.searchParams.get("messageId");
  if (!messageId) {
    return NextResponse.json({ error: "messageId required" }, { status: 400 });
  }

  const beforeRaw = url.searchParams.get("before");
  const afterRaw = url.searchParams.get("after");
  const before = beforeRaw ? Number.parseInt(beforeRaw, 10) : undefined;
  const after = afterRaw ? Number.parseInt(afterRaw, 10) : undefined;

  const window = await loadMessageContextWindow(session.teamId, conversationId, {
    targetMessageId: messageId,
    before,
    after,
  });
  if (!window) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(window);
}
