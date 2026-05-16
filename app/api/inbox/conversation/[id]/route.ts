import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { getConversationWithRefs } from "@/lib/queries";

/**
 * GET /api/inbox/conversation/<id>
 *   → { data: ConversationWithRefs, nextOlderCursor: string | null }
 *
 * Mirrors the server-component fetch in app/inbox/[conversationId]/page.tsx
 * for the client-side workspace cache. Hit on cache miss when the agent
 * clicks a chat they haven't loaded in this session; the response is folded
 * into the in-memory Map and the thread renders without a route navigation.
 *
 * Static catalog data (team members, tags, stages, field definitions) is
 * intentionally NOT included — it's loaded once with the inbox layout and
 * doesn't change between chats, so re-shipping it per cache miss is pure
 * waste.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const { id: conversationId } = await ctx.params;

  const page = await getConversationWithRefs(session.teamId, conversationId);
  if (!page) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(page);
}
