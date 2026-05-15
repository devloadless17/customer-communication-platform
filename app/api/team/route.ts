import { NextResponse } from "next/server";

import { blobStorage } from "@/lib/blob-storage";
import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { invalidateProviderConfig } from "@/lib/providers/config";

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

  // Collect blob keys BEFORE the cascade nukes the message rows. Filter to
  // non-null so we don't pass undefineds into the blob delete call.
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
    console.error("[api/team DELETE] cascade delete failed", err);
    return NextResponse.json(
      { error: "delete failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  // Best-effort cache eviction so a re-registered team with the same id
  // (unlikely on cuid, but harmless) won't pick up a stale provider config.
  invalidateProviderConfig(teamId);

  // Fire-and-forget blob cleanup. Don't make the user wait on UploadThing's
  // batch delete (can be 5-30s for a busy team), and don't fail the delete
  // if it errors — the contract on blobStorage.delete is "never throw."
  if (blobKeys.length > 0) {
    void blobStorage.delete(blobKeys);
  }

  return NextResponse.json({ ok: true });
}
