/**
 * Pure condition evaluator for trigger-time AND/OR groups + branch-step
 * condition evaluation. Same shape used in both contexts.
 *
 *   { op: "AND" | "OR", children: (Condition | Group)[] }
 *
 * Legacy automation rules stored a flat array; the migration to Workflow
 * wraps those into a single AND group, so the runtime only needs to handle
 * the group shape. We still tolerate flat arrays as input for forward-compat
 * with the external API (a third-party caller might POST the older shape).
 *
 * Garbage in returns `false` (fail closed). The management API runs the
 * strict validator on write to catch typos at save time instead of silently
 * never firing.
 */
import type { WorkflowTriggerEvent } from "@prisma/client";

import type { EventPayload } from "@/lib/workflows/events";

export type ConditionField =
  // Message fields (message_received)
  | "body"
  | "body_lower"
  | "direction"
  // Stable id of an interactive button/list reply tap (message_received)
  | "option_id"
  // Session position of the inbound (message_received): first_ever |
  // returning_session | continued. Lets a flow greet only the first message
  // of a session, or skip the greeting on continued messages.
  | "session_kind"
  // Conversation fields (most triggers carry a conversation snapshot)
  | "status_from"
  | "status_to"
  | "assigned_user_id"
  | "conversation_status"
  /**
   * WHICH account on the channel this thread belongs to (the ChannelConnection
   * id) — "did this come in on the Sales number or the Support number".
   * `channel` alone cannot express that, so a multi-number workspace had no way
   * to route by number at all.
   */
  | "channel_account_id"
  // Contact fields (always present)
  | "contact_phone"
  | "contact_name"
  | "contact_email"
  | "contact_stage_id"
  // Tag-update fields (contact_tag_updated)
  | "tag_id"
  | "tag_change_kind"
  // Field-update fields (contact_field_updated)
  | "field_key"
  | "field_new_value"
  // Lifecycle-update fields (contact_lifecycle_updated)
  | "stage_from"
  | "stage_to"
  // TICKET fields. `ticket_status_from/to` are deliberately distinct from the
  // conversation's `status_from/to`: the two lifecycles are different sets
  // (a ticket is new/open/pending/on_hold/solved/closed), and sharing one field
  // name would let a condition written for one silently mean the other.
  | "ticket_status_from"
  | "ticket_status_to"
  | "ticket_priority"
  | "ticket_subject"
  | "ticket_cause"
  | "ticket_assigned_user_id"
  | "ticket_team_id"
  | "ticket_tag_id"
  | "ticket_breached_leg"
  | "ticket_guest_workspace_id";

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
  value?: string;
}

export type GroupOp = "AND" | "OR";

export interface ConditionGroup {
  op: GroupOp;
  children: Array<Condition | ConditionGroup>;
}

/**
 * Per-trigger condition-field whitelist. Mirrored on the client in
 * components/workflows/builder/types.ts.
 *
 * `manual_trigger` and `incoming_webhook` expose contact fields only —
 * other fields don't apply since neither event carries a conversation or
 * message snapshot by definition.
 */
