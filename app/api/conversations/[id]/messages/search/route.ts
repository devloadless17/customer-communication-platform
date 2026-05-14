import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { searchConversationMessages } from "@/lib/queries";

/**
 * GET /api/conversations/<id>/messages/search?q=<text>&take=25&cursor=<keyset>
 *
 * Free-text search inside a single conversation. Matches `body` OR
 * `mediaCaption` with ILIKE, scoped to the caller's team. Empty `q`
 * short-circuits to `{ items: [], nextCursor: null, totalMatched: 0 }`.
 *
 * Pagination uses the same `(timestamp, id)` keyset cursor as the older-
 * messages pager so the codec is shared. Newest-first.
 *
 * Returns 200 with an empty page when the conversation belongs to a
 * different team — same shape as "no matches" so we don't leak existence.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_QUERY = 1;
const MAX_QUERY = 200;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const { id: conversationId } = await ctx.params;
  const url = new URL(req.url);
  const query = (url.searchParams.get("q") ?? "").trim();
  if (query.length < MIN_QUERY) {
    return NextResponse.json({ items: [], nextCursor: null, totalMatched: 0 });
  }
  if (query.length > MAX_QUERY) {
    return NextResponse.json({ error: "query too long" }, { status: 400 });
  }

  const cursor = url.searchParams.get("cursor") ?? undefined;
  const takeRaw = url.searchParams.get("take");
  const take = takeRaw ? Number.parseInt(takeRaw, 10) : undefined;

  const page = await searchConversationMessages(session.teamId, conversationId, {
    query,
    take,
    cursor,
  });
  return NextResponse.json(page);
}
