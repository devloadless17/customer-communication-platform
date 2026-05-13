import "server-only";

import { NextResponse } from "next/server";

import { authenticateApiKey } from "@/lib/external-auth";
import { db } from "@/lib/db";
import { toExternalContact } from "@/lib/external-shapes";

/**
 * GET /api/external/v1/contacts/[id]
 *
 * Returns one contact. Surfaced from the webhook envelope's _links.contact —
 * an AI flow can fetch full profile (email, location, custom fields) without
 * us bloating every trigger payload.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateApiKey(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await ctx.params;

  const row = await db.contact.findFirst({
    where: { id, teamId: auth.teamId },
  });
  if (!row) {
    return NextResponse.json({ error: "contact not found" }, { status: 404 });
  }
  return NextResponse.json({ contact: toExternalContact(row) });
}
