/**
 * Pure condition evaluator. No I/O — given a parsed conditions array and an
 * event payload, returns true if every condition matches (AND-of-list).
 *
 * Conditions are stored on Automation.conditions as JSON, so the evaluator
 * also doubles as a runtime validator: garbage in returns `false` rather than
 * throwing. The management API does stricter validation on write to catch
 * typos at save time instead of silently never firing.
 */
import type { AutomationTriggerEvent } from "@prisma/client";

import type { EventPayload } from "@/lib/automations/events";

export type ConditionField =
  | "body"
  | "body_lower"
  | "status_from"
  | "status_to"
  | "assigned_user_id"
  | "contact_phone"
  | "contact_name"
  | "direction";

export type ConditionOp =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "regex"
  | "is_null"
  | "is_not_null";

export interface Condition {
  field: ConditionField;
  op: ConditionOp;
  /** Required for every op EXCEPT is_null / is_not_null. Always compared as string. */
  value?: string;
}

/** Fields each trigger event makes available. Used by the UI to scope the picker. */
export const FIELDS_BY_TRIGGER: Record<AutomationTriggerEvent, ConditionField[]> = {
  message_received: [
    "body",
    "body_lower",
    "direction",
    "contact_phone",
    "contact_name",
  ],
  conversation_assigned: [
    "assigned_user_id",
    "contact_phone",
    "contact_name",
  ],
  conversation_status_changed: [
    "status_from",
    "status_to",
    "contact_phone",
    "contact_name",
  ],
};

const OPS_REQUIRING_VALUE: ReadonlySet<ConditionOp> = new Set<ConditionOp>([
  "equals", "not_equals", "contains", "not_contains",
  "starts_with", "ends_with", "regex",
]);

/**
 * Permissive parse — used at evaluate time. Returns `null` for rows we can't
 * make sense of so a single typo doesn't take down the whole rule.
 */
function parseCondition(raw: unknown): Condition | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.field !== "string" || typeof r.op !== "string") return null;
  const field = r.field as ConditionField;
  const op = r.op as ConditionOp;
  const value = typeof r.value === "string" ? r.value : undefined;
  if (OPS_REQUIRING_VALUE.has(op) && value === undefined) return null;
  return { field, op, ...(value !== undefined ? { value } : {}) };
}

/**
 * Strict validate — used by the management API at write time. Returns an
 * error string per invalid row, or empty array when valid. Also enforces
 * the trigger ↔ field compatibility map.
 */
export function validateConditions(
  trigger: AutomationTriggerEvent,
  conditions: unknown,
): string[] {
  if (!Array.isArray(conditions)) {
    return ["conditions must be an array"];
  }
  const errors: string[] = [];
  const allowed = new Set(FIELDS_BY_TRIGGER[trigger]);
  conditions.forEach((raw, i) => {
    const c = parseCondition(raw);
    if (!c) {
      errors.push(`conditions[${i}]: malformed`);
      return;
    }
    if (!allowed.has(c.field)) {
      errors.push(`conditions[${i}]: field "${c.field}" is not valid for ${trigger}`);
    }
    if (c.op === "regex" && c.value) {
      try {
        // eslint-disable-next-line no-new
        new RegExp(c.value);
      } catch {
        errors.push(`conditions[${i}]: invalid regex "${c.value}"`);
      }
    }
  });
  return errors;
}

/** Extract the string value of a field from the (loosely typed) payload. */
function readField(field: ConditionField, payload: EventPayload): string | null {
  // EventPayload is a tagged union; we duck-type the lookups so each field
  // only resolves on payloads where it makes sense. Missing → null.
  const anyPayload = payload as unknown as {
    message?: { body?: string; direction?: string };
    contact?: { phoneNumber?: string; name?: string };
    assignedUser?: { id?: string } | null;
    previousStatus?: string;
    newStatus?: string;
  };
  switch (field) {
    case "body":
      return anyPayload.message?.body ?? null;
    case "body_lower":
      return anyPayload.message?.body?.toLowerCase() ?? null;
    case "direction":
      return anyPayload.message?.direction ?? null;
    case "status_from":
      return anyPayload.previousStatus ?? null;
    case "status_to":
      return anyPayload.newStatus ?? null;
    case "assigned_user_id":
      return anyPayload.assignedUser?.id ?? null;
    case "contact_phone":
      return anyPayload.contact?.phoneNumber ?? null;
    case "contact_name":
      return anyPayload.contact?.name ?? null;
  }
}

function applyOp(
  op: ConditionOp,
  actual: string | null,
  expected: string | undefined,
): boolean {
  switch (op) {
    case "is_null":
      return actual === null;
    case "is_not_null":
      return actual !== null;
    case "equals":
      return actual === expected;
    case "not_equals":
      return actual !== expected;
    case "contains":
      return actual !== null && expected !== undefined && actual.includes(expected);
    case "not_contains":
      return actual === null || expected === undefined || !actual.includes(expected);
    case "starts_with":
      return actual !== null && expected !== undefined && actual.startsWith(expected);
    case "ends_with":
      return actual !== null && expected !== undefined && actual.endsWith(expected);
    case "regex":
      if (actual === null || expected === undefined) return false;
      try {
        return new RegExp(expected).test(actual);
      } catch {
        // Invalid regex stored on the rule — fail closed so we don't fire
        // unexpectedly. The management API validates at write time too.
        return false;
      }
  }
}

/**
 * Evaluate the full conditions array against a payload. Empty array → true
 * (so "no filter" means "fire on every event of this trigger").
 */
export function evaluateConditions(
  rawConditions: unknown,
  payload: EventPayload,
): boolean {
  if (!Array.isArray(rawConditions)) return false;
  for (const raw of rawConditions) {
    const c = parseCondition(raw);
    if (!c) return false; // a malformed row never matches — fail closed
    const actual = readField(c.field, payload);
    if (!applyOp(c.op, actual, c.value)) return false;
  }
  return true;
}
