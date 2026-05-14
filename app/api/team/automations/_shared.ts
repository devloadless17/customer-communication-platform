import "server-only";

import type { AutomationTriggerEvent } from "@prisma/client";

import { parseWebhookConfig, ActionConfigError } from "@/lib/automations/actions/webhook";
import { validateConditions } from "@/lib/automations/conditions";

/**
 * Shared helpers for /api/team/automations routes. Lives in an underscore-
 * prefixed file so Next.js treats it as a private module (not a route) —
 * route files can only export GET/POST/runtime/dynamic/etc., so the helpers
 * had to move out of route.ts.
 */

export const VALID_TRIGGERS: ReadonlyArray<AutomationTriggerEvent> = [
  "message_received",
  "conversation_assigned",
  "conversation_status_changed",
];

export interface CreateBody {
  name?: unknown;
  enabled?: unknown;
  trigger?: unknown;
  conditions?: unknown;
  actionType?: unknown;
  actionConfig?: unknown;
}

export interface ParsedAutomation {
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
