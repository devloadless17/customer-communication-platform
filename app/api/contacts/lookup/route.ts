import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { lookupContacts } from "@/lib/queries";

/**
 * Resolve a set of contact ids to their display labels (name + phone) for
 * rendering selection chips. The picker UIs no longer load the whole contact
 * list into the browser — they hold just the ids and call this for whatever
 * they need to show.
 *
 *   GET /api/contacts/lookup?ids=a,b,c  →  { contacts: { id, name, phoneNumber }[] }
 *
 * Unknown / cross-team ids are silently dropped (the caller's chip falls back
 * to the raw id).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const ids = (new URL(req.url).searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const contacts = await lookupContacts(session.teamId, ids);
  return NextResponse.json({ contacts });
}
