import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { emitCatalogChange } from "@/lib/socket/server";

/**
 * Admin-only: revoke a pending invite. Hard-deletes the row so the link's
 * tokenHash is gone — any attempt to redeem it falls through the
 * `findUnique({ where: { tokenHash } })` lookup in /invite/[token]/actions
 * and the recipient sees "This invite link is invalid."
 *
 * We refuse to revoke ALREADY-ACCEPTED invites: those are historical audit
 * rows and the corresponding User account is what an admin would actually
 * want to remove (via DELETE /api/users/[id]). Returning 404 keeps the UI
 * simple — it just removes the row optimistically and the next list pull
 * confirms.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;
  const { id } = await ctx.params;

  // Scope by teamId in the same query so a foreign-team id can never match
  // and a request for an already-accepted invite (acceptedAt != null) is
  // treated as "not found" — admins can't undo an accept by revoking.
  const result = await db.invite.deleteMany({
    where: { id, teamId, acceptedAt: null },
  });
  if (result.count === 0) {
    return NextResponse.json({ error: "invite not found" }, { status: 404 });
  }

  emitCatalogChange(teamId, "invites");
  return NextResponse.json({ ok: true });
}