export const FIELDS_BY_TRIGGER: Record<WorkflowTriggerEvent, ConditionField[]> = {
  message_received: [
    "body", "body_lower", "direction", "option_id", "session_kind",
    "contact_phone", "contact_name", "contact_email", "contact_stage_id",
    "conversation_status", "assigned_user_id", "channel_account_id",
  ],
  conversation_created: [
    "contact_phone", "contact_name", "contact_email", "contact_stage_id",
    "channel_account_id",
  ],
  conversation_opened: [
    "status_from", "contact_phone", "contact_name", "contact_email",
    "assigned_user_id", "channel_account_id",
  ],
  conversation_closed: [
    "status_from", "contact_phone", "contact_name", "contact_email",
    "assigned_user_id", "channel_account_id",
  ],
  conversation_assigned: [
    "assigned_user_id", "contact_phone", "contact_name", "contact_email",
    "channel_account_id",
  ],
  conversation_status_changed: [
    "status_from", "status_to", "contact_phone", "contact_name", "contact_email",
    "channel_account_id",
  ],
  contact_tag_updated: [
    "tag_id", "tag_change_kind", "contact_phone", "contact_name", "contact_email",
  ],
  contact_field_updated: [
    "field_key", "field_new_value", "contact_phone", "contact_name", "contact_email",
  ],
  contact_lifecycle_updated: [
    "stage_from", "stage_to", "contact_phone", "contact_name", "contact_email",
  ],
  ticket_created: [
    "ticket_priority", "ticket_subject", "ticket_cause", "ticket_assigned_user_id",
    "ticket_team_id", "ticket_tag_id",
    "contact_phone", "contact_name", "contact_email", "contact_stage_id",
  ],
  ticket_status_changed: [
    "ticket_status_from", "ticket_status_to", "ticket_priority",
    "ticket_assigned_user_id", "ticket_team_id", "ticket_tag_id",
    "contact_phone", "contact_name", "contact_email",
  ],
  ticket_priority_changed: [
    "ticket_priority", "ticket_status_to", "ticket_assigned_user_id",
    "ticket_team_id", "ticket_tag_id",
    "contact_phone", "contact_name", "contact_email",
  ],
  ticket_assigned: [
    "ticket_assigned_user_id", "ticket_priority", "ticket_status_to",
    "ticket_team_id", "ticket_tag_id",
    "contact_phone", "contact_name", "contact_email",
  ],
  ticket_sla_breached: [
    "ticket_breached_leg", "ticket_priority", "ticket_status_to",
    "ticket_assigned_user_id", "ticket_team_id", "ticket_tag_id",
    "contact_phone", "contact_name", "contact_email",
  ],
  ticket_escalated: [
    "ticket_guest_workspace_id", "ticket_priority", "ticket_status_to",
    "ticket_team_id", "ticket_tag_id",
    "contact_phone", "contact_name", "contact_email",
  ],
  manual_trigger: [
    "contact_phone", "contact_name", "contact_email",
  ],
  incoming_webhook: [
    "contact_phone", "contact_name", "contact_email",
  ],
};

const OPS_REQUIRING_VALUE: ReadonlySet<ConditionOp> = new Set<ConditionOp>([
  "equals", "not_equals", "contains", "not_contains",
  "starts_with", "ends_with", "regex",
]);

// ---------------------------------------------------------------------------
// Parsing — permissive, used at runtime.
// ---------------------------------------------------------------------------

function parseCondition(raw: unknown): Condition | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.field !== "string" || typeof r.op !== "string") return null;
  if ("children" in r) return null;
  const field = r.field as ConditionField;
  const op = r.op as ConditionOp;
  const value = typeof r.value === "string" ? r.value : undefined;
  if (OPS_REQUIRING_VALUE.has(op) && value === undefined) return null;
  return { field, op, ...(value !== undefined ? { value } : {}) };
}

function isGroupLike(raw: unknown): raw is Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  return Array.isArray(r.children) && (r.op === "AND" || r.op === "OR");
}

function parseGroup(raw: unknown): ConditionGroup | null {
  if (!isGroupLike(raw)) return null;
  const op = raw.op as GroupOp;
  const childrenRaw = raw.children as unknown[];
  const children: Array<Condition | ConditionGroup> = [];
  for (const c of childrenRaw) {
    const g = parseGroup(c);
    if (g) {
      children.push(g);
      continue;
    }
    const leaf = parseCondition(c);
    if (leaf) children.push(leaf);
  }
  return { op, children };
}

/** Lift any stored shape (legacy flat array OR canonical group) to a group. */
export function toGroup(raw: unknown): ConditionGroup {
  if (Array.isArray(raw)) {
    const children: Array<Condition | ConditionGroup> = [];
    for (const c of raw) {
      const leaf = parseCondition(c);
      if (leaf) children.push(leaf);
    }
    return { op: "AND", children };
  }
  const g = parseGroup(raw);
  if (g) return g;
  return { op: "AND", children: [] };
}

