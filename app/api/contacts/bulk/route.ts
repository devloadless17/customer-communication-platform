import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { blobStorage } from "@/lib/blob-storage";
import { emitToTeam } from "@/lib/socket/server";
import type { Contact } from "@/lib/types";

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

/**
 * Hard cap on a single bulk request. Each `tag-add` / `tag-remove` action
 * fires one DB update per contact (Prisma's M2M `connect` / `disconnect`
 * has no batch primitive that preserves OTHER existing tag links), so the
 * payload size directly controls DB roundtrip count. 500 is comfortable for
 * a single UI selection and bounds worst-case latency to a couple of seconds.
 * If a future caller needs more, split client-side or move to a background
 * job.
 */
const MAX_BULK_IDS = 500;

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
  if (requestedIds.length > MAX_BULK_IDS) {
    return NextResponse.json(
      {
        error: "too many contactIds",
        detail: `Cap is ${MAX_BULK_IDS} per request; got ${requestedIds.length}. Split the request client-side.`,
      },
      { status: 413 },
    );
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
    // links; per-contact connect/disconnect is the safe path. With the
    // MAX_BULK_IDS cap above the worst case is ~500 updates — fan out
    // concurrently so the Prisma pool churns through them in parallel
    // (~500× speed-up vs an awaited for-loop). Pool size naturally
    // throttles excess concurrency.
    //
    // allSettled (not all): if a single update fails (rare — DB connection
    // blip, contact deleted between the team-filter findMany above and
    // this update), Promise.all would reject AFTER other in-flight updates
    // had already mutated the DB → partial write, opaque error to the
    // client. allSettled lets every update run to completion and surfaces
    // the failure count honestly. Tag connect/disconnect is idempotent so
    // the client can retry to converge.
    const op = action === "tag-add" ? "connect" : "disconnect";
    const results = await Promise.allSettled(
      ownedIds.map((id) =>
        // ownedIds is already team-filtered by the findMany above, but pin
        // the teamId on the update too — defense-in-depth so a future
        // refactor of ownedIds can't silently turn this into a cross-tenant
        // write.
        db.contact.update({
          where: { id, teamId },
          data: { tags: { [op]: { id: tagId } } },
        }),
      ),
    );
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - succeeded;
    if (failed > 0) {
      const firstReason = results.find(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      )?.reason;
      console.error(
        `[contacts/bulk] ${action} partial failure: ${failed}/${results.length} contacts. First error:`,
        firstReason instanceof Error ? firstReason.message : firstReason,
      );
    }

    // Fan out per-contact updates so every open inbox / contact panel /
    // contacts list merges the new tag set without a refresh. Re-fetching
    // ALL ownedIds (not just succeeded ones) is correct: the socket
    // payload is just "here's the current truth for this contact," so
    // emitting an unchanged row for a failed update is harmless — clients
    // see whatever the DB actually holds.
    const updated = await db.contact.findMany({
      where: { teamId, id: { in: ownedIds } },
      include: { tags: { select: { id: true } } },
    });
    for (const c of updated) {
      const payload: Contact = {
        id: c.id,
        teamId: c.teamId,
        phoneNumber: c.phoneNumber,
        identityProvider: c.identityProvider,
        externalContactId: c.externalContactId,
        name: c.name,
        avatarUrl: c.avatarUrl ?? undefined,
        email: c.email ?? undefined,
        location: c.location ?? undefined,
        customFields: normalizeStringMap(c.customFields),
        source: c.source,
        stageId: c.stageId,
        tagIds: c.tags.map((t) => t.id),
      };
      emitToTeam(teamId, "contact:updated", { teamId, contact: payload });
    }

    return NextResponse.json({
      ok: failed === 0,
      count: succeeded,
      action,
      ...(failed > 0 ? { failed } : {}),
    });
  }

  return NextResponse.json(
    { error: "unknown action", detail: `Expected one of: delete, tag-add, tag-remove.` },
    { status: 400 },
  );
}

function normalizeStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
