import { NextResponse } from "next/server";

import { blobStorage } from "@/lib/blob-storage";
import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { invalidateProviderConfig } from "@/lib/providers/config";
import { disconnectUserSockets } from "@/lib/socket/server";

/**
 * Admin-only: permanently delete the current team. This cascades through
 * every team-scoped table — users, contacts, conversations, messages,
 * notes, templates, broadcasts, invites, automations, api keys, sessions,
 * accounts, blob references — so the org disappears in one transaction.
 *
 * Blob storage cleanup is best-effort: we collect every message's mediaKey
 * first, then call blobStorage.delete after the DB delete succeeds. A
 * partial blob delete (network blip, UploadThing 5xx) leaves orphan files
 * but does NOT block the org delete. Orphans cost storage, not correctness.
 *
 * On success the caller's session row is gone (Cascade) — the response
 * tells the client to navigate to /logout for a clean cookie clear.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE() {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;
  const teamId = session.teamId;

  // Collect blob keys AND the full team-member id list BEFORE the cascade
  // nukes the rows. Blob keys feed the post-delete cleanup; member ids feed
  // the explicit socket disconnect below (the cascade clears their sessions
  // but already-connected Socket.io clients stay live until we kick them).
  const [blobKeyRows, teamMembers] = await Promise.all([
    db.message.findMany({
      where: { teamId, mediaKey: { not: null } },
      select: { mediaKey: true },
    }),
    db.user.findMany({ where: { teamId }, select: { id: true } }),
  ]);
  const blobKeys = blobKeyRows
    .map((r) => r.mediaKey)
    .filter((k): k is string => Boolean(k));

  try {
    await db.team.delete({ where: { id: teamId } });
  } catch (err) {
    console.error("[api/team DELETE] cascade delete failed", err);
    return NextResponse.json(
      { error: "delete failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  // Best-effort cache eviction so a re-registered team with the same id
  // (unlikely on cuid, but harmless) won't pick up a stale provider config.
  invalidateProviderConfig(teamId);

  // Kick every live socket the team's members had open. Cascade nuked their
  // Session rows already, but Socket.io connections sit on top of an
  // already-validated handshake and would otherwise stay subscribed to the
  // (now empty) team room until the browser's next request hits a 401 or
  // the underlying TCP socket times out. Disconnecting now means every
  // teammate's tab immediately sees a connection drop — symmetrical with
  // what we do on user-deactivate and user-delete.
  let droppedSockets = 0;
  for (const m of teamMembers) {
    droppedSockets += disconnectUserSockets(m.id);
  }
  if (droppedSockets > 0) {
    console.info(
      `[api/team DELETE] dropped ${droppedSockets} live socket(s) across ${teamMembers.length} member(s)`,
    );
  }

  // Fire-and-forget blob cleanup. Don't make the user wait on UploadThing's
  // batch delete (can be 5-30s for a busy team), and don't fail the delete
  // if it errors — the contract on blobStorage.delete is "never throw."
  if (blobKeys.length > 0) {
    void blobStorage.delete(blobKeys);
  }

  return NextResponse.json({ ok: true });
}
