import "server-only";

import { Prisma } from "@prisma/client";
import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { enqueueWorkflowRun } from "@/lib/workflows/queue";

/**
 * POST /api/team/workflows/[id]/incoming-webhook
 *
 * The per-workflow inbound URL. Authentication is via an HMAC-SHA256
 * signature in the `X-Workflow-Signature` header — the secret is stored in
 * triggerConfig.secret on the workflow itself, generated when the admin
 * picks the `incoming_webhook` trigger.
 *
 *   X-Workflow-Signature: hex-encoded HMAC-SHA256 of the raw body
 *
 * The body is passed verbatim into the run's eventPayload.body so step
 * handlers can read it via `$var.body.*` tokens (round 2c — for now the
 * raw body is accessible via the envelope's `data` object).
 *
 * Public endpoint by design — no session required. Signature is the gate.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const wf = await db.workflow.findFirst({
    where: { id },
    select: {
      id: true,
      teamId: true,
      trigger: true,
      enabled: true,
      published: true,
      triggerConfig: true,
    },
  });
  if (!wf) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (wf.trigger !== "incoming_webhook") {
    return NextResponse.json(
      { error: "workflow trigger is not incoming_webhook" },
      { status: 404 },
    );
  }
  if (!wf.enabled || !wf.published) {
    return NextResponse.json(
      { error: "workflow is disabled or unpublished" },
      { status: 409 },
    );
  }

  const secret = (wf.triggerConfig as { secret?: string })?.secret;
  if (!secret) {
    return NextResponse.json(
      { error: "workflow not configured with a signature secret" },
      { status: 500 },
    );
  }

  const rawBody = await req.text();
  const signatureHeader = req.headers.get("x-workflow-signature") ?? "";
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (signatureHeader.length !== expected.length) {
    return NextResponse.json({ error: "invalid signature" }, { status: 403 });
  }
  try {
    const a = Buffer.from(signatureHeader, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (!timingSafeEqual(a, b)) {
      return NextResponse.json({ error: "invalid signature" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 403 });
  }

  let parsedBody: unknown = null;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsedBody = { raw: rawBody };
  }

  // Header pass-through — strip the signature header we just used so the
  // step handler doesn't accidentally proxy it onward.
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    if (k.toLowerCase() === "x-workflow-signature") return;
    headers[k] = v;
  });

  const eventPayload = {
    contact: null,
    body: parsedBody,
    headers,
  };

  const run = await db.workflowRun.create({
    data: {
      workflowId: wf.id,
      teamId: wf.teamId,
      trigger: "incoming_webhook",
      contactId: null,
      conversationId: null,
      eventPayload: eventPayload as Prisma.InputJsonValue,
      status: "queued",
    },
    select: { id: true },
  });
  await enqueueWorkflowRun(run.id);
  return NextResponse.json({ ok: true, runId: run.id });
}
