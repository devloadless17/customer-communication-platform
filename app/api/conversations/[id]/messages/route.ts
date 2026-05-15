import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { listNewerMessages, listOlderMessages } from "@/lib/queries";

/**
 * GET /api/conversations/<id>/messages?before=<cursor>&take=30
 *   → page of messages OLDER than cursor, oldest-first (infinite-scroll up).
 *
 * GET /api/conversations/<id>/messages?after=<isoTimestamp>&take=30
 *   → all messages strictly NEWER than the timestamp, oldest-first. Used by
 *     the conversation events hook on socket (re)connect to close the gap
 *     between SSR render and `subscribe:conversation` — any webhook that
 *     landed while the tab was hydrating got emitted into an empty room.
 *
 * Exactly one of `before` / `after` is required. Empty page for both unknown
 * conversations and unauthorized teams (same shape, no enumeration oracle).
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
  const before = url.searchParams.get("before");
  const after = url.searchParams.get("after");
  const takeRaw = url.searchParams.get("take");
  const take = takeRaw ? Number.parseInt(takeRaw, 10) : undefined;

  if (after) {
    const page = await listNewerMessages(session.teamId, conversationId, { after, take });
    return NextResponse.json(page);
  }

  if (!before) {
    return NextResponse.json(
      { error: "before or after cursor required" },
      { status: 400 },
    );
  }

  const page = await listOlderMessages(session.teamId, conversationId, { take, before });
  return NextResponse.json(page);
}
