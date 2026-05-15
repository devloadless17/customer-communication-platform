import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { canManageContactFields } from "@/lib/auth/permissions";
import { emitCatalogChange } from "@/lib/socket/server";
import type { ContactFieldDefinition } from "@/lib/types";

/**
 * Mutate a single team-wide contact field definition.
 *
 *  PATCH  — rename label or change order. Key is intentionally NOT mutable —
 *           Contact.customFields rows are keyed by it; renaming would orphan
 *           every contact's data.
 *  DELETE — remove the definition AND strip the key from every contact's
 *           customFields in the same transaction. Without that strip,
 *           contacts would keep showing "ghost" fields the team chose to
 *           drop, which is confusing and bloats every row's JSON.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LABEL = 60;

interface PatchBody {
  label?: unknown;
  order?: unknown;
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  if (!canManageContactFields(session.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;

  let raw: PatchBody;
  try {
    raw = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const update: { label?: string; order?: number } = {};

  if (raw.label !== undefined) {
    if (typeof raw.label !== "string") {
      return NextResponse.json({ error: "label must be a string" }, { status: 400 });
    }
    const trimmed = raw.label.trim();
    if (!trimmed) {
      return NextResponse.json({ error: "label is required" }, { status: 400 });
    }
    if (trimmed.length > MAX_LABEL) {
      return NextResponse.json({ error: "label too long" }, { status: 400 });
    }
    update.label = trimmed;
  }

  if (raw.order !== undefined) {
    if (typeof raw.order !== "number" || !Number.isFinite(raw.order)) {
      return NextResponse.json({ error: "order must be a number" }, { status: 400 });
    }
    update.order = Math.floor(raw.order);
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  }

  // Scope by teamId so a malicious client can't mutate another tenant's
  // definitions even by guessing the id.
  const existing = await db.contactFieldDefinition.findFirst({
    where: { id, teamId: session.teamId },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const updated = await db.contactFieldDefinition.update({
    where: { id },
    data: update,
  });
  const definition: ContactFieldDefinition = {
    id: updated.id,
    teamId: updated.teamId,
    key: updated.key,
    label: updated.label,
    order: updated.order,
  };
  emitCatalogChange(session.teamId, "contact-fields");
  return NextResponse.json({ definition });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  if (!canManageContactFields(session.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;

  const def = await db.contactFieldDefinition.findFirst({
    where: { id, teamId: session.teamId },
  });
  if (!def) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Strip the key from every contact's customFields in the same transaction
  // as the definition delete. Postgres has a JSONB `-` operator which is
  // exactly the right tool here; Prisma doesn't expose it as typed update
  // args so we drop to $executeRaw. The `?` operator (key existence) is the
  // only filter that touches the JSON column, keeping the WHERE indexable on
  // teamId for the bulk path.
  await db.$transaction([
    db.$executeRaw`
      UPDATE "Contact"
      SET "customFields" = "customFields" - ${def.key}
      WHERE "teamId" = ${session.teamId}
        AND "customFields" ? ${def.key}
    `,
    db.contactFieldDefinition.delete({ where: { id } }),
  ]);

  emitCatalogChange(session.teamId, "contact-fields");
  return NextResponse.json({ ok: true });
}
