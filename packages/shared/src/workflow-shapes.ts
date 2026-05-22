/**
 * Static shape registry for the workflow input/output inspector.
 *
 * Each entry describes the JSON shape a step's `run()` returns (in
 * structured form, not as a stringified blob). Drives:
 *
 *   - The OUTPUT pane in the step editor drawer — renders a tree of
 *     leaves the author can click to insert as `$var.previousStep.<path>`.
 *   - Downstream "what's reachable from this step?" computation when the
 *     selected step's upstream graph is walked.
 *   - Future contract: the per-step test-run endpoint (PR 3) returns
 *     values shaped per this registry so the inspector can render them
 *     inline alongside the schema.
 *
 * Shape semantics (kept deliberately simple — no JSON-Schema overhead):
 *
 *   { kind: "object", fields: { foo: <Shape>, ... } }
 *   { kind: "leaf", type: "string" | "number" | "boolean" | "json", description? }
 *   { kind: "union", variants: [<Shape>, ...] }
 *
 * `kind: "union"` is for branchy outputs (ask_question's `answered` vs
 * `timeout` body shape, for example). Renderers should flatten to the
 * superset of leaves so the picker doesn't gate behind run-time facts.
 */

import type { WorkflowStepType, WorkflowTriggerEvent } from "@prisma/client";

export type FieldShape =
  | {
      kind: "leaf";
      type: "string" | "number" | "boolean" | "json";
      description?: string;
    }
  | { kind: "object"; fields: Record<string, FieldShape> }
  | { kind: "union"; variants: FieldShape[] };

const leafString = (description?: string): FieldShape => ({
  kind: "leaf",
  type: "string",
  ...(description ? { description } : {}),
});
const leafNumber = (description?: string): FieldShape => ({
  kind: "leaf",
  type: "number",
  ...(description ? { description } : {}),
});
const leafBool = (description?: string): FieldShape => ({
  kind: "leaf",
  type: "boolean",
  ...(description ? { description } : {}),
});

const CONTACT_SHAPE: FieldShape = {
  kind: "object",
  fields: {
    // Keys MUST match the resolver vocabulary (BUILTIN_CONTACT_KEYS in
    // field-tokens.ts): the inspector inserts `$var.<ns>.contact.<key>` and
    // the runtime resolves the SAME key. Don't advertise raw DB column names
    // (phoneNumber / id / stageId) the resolver can't resolve — that's how
    // `$var.trigger.contact.phoneNumber` ended up always-empty.
    name: leafString(),
    phone: leafString("E.164 phone"),
    email: leafString(),
    location: leafString(),
    stage_name: leafString("Lifecycle stage name"),
    tag_names: leafString("Comma-separated tag names"),
    window_state: leafString("open | closing-soon | closed | never"),
    last_inbound_at: leafString("ISO timestamp"),
  },
};

const MESSAGE_SHAPE: FieldShape = {
  kind: "object",
  fields: {
    id: leafString(),
    body: leafString(),
    sender_name: leafString(),
    timestamp: leafString("ISO"),
    direction: leafString("in | out"),
    media_kind: leafString(),
    media_url: leafString(),
    has_media: leafBool(),
  },
};

const CONVERSATION_SHAPE: FieldShape = {
  kind: "object",
  fields: {
    id: leafString(),
    status: leafString("open | pending | closed"),
    unread_count: leafNumber(),
    has_unread: leafBool(),
    assigned_user_id: leafString(),
    assigned_agent_name: leafString(),
    last_message_at: leafString("ISO"),
  },
};

const AGENT_SHAPE: FieldShape = {
  kind: "object",
  fields: {
    // Resolver only knows agent name + email (BUILTIN_AGENT_KEYS); `id`
    // isn't resolvable, so don't advertise it.
    name: leafString(),
    email: leafString(),
  },
};

/**
 * Trigger payload shapes — what the `$var.trigger.*` namespace exposes
 * for each WorkflowTriggerEvent. Most triggers carry contact + (some
 * subset of) conversation + message + agent. Missing namespaces resolve
 * to empty when the picker walks them, so it's safe to keep this
 * conservative.
 */
