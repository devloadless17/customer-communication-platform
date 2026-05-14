import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { canManageStages } from "@/lib/auth/permissions";

/**
 * Bulk-reorder the team's stage catalog.
 *
 * PATCH body: `{ orderedIds: string[] }`. Every id in the array gets its
 * `position` set to the array index; ids missing from the array are not
 * touched. This is the dumbest possible API the drag-drop UI can drive — no
 * fractional positions, no "move id X to slot Y" — and it works well at the
 * scale of stages (<30 per team, capped).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PatchBody {
  orderedIds?: unknown;
}

export async function PATCH(req: Request) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  if (!canManageStages(session.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let raw: PatchBody;
  try {
    raw = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!Array.isArray(raw.orderedIds)) {
    return NextResponse.json(
      { error: "orderedIds must be an array of stage ids" },
      { status: 400 },
    );
  }

  const ids = raw.orderedIds.filter((s): s is string => typeof s === "string" && s.length > 0);
  if (ids.length === 0) {
    return NextResponse.json({ ok: true });
  }
  if (new Set(ids).size !== ids.length) {
    return NextResponse.json({ error: "orderedIds has duplicates" }, { status: 400 });
  }

  // Confirm every id belongs to this team. Without this scope check a
  // malicious client could rewrite positions on another tenant's stages by
  // submitting their ids.
  const owned = await db.contactStage.findMany({
    where: { teamId: session.teamId, id: { in: ids } },
    select: { id: true },
  });
  if (owned.length !== ids.length) {
    return NextResponse.json(
      { error: "one or more ids are not in this team" },
      { status: 400 },
    );
  }

  await db.$transaction(
    ids.map((id, index) =>
      db.contactStage.update({ where: { id }, data: { position: index } }),
    ),
  );
  revalidateTag("contact-stages");

  return NextResponse.json({ ok: true });
}
