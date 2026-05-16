import "server-only";

import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { emitCatalogChange } from "@/lib/socket/server";
import { parseWorkflowBody } from "../../_shared";

/**
 * POST /api/team/workflows/[id]/publish
 *
 *   { publish: true | false }
 *
 * Flipping to published runs PUBLISH-tier validation against the stored
 * graph. Any error → 400, the workflow stays draft. Flipping to unpublished
 * never validates (you can always pull a published workflow offline).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  const existing = await db.workflow.findFirst({
    where: { id, teamId: session.teamId },
  });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  let raw: { publish?: unknown };
  try {
    raw = (await req.json()) as typeof raw;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const publish = raw.publish !== false;

  if (publish) {
    const parsed = parseWorkflowBody(
      {
        name: existing.name,
        enabled: existing.enabled,
        trigger: existing.trigger,
        triggerConfig: existing.triggerConfig,
        triggerConditions: existing.triggerConditions,
        triggerOncePerContact: existing.triggerOncePerContact,
        graph: existing.graph,
      },
      { forPublish: true },
    );
    if (parsed.errors.length > 0) {
      return NextResponse.json(
        {
          error: "cannot publish — fix validation errors first",
          details: parsed.errors,
          stepErrors: parsed.stepErrors,
        },
        { status: 400 },
      );
    }
  }

  await db.workflow.update({
    where: { id },
    data: { published: publish },
  });
  emitCatalogChange(session.teamId, "workflows");
  return NextResponse.json({ ok: true, published: publish });
}
