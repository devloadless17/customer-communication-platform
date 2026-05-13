import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

import { requireSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { canManageStages } from "@/lib/permissions";
import { TAG_COLORS, type ContactStage, type TagColor } from "@/lib/types";

/**
 * Team-wide customer-lifecycle stages.
 *
 *  GET  — anyone signed-in (the contact panel + contacts table need to
 *         render the catalog for everyone).
 *  POST — admin / manager / superAdmin. Adds a new stage at the end of the
 *         list; the first stage to be created (or the only one) auto-flags
 *         as `isDefault`.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_NAME = 60;
const MAX_STAGES_PER_TEAM = 30;

interface PostBody {
  name?: unknown;
  color?: unknown;
}

export async function GET() {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const rows = await db.contactStage.findMany({
    where: { teamId: session.teamId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  const stages: ContactStage[] = rows.map((r) => ({
    id: r.id,
    teamId: r.teamId,
    name: r.name,
    color: r.color as TagColor,
    position: r.position,
    isDefault: r.isDefault,
  }));
  return NextResponse.json({ stages });
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  if (!canManageStages(session.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let raw: PostBody;
  try {
    raw = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (name.length > MAX_NAME) {
    return NextResponse.json({ error: "name too long" }, { status: 400 });
  }

  const color = pickColor(raw.color);

  // Single round-trip to learn the existing rows: the count gate, the next
  // position, and whether ANY default exists (so the very first stage gets
  // promoted to default automatically — a team with zero stages would
  // otherwise have nowhere to put new contacts).
  const existing = await db.contactStage.findMany({
    where: { teamId: session.teamId },
    select: { id: true, position: true, isDefault: true },
    orderBy: { position: "desc" },
  });
  if (existing.length >= MAX_STAGES_PER_TEAM) {
    return NextResponse.json(
      { error: `at most ${MAX_STAGES_PER_TEAM} stages per team` },
      { status: 400 },
    );
  }

  const nextPosition = (existing[0]?.position ?? -1) + 1;
  const isDefault = existing.length === 0;

  try {
    const created = await db.contactStage.create({
      data: {
        teamId: session.teamId,
        name,
        color,
        position: nextPosition,
        isDefault,
      },
    });
    revalidateTag("contact-stages");

    const stage: ContactStage = {
      id: created.id,
      teamId: created.teamId,
      name: created.name,
      color: created.color as TagColor,
      position: created.position,
      isDefault: created.isDefault,
    };
    return NextResponse.json({ stage }, { status: 201 });
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "a stage with this name already exists" },
        { status: 409 },
      );
    }
    console.error("[api/team/stages/POST] failed", err);
    return NextResponse.json({ error: "create failed" }, { status: 500 });
  }
}

function pickColor(v: unknown): TagColor {
  if (typeof v !== "string") return "slate";
  return (TAG_COLORS as readonly string[]).includes(v) ? (v as TagColor) : "slate";
}
