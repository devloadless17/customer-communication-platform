import { NextResponse } from "next/server";

import { blobStorage } from "@/lib/blob-storage";
import { requireSuperAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { invalidateProviderConfig } from "@/lib/providers/config";

/**
 * superAdmin-only: permanently delete ANY team on the platform. Same cascade
 * semantics as DELETE /api/team (the admin-deletes-their-own-org endpoint),
 * but reachable from /admin/teams/[id] without needing to be a member.
 *
 * Refuses to delete the operator's own team — that's what /api/team is for,
 * and we want the operator's last action to be reversible (signout) rather
 * than self-destruct.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireSuperAdmin();
  if (session instanceof NextResponse) return session;

  const { id: teamId } = await ctx.params;

  if (teamId === session.teamId) {
    return NextResponse.json(
      { error: "use /api/team to delete your own organization" },
      { status: 400 },
    );
  }

  const team = await db.team.findUnique({
    where: { id: teamId },
    select: { id: true },
  });
  if (!team) {
    return NextResponse.json({ error: "team not found" }, { status: 404 });
  }

  const blobKeyRows = await db.message.findMany({
    where: { teamId, mediaKey: { not: null } },
    select: { mediaKey: true },
  });
  const blobKeys = blobKeyRows
    .map((r) => r.mediaKey)
    .filter((k): k is string => Boolean(k));

  try {
    await db.team.delete({ where: { id: teamId } });
  } catch (err) {
    console.error(`[api/admin/teams ${teamId} DELETE] cascade delete failed`, err);
    return NextResponse.json(
      { error: "delete failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  invalidateProviderConfig(teamId);

  if (blobKeys.length > 0) {
    void blobStorage.delete(blobKeys);
  }

  return NextResponse.json({ ok: true });
}