// ---------------------------------------------------------------------------
// Validation — strict, used at write time.
// ---------------------------------------------------------------------------

export function validateConditions(
  trigger: WorkflowTriggerEvent,
  conditions: unknown,
): string[] {
  const allowed = new Set(FIELDS_BY_TRIGGER[trigger]);
  if (Array.isArray(conditions)) return validateLeafArray(conditions, allowed, "conditions");
  if (isGroupLike(conditions)) return validateGroup(conditions, allowed, "conditions");
  return ["conditions must be an array or a { op, children } group"];
}

function validateLeafArray(
  rows: unknown[],
  allowed: ReadonlySet<ConditionField>,
  path: string,
): string[] {
  const errors: string[] = [];
  rows.forEach((raw, i) => {
    errors.push(...validateLeaf(raw, allowed, `${path}[${i}]`));
  });
  return errors;
}

function validateLeaf(
  raw: unknown,
  allowed: ReadonlySet<ConditionField>,
  path: string,
): string[] {
  const c = parseCondition(raw);
  if (!c) return [`${path}: malformed`];
  const errors: string[] = [];
  if (!allowed.has(c.field)) {
    errors.push(`${path}: field "${c.field}" is not valid for this trigger`);
  }
  if (c.op === "regex" && c.value) {
    try {
       
      new RegExp(c.value);
    } catch {
      errors.push(`${path}: invalid regex "${c.value}"`);
    }
    // Length cap on the pattern itself. Catastrophic-backtracking patterns
    // like `(a+)+$` are short by nature, so this isn't a perfect defense,
    // but a 200-char ceiling stops the obvious `.*.*.*…` super-linear
    // chains and matches what RE2-aware tools (which we're not running)
    // commonly bound. The wall-clock cap below is the real defense.
    if (c.value.length > 200) {
      errors.push(`${path}: regex too long (max 200 chars)`);
    }
    // Reject the catastrophic shape at publish time so the author gets a clear
    // message now, rather than a condition that silently never matches at run
    // time (where the same check fails closed to protect the event loop).
    if (hasCatastrophicQuantifier(c.value)) {
      errors.push(
        `${path}: regex uses a nested repeat like (a+)+ which can hang the workflow engine — ` +
          `rewrite it without a repeat inside a repeated group`,
      );
    }
  }
  return errors;
}

/**
 * Wall-clock cap for `RegExp.test()` against admin-supplied patterns.
 * Catastrophic-backtracking inputs (the `(a+)+$` class) can pin a worker
 * CPU for tens of seconds before V8 finishes. We can't truly preempt the
 * regex engine from JS, but we CAN bound the input length AND only call
 * `.test()` after the input passes a length check — both shrink the
 * realistic blast radius from "indefinite worker stall" to "one slow step
 * advance" before the next BullMQ retry takes over.
 */
const REGEX_INPUT_MAX_LEN = 64 * 1024;

/**
 * Detect the nested-unbounded-quantifier shape that drives catastrophic
 * backtracking — `(a+)+`, `(a*)*`, `(a+)*`, `([a-z]+){2,}`.
 *
 * This is the dominant ReDoS class and the one that is trivially short, so the
 * 200-char pattern cap does nothing against it. An inner UNBOUNDED quantifier
 * inside a group that is itself UNBOUNDED-quantified is what makes the match
 * space exponential; a bounded inner count like `(\d{4})+` is linear and stays
 * allowed, so ordinary patterns are unaffected.
 *
 * Heuristic by design — it cannot catch every pathological pattern (overlapping
 * alternations such as `(a|a)+` slip through). The complete fix is a linear-time
 * engine (`re2`) or evaluating in a worker thread with a hard terminate; both are
 * larger changes than this file. This closes the cheap, obvious, high-impact
 * case without a native dependency.
 */
