import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
import { MetaSendError, MissingWabaIdError } from "@/lib/providers/meta";

/**
 * Per-template operations.
 *
 *   DELETE → remove from Meta first, then from our cache. A failure on Meta
 *            keeps the local row so a re-sync stays consistent — otherwise
 *            admins would see "deleted" in the app while the template stays
 *            active in WhatsApp Manager.
 *   PATCH  → update variableBindings only (the part of the template our app
 *            owns; Meta doesn't see this column). Submitting a new template
 *            content goes through POST /create + DELETE the old one.
 *
 * Both routes are admin-style for now (no role gate) since the team-level
 * gating happens at the session lookup — a contact on team A can never see
 * team B's templates. Tighten to admin-only when we add roles.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;
  const { id } = await params;

  const template = await db.messageTemplate.findFirst({
    where: { id, teamId },
  });
  if (!template) {
    return NextResponse.json({ error: "template not found" }, { status: 404 });
  }

  // Meta delete must succeed before we drop the local row. The provider
  // already treats Meta's 404 as success, so re-deleting an already-gone
  // template still cleans up the local cache.
  let config;
  try {
    config = await getMetaSendConfig(teamId);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      return NextResponse.json(
        { error: "whatsapp not connected", detail: err.message },
        { status: 409 },
      );
    }
    throw err;
  }

  const provider = getMetaProvider();
  if (!provider.deleteTemplate) {
    return NextResponse.json(
      { error: "provider does not support template delete" },
      { status: 501 },
    );
  }

  try {
    await provider.deleteTemplate(
      {
        name: template.name,
        ...(template.externalId ? { externalId: template.externalId } : {}),
      },
      config,
    );
  } catch (err) {
    if (err instanceof MissingWabaIdError) {
      return NextResponse.json(
        {
          error: "waba id missing",
          detail:
            "Add your WhatsApp Business Account ID in Settings → WhatsApp before deleting templates.",
        },
        { status: 409 },
      );
    }
    if (err instanceof MetaSendError) {
      return NextResponse.json(
        {
          error: "meta rejected request",
          status: err.httpStatus,
          detail: err.body.slice(0, 500),
        },
        { status: 422 },
      );
    }
    console.error("[api/templates/[id]] delete on Meta failed", err);
    return NextResponse.json(
      {
        error: "delete failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  await db.messageTemplate.delete({ where: { id: template.id } });
  return NextResponse.json({ ok: true });
}

interface PatchBody {
  variableBindings?: unknown;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;
  const { id } = await params;

  let raw: PatchBody;
  try {
    raw = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (raw.variableBindings === undefined) {
    return NextResponse.json(
      { error: "nothing to update", detail: "Only variableBindings is patchable." },
      { status: 400 },
    );
  }

  // Generous on shape — the runner re-parses the bindings on every read so a
  // bad write degrades to the legacy `manual` behavior, not a crash. We just
  // require it to be an object so we don't store a primitive in a JSONB col.
  const bindings = raw.variableBindings;
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    return NextResponse.json(
      { error: "invalid bindings", detail: "Expected an object." },
      { status: 400 },
    );
  }

  const updated = await db.messageTemplate.updateMany({
    where: { id, teamId },
    data: { variableBindings: bindings as Prisma.InputJsonValue },
  });
  if (updated.count === 0) {
    return NextResponse.json({ error: "template not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
