import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { emitToTeam } from "@/lib/socket/server";
import type { Contact } from "@/lib/types";

/**
 * Set the tags applied to a contact.
 *
 *   PUT { tagIds: string[] }
 *
 * Replace semantics — the array is the new full set. Tags not in the array
 * are removed, tags not previously on the contact are added. Cross-team tag
 * ids are silently filtered out (defense against id-stuffing).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;
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

  const contact = await db.contact.findFirst({ where: { id, teamId } });
  if (!contact) {
    return NextResponse.json({ error: "contact not found" }, { status: 404 });
  }

  // Filter to tags that belong to this team. Anyone trying to apply a
  // foreign-team tag id just gets it dropped silently.
  const validIds =
    requestedIds.length === 0
      ? []
      : (
          await db.tag.findMany({
            where: { teamId, id: { in: requestedIds } },
            select: { id: true },
          })
        ).map((t) => t.id);

  const updated = await db.contact.update({
    where: { id },
    data: { tags: { set: validIds.map((tagId) => ({ id: tagId })) } },
  });

  // Broadcast so other viewers of this contact (sidebar rows, the active
  // thread, the contact panel) merge the new tag set in real time — matches
  // the contact:updated contract used by the PATCH route.
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
