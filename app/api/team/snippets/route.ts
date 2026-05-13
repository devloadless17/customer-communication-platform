import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

import { getSession } from "@/lib/current-user";
import { db } from "@/lib/db";

/**
 * Team snippets CRUD.
 *
 *   GET  → list every snippet (no pagination — these are small, low-N rows
 *          and the reply-box picker needs the full set on first open anyway)
 *   POST → create a new snippet
 *
 * Authorization: anyone on the team can create / read for v1. The model
 * has `createdById` so we can layer per-user permissions later (e.g.
 * "edit own only, admin edits all") without a migration.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  name?: unknown;
  label?: unknown;
  body?: unknown;
}

export async function GET() {
  const { teamId } = await getSession();
  const rows = await db.snippet.findMany({
    where: { teamId },
    orderBy: [{ label: "asc" }],
    include: { createdBy: { select: { id: true, name: true } } },
  });
  return NextResponse.json({
    snippets: rows.map((r) => ({
      id: r.id,
      name: r.name,
      label: r.label,
      body: r.body,
      createdById: r.createdById,
      createdByName: r.createdBy.name,
      updatedAt: r.updatedAt.toISOString(),
    })),
  });
}

export async function POST(req: Request) {
  const { user, teamId } = await getSession();

  let raw: Body;
  try {
    raw = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const name = typeof raw.name === "string" ? raw.name.trim().toLowerCase() : "";
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  const body = typeof raw.body === "string" ? raw.body : "";

  if (!/^[a-z0-9_]{1,64}$/.test(name)) {
    return NextResponse.json(
      {
        error: "invalid name",
        detail: "Use lowercase letters, digits and underscores only (max 64 chars).",
      },
      { status: 400 },
    );
  }
  if (label.trim().length === 0 || label.length > 80) {
    return NextResponse.json(
      { error: "invalid label", detail: "Label is required and must be ≤ 80 chars." },
      { status: 400 },
    );
  }
  if (body.trim().length === 0 || body.length > 4000) {
    return NextResponse.json(
      { error: "invalid body", detail: "Body is required and must be ≤ 4000 chars." },
      { status: 400 },
    );
  }

  try {
    const created = await db.snippet.create({
      data: { teamId, name, label, body, createdById: user.id },
    });
    // Invalidate the inbox-layout's cached snippet list so the next
    // navigation hydrates the new row immediately.
    revalidateTag("snippets");
    return NextResponse.json({ ok: true, id: created.id });
  } catch (err) {
    // Unique constraint on (teamId, name) — friendly error.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "name already in use", detail: `A snippet named "${name}" already exists.` },
        { status: 409 },
      );
    }
    throw err;
  }
}
