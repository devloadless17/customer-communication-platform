// Note: no `server-only` import — pulled in by the BullMQ worker which boots
// from server.ts, outside the Next bundler context.

import type { WorkflowStepType } from "@prisma/client";

/**
 * DAG types for a Workflow.graph column.
 *
 *   {
 *     startNodeId: string,
 *     nodes: [{ id, type, config, position? }],
 *     edges: [{ from, to, label? }],
 *   }
 *
 * Edges are labeled for control-flow steps:
 *   branch       → emits "true" and "false" edges (exactly two)
 *   jump_to_step → ignores its outgoing edges; targetStepId is in config
 *   wait         → exactly one outgoing edge (resumes there after the delay)
 *   everything else → exactly one outgoing edge ("default" / unlabeled)
 *
 * Validation is enforced in validateGraph(). The runner trusts the validated
 * shape; if a published workflow's graph is malformed, the run fails fast
 * with a step-level error.
 */

export interface NodePosition {
  x: number;
  y: number;
}

export interface WorkflowNode {
  id: string;
  type: WorkflowStepType;
  config: Record<string, unknown>;
  position?: NodePosition;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  /** Used by branch ("true" | "false") and reserved for future named outputs. */
  label?: string;
}

export interface WorkflowGraph {
  startNodeId: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** A graph that exists but has no steps yet — also valid (a draft). */
export const EMPTY_GRAPH: WorkflowGraph = {
  startNodeId: "",
  nodes: [],
  edges: [],
};

// ---------------------------------------------------------------------------
// Parsing — permissive, used at runtime. Anything unparseable becomes EMPTY.
// ---------------------------------------------------------------------------

export function toGraph(raw: unknown): WorkflowGraph {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_GRAPH;
  const r = raw as Record<string, unknown>;
  const startNodeId = typeof r.startNodeId === "string" ? r.startNodeId : "";
  const nodes = Array.isArray(r.nodes) ? r.nodes.map(parseNode).filter(Boolean) as WorkflowNode[] : [];
  const edges = Array.isArray(r.edges) ? r.edges.map(parseEdge).filter(Boolean) as WorkflowEdge[] : [];
  return { startNodeId, nodes, edges };
}

function parseNode(raw: unknown): WorkflowNode | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.type !== "string") return null;
  const config = r.config && typeof r.config === "object" && !Array.isArray(r.config)
    ? (r.config as Record<string, unknown>)
    : {};
  const position = r.position && typeof r.position === "object" && !Array.isArray(r.position)
    ? r.position as NodePosition
    : undefined;
  return {
    id: r.id,
    type: r.type as WorkflowStepType,
    config,
    ...(position ? { position } : {}),
  };
}

function parseEdge(raw: unknown): WorkflowEdge | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.from !== "string" || typeof r.to !== "string") return null;
  const label = typeof r.label === "string" ? r.label : undefined;
  return { from: r.from, to: r.to, ...(label !== undefined ? { label } : {}) };
}

// ---------------------------------------------------------------------------
// Validation — strict, used by the management API at write time.
// ---------------------------------------------------------------------------

/**
 * Strict graph validation. Returns empty array when valid, otherwise a list
 * of human-readable errors. Save anyway is allowed for draft workflows;
 * publish requires zero errors.
 */
export function validateGraph(graph: WorkflowGraph): string[] {
  const errors: string[] = [];

  if (!graph.startNodeId) {
    // Empty graph = empty workflow draft. Allowed for save, not for publish.
    if (graph.nodes.length > 0 || graph.edges.length > 0) {
      errors.push("graph.startNodeId is required when nodes exist");
    }
    return errors;
  }

  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (ids.has(n.id)) errors.push(`graph.nodes: duplicate id "${n.id}"`);
    ids.add(n.id);
  }

  if (!ids.has(graph.startNodeId)) {
    errors.push(`graph.startNodeId "${graph.startNodeId}" not in nodes`);
  }

  for (const e of graph.edges) {
    if (!ids.has(e.from)) errors.push(`graph.edges: from "${e.from}" not in nodes`);
    if (!ids.has(e.to)) errors.push(`graph.edges: to "${e.to}" not in nodes`);
  }

  // Branch nodes must have a labeled true + false edge. Other control-flow
  // step types enforce their own edge invariants in the runner/handler.
  for (const n of graph.nodes) {
    if (n.type === "branch") {
      const outs = graph.edges.filter((e) => e.from === n.id);
      const labels = new Set(outs.map((e) => e.label));
      if (!labels.has("true") || !labels.has("false")) {
        errors.push(`branch node "${n.id}" must have edges labeled "true" and "false"`);
      }
    }
  }

  // Detect orphans — non-start nodes with no incoming edge. Warn, don't fail,
  // because mid-edit drafts often have temporarily-detached steps. (Round 2c
  // could promote to error on publish.)
  // For now we omit the orphan check.

  return errors;
}

// ---------------------------------------------------------------------------
// Traversal — what runs next from here.
// ---------------------------------------------------------------------------

/**
 * Pick the next step after `fromId`. For most step types we use the single
 * unlabeled edge; for branch the caller passes `selectedLabel` (e.g. "true"
 * or "false") and we pick that edge.
 *
 * Returns `null` when there's no outgoing edge — the runner treats that as
 * end-of-graph and marks the run completed.
 */
export function findNextStep(
  graph: WorkflowGraph,
  fromId: string,
  selectedLabel?: string,
): string | null {
  const outs = graph.edges.filter((e) => e.from === fromId);
  if (outs.length === 0) return null;
  if (selectedLabel !== undefined) {
    const labeled = outs.find((e) => e.label === selectedLabel);
    return labeled?.to ?? null;
  }
  // Prefer unlabeled edges for the "default" path. If only labeled edges
  // exist (rare — would be a misconfigured graph), pick the first as a
  // forgiving fallback rather than dead-ending the run.
  const unlabeled = outs.find((e) => !e.label);
  return (unlabeled ?? outs[0])?.to ?? null;
}

export function findNode(graph: WorkflowGraph, id: string): WorkflowNode | null {
  return graph.nodes.find((n) => n.id === id) ?? null;
}
