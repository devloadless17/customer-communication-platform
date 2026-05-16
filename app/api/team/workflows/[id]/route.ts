import "server-only";

import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { emitCatalogChange } from "@/lib/socket/server";

import { parseWorkflowBody, redactGraph, type WorkflowBody } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  const row = await db.workflow.findFirst({
    where: { id, teamId: session.teamId },
  });
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json({
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    published: row.published,
    trigger: row.trigger,
    triggerConfig: row.triggerConfig,
    triggerConditions: row.triggerConditions,
    triggerOncePerContact: row.triggerOncePerContact,
    graph: redactGraph(row.graph as unknown as ReturnType<typeof redactGraph>),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export async function PATCH(
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

  let body: WorkflowBody;
  try {
    body = (await req.json()) as WorkflowBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // For PATCH we accept partial bodies — fold the incoming fields over the
  // existing row and validate the merged result. This keeps the canvas's
  // auto-save shape (graph-only updates) trivial without losing trigger /
  // conditions validation.
  const merged: WorkflowBody = {
    name: body.name ?? existing.name,
    enabled: body.enabled === undefined ? existing.enabled : body.enabled,
    trigger: body.trigger ?? existing.trigger,
    triggerConfig: body.triggerConfig ?? existing.triggerConfig,
    triggerConditions: body.triggerConditions ?? existing.triggerConditions,
    triggerOncePerContact:
      body.triggerOncePerContact === undefined ? existing.triggerOncePerContact : body.triggerOncePerContact,
    graph: body.graph ?? existing.graph,
    // PATCH never publishes — clients use /publish to flip the bit.
    published: existing.published,
  };

  // Merge-merge: secrets that admins didn't re-enter (bearer tokens etc.) get
  // restored from the existing graph so they survive a save. We compare step
  // configs by id; any step whose incoming config drops a secret recovers
  // it from the matching existing step.
  if (body.graph) {
    const oldNodes = (existing.graph as { nodes?: Array<{ id: string; type: string; config: unknown }> }).nodes ?? [];
    const incomingNodes = (merged.graph as { nodes?: Array<{ id: string; type: string; config: unknown }> }).nodes ?? [];
    for (const inN of incomingNodes) {
      const oldN = oldNodes.find((n) => n.id === inN.id);
      if (!oldN || oldN.type !== inN.type) continue;
      const inCfg = inN.config as Record<string, unknown>;
      const oldCfg = oldN.config as Record<string, unknown>;
      // http_request: preserve bearerToken when not re-entered.
      if (inN.type === "http_request" && !inCfg.bearerToken && typeof oldCfg.bearerToken === "string") {
        inCfg.bearerToken = oldCfg.bearerToken;
      }
    }
  }

  const parsed = parseWorkflowBody(merged);
  if (parsed.errors.length > 0) {
    return NextResponse.json(
      { error: "validation failed", details: parsed.errors, stepErrors: parsed.stepErrors },
      { status: 400 },
    );
  }

  try {
    const updated = await db.workflow.update({
      where: { id },
      data: {
        name: parsed.name,
        enabled: parsed.enabled,
        trigger: parsed.trigger,
        triggerConfig: parsed.triggerConfig as Prisma.InputJsonValue,
        triggerConditions: parsed.triggerConditions as Prisma.InputJsonValue,
        triggerOncePerContact: parsed.triggerOncePerContact,
        graph: parsed.graph as unknown as Prisma.InputJsonValue,
      },
    });
    emitCatalogChange(session.teamId, "workflows");
    return NextResponse.json({
      id: updated.id,
      name: updated.name,
      enabled: updated.enabled,
      published: updated.published,
      trigger: updated.trigger,
      triggerConfig: updated.triggerConfig,
      triggerConditions: updated.triggerConditions,
      triggerOncePerContact: updated.triggerOncePerContact,
      graph: redactGraph(updated.graph as unknown as ReturnType<typeof redactGraph>),
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json(
        { error: "name already in use", details: [`A workflow named "${parsed.name}" already exists.`] },
        { status: 409 },
      );
    }
    throw err;
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  const existing = await db.workflow.findFirst({
    where: { id, teamId: session.teamId },
    select: { id: true },
  });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  await db.workflow.delete({ where: { id } });
  emitCatalogChange(session.teamId, "workflows");
  return NextResponse.json({ ok: true });
}
