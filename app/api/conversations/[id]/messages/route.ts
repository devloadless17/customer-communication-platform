import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { listOlderMessages } from "@/lib/queries";

/**
 * GET /api/conversations/<id>/messages?before=<cursor>&take=30
 *
 * Returns up to `take` messages OLDER than the cursor, in chronological
 * (oldest-first) order so the client can prepend. Returns an empty page
 * when the conversation doesn't belong to the caller's team — same shape
 * as "no more messages" so we don't leak existence.
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
  const takeRaw = url.searchParams.get("take");
  const take = takeRaw ? Number.parseInt(takeRaw, 10) : undefined;

  if (!before) {
    return NextResponse.json({ error: "before cursor required" }, { status: 400 });
  }

  const page = await listOlderMessages(session.teamId, conversationId, { take, before });
  return NextResponse.json(page);
}
