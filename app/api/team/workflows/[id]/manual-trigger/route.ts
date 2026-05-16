import "server-only";

import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { dispatchManualTrigger } from "@/lib/workflows/dispatcher";

/**
 * POST /api/team/workflows/[id]/manual-trigger
 *
 *   { contactId: string, conversationId?: string, metadata?: Record<string,string> }
 *
 * Run a `manual_trigger` workflow on demand. Used by the inbox "Run workflow"
 * menu in the conversation panel + by Round-2c shortcuts. Available to
 * any agent (not admin-only) — but the workflow must actually be of
 * `trigger=manual_trigger` for this endpoint to work, otherwise it returns
 * 409. That gate keeps a curious user from re-firing, say, a "welcome"
 * workflow (which has its own one-shot semantics) outside the natural
 * trigger.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId, userId } = session;
  const { id } = await ctx.params;

  let body: { contactId?: unknown; conversationId?: unknown; metadata?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const contactId = typeof body.contactId === "string" ? body.contactId : null;
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
  const metadata =
    body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? Object.fromEntries(
          Object.entries(body.metadata as Record<string, unknown>).filter(
            (e): e is [string, string] => typeof e[1] === "string",
          ),
        )
      : {};

  if (!contactId) {
    return NextResponse.json({ error: "contactId required" }, { status: 400 });
  }

  const wf = await db.workflow.findFirst({
    where: { id, teamId },
    select: { id: true, trigger: true, enabled: true, published: true },
  });
  if (!wf) return NextResponse.json({ error: "workflow not found" }, { status: 404 });
  if (wf.trigger !== "manual_trigger") {
    return NextResponse.json(
      { error: "workflow trigger is not manual_trigger" },
      { status: 409 },
    );
  }
  if (!wf.enabled || !wf.published) {
    return NextResponse.json(
      { error: "workflow is disabled or unpublished" },
      { status: 409 },
    );
  }

  try {
    const runId = await dispatchManualTrigger({
      teamId,
      workflowId: id,
      contactId,
      conversationId,
      triggeredByUserId: userId,
      metadata,
    });
    return NextResponse.json({ ok: true, runId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "dispatch failed" },
      { status: 500 },
    );
  }
}
