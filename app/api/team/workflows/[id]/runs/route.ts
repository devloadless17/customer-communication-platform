import "server-only";

import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  const wf = await db.workflow.findFirst({
    where: { id, teamId: session.teamId },
    select: { id: true },
  });
  if (!wf) return NextResponse.json({ error: "not found" }, { status: 404 });

  const rows = await db.workflowRun.findMany({
    where: { workflowId: id },
    orderBy: { startedAt: "desc" },
    take: 50,
    select: {
      id: true,
      status: true,
      trigger: true,
      attempts: true,
      errorMessage: true,
      currentStepId: true,
      waitUntil: true,
      startedAt: true,
      finishedAt: true,
      stepLog: true,
    },
  });
  return NextResponse.json({
    runs: rows.map((r) => ({
      id: r.id,
      status: r.status,
      trigger: r.trigger,
      attempts: r.attempts,
      errorMessage: r.errorMessage,
      currentStepId: r.currentStepId,
      waitUntil: r.waitUntil?.toISOString() ?? null,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      // Summarized for the table; the [runId] route returns the full payload.
      stepCount: Array.isArray(r.stepLog) ? r.stepLog.length : 0,
    })),
  });
}
