import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { getAudienceGroup } from "@/lib/queries";

/**
 * Audience group detail.
 *
 *   GET    → group with current member count + member ids preview.
 *   PATCH  → update name/description/tags/contacts. Each field optional;
 *            tags + contacts are full-replace ("set") semantics when sent.
 *   DELETE → drop the group. Broadcasts that referenced it keep their
 *            `audienceGroupName` snapshot for the audit trail.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PatchBody {
  name?: unknown;
  description?: unknown;
  tagIds?: unknown;
  contactIds?: unknown;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;
  const { id } = await ctx.params;
  const group = await getAudienceGroup(teamId, id);
  if (!group) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ group });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;
  const { id } = await ctx.params;

  let raw: PatchBody;
  try {
    raw = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const existing = await db.audienceGroup.findFirst({ where: { id, teamId } });
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const data: {
    name?: string;
    description?: string | null;
    tags?: { set: { id: string }[] };
    contacts?: { set: { id: string }[] };
  } = {};

  if (raw.name !== undefined) {
    if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }
    if (raw.name.length > 80) {
      return NextResponse.json({ error: "name too long" }, { status: 400 });
    }
    data.name = raw.name.trim();
  }

  if (raw.description !== undefined) {
    if (raw.description === null || raw.description === "") {
      data.description = null;
    } else if (typeof raw.description === "string") {
      data.description = raw.description.trim().slice(0, 500);
    } else {
      return NextResponse.json(
        { error: "description must be string or null" },
        { status: 400 },
      );
    }
  }

  if (raw.tagIds !== undefined) {
    if (!Array.isArray(raw.tagIds)) {
      return NextResponse.json({ error: "tagIds must be array" }, { status: 400 });
    }
    const requested = raw.tagIds.filter((x): x is string => typeof x === "string");
    const owned = await db.tag.findMany({
      where: { teamId, id: { in: requested } },
      select: { id: true },
    });
    data.tags = { set: owned.map((t) => ({ id: t.id })) };
  }

  if (raw.contactIds !== undefined) {
    if (!Array.isArray(raw.contactIds)) {
      return NextResponse.json({ error: "contactIds must be array" }, { status: 400 });
    }
    const requested = raw.contactIds.filter((x): x is string => typeof x === "string");
    const owned = await db.contact.findMany({
      where: { teamId, id: { in: requested } },
      select: { id: true },
    });
    data.contacts = { set: owned.map((c) => ({ id: c.id })) };
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  try {
    await db.audienceGroup.update({ where: { id }, data });
    const updated = await getAudienceGroup(teamId, id);
    return NextResponse.json({ group: updated });
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "name taken", detail: `A group with that name already exists.` },
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
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;
  const { id } = await ctx.params;

  const existing = await db.audienceGroup.findFirst({ where: { id, teamId } });
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  await db.audienceGroup.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
