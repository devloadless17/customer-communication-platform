import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { listConversations } from "@/lib/queries";

/**
 * GET /api/conversations?cursor=<opaque>&take=25
 *
 * Returns the next page of conversations after the given cursor. Cursor is
 * the keyset value returned in the previous response (`nextCursor`); omit
 * it to fetch from the start. Page size capped server-side.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor") || null;
  const takeRaw = url.searchParams.get("take");
  const take = takeRaw ? Number.parseInt(takeRaw, 10) : undefined;

  const page = await listConversations(session.teamId, { take, cursor });
  return NextResponse.json(page);
}
