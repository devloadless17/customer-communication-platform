import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { emitToTeam } from "@/lib/socket/server";
import type { Contact } from "@/lib/types";
import { dispatch } from "@/lib/workflows/dispatcher";
import { workflowContactSnapshot } from "@/lib/workflows/events";

/**
 * Set the tags applied to a contact.
 *
 *   PUT { tagIds: string[] }
 *
 * Replace semantics — the array is the new full set. Tags not in the array
 * are removed, tags not previously on the contact are added. Cross-team tag
 * ids are silently filtered out (defense against id-stuffing).
 *
 * Dispatches one `contact_tag_updated` event per changed tag — additions
 * and removals fire separately so workflow authors can filter by
 * `tag_change_kind` ("added" / "removed").
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId, userId } = session;
  const { id } = await ctx.params;

  let raw: { tagIds?: unknown };
  try {
    raw = (await req.json()) as typeof raw;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const requestedIds = Array.isArray(raw.tagIds)
    ? raw.tagIds.filter((x): x is string => typeof x === "string")
    : [];

  const contact = await db.contact.findFirst({
    where: { id, teamId },
    include: { tags: { select: { id: true } } },
  });
  if (!contact) {
    return NextResponse.json({ error: "contact not found" }, { status: 404 });
  }

  const validIds =
    requestedIds.length === 0
      ? []
      : (
          await db.tag.findMany({
            where: { teamId, id: { in: requestedIds } },
            select: { id: true },
          })
        ).map((t) => t.id);

  const previousIds = new Set(contact.tags.map((t) => t.id));
  const nextIds = new Set(validIds);
  const added = validIds.filter((tagId) => !previousIds.has(tagId));
  const removed = [...previousIds].filter((tagId) => !nextIds.has(tagId));

  const updated = await db.contact.update({
    where: { id },
    data: { tags: { set: validIds.map((tagId) => ({ id: tagId })) } },
    include: { tags: { select: { id: true } } },
  });

  const payload: Contact = {
    id: updated.id,
    teamId: updated.teamId,
    phoneNumber: updated.phoneNumber,
    identityProvider: updated.identityProvider,
    externalContactId: updated.externalContactId,
    name: updated.name,
    avatarUrl: updated.avatarUrl ?? undefined,
    email: updated.email ?? undefined,
    location: updated.location ?? undefined,
    customFields: normalizeStringMap(updated.customFields),
    source: updated.source,
    stageId: updated.stageId,
    tagIds: validIds,
  };
  emitToTeam(teamId, "contact:updated", { teamId, contact: payload });

  // Workflow dispatches — one event per changed tag, additions then removals.
  // The conversation field on the payload would require a fetch we don't
  // want on this hot path; leave it null and let workflow authors look up
  // the conversation by contactId via the external API if they need it.
  const contactSnap = workflowContactSnapshot(updated);
  for (const tagId of added) {
    await dispatch(teamId, "contact_tag_updated", {
      contact: contactSnap,
      kind: "added",
      tagId,
      changedByUserId: userId,
    });
  }
  for (const tagId of removed) {
    await dispatch(teamId, "contact_tag_updated", {
      contact: contactSnap,
      kind: "removed",
      tagId,
      changedByUserId: userId,
    });
  }

  return NextResponse.json({ ok: true, tagIds: validIds });
}

function normalizeStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
