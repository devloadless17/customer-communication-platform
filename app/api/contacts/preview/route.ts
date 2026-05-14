import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { previewAudienceContacts } from "@/lib/queries";

/**
 * Recipients preview for a broadcast audience — total count plus a capped
 * sample of `{ id, name, phoneNumber }`. Same UNION semantics as
 * `/api/contacts/count` (contacts carrying ANY of `tagIds` OR present in
 * `contactIds`), just with a list attached.
 *
 *   POST /api/contacts/preview  { tagIds?: string[], contactIds?: string[] }
 *     → { total: number, sample: { id, name, phoneNumber }[] }
 *
 * POST (not GET) because `contactIds` can be a few hundred cuids. Empty input
 * → { total: 0, sample: [] }.
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

  const result = await previewAudienceContacts(session.teamId, { tagIds, contactIds });
  return NextResponse.json(result);
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}
