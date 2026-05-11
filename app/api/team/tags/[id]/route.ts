import { NextResponse } from "next/server";

import { getSession } from "@/lib/current-user";
import { db } from "@/lib/db";
import { TAG_COLORS, type TagColor } from "@/lib/types";

/**
 * Tag detail: rename / recolor / delete.
 *
 *   PATCH  → update name and/or color
 *   DELETE → drop the tag. The implicit M2M join rows go with it; contacts
 *            simply lose this tag.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { teamId } = await getSession();
  const { id } = await ctx.params;

  let raw: { name?: unknown; color?: unknown };
  try {
    raw = (await req.json()) as typeof raw;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // Ownership gate before any write — server never trusts the id from the
  // request body alone.
  const existing = await db.tag.findFirst({ where: { id, teamId } });
  if (!existing) {
    return NextResponse.json({ error: "tag not found" }, { status: 404 });
  }

  const data: { name?: string; color?: TagColor } = {};
  if (typeof raw.name === "string") {
    const next = raw.name.trim();
    if (!next) {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }
    if (next.length > 40) {
      return NextResponse.json(
        { error: "name too long", detail: "Max 40 characters." },
        { status: 400 },
      );
    }
    data.name = next;
  }
  if (typeof raw.color === "string" && (TAG_COLORS as string[]).includes(raw.color)) {
    data.color = raw.color as TagColor;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  try {
    const updated = await db.tag.update({ where: { id }, data });
    return NextResponse.json({
      tag: {
        id: updated.id,
        teamId: updated.teamId,
        name: updated.name,
        color: updated.color as TagColor,
      },
    });
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "name taken", detail: `A tag with that name already exists.` },
        { status: 409 },
      );
    }
    throw err;
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { teamId } = await getSession();
  const { id } = await ctx.params;

  const existing = await db.tag.findFirst({ where: { id, teamId } });
  if (!existing) {
    return NextResponse.json({ error: "tag not found" }, { status: 404 });
  }

  await db.tag.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