export const TRIGGER_SHAPES: Record<WorkflowTriggerEvent, FieldShape> = {
  message_received: {
    kind: "object",
    fields: {
      contact: CONTACT_SHAPE,
      message: MESSAGE_SHAPE,
      conversation: CONVERSATION_SHAPE,
    },
  },
  conversation_created: {
    kind: "object",
    fields: { contact: CONTACT_SHAPE, conversation: CONVERSATION_SHAPE },
  },
  conversation_opened: {
    kind: "object",
    fields: { contact: CONTACT_SHAPE, conversation: CONVERSATION_SHAPE },
  },
  conversation_closed: {
    kind: "object",
    fields: { contact: CONTACT_SHAPE, conversation: CONVERSATION_SHAPE },
  },
  conversation_assigned: {
    kind: "object",
    fields: {
      contact: CONTACT_SHAPE,
      conversation: CONVERSATION_SHAPE,
      agent: AGENT_SHAPE,
    },
  },
  conversation_status_changed: {
    kind: "object",
    fields: { contact: CONTACT_SHAPE, conversation: CONVERSATION_SHAPE },
  },
  contact_tag_updated: {
    kind: "object",
    fields: { contact: CONTACT_SHAPE },
  },
  contact_field_updated: {
    kind: "object",
    fields: { contact: CONTACT_SHAPE },
  },
  contact_lifecycle_updated: {
    kind: "object",
    fields: { contact: CONTACT_SHAPE },
  },
  manual_trigger: {
    kind: "object",
    fields: {
      contact: CONTACT_SHAPE,
      conversation: CONVERSATION_SHAPE,
      agent: AGENT_SHAPE,
    },
  },
  incoming_webhook: {
    kind: "object",
    fields: { contact: CONTACT_SHAPE },
  },
};

/**
 * Per-step OUTPUT shapes — what `$var.previousStep.X` / `$var.steps.<id>.X`
 * resolves to after each step type runs. Conservative: leaves out fields
 * authors are unlikely to reference; the resolver still answers any
 * deeper path the step happens to produce (output is a JSON value, not
 * gated by this registry at run time). This registry is purely for the
 * UI inspector's leaf list.
 */
export const STEP_OUTPUT_SHAPES: Record<WorkflowStepType, FieldShape> = {
  send_message: {
    kind: "object",
    fields: {
      messageId: leafString("Local message row id"),
      externalId: leafString("Provider wamid"),
    },
  },
  send_template: {
    kind: "object",
    fields: {
      messageId: leafString(),
      externalId: leafString(),
    },
  },
  add_comment: {
    kind: "object",
    fields: { noteId: leafString() },
  },
  assign_to: {
    kind: "object",
    fields: { userId: leafString(), conversationId: leafString() },
  },
  set_status: {
    kind: "object",
    fields: { status: leafString("open | pending | closed") },
  },
  open_conversation: {
    kind: "object",
    fields: { conversationId: leafString() },
  },
  close_conversation: {
    kind: "object",
    fields: { conversationId: leafString(), category: leafString() },
  },
  add_tag: {
    kind: "object",
    fields: { tagId: leafString(), contactId: leafString() },
  },
  remove_tag: {
    kind: "object",
    fields: { tagId: leafString(), contactId: leafString() },
  },
  update_field: {
    kind: "object",
    fields: { fieldKey: leafString(), value: leafString() },
  },
  update_lifecycle: {
    kind: "object",
    fields: { stageId: leafString() },
  },
  branch: {
    kind: "object",
    fields: { selected: leafString("'true' or 'false'") },
  },
  wait: {
    kind: "object",
    fields: { delayMs: leafNumber() },
  },
  jump_to_step: {
    kind: "object",
    fields: { target: leafString() },
  },
  noop: {
    kind: "object",
    fields: { status: leafString() },
  },
  ask_question: {
    kind: "object",
    fields: {
      selected: leafString("answered | timeout | <option id>"),
      answer: leafString("The contact's reply text"),
      optionId: leafString("Stable id for button / list taps"),
    },
  },
  http_request: {
    kind: "object",
    fields: {
      statusCode: leafNumber(),
      body: {
        kind: "leaf",
        type: "json",
        description: "Response body — drill in via $var.previousStep.body.<path>",
      },
    },
  },
  trigger_workflow: {
    kind: "object",
    fields: { runId: leafString() },
  },
};

/**
 * Walk a shape and produce a flat list of leaf paths suitable for the
 * picker. Each leaf path is the dotted segments from the shape's root.
 *
 *   { foo: { bar: leaf } }  →  [["foo", "bar"]]
 *
 * Unions are flattened to the SUPERSET of leaves so the picker doesn't
 * gate behind run-time facts.
 */
export function flattenShape(
  shape: FieldShape,
  prefix: string[] = [],
): Array<{ path: string[]; type: string; description?: string }> {
  switch (shape.kind) {
    case "leaf":
      return [
        {
          path: prefix,
          type: shape.type,
          ...(shape.description ? { description: shape.description } : {}),
        },
      ];
    case "object": {
      const out: Array<{ path: string[]; type: string; description?: string }> = [];
      for (const [key, sub] of Object.entries(shape.fields)) {
        out.push(...flattenShape(sub, [...prefix, key]));
      }
      return out;
    }
    case "union": {
      const seen = new Set<string>();
      const out: Array<{ path: string[]; type: string; description?: string }> = [];
      for (const variant of shape.variants) {
        for (const leaf of flattenShape(variant, prefix)) {
          const key = leaf.path.join(".");
          if (!seen.has(key)) {
            seen.add(key);
            out.push(leaf);
          }
        }
      }
      return out;
    }
  }
}
