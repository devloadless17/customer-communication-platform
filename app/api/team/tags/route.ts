import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { TAG_COLORS, type Tag, type TagColor } from "@/lib/types";

/**
 * Team-wide tag catalog.
 *
 *   GET  → all tags, alphabetical
 *   POST → create a new tag (body: { name, color? })
 *
 * Tags are team-scoped — name unique within a team. Color falls back to
 * "slate" when omitted or unrecognized; the UI shows a color swatch picker
 * but the server is permissive so a stale client doesn't break creation.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;
  const rows = await db.tag.findMany({
    where: { teamId },
    orderBy: { name: "asc" },
  });
  const tags: Tag[] = rows.map((r) => ({
    id: r.id,
    teamId: r.teamId,
    name: r.name,
    color: normalizeColor(r.color),
  }));
  return NextResponse.json({ tags });
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;

  let raw: { name?: unknown; color?: unknown };
  try {
    raw = (await req.json()) as typeof raw;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  // Same length cap WhatsApp shows in template segmentation UIs — long enough
  // for any reasonable label, short enough to render in a chip.
  if (name.length > 40) {
    return NextResponse.json(
      { error: "name too long", detail: "Tag name must be 40 characters or fewer." },
      { status: 400 },
    );
  }

  const color = normalizeColor(raw.color);

  try {
    const created = await db.tag.create({
      data: { teamId, name, color },
    });
    return NextResponse.json({
      tag: {
        id: created.id,
        teamId: created.teamId,
        name: created.name,
        color: normalizeColor(created.color),
      } satisfies Tag,
    });
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "name taken", detail: `A tag named "${name}" already exists.` },
        { status: 409 },
      );
    }
    throw err;
  }
}

function normalizeColor(v: unknown): TagColor {
  if (typeof v !== "string") return "slate";
  return (TAG_COLORS as string[]).includes(v) ? (v as TagColor) : "slate";
}
