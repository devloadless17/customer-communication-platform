import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { canManageStages } from "@/lib/auth/permissions";
import { emitCatalogChange } from "@/lib/socket/server";
import { TAG_COLORS, type ContactStage, type TagColor } from "@/lib/types";

/**
 * Mutate a single customer-lifecycle stage.
 *
 *  PATCH  — rename, recolor, promote to default. Reorder lives on the
 *           sibling /reorder route so a bulk drag-drop is one round-trip.
 *  DELETE — drop the row. Blocked while contacts are still parked in this
 *           stage; the admin has to move them first (see /contacts filter +
 *           bulk-move flow). Mirrors what the AskUserQuestion answer asked
 *           for: safest, never silently moves contacts.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_NAME = 60;

interface PatchBody {
  name?: unknown;
  color?: unknown;
  isDefault?: unknown;
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  if (!canManageStages(session.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;

  let raw: PatchBody;
  try {
    raw = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const update: { name?: string; color?: TagColor; isDefault?: boolean } = {};

  if (raw.name !== undefined) {
    if (typeof raw.name !== "string") {
      return NextResponse.json({ error: "name must be a string" }, { status: 400 });
    }
    const trimmed = raw.name.trim();
    if (!trimmed) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (trimmed.length > MAX_NAME) {
      return NextResponse.json({ error: "name too long" }, { status: 400 });
    }
    update.name = trimmed;
  }

  if (raw.color !== undefined) {
    if (typeof raw.color !== "string") {
      return NextResponse.json({ error: "color must be a string" }, { status: 400 });
    }
    if (!(TAG_COLORS as readonly string[]).includes(raw.color)) {
      return NextResponse.json({ error: "unknown color" }, { status: 400 });
    }
    update.color = raw.color as TagColor;
  }

  if (raw.isDefault !== undefined) {
    if (typeof raw.isDefault !== "boolean") {
      return NextResponse.json(
        { error: "isDefault must be a boolean" },
        { status: 400 },
      );
    }
    update.isDefault = raw.isDefault;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  }

  const existing = await db.contactStage.findFirst({
    where: { id, teamId: session.teamId },
    select: { id: true, isDefault: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Promoting a row to default has to demote the previous default in the
  // same transaction — otherwise we'd have two defaults in a row's worth of
  // wall-clock and the contacts/create path could pick the wrong one.
  // Demoting the current default is not allowed; admins promote a different
  // stage instead (or delete the row, which is gated separately).
  if (update.isDefault === false && existing.isDefault) {
    return NextResponse.json(
      {
        error:
          "can't unset isDefault directly — promote another stage to default instead",
      },
      { status: 400 },
    );
  }

  try {
    const updated = await db.$transaction(async (tx) => {
      if (update.isDefault === true && !existing.isDefault) {
        await tx.contactStage.updateMany({
          where: { teamId: session.teamId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.contactStage.update({ where: { id }, data: update });
    });

    revalidateTag("contact-stages");
    emitCatalogChange(session.teamId, "stages");
    const stage: ContactStage = {
      id: updated.id,
      teamId: updated.teamId,
      name: updated.name,
      color: updated.color as TagColor,
      position: updated.position,
      isDefault: updated.isDefault,
    };
    return NextResponse.json({ stage });
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
    console.error("[api/team/stages PATCH] failed", err);
    return NextResponse.json({ error: "update failed" }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  if (!canManageStages(session.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;

  const stage = await db.contactStage.findFirst({
    where: { id, teamId: session.teamId },
    select: { id: true, isDefault: true },
  });
  if (!stage) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Block-delete-with-contacts (per chosen UX). The error carries the count
  // so the UI can render a useful "12 contacts still here — move them
  // first" message without a second round-trip.
  const contactCount = await db.contact.count({
    where: { teamId: session.teamId, stageId: id },
  });
  if (contactCount > 0) {
    return NextResponse.json(
      {
        error: "stage in use",
        detail: `${contactCount} contact${contactCount === 1 ? " is" : "s are"} still in this stage. Move them to another stage first.`,
        contactCount,
      },
      { status: 409 },
    );
  }

  // Promoting another stage to default before delete is the admin's job —
  // we never silently shift it. If they're deleting the default and there
  // ARE other stages, refuse and ask them to promote one first; if this is
  // the LAST stage, allow the delete (the team will be stage-less until
  // they re-create one, and ensureDefaultStage handles that path).
  if (stage.isDefault) {
    const otherCount = await db.contactStage.count({
      where: { teamId: session.teamId, NOT: { id } },
    });
    if (otherCount > 0) {
      return NextResponse.json(
        {
          error: "default stage",
          detail:
            "This is the default stage. Promote another stage to default before deleting.",
        },
        { status: 409 },
      );
    }
  }

  await db.contactStage.delete({ where: { id } });
  revalidateTag("contact-stages");
  emitCatalogChange(session.teamId, "stages");
  return NextResponse.json({ ok: true });
}
