import "server-only";

import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";

/**
 * GET /api/team/automations/[id]/runs
 *
 * Return the most recent 50 runs for this automation, newest first. Used by
 * the rule's detail page to render the runs table. No pagination yet —
 * runs older than the cap are pruned by the cron in worker (planned).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  const auto = await db.automation.findFirst({
    where: { id, teamId: session.teamId },
    select: { id: true },
  });
  if (!auto) return NextResponse.json({ error: "not found" }, { status: 404 });

  const rows = await db.automationRun.findMany({
    where: { automationId: id },
    orderBy: { startedAt: "desc" },
    take: 50,
    select: {
      id: true,
      status: true,
      trigger: true,
      attempts: true,
      responseStatus: true,
      responseBody: true,
      errorMessage: true,
      startedAt: true,
      finishedAt: true,
    },
  });
  return NextResponse.json({
    runs: rows.map((r) => ({
      id: r.id,
      status: r.status,
      trigger: r.trigger,
      attempts: r.attempts,
      responseStatus: r.responseStatus,
      responseBody: r.responseBody,
      errorMessage: r.errorMessage,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    })),
  });
}
