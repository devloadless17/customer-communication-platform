import "server-only";

import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string; runId: string }> },
) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;
  const { id, runId } = await ctx.params;

  const run = await db.workflowRun.findFirst({
    where: { id: runId, workflowId: id, teamId: session.teamId },
  });
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json({
    id: run.id,
    workflowId: run.workflowId,
    status: run.status,
    trigger: run.trigger,
    contactId: run.contactId,
    conversationId: run.conversationId,
    currentStepId: run.currentStepId,
    waitUntil: run.waitUntil?.toISOString() ?? null,
    jumpsUsed: run.jumpsUsed,
    attempts: run.attempts,
    errorMessage: run.errorMessage,
    eventPayload: run.eventPayload,
    stepLog: run.stepLog,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  });
}
