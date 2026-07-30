"use client";

import type {
  WorkflowStepType,
  WorkflowTriggerEvent,
} from "@prisma/client";

/**
 * Client-side mirrors of the server graph + condition shapes. Kept duplicated
 * (rather than imported from lib/workflows) so we don't drag `server-only`
 * modules into the bundle.
 *
 * Wire format is identical to what lib/workflows/graph.ts validates.
 */

export type Trigger = WorkflowTriggerEvent;
export type StepType = WorkflowStepType;

export interface NodePosition {
  x: number;
  y: number;
}

export interface WorkflowNode {
  id: string;
  type: StepType;
  config: Record<string, unknown>;
  position?: NodePosition;
  /** Author-supplied node title. Falls back to the step type label on the
   *  canvas when undefined. Mirrors apps/api/src/lib/workflows/graph.ts. */
  name?: string;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  label?: string;
}

export interface WorkflowGraph {
  startNodeId: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

// Conditions ----------------------------------------------------------------

export type GroupOp = "AND" | "OR";

export type ConditionField =
  | "body" | "body_lower" | "direction" | "option_id" | "session_kind"
  | "status_from" | "status_to" | "assigned_user_id" | "conversation_status"
  | "contact_phone" | "contact_name" | "contact_email" | "contact_stage_id"
  | "channel_account_id"
  | "tag_id" | "tag_change_kind"
  | "field_key" | "field_new_value"
  | "stage_from" | "stage_to"
  // TICKET fields. Prefixed and separate from the conversation's `status_*`
  // because the two lifecycles are different sets — sharing a name would let a
  // condition written for one silently mean the other.
  | "ticket_status_from" | "ticket_status_to" | "ticket_priority"
  | "ticket_subject" | "ticket_cause" | "ticket_assigned_user_id"
  | "ticket_team_id" | "ticket_tag_id" | "ticket_breached_leg"
  | "ticket_guest_workspace_id";

export type ConditionOp =
  | "equals" | "not_equals" | "contains" | "not_contains"
  | "starts_with" | "ends_with" | "regex"
  | "is_null" | "is_not_null";

export interface Condition {
  field: ConditionField;
  op: ConditionOp;
  value: string;
  /**
   * Client-only stable id for React keying. Stamped at insert-time + on
   * server-hydration; carried forward by every spread (`{...condition,
   * value}`). Without this, the editor used `key={idx}` and any edit that
   * recreated the surrounding object (every keystroke goes through
   * `onChange({...condition, value})`) re-keyed the row → input remount →
   * focus lost mid-typing. Optional in the type so legacy persisted graphs
   * deserialize without complaint; `useChildKeys` stamps lazily.
   */
  _id?: string;
}

export interface ConditionGroup {
  op: GroupOp;
  children: Array<Condition | ConditionGroup>;
  /** See `Condition._id`. */
  _id?: string;
}

export function isGroup(c: Condition | ConditionGroup): c is ConditionGroup {
  return "children" in c;
}

// Catalogs (loaded server-side, passed top-down) ----------------------------

export interface BuilderCatalogs {
  users: Array<{ id: string; name: string; email: string }>;
  templates: Array<{
    id: string;
    name: string;
    bodyText: string;
    language: string;
    status: string;
  }>;
  tags: Array<{ id: string; name: string; color: string }>;
  stages: Array<{ id: string; name: string; position: number }>;
  fields: Array<{ key: string; label: string }>;
  workflows: Array<{ id: string; name: string; trigger: Trigger }>;
  /** Named assignment policies, for the `assign_to` step's policy mode. */
  assignmentPolicies: Array<{ id: string; name: string; isDefault: boolean }>;
  /**
   * Connected channel accounts — a specific WhatsApp number, Page or Instagram
   * handle. Sourced from the app-wide directory, not a workflow-specific fetch.
   */
  channelAccounts: Array<{ id: string; name: string; channel: string }>;
}

// Trigger + step metadata --------------------------------------------------

export const TRIGGER_OPTIONS: Array<{
  value: Trigger;
  label: string;
  description: string;
  group: "inbox" | "contact" | "ticket" | "external";
}> = [
  { value: "message_received", label: "Message Received", description: "Inbound message arrived.", group: "inbox" },
  { value: "conversation_created", label: "Conversation Created", description: "First-ever conversation for a contact.", group: "inbox" },
  { value: "conversation_opened", label: "Conversation Opened", description: "Status moved to open.", group: "inbox" },
  { value: "conversation_closed", label: "Conversation Closed", description: "Status moved to closed.", group: "inbox" },
  { value: "conversation_assigned", label: "Conversation Assigned", description: "Assignee changed.", group: "inbox" },
  { value: "conversation_status_changed", label: "Status Changed", description: "Any status transition.", group: "inbox" },
  { value: "ticket_created", label: "Ticket Raised", description: "A ticket was opened on a conversation.", group: "ticket" },
  { value: "ticket_status_changed", label: "Ticket Status Changed", description: "Any ticket status transition, including solved / closed / reopened.", group: "ticket" },
  { value: "ticket_priority_changed", label: "Ticket Priority Changed", description: "Someone re-prioritized a ticket.", group: "ticket" },
  { value: "ticket_assigned", label: "Ticket Assigned", description: "A ticket got an owner, or was handed to a team.", group: "ticket" },
  { value: "ticket_sla_breached", label: "Ticket SLA Breached", description: "A first-response or resolution promise was missed. Fires once per leg.", group: "ticket" },
  { value: "ticket_escalated", label: "Ticket Escalated", description: "A ticket was shared with another workspace in the organization.", group: "ticket" },
  { value: "contact_tag_updated", label: "Contact Tag Updated", description: "Tag added or removed.", group: "contact" },
  { value: "contact_field_updated", label: "Contact Field Updated", description: "A custom field changed.", group: "contact" },
  { value: "contact_lifecycle_updated", label: "Lifecycle Updated", description: "Contact moved between stages.", group: "contact" },
  { value: "manual_trigger", label: "Manual Trigger", description: "Fired by an agent from the conversation panel or by another workflow.", group: "external" },
  { value: "incoming_webhook", label: "Incoming Webhook", description: "External system POSTs to a per-workflow URL.", group: "external" },
];

export const STEP_OPTIONS: Array<{
  value: StepType;
  label: string;
  description: string;
  group: "message" | "convo" | "contact" | "control" | "external";
}> = [
  { value: "send_message", label: "Send a Message", description: "Free-form text to the contact.", group: "message" },
  { value: "send_template", label: "Send Template", description: "Approved WhatsApp template.", group: "message" },
  { value: "add_comment", label: "Add Comment", description: "Internal note on the conversation.", group: "message" },
  { value: "assign_to", label: "Assign To", description: "Assign or unassign the conversation.", group: "convo" },
  { value: "set_status", label: "Set Status", description: "open / pending / closed.", group: "convo" },
  { value: "open_conversation", label: "Open Conversation", description: "Shortcut for Set Status → open.", group: "convo" },
  { value: "close_conversation", label: "Close Conversation", description: "Shortcut for Set Status → closed, with category + summary.", group: "convo" },
  { value: "create_ticket", label: "Open a Ticket", description: "Open a work item on this conversation.", group: "convo" },
  { value: "set_ticket_status", label: "Set Ticket Status", description: "Move the conversation's active ticket.", group: "convo" },
  { value: "set_ticket_priority", label: "Set Ticket Priority", description: "Escalate or de-escalate the active ticket.", group: "convo" },
  { value: "assign_ticket", label: "Assign Ticket", description: "Give the active ticket an owner — a named teammate, or whoever on a team is available.", group: "convo" },
  { value: "add_tag", label: "Add Tag", description: "Apply a tag to the contact.", group: "contact" },
  { value: "remove_tag", label: "Remove Tag", description: "Remove a tag from the contact.", group: "contact" },
  { value: "update_field", label: "Update Contact Field", description: "Set a custom field value.", group: "contact" },
  { value: "update_lifecycle", label: "Update Lifecycle", description: "Move the contact to a stage.", group: "contact" },
  { value: "branch", label: "Branch", description: "If/else based on conditions.", group: "control" },
  { value: "wait", label: "Wait", description: "Pause before continuing.", group: "control" },
  { value: "jump_to_step", label: "Jump to Step", description: "Jump to another step in this workflow.", group: "control" },
  { value: "noop", label: "Do Nothing", description: "Stop this branch with no action.", group: "control" },
  { value: "ask_question", label: "Ask a Question", description: "Send a question, wait for the contact's reply, branch on answered / timeout.", group: "control" },
  { value: "http_request", label: "HTTP Request", description: "POST the envelope to an external URL.", group: "external" },
  { value: "trigger_workflow", label: "Trigger Workflow", description: "Run another workflow for this contact.", group: "external" },
];

// Trigger contact-context -------------------------------------------------
//
// `incoming_webhook` fires from a raw external POST with NO contact and NO
// conversation attached (the server seeds `contact: null` / `contactId:
// null` — see apps/api/.../workflows.service.ts). Every contact-scoped
// condition field and every contact/conversation-acting step therefore
// silently no-ops on that trigger. We surface that at author time instead:
// the condition picker hides contact_* fields and the step palette badges
// the acting steps. Keep this list in sync with the server resolver — these
// are the steps whose `run()` reads `ctx.conversation` / `ctx.contact`.

/** Triggers that DON'T carry a contact (and so can't act on one). Today only
 *  `incoming_webhook`; broken out as a helper so callers read intent, not a
 *  bare equality check. */
export function triggerCarriesContact(trigger: Trigger): boolean {
  return trigger !== "incoming_webhook";
}

/** Condition fields that resolve against the trigger's contact. Hidden by the
 *  picker when the trigger carries no contact. */
export const CONTACT_SCOPED_FIELDS: ReadonlySet<ConditionField> = new Set([
  "contact_phone",
  "contact_name",
  "contact_email",
  "contact_stage_id",
]);

/** Step types whose action targets the trigger's contact / conversation, so
 *  they no-op on a contact-less trigger. The palette badges these (and the
 *  same message is reusable in a step-level warning). */
export const CONTACT_ACTING_STEPS: ReadonlySet<StepType> = new Set([
  "send_message",
  "send_template",
  "add_comment",
  "assign_to",
  "set_status",
  "open_conversation",
  "close_conversation",
  "add_tag",
  "remove_tag",
  "update_field",
  "update_lifecycle",
  "ask_question",
  // Every ticket step resolves the conversation from the envelope — a
  // contact-less trigger has none, so they'd no-op silently without this badge.
  "create_ticket",
  "set_ticket_status",
  "set_ticket_priority",
  "assign_ticket",
]);

/** Author-facing reason shown when a contact-acting step is offered on a
 *  trigger with no contact. */
export const NEEDS_CONTACT_TRIGGER_HINT = "Needs a contact-scoped trigger";

export function emptyConfigFor(type: StepType): Record<string, unknown> {
  switch (type) {
    case "send_message":
      return { body: "" };
    case "send_template":
      return { templateId: "", variables: { body: [] } };
    case "add_comment":
      return { body: "" };
    case "assign_to":
      return { mode: "unassign" };
    case "set_status":
      return { status: "open" };
    case "open_conversation":
      return {};
    case "close_conversation":
      return {};
    case "add_tag":
    case "remove_tag":
      return { tagId: "" };
    case "update_field":
      return { fieldKey: "", value: "" };
    case "update_lifecycle":
      return { stageId: "" };
    case "branch":
      return { conditions: { op: "AND", children: [] } };
    case "wait":
      return { delayMs: 60_000 };
    case "jump_to_step":
      return { targetStepId: "" };
    case "noop":
      return {};
    case "ask_question":
      return { question: "", timeoutHours: 24 };
    case "http_request":
      return { url: "" };
    case "trigger_workflow":
      return { workflowId: "" };
    case "create_ticket":
      // `onlyIfNoActiveTicket` defaults ON server-side; mirrored here so the
      // editor shows the real default rather than an empty checkbox that then
      // behaves as if it were ticked.
      return { subject: "", priority: "normal", onlyIfNoActiveTicket: true };
    case "set_ticket_status":
      return { status: "solved" };
    case "set_ticket_priority":
      return { priority: "high" };
    case "assign_ticket":
      return { mode: "unassign" };
  }
}

// Constants mirrored from the server -------------------------------------

export const FIELDS_BY_TRIGGER: Record<Trigger, ConditionField[]> = {
  message_received: [
    "body", "body_lower", "direction", "option_id", "session_kind",
    "contact_phone", "contact_name", "contact_email", "contact_stage_id",
    "conversation_status", "assigned_user_id", "channel_account_id",
  ],
  // Every trigger that carries a conversation snapshot can condition on the
  // ACCOUNT — the resolver reads `conversation.channelConnectionId`. Kept in
  // lockstep with FIELDS_BY_TRIGGER in apps/api/src/lib/workflows/conditions.ts:
  // this list is a MIRROR, and a field the server accepts but this omits is
  // simply unreachable in the builder (which is what "channel_account_id
  // exists" meant in practice until now).
  conversation_created: ["contact_phone", "contact_name", "contact_email", "contact_stage_id", "channel_account_id"],
  conversation_opened: ["status_from", "contact_phone", "contact_name", "contact_email", "assigned_user_id", "channel_account_id"],
  conversation_closed: ["status_from", "contact_phone", "contact_name", "contact_email", "assigned_user_id", "channel_account_id"],
  conversation_assigned: ["assigned_user_id", "contact_phone", "contact_name", "contact_email", "channel_account_id"],
  conversation_status_changed: ["status_from", "status_to", "contact_phone", "contact_name", "contact_email", "channel_account_id"],
  ticket_created: ["ticket_priority", "ticket_subject", "ticket_cause", "ticket_assigned_user_id", "ticket_team_id", "ticket_tag_id", "contact_phone", "contact_name", "contact_email", "contact_stage_id"],
  ticket_status_changed: ["ticket_status_from", "ticket_status_to", "ticket_priority", "ticket_assigned_user_id", "ticket_team_id", "ticket_tag_id", "contact_phone", "contact_name", "contact_email"],
  ticket_priority_changed: ["ticket_priority", "ticket_status_to", "ticket_assigned_user_id", "ticket_team_id", "ticket_tag_id", "contact_phone", "contact_name", "contact_email"],
  ticket_assigned: ["ticket_assigned_user_id", "ticket_priority", "ticket_status_to", "ticket_team_id", "ticket_tag_id", "contact_phone", "contact_name", "contact_email"],
  ticket_sla_breached: ["ticket_breached_leg", "ticket_priority", "ticket_status_to", "ticket_assigned_user_id", "ticket_team_id", "ticket_tag_id", "contact_phone", "contact_name", "contact_email"],
  ticket_escalated: ["ticket_guest_workspace_id", "ticket_priority", "ticket_status_to", "ticket_team_id", "ticket_tag_id", "contact_phone", "contact_name", "contact_email"],
  contact_tag_updated: ["tag_id", "tag_change_kind", "contact_phone", "contact_name", "contact_email"],
  contact_field_updated: ["field_key", "field_new_value", "contact_phone", "contact_name", "contact_email"],
  contact_lifecycle_updated: ["stage_from", "stage_to", "contact_phone", "contact_name", "contact_email"],
  manual_trigger: ["contact_phone", "contact_name", "contact_email"],
  incoming_webhook: ["contact_phone", "contact_name", "contact_email"],
};

export const FIELD_LABELS: Record<ConditionField, string> = {
  body: "Message body",
  body_lower: "Message body (lowercased)",
  direction: "Direction",
  option_id: "Button/List option id",
  session_kind: "Session (first/returning/continued)",
  status_from: "Previous status",
  status_to: "New status",
  assigned_user_id: "Assigned user",
  conversation_status: "Conversation status",
  contact_phone: "Contact phone",
  contact_name: "Contact name",
  contact_email: "Contact email",
  contact_stage_id: "Contact stage",
  channel_account_id: "Account (number / Page)",
  tag_id: "Tag",
  tag_change_kind: "Tag change",
  field_key: "Field",
  field_new_value: "Field new value",
  stage_from: "Previous stage",
  stage_to: "New stage",
  ticket_status_from: "Ticket status (previous)",
  ticket_status_to: "Ticket status",
  ticket_priority: "Ticket priority",
  ticket_subject: "Ticket subject",
  ticket_cause: "Ticket cause",
  ticket_assigned_user_id: "Ticket assignee",
  ticket_team_id: "Ticket team",
  ticket_tag_id: "Ticket tag",
  ticket_breached_leg: "Which promise was missed",
  ticket_guest_workspace_id: "Escalated to workspace",
};

/**
 * How the value column should render for each condition field. Catalog-backed
 * fields ("stage" / "tag" / "user" / "field_key") show a dropdown of the
 * team's rows so authors never have to look up a CUID by hand. Enum fields
 * ("status" / "direction" / "tag_change_kind") render a dropdown of allowed
 * literal values. Everything else stays a free-text Input.
 */
export type FieldValueKind =
  | "text"
  | "stage"
  | "tag"
  | "user"
  | "status"
  | "direction"
  | "tag_change_kind"
  | "session_kind"
  | "channel_account"
  | "field_key"
  | "ticket_status"
  | "ticket_priority"
  | "ticket_team"
  | "ticket_breached_leg"
  | "workspace";

export const FIELD_VALUE_KIND: Record<ConditionField, FieldValueKind> = {
  body: "text",
  body_lower: "text",
  direction: "direction",
  option_id: "text",
  session_kind: "session_kind",
  status_from: "status",
  status_to: "status",
  conversation_status: "status",
  assigned_user_id: "user",
  contact_phone: "text",
  contact_name: "text",
  contact_email: "text",
  contact_stage_id: "stage",
  channel_account_id: "channel_account",
  tag_id: "tag",
  tag_change_kind: "tag_change_kind",
  field_key: "field_key",
  field_new_value: "text",
  stage_from: "stage",
  stage_to: "stage",
  // The ticket lifecycle is its OWN enum (new/open/pending/on_hold/solved/
  // closed) — reusing the conversation's `status` kind would offer the wrong
  // three values.
  ticket_status_from: "ticket_status",
  ticket_status_to: "ticket_status",
  ticket_priority: "ticket_priority",
  ticket_subject: "text",
  ticket_cause: "text",
  ticket_assigned_user_id: "user",
  ticket_team_id: "ticket_team",
  ticket_tag_id: "tag",
  ticket_breached_leg: "ticket_breached_leg",
  ticket_guest_workspace_id: "workspace",
};

export const STATUS_VALUES = ["open", "pending", "closed"] as const;
/** The TICKET lifecycle — a different set from the conversation's. */
export const TICKET_STATUS_VALUES = [
  "new",
  "open",
  "pending",
  "on_hold",
  "solved",
  "closed",
] as const;
export const TICKET_PRIORITY_VALUES = ["low", "normal", "high", "urgent"] as const;
export const TICKET_BREACHED_LEG_VALUES = ["first_response", "resolution"] as const;
export const DIRECTION_VALUES = ["in", "out"] as const;
export const TAG_CHANGE_KIND_VALUES = ["added", "removed"] as const;
export const SESSION_KIND_VALUES = [
  "first_ever",
  "returning_session",
  "continued",
] as const;

export const OP_OPTIONS: Array<{ value: ConditionOp; label: string; needsValue: boolean }> = [
  { value: "equals", label: "is equal to", needsValue: true },
  { value: "not_equals", label: "is not equal to", needsValue: true },
  { value: "contains", label: "contains", needsValue: true },
  { value: "not_contains", label: "does not contain", needsValue: true },
  { value: "starts_with", label: "starts with", needsValue: true },
  { value: "ends_with", label: "ends with", needsValue: true },
  { value: "regex", label: "matches regex", needsValue: true },
  { value: "is_null", label: "is empty", needsValue: false },
  { value: "is_not_null", label: "is not empty", needsValue: false },
];

// Helpers ----------------------------------------------------------------

export function cuidLike(): string {
  // Short client-side id; the server doesn't require cuid format for graph
  // node ids, just uniqueness within a graph.
  return "n_" + Math.random().toString(36).slice(2, 10);
}

export function toGroup(raw: unknown): ConditionGroup {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.children) && (r.op === "AND" || r.op === "OR")) {
      return raw as ConditionGroup;
    }
  }
  if (Array.isArray(raw)) {
    return { op: "AND", children: raw as ConditionGroup["children"] };
  }
  return { op: "AND", children: [] };
}
