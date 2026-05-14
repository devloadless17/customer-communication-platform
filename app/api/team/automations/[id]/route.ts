import "server-only";

import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { parseWebhookConfig, ActionConfigError } from "@/lib/automations/actions/webhook";
import { validateConditions } from "@/lib/automations/conditions";

import { redactActionConfig } from "../_shared";

/**
 *   GET    /api/team/automations/[id]   → fetch one
 *   PATCH  /api/team/automations/[id]   → partial update
 *   DELETE /api/team/automations/[id]   → delete (cascades runs)
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

  const row = await db.automation.findFirst({
    where: { id, teamId: session.teamId },
  });
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json({
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    trigger: row.trigger,
    conditions: row.conditions,
    actionType: row.actionType,
    actionConfig: redactActionConfig(row.actionConfig),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

interface PatchBody {
  name?: unknown;
  enabled?: unknown;
  trigger?: unknown;
  conditions?: unknown;
  actionType?: unknown;
  actionConfig?: unknown;
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  const existing = await db.automation.findFirst({
    where: { id, teamId: session.teamId },
  });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const errors: string[] = [];
  const data: Prisma.AutomationUpdateInput = {};

  if (body.name !== undefined) {
    const n = typeof body.name === "string" ? body.name.trim() : "";
    if (!n) errors.push("name: required");
    else if (n.length > 100) errors.push("name: too long (max 100)");
    else data.name = n;
  }

  if (body.enabled !== undefined) {
    data.enabled = body.enabled !== false;
  }

  const VALID_TRIGGERS: ReadonlyArray<string> = [
    "message_received",
    "conversation_assigned",
    "conversation_status_changed",
  ];
  const effectiveTrigger =
    typeof body.trigger === "string" && VALID_TRIGGERS.includes(body.trigger)
      ? (body.trigger as typeof existing.trigger)
      : existing.trigger;
  if (body.trigger !== undefined && !VALID_TRIGGERS.includes(body.trigger as string)) {
    errors.push(`trigger: must be one of ${VALID_TRIGGERS.join(", ")}`);
  }
  if (body.trigger !== undefined) data.trigger = effectiveTrigger;

  if (body.conditions !== undefined) {
    const conditions = Array.isArray(body.conditions) ? body.conditions : [];
    errors.push(...validateConditions(effectiveTrigger, conditions));
    data.conditions = conditions as Prisma.InputJsonValue;
  }

  if (body.actionConfig !== undefined) {
    try {
      // Preserve the existing token when the UI omits bearerToken (blank
      // input = "keep current"). Without this, every save would clear the
      // stored token unless the admin re-typed it.
      const incoming = body.actionConfig as Record<string, unknown> | undefined;
      const merged: Record<string, unknown> = { ...(incoming ?? {}) };
      if (!merged.bearerToken) {
        const old = existing.actionConfig as { bearerToken?: string } | null;
        if (old && typeof old.bearerToken === "string") {
          merged.bearerToken = old.bearerToken;
        }
      }
      const cfg = parseWebhookConfig(merged);
      data.actionConfig = cfg as unknown as Prisma.InputJsonValue;
    } catch (err) {
      errors.push(`actionConfig: ${err instanceof ActionConfigError ? err.message : "invalid"}`);
    }
  }

  if (errors.length > 0) {
    return NextResponse.json({ error: "validation failed", details: errors }, { status: 400 });
  }

  const updated = await db.automation.update({ where: { id }, data });
  return NextResponse.json({
    id: updated.id,
    name: updated.name,
    enabled: updated.enabled,
    trigger: updated.trigger,
    conditions: updated.conditions,
    actionType: updated.actionType,
    actionConfig: redactActionConfig(updated.actionConfig),
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  const existing = await db.automation.findFirst({
    where: { id, teamId: session.teamId },
    select: { id: true },
  });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  // AutomationRun has onDelete: Cascade — history goes with the rule. If
  // long-lived audit becomes a requirement we keep the rule and just disable
  // it instead. For now, intentional cleanup.
  await db.automation.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
