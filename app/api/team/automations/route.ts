import "server-only";

import { type AutomationTriggerEvent, Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { parseWebhookConfig, ActionConfigError } from "@/lib/automations/actions/webhook";
import { validateConditions } from "@/lib/automations/conditions";

/**
 * Automation management API. Admin-only — automations can move money via
 * webhooks and send WhatsApp messages, so issuing them is admin-trust.
 *
 *   GET  /api/team/automations          → list
 *   POST /api/team/automations          → create
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_TRIGGERS: ReadonlyArray<AutomationTriggerEvent> = [
  "message_received",
  "conversation_assigned",
  "conversation_status_changed",
];

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

interface CreateBody {
  name?: unknown;
  enabled?: unknown;
  trigger?: unknown;
  conditions?: unknown;
  actionType?: unknown;
  actionConfig?: unknown;
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

interface ParsedAutomation {
  name: string;
  enabled: boolean;
  trigger: AutomationTriggerEvent;
  conditions: unknown[];
  actionType: "webhook";
  actionConfig: unknown;
  errors: string[];
}

export function parseAutomationBody(body: CreateBody): ParsedAutomation {
  const errors: string[] = [];

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) errors.push("name: required");
  else if (name.length > 100) errors.push("name: too long (max 100)");

  const enabled = body.enabled !== false; // default true

  const trigger = body.trigger as AutomationTriggerEvent;
  if (!VALID_TRIGGERS.includes(trigger)) {
    errors.push(`trigger: must be one of ${VALID_TRIGGERS.join(", ")}`);
  }

  const conditionsRaw = Array.isArray(body.conditions) ? body.conditions : [];
  if (trigger && VALID_TRIGGERS.includes(trigger)) {
    errors.push(...validateConditions(trigger, conditionsRaw));
  }

  const actionType = (body.actionType as "webhook") ?? "webhook";
  if (actionType !== "webhook") {
    errors.push("actionType: only 'webhook' is supported");
  }

  let actionConfig: unknown = {};
  try {
    actionConfig = parseWebhookConfig(body.actionConfig);
  } catch (err) {
    errors.push(`actionConfig: ${err instanceof ActionConfigError ? err.message : "invalid"}`);
  }

  return {
    name,
    enabled,
    trigger,
    conditions: conditionsRaw,
    actionType,
    actionConfig,
    errors,
  };
}

/** Strip secrets from a stored action config before returning to the client. */
export function redactActionConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...r };
  if (typeof r.bearerToken === "string" && r.bearerToken.length > 0) {
    // Tell the UI a token is set without leaking the value. The form lets
    // admins re-enter it to update; leaving the input blank keeps the
    // existing token on PATCH.
    out.bearerTokenSet = true;
    delete out.bearerToken;
  }
  return out;
}
