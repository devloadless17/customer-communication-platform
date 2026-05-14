import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";

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

  await db.contact.update({
    where: { id },
    data: { tags: { set: validIds.map((tagId) => ({ id: tagId })) } },
  });

  return NextResponse.json({ ok: true, tagIds: validIds });
}
