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

  // Cap the window dimensions so a malformed (or malicious) client can't
  // request a 20k-message slice — that would block the response thread for
  // seconds on the DB side and balloon the JSON payload to MBs over 3G.
  // 100 in each direction keeps the response a few KB regardless of input.
  const CONTEXT_WINDOW_MAX = 100;
  const parseClamped = (raw: string | null): number | undefined => {
    if (raw === null) return undefined;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return undefined;
    return Math.min(parsed, CONTEXT_WINDOW_MAX);
  };
  const before = parseClamped(url.searchParams.get("before"));
  const after = parseClamped(url.searchParams.get("after"));

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
