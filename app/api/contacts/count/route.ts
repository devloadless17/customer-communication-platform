import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth-helpers";
import { countAudienceContacts } from "@/lib/queries";

/**
 * Live recipient count for an audience selection — contacts carrying ANY of
 * `tagIds` OR present in `contactIds` (the audience-group union semantics).
 *
 *   POST /api/contacts/count  { tagIds?: string[], contactIds?: string[] }
 *     → { count: number }
 *
 * POST (not GET) because `contactIds` can be a few hundred cuids — too long
 * for a query string. Empty input → count 0.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IDS = 5000;

export async function POST(req: Request) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  let body: { tagIds?: unknown; contactIds?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const tagIds = asStringArray(body.tagIds).slice(0, MAX_IDS);
  const contactIds = asStringArray(body.contactIds).slice(0, MAX_IDS);

  const count = await countAudienceContacts(session.teamId, { tagIds, contactIds });
  return NextResponse.json({ count });
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}
