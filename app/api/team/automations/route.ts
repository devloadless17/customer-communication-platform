import "server-only";

import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import {
  type CreateBody,
  parseAutomationBody,
  redactActionConfig,
} from "./_shared";

/**
 * Automation management API. Admin-only — automations can move money via
 * webhooks and send WhatsApp messages, so issuing them is admin-trust.
 *
 *   GET  /api/team/automations          → list
 *   POST /api/team/automations          → create
 *
 * Validation + redaction helpers live in ./_shared.ts so the sibling
 * /[id] route can import them too — Next.js refuses non-route exports
 * from route.ts files.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  const rows = await db.automation.findMany({
    where: { teamId: session.teamId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      enabled: true,
      trigger: true,
      conditions: true,
      actionType: true,
      actionConfig: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({
    automations: rows.map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      trigger: r.trigger,
      conditions: r.conditions,
      actionType: r.actionType,
      // Strip bearerToken from list responses — it's a write-only secret.
      // The detail GET also strips it. Editing requires re-entering the token.
      actionConfig: redactActionConfig(r.actionConfig),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  });
}

export async function POST(req: Request) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = parseAutomationBody(body);
  if (parsed.errors.length > 0) {
    return NextResponse.json({ error: "validation failed", details: parsed.errors }, { status: 400 });
  }

  const created = await db.automation.create({
    data: {
      teamId: session.teamId,
      name: parsed.name,
      enabled: parsed.enabled,
      trigger: parsed.trigger,
      conditions: parsed.conditions as Prisma.InputJsonValue,
      actionType: parsed.actionType,
      actionConfig: parsed.actionConfig as Prisma.InputJsonValue,
    },
  });
  return NextResponse.json({
    id: created.id,
    name: created.name,
    enabled: created.enabled,
    trigger: created.trigger,
    conditions: created.conditions,
    actionType: created.actionType,
    actionConfig: redactActionConfig(created.actionConfig),
    createdAt: created.createdAt.toISOString(),
    updatedAt: created.updatedAt.toISOString(),
  });
}
