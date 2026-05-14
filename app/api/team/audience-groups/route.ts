import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { getAudienceGroup, listAudienceGroups } from "@/lib/queries";

/**
 * Audience groups: list + create.
 *
 *   GET  → all groups for the team with current member counts.
 *   POST → create a new group. Body: { name, description?, tagIds?, contactIds? }
 *
 * Empty groups (no tags and no contacts) are allowed at creation — the
 * agent might add members later via PATCH. The broadcast wizard rejects
 * empty groups at send time, not here.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;
  const groups = await listAudienceGroups(teamId);
  return NextResponse.json({ groups });
}

interface CreateBody {
  name?: unknown;
  description?: unknown;
  tagIds?: unknown;
  contactIds?: unknown;
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { userId, teamId } = session;

  let raw: CreateBody;
  try {
    raw = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  if (name.length > 80) {
    return NextResponse.json(
      { error: "name too long", detail: "Max 80 characters." },
      { status: 400 },
    );
  }
  const description =
    typeof raw.description === "string" && raw.description.trim().length > 0
      ? raw.description.trim().slice(0, 500)
      : null;

  const requestedTagIds = Array.isArray(raw.tagIds)
    ? raw.tagIds.filter((x): x is string => typeof x === "string")
    : [];
  const requestedContactIds = Array.isArray(raw.contactIds)
    ? raw.contactIds.filter((x): x is string => typeof x === "string")
    : [];

  // Cross-team id stuffing defense: filter to ids that actually belong to
  // this team. Foreign ids get silently dropped.
  const validTagIds = await ownedIds("tag", teamId, requestedTagIds);
  const validContactIds = await ownedIds("contact", teamId, requestedContactIds);

  try {
    const created = await db.audienceGroup.create({
      data: {
        teamId,
        createdById: userId,
        name,
        description,
        tags: { connect: validTagIds.map((id) => ({ id })) },
        contacts: { connect: validContactIds.map((id) => ({ id })) },
      },
      select: { id: true },
    });

    const dto = await getAudienceGroup(teamId, created.id);
    return NextResponse.json({ group: dto });
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "name taken", detail: `A group named "${name}" already exists.` },
        { status: 409 },
      );
    }
    throw err;
  }
}

async function ownedIds(
  kind: "tag" | "contact",
  teamId: string,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows =
    kind === "tag"
      ? await db.tag.findMany({
          where: { teamId, id: { in: ids } },
          select: { id: true },
        })
      : await db.contact.findMany({
          where: { teamId, id: { in: ids } },
          select: { id: true },
        });
  return rows.map((r) => r.id);
}
