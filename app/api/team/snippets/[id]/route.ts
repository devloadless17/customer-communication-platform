import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

import { getSession } from "@/lib/current-user";
import { db } from "@/lib/db";

/**
 * Per-snippet routes.
 *   PATCH  → update label / body / name (rare).
 *   DELETE → remove. No cascade work needed — snippets aren't referenced.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PatchBody {
  name?: unknown;
  label?: unknown;
  body?: unknown;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { teamId } = await getSession();
  const { id } = await params;

  let raw: PatchBody;
  try {
    raw = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const data: { name?: string; label?: string; body?: string } = {};

  if (raw.name !== undefined) {
    const name = typeof raw.name === "string" ? raw.name.trim().toLowerCase() : "";
    if (!/^[a-z0-9_]{1,64}$/.test(name)) {
      return NextResponse.json(
        { error: "invalid name", detail: "Use lowercase letters, digits and underscores only." },
        { status: 400 },
      );
    }
    data.name = name;
  }
  if (raw.label !== undefined) {
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    if (label.length === 0 || label.length > 80) {
      return NextResponse.json(
        { error: "invalid label", detail: "Label is required and must be ≤ 80 chars." },
        { status: 400 },
      );
    }
    data.label = label;
  }
  if (raw.body !== undefined) {
    const body = typeof raw.body === "string" ? raw.body : "";
    if (body.trim().length === 0 || body.length > 4000) {
      return NextResponse.json(
        { error: "invalid body", detail: "Body is required and must be ≤ 4000 chars." },
        { status: 400 },
      );
    }
    data.body = body;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  try {
    const updated = await db.snippet.updateMany({
      where: { id, teamId },
      data,
    });
    if (updated.count === 0) {
      return NextResponse.json({ error: "snippet not found" }, { status: 404 });
    }
    revalidateTag("snippets");
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "name already in use", detail: "Another snippet already uses that name." },
        { status: 409 },
      );
    }
    throw err;
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { teamId } = await getSession();
  const { id } = await params;
  const result = await db.snippet.deleteMany({ where: { id, teamId } });
  if (result.count === 0) {
    return NextResponse.json({ error: "snippet not found" }, { status: 404 });
  }
  revalidateTag("snippets");
  return NextResponse.json({ ok: true });
}
