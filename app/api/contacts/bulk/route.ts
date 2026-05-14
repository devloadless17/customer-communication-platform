import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { blobStorage } from "@/lib/blob-storage";
import { emitToTeam } from "@/lib/socket-server";

/**
 * Bulk operations on a set of contacts.
 *
 *   POST body: { action: "delete" | "tag-add" | "tag-remove", contactIds: string[], tagId?: string }
 *
 * Why one endpoint instead of three: the auth check, ownership filter, and
 * socket fan-out are the same shape across all three actions. Branching
 * internally keeps the surface area small.
 *
 * All actions are scoped to the caller's team — foreign-team ids in the
 * request are silently filtered out before the write.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  action?: unknown;
  contactIds?: unknown;
  tagId?: unknown;
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;

  let raw: Body;
  try {
    raw = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const action = typeof raw.action === "string" ? raw.action : "";
  const requestedIds = Array.isArray(raw.contactIds)
    ? raw.contactIds.filter((x): x is string => typeof x === "string")
    : [];
  const tagId = typeof raw.tagId === "string" ? raw.tagId : null;

  if (requestedIds.length === 0) {
    return NextResponse.json({ error: "contactIds required" }, { status: 400 });
  }

  // Filter to contacts that actually belong to this team. The downstream
  // `deleteMany` / `connect` calls would already scope by teamId, but doing
  // the lookup explicitly lets us return the actual count of affected rows.
  const ownContacts = await db.contact.findMany({
    where: { teamId, id: { in: requestedIds } },
    select: { id: true },
  });
  const ownedIds = ownContacts.map((c) => c.id);
  if (ownedIds.length === 0) {
    return NextResponse.json(
      { error: "no matching contacts in this team" },
      { status: 404 },
    );
  }

  if (action === "delete") {
    // Gather blob keys + affected conversation ids BEFORE the cascade delete
    // so we can clean up the provider and fan out socket events.
    const conversationsWithMedia = await db.conversation.findMany({
      where: { teamId, contactId: { in: ownedIds } },
      select: {
        id: true,
        messages: {
          where: { mediaKey: { not: null } },
          select: { mediaKey: true },
        },
      },
    });
    const mediaKeys = conversationsWithMedia
      .flatMap((c) => c.messages)
      .map((m) => m.mediaKey)
      .filter((k): k is string => Boolean(k));
    const conversationIds = conversationsWithMedia.map((c) => c.id);

    await db.contact.deleteMany({ where: { teamId, id: { in: ownedIds } } });

    if (mediaKeys.length > 0) {
      await blobStorage.delete(mediaKeys);
    }

    for (const cid of conversationIds) {
      emitToTeam(teamId, "conversation:deleted", { teamId, conversationId: cid });
    }
    for (const id of ownedIds) {
      emitToTeam(teamId, "contact:deleted", { teamId, contactId: id });
    }

    return NextResponse.json({ ok: true, count: ownedIds.length });
  }

  if (action === "tag-add" || action === "tag-remove") {
    if (!tagId) {
      return NextResponse.json({ error: "tagId required" }, { status: 400 });
    }
    const tag = await db.tag.findFirst({ where: { id: tagId, teamId } });
    if (!tag) {
      return NextResponse.json({ error: "tag not found" }, { status: 404 });
    }

    // Connect / disconnect the M2M one row at a time. Prisma doesn't have a
    // `set` operator that takes a list AND preserves existing other-tag
    // links; per-contact connect/disconnect is the safe path. The contact
    // count is small (bulk action — at most a few hundred), so the latency
    // is fine.
    const op = action === "tag-add" ? "connect" : "disconnect";
    for (const id of ownedIds) {
      // ownedIds is already team-filtered by the findMany above, but pin the
      // teamId on the update too — defense-in-depth so a future refactor of
      // ownedIds can't silently turn this into a cross-tenant write.
      await db.contact.update({
        where: { id, teamId },
        data: { tags: { [op]: { id: tagId } } },
      });
    }

    return NextResponse.json({ ok: true, count: ownedIds.length, action });
  }

  return NextResponse.json(
    { error: "unknown action", detail: `Expected one of: delete, tag-add, tag-remove.` },
    { status: 400 },
  );
}