const CATASTROPHIC_QUANTIFIER = /\([^()]*(?:[*+]|\{\d+,\})[^()]*\)\s*(?:[*+]|\{\d+,\})/;
export function hasCatastrophicQuantifier(pattern: string): boolean {
  return CATASTROPHIC_QUANTIFIER.test(pattern);
}

// Patterns already warned about at runtime, so we log each stored pattern once
// instead of on every evaluation (the regex op runs per matching event).
const refusedRuntimePatterns = new Set<string>();

function validateGroup(
  raw: unknown,
  allowed: ReadonlySet<ConditionField>,
  path: string,
): string[] {
  if (!isGroupLike(raw)) return [`${path}: must be { op: "AND"|"OR", children: [] }`];
  const errors: string[] = [];
  if (raw.op !== "AND" && raw.op !== "OR") {
    errors.push(`${path}.op: must be "AND" or "OR"`);
  }
  const children = raw.children as unknown[];
  const depth = path.split(".children").length - 1;
  if (depth >= 3) {
    errors.push(`${path}: groups nested more than 3 levels — split into separate workflows`);
    return errors;
  }
  children.forEach((c, i) => {
    if (isGroupLike(c)) {
      errors.push(...validateGroup(c, allowed, `${path}.children[${i}]`));
    } else {
      errors.push(...validateLeaf(c, allowed, `${path}.children[${i}]`));
    }
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function readField(field: ConditionField, payload: EventPayload): string | null {
  const p = payload as unknown as {
    message?: {
      body?: string;
      direction?: string;
      interactive?: { kind?: string; id?: string; title?: string } | null;
    };
    contact?: {
      phoneNumber?: string;
      name?: string;
      email?: string | null;
      stageId?: string | null;
    };
    conversation?: {
      status?: string;
      assignedUserId?: string | null;
      channelConnectionId?: string | null;
    } | null;
    assignedUser?: { id?: string } | null;
    previousStatus?: string;
    newStatus?: string;
    tagId?: string;
    kind?: string;
    fieldKey?: string;
    newValue?: string | null;
    previousStageId?: string | null;
    newStageId?: string | null;
    sessionKind?: string;
    ticket?: {
      status?: string;
      priority?: string;
      subject?: string | null;
      description?: string | null;
      assignedUserId?: string | null;
      assignedTeamId?: string | null;
      tagIds?: string[];
    } | null;
    newPriority?: string;
    assignedUserId?: string | null;
    breachedLeg?: string;
    guestWorkspaceId?: string;
  };
  switch (field) {
    case "body":
      return p.message?.body ?? null;
    case "body_lower":
      return p.message?.body?.toLowerCase() ?? null;
    case "direction":
      return p.message?.direction ?? null;
    case "option_id":
      return p.message?.interactive?.id ?? null;
    case "session_kind":
      return p.sessionKind ?? null;
    case "status_from":
      return p.previousStatus ?? null;
    case "status_to":
      return p.newStatus ?? null;
    case "conversation_status":
      return p.conversation?.status ?? null;
    case "channel_account_id":
      return p.conversation?.channelConnectionId ?? null;
    case "assigned_user_id":
      return p.assignedUser?.id ?? p.conversation?.assignedUserId ?? null;
    case "contact_phone":
      return p.contact?.phoneNumber ?? null;
    case "contact_name":
      return p.contact?.name ?? null;
    case "contact_email":
      return p.contact?.email ?? null;
    case "contact_stage_id":
      return p.contact?.stageId ?? null;
    case "tag_id":
      return p.tagId ?? null;
    case "tag_change_kind":
      return p.kind ?? null;
    case "field_key":
      return p.fieldKey ?? null;
    case "field_new_value":
      return p.newValue ?? null;
    case "stage_from":
      return p.previousStageId ?? null;
    case "stage_to":
      return p.newStageId ?? null;
    // ---- Ticket fields ----
    // `ticket_status_to` reads the SNAPSHOT rather than `newStatus`, so it also
    // answers on triggers that carry no transition (created, sla_breached,
    // escalated) — "urgent AND still on_hold" is a condition people write.
    case "ticket_status_from":
      return p.previousStatus ?? null;
    case "ticket_status_to":
      return p.newStatus ?? p.ticket?.status ?? null;
    case "ticket_priority":
      return p.newPriority ?? p.ticket?.priority ?? null;
    case "ticket_subject":
      return p.ticket?.subject ?? null;
    case "ticket_cause":
      return p.ticket?.description ?? null;
    case "ticket_assigned_user_id":
      // The assignment trigger's own field wins; otherwise the snapshot's.
      return p.assignedUserId ?? p.ticket?.assignedUserId ?? null;
    case "ticket_team_id":
      return p.ticket?.assignedTeamId ?? null;
    // Multi-valued: `equals` means "has this tag". Joined with a delimiter for
    // the substring ops so `contains` can't match across two ids.
    case "ticket_tag_id":
      return p.ticket?.tagIds?.length ? p.ticket.tagIds.join(",") : null;
    case "ticket_breached_leg":
      return p.breachedLeg ?? null;
    case "ticket_guest_workspace_id":
      return p.guestWorkspaceId ?? null;
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
      // Don't hand an unbounded input to a possibly-pathological pattern.
      // The validator already capped pattern length; capping input length
      // here closes the loop. 64KiB covers every legitimate message body /
      // contact-field text we'd condition on; pathological huge inputs
      // never produce useful conditions and routinely show up only from
      // malicious automation tests.
      if (actual.length > REGEX_INPUT_MAX_LEN) return false;
      if (expected.length > 200) return false;
      // Refuse to EXECUTE a catastrophic-backtracking shape, don't just refuse
      // to save it: this runs in-process (RUN_WORKER_INLINE is mandatory in
      // prod), so `(a+)+$` against an attacker-chosen body pins the single event
      // loop serving HTTP + Socket.io for EVERY tenant — a full-platform freeze
      // triggered by one org's workflow and one of that org's own customers.
      // The publish-time validator below rejects new patterns, but workflows
      // saved before this guard existed would still reach here, so the runtime
      // check is the one that actually closes the hole. Fail closed: a condition
      // we won't evaluate is `false`, never a stall.
      //
      // Fail-closed here is silent from the tenant's side — a pre-existing regex
      // condition (incl. a heuristic false-positive on a safe polynomial pattern
      // like `^(\d+,)*\d+$`) stops matching with no error. Warn once per pattern
      // so operators can see which automation went dark and rewrite it.
      if (hasCatastrophicQuantifier(expected)) {
        if (!refusedRuntimePatterns.has(expected)) {
          refusedRuntimePatterns.add(expected);
          console.warn(
            `[workflows] regex_condition_refused_at_runtime — a stored regex ` +
              `condition uses a nested-repeat shape and will never match until ` +
              `rewritten (pattern=${JSON.stringify(expected)}); the automation ` +
              `using it has gone dark.`,
          );
        }
        return false;
      }
      try {
        return new RegExp(expected).test(actual);
      } catch {
        return false;
      }
  }
}

function evaluateLeaf(c: Condition, payload: EventPayload): boolean {
  const actual = readField(c.field, payload);
  return applyOp(c.op, actual, c.value);
}

function evaluateGroup(g: ConditionGroup, payload: EventPayload): boolean {
  if (g.children.length === 0) return true;
  if (g.op === "AND") {
    for (const child of g.children) {
      if (!evaluateChild(child, payload)) return false;
    }
    return true;
  }
  for (const child of g.children) {
    if (evaluateChild(child, payload)) return true;
  }
  return false;
}

function evaluateChild(c: Condition | ConditionGroup, payload: EventPayload): boolean {
  if ("children" in c) return evaluateGroup(c, payload);
  return evaluateLeaf(c, payload);
}

export function evaluateConditions(
  rawConditions: unknown,
  payload: EventPayload,
): boolean {
  const group = toGroup(rawConditions);
  return evaluateGroup(group, payload);
}
