import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { canManageContactFields } from "@/lib/auth/permissions";
import { emitCatalogChange } from "@/lib/socket/server";
import type { ContactFieldDefinition } from "@/lib/types";

/**
 * Team-wide contact field definitions.
 *
 *  GET  — anyone signed-in (the panel needs to render the schema for everyone).
 *  POST — admin / manager only. Adds a definition; key is derived from label
 *         and is immutable so existing Contact.customFields[key] keeps
 *         pointing at the right column.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LABEL = 60;
const MAX_FIELDS_PER_TEAM = 50;

interface PostBody {
  label?: unknown;
}

export async function GET() {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const rows = await db.contactFieldDefinition.findMany({
    where: { teamId: session.teamId },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
  const definitions: ContactFieldDefinition[] = rows.map((r) => ({
    id: r.id,
    teamId: r.teamId,
    key: r.key,
    label: r.label,
    order: r.order,
  }));
  return NextResponse.json({ definitions });
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  if (!canManageContactFields(session.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let raw: PostBody;
  try {
    raw = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (!label) {
    return NextResponse.json({ error: "label is required" }, { status: 400 });
  }
  if (label.length > MAX_LABEL) {
    return NextResponse.json({ error: "label too long" }, { status: 400 });
  }

  // Cap the number of definitions so a runaway client can't bloat the panel
  // (and the JSON column on every contact, since every key gets rendered).
  const existing = await db.contactFieldDefinition.findMany({
    where: { teamId: session.teamId },
    select: { key: true, order: true },
    orderBy: { order: "desc" },
    take: MAX_FIELDS_PER_TEAM,
  });
  if (existing.length >= MAX_FIELDS_PER_TEAM) {
    return NextResponse.json(
      { error: `at most ${MAX_FIELDS_PER_TEAM} contact fields per team` },
      { status: 400 },
    );
  }

  const baseKey = slugifyKey(label);
  if (!baseKey) {
    return NextResponse.json({ error: "label must contain letters or digits" }, { status: 400 });
  }

  // Disambiguate against existing keys in this team. Two fields with the same
  // label would otherwise crash on the [teamId, key] unique index.
  const usedKeys = new Set(existing.map((e) => e.key));
  let key = baseKey;
  let suffix = 2;
  while (usedKeys.has(key)) {
    key = `${baseKey}_${suffix++}`;
  }

  const nextOrder = (existing[0]?.order ?? -1) + 1;

  try {
    const created = await db.contactFieldDefinition.create({
      data: {
        teamId: session.teamId,
        key,
        label,
        order: nextOrder,
      },
    });
    const definition: ContactFieldDefinition = {
      id: created.id,
      teamId: created.teamId,
      key: created.key,
      label: created.label,
      order: created.order,
    };
    emitCatalogChange(session.teamId, "contact-fields");
    return NextResponse.json({ definition }, { status: 201 });
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json({ error: "field with that key already exists" }, { status: 409 });
    }
    console.error("[api/team/contact-fields/POST] failed", err);
    return NextResponse.json({ error: "create failed" }, { status: 500 });
  }
}

/**
 * Lowercase + underscored slug from a label. Keeps the key readable in
 * Postgres (so `customFields->>'order_id'` reads naturally in psql) without
 * letting users type collisions like "Order ID" vs "order id".
 */
function slugifyKey(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}
