import "server-only";

import { NextResponse } from "next/server";

import { authenticateApiKey } from "@/lib/external-auth";
import { db } from "@/lib/db";
import { toExternalConversation } from "@/lib/external-shapes";

/**
 * GET /api/external/v1/conversations
 *
 * Query params:
 *   - phone:  filter by contact phone (E.164 digits, no '+')
 *   - status: open | pending | closed
 *   - limit:  1..100 (default 50)
 *   - cursor: opaque cursor from a prior response
 *
 * Returns `{ items, nextCursor }`. Cursor is the id of the last item — keyset
 * pagination on lastMessageAt descending, then id descending.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_STATUS = new Set(["open", "pending", "closed"]);

export async function GET(req: Request) {
  const auth = await authenticateApiKey(req);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const phone = url.searchParams.get("phone");
  const status = url.searchParams.get("status");
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50));
  const cursor = url.searchParams.get("cursor");

  // status filter validation — invalid value returns 400 so integrators catch
  // typos at integration time rather than silently empty results.
  if (status && !VALID_STATUS.has(status)) {
    return NextResponse.json(
      { error: `status must be one of open, pending, closed` },
      { status: 400 },
    );
  }

  const rows = await db.conversation.findMany({
    where: {
      teamId: auth.teamId,
      ...(status ? { status: status as "open" | "pending" | "closed" } : {}),
      ...(phone ? { contact: { phoneNumber: phone } } : {}),
    },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: limit + 1, // peek ahead for nextCursor
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const items = rows.slice(0, limit).map(toExternalConversation);
  const lastItem = items[items.length - 1];
  const nextCursor = rows.length > limit && lastItem ? lastItem.id : null;

  return NextResponse.json({ items, nextCursor });
}
