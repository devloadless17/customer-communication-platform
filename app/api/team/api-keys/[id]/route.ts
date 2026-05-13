import "server-only";

import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth-helpers";
import { db } from "@/lib/db";

/**
 * Revoke an API key. We don't hard-delete so audit/lastUsedAt history stays
 * intact — a deleted row would look identical to a key that never existed.
 * Once revoked, the bearer-token middleware rejects further requests.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  const key = await db.teamApiKey.findFirst({
    where: { id, teamId: session.teamId },
    select: { id: true, revokedAt: true },
  });
  if (!key) {
    return NextResponse.json({ error: "key not found" }, { status: 404 });
  }
  if (key.revokedAt) {
    // Idempotent — revoking twice is fine.
    return NextResponse.json({ ok: true });
  }
  await db.teamApiKey.update({
    where: { id },
    data: { revokedAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
