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
  | "body" | "body_lower" | "direction"
  | "status_from" | "status_to" | "assigned_user_id" | "conversation_status"
  | "contact_phone" | "contact_name" | "contact_email" | "contact_stage_id"
  | "tag_id" | "tag_change_kind"
  | "field_key" | "field_new_value"
  | "stage_from" | "stage_to";

export type ConditionOp =
  | "equals" | "not_equals" | "contains" | "not_contains"
  | "starts_with" | "ends_with" | "regex"
  | "is_null" | "is_not_null";

export interface Condition {
  field: ConditionField;
  op: ConditionOp;
  value: string;
}

export interface ConditionGroup {
  op: GroupOp;
  children: Array<Condition | ConditionGroup>;
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
}

// Trigger + step metadata --------------------------------------------------

export const TRIGGER_OPTIONS: Array<{
  value: Trigger;
  label: string;
  description: string;
  group: "inbox" | "contact" | "external";
}> = [
  { value: "message_received", label: "Message Received", description: "Inbound message arrived.", group: "inbox" },
  { value: "conversation_created", label: "Conversation Created", description: "First-ever conversation for a contact.", group: "inbox" },
  { value: "conversation_opened", label: "Conversation Opened", description: "Status moved to open.", group: "inbox" },
  { value: "conversation_closed", label: "Conversation Closed", description: "Status moved to closed.", group: "inbox" },
  { value: "conversation_assigned", label: "Conversation Assigned", description: "Assignee changed.", group: "inbox" },
  { value: "conversation_status_changed", label: "Status Changed", description: "Any status transition.", group: "inbox" },
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
  { value: "add_tag", label: "Add Tag", description: "Apply a tag to the contact.", group: "contact" },
  { value: "remove_tag", label: "Remove Tag", description: "Remove a tag from the contact.", group: "contact" },
  { value: "update_field", label: "Update Contact Field", description: "Set a custom field value.", group: "contact" },
  { value: "update_lifecycle", label: "Update Lifecycle", description: "Move the contact to a stage.", group: "contact" },
  { value: "branch", label: "Branch", description: "If/else based on conditions.", group: "control" },
  { value: "wait", label: "Wait", description: "Pause before continuing.", group: "control" },
  { value: "jump_to_step", label: "Jump to Step", description: "Jump to another step in this workflow.", group: "control" },
  { value: "http_request", label: "HTTP Request", description: "POST the envelope to an external URL.", group: "external" },
  { value: "trigger_workflow", label: "Trigger Workflow", description: "Run another workflow for this contact.", group: "external" },
];

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
    case "http_request":
      return { url: "" };
    case "trigger_workflow":
      return { workflowId: "" };
  }
}

// Constants mirrored from the server -------------------------------------

export const FIELDS_BY_TRIGGER: Record<Trigger, ConditionField[]> = {
  message_received: [
    "body", "body_lower", "direction",
    "contact_phone", "contact_name", "contact_email", "contact_stage_id",
    "conversation_status", "assigned_user_id",
  ],
  conversation_created: ["contact_phone", "contact_name", "contact_email", "contact_stage_id"],
  conversation_opened: ["status_from", "contact_phone", "contact_name", "contact_email", "assigned_user_id"],
  conversation_closed: ["status_from", "contact_phone", "contact_name", "contact_email", "assigned_user_id"],
  conversation_assigned: ["assigned_user_id", "contact_phone", "contact_name", "contact_email"],
  conversation_status_changed: ["status_from", "status_to", "contact_phone", "contact_name", "contact_email"],
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
  status_from: "Previous status",
  status_to: "New status",
  assigned_user_id: "Assigned user",
  conversation_status: "Conversation status",
  contact_phone: "Contact phone",
  contact_name: "Contact name",
  contact_email: "Contact email",
  contact_stage_id: "Contact stage",
  tag_id: "Tag",
  tag_change_kind: "Tag change",
  field_key: "Field",
  field_new_value: "Field new value",
  stage_from: "Previous stage",
  stage_to: "New stage",
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
  | "field_key";

export const FIELD_VALUE_KIND: Record<ConditionField, FieldValueKind> = {
  body: "text",
  body_lower: "text",
  direction: "direction",
  status_from: "status",
  status_to: "status",
  conversation_status: "status",
  assigned_user_id: "user",
  contact_phone: "text",
  contact_name: "text",
  contact_email: "text",
  contact_stage_id: "stage",
  tag_id: "tag",
  tag_change_kind: "tag_change_kind",
  field_key: "field_key",
  field_new_value: "text",
  stage_from: "stage",
  stage_to: "stage",
};

export const STATUS_VALUES = ["open", "pending", "closed"] as const;
export const DIRECTION_VALUES = ["in", "out"] as const;
export const TAG_CHANGE_KIND_VALUES = ["added", "removed"] as const;

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
