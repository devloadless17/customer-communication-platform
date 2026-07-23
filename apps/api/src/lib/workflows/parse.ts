import type { WorkflowTriggerEvent } from "@prisma/client";

import { validateConditions } from "@/lib/workflows/conditions";
import {
  type WorkflowGraph,
  isGraphIncompletenessError,
  toGraph,
  validateGraph,
} from "@/lib/workflows/graph";
import { parseStepConfig, redactStepConfig } from "@/lib/workflows/steps";

/**
 * Validation helpers for workflow CRUD. Centralized so the create + patch
 * routes share validation semantics — and so /api/workspace/workflows/[id]/publish
 * can require zero-error validation as a publish gate while save tolerates
 * a half-edited draft.
 *
 * Validation tiers:
 *   - SAVE: name + trigger required; conditions + graph + step configs are
 *     all tolerantly validated (graph nodes can be missing the start, edges
 *     can be incomplete — admin's still building it).
 *   - PUBLISH: every step config must parse, graph must validate clean,
 *     conditions must validate clean. Failing publish keeps the workflow
 *     `published=false` so the dispatcher never picks up a broken graph.
 *
 * Moved from `app/api/workspace/workflows/_shared.ts` so the NestJS workflows
 * controller can import it without crossing the `lib/` → `app/api/` boundary
 * (lib code may never depend on app code).
 */

export const VALID_TRIGGERS: ReadonlyArray<WorkflowTriggerEvent> = [
  "message_received",
  "conversation_created",
  "conversation_opened",
  "conversation_closed",
  "conversation_assigned",
  "conversation_status_changed",
  "contact_field_updated",
  "contact_tag_updated",
  "contact_lifecycle_updated",
  "manual_trigger",
  "incoming_webhook",
];

export interface WorkflowBody {
  name?: unknown;
  published?: unknown;
  trigger?: unknown;
  triggerConfig?: unknown;
  triggerConditions?: unknown;
  triggerOncePerContact?: unknown;
  graph?: unknown;
}

export interface ParsedWorkflow {
  name: string;
  published: boolean;
  trigger: WorkflowTriggerEvent;
  triggerConfig: Record<string, unknown>;
  triggerConditions: unknown;
  triggerOncePerContact: boolean;
  graph: WorkflowGraph;
  errors: string[];
  /**
   * Non-blocking structural-incompleteness notices (SAVE tier only). A
   * freshly added Branch / ask_question node has unwired outputs mid-build;
   * those surface here so the canvas can show them WITHOUT blocking autosave
   * or Test. Always empty in PUBLISH tier — there the same conditions are
   * promoted into `errors` (publish must block on an incomplete graph).
   */
  warnings: string[];
  /** Detailed errors found in step configs. Always populated even when ok. */
  stepErrors: Record<string, string>;
}

export function parseWorkflowBody(
  body: WorkflowBody,
  opts: { forPublish?: boolean } = {},
): ParsedWorkflow {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stepErrors: Record<string, string> = {};

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) errors.push("name: required");
  else if (name.length > 100) errors.push("name: too long (max 100)");

  const published = body.published === true;
  const triggerOncePerContact = body.triggerOncePerContact === true;

  const trigger = body.trigger as WorkflowTriggerEvent;
  if (!VALID_TRIGGERS.includes(trigger)) {
    errors.push(`trigger: must be one of ${VALID_TRIGGERS.join(", ")}`);
  }

  const triggerConfig =
    body.triggerConfig && typeof body.triggerConfig === "object" && !Array.isArray(body.triggerConfig)
      ? (body.triggerConfig as Record<string, unknown>)
      : {};

  if (trigger && VALID_TRIGGERS.includes(trigger)) {
    errors.push(
      ...validateConditions(trigger, body.triggerConditions ?? { op: "AND", children: [] }),
    );
  }

  const graph = toGraph(body.graph);
  const graphErrors = validateGraph(graph);
  if (opts.forPublish) {
    errors.push(...graphErrors);
  } else {
    // SAVE tier: control-flow INCOMPLETENESS (a freshly added Branch /
    // ask_question node with unwired outputs) is the normal mid-build state
    // — route those to `warnings` so the canvas shows them WITHOUT blocking
    // autosave or Test. Truly-fatal structural errors (duplicate id, start /
    // edge endpoint not in nodes, too-many-nodes, cycle) still block the save.
    for (const e of graphErrors) {
      if (isGraphIncompletenessError(e)) warnings.push(e);
      else errors.push(e);
    }
  }

  // Per-step config validation — done against the live step registry.
  for (const node of graph.nodes) {
    try {
      parseStepConfig(node.type, node.config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "invalid";
      stepErrors[node.id] = msg;
      // Only block save when publishing; otherwise the admin should be able
      // to keep editing a partially-broken step.
      if (opts.forPublish) errors.push(`step[${node.id}]: ${msg}`);
    }
  }

  return {
    name,
    published,
    trigger,
    triggerConfig,
    triggerConditions: body.triggerConditions ?? { op: "AND", children: [] },
    triggerOncePerContact,
    graph,
    errors,
    warnings,
    stepErrors,
  };
}

/** Redact secrets out of the graph's step configs before sending to the UI. */
export function redactGraph(graph: WorkflowGraph): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => ({
      ...n,
      config: (redactStepConfig(n.type, n.config) as Record<string, unknown>) ?? {},
    })),
  };
}
