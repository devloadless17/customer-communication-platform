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
  /**
   * Author-supplied label rendered as the node's title on the canvas. When
   * empty/missing the canvas falls back to the step type label (e.g.
   * "Send Message"), so existing graphs keep rendering identically. Used
   * purely for human readability — the runner ignores it.
   */
  name?: string;
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
  // Trim + cap at 80 chars so a runaway paste can't blow up the canvas
  // layout. Empty string is normalized to undefined so the render path's
  // fallback-to-type-label branch fires.
  const rawName = typeof r.name === "string" ? r.name.trim().slice(0, 80) : "";
  const name = rawName.length > 0 ? rawName : undefined;
  return {
    id: r.id,
    type: r.type as WorkflowStepType,
    config,
    ...(position ? { position } : {}),
    ...(name ? { name } : {}),
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
/**
 * Hard cap on graph size. React Flow's canvas isn't using
 * `onlyRenderVisibleElements` (would need 200+ nodes to benefit), so a
 * runaway author wiring hundreds of step nodes makes the builder
 * pan/zoom stutter and the per-effect re-projection at workflow-canvas.tsx
 * walk the whole graph. Cap matches the docs target ("you don't need
 * more than a few dozen steps per workflow") with headroom for split
 * branches.
 */
export const MAX_WORKFLOW_NODES = 200;

export function validateGraph(graph: WorkflowGraph): string[] {
  const errors: string[] = [];

  if (!graph.startNodeId) {
    // Empty graph = empty workflow draft. Allowed for save, not for publish.
    if (graph.nodes.length > 0 || graph.edges.length > 0) {
      errors.push("graph.startNodeId is required when nodes exist");
    }
    return errors;
  }

  if (graph.nodes.length > MAX_WORKFLOW_NODES) {
    errors.push(
      `graph.nodes: too many nodes (${graph.nodes.length}); max ${MAX_WORKFLOW_NODES}`,
    );
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

  // Branch nodes must have a labeled true + false edge. ask_question nodes
  // must have answered + timeout edges. Other control-flow step types
  // enforce their own edge invariants in the runner/handler.
  for (const n of graph.nodes) {
    if (n.type === "branch") {
      const outs = graph.edges.filter((e) => e.from === n.id);
      const labels = new Set(outs.map((e) => e.label));
      if (!labels.has("true") || !labels.has("false")) {
        errors.push(`branch node "${n.id}" must have edges labeled "true" and "false"`);
      }
    }
    if (n.type === "ask_question") {
      const outs = graph.edges.filter((e) => e.from === n.id);
      const labels = new Set(outs.map((e) => e.label));
      // Two legal shapes:
      //   1. Generic free-text mode: "answered" + "timeout" edges.
      //   2. N-way buttons mode: one edge per option id + "timeout". Option
      //      ids come from the step's `options` config (validated by
      //      parseStepConfig); here we just require SOMETHING-non-timeout +
      //      timeout. The runner falls back to "answered" if the tapped
      //      option doesn't match any edge, which keeps the safety net
      //      alive even when an author renames an option after wiring.
      const hasTimeout = labels.has("timeout");
      const hasAnswered = labels.has("answered");
      const hasNonTimeoutOption = Array.from(labels).some(
        (l) => l && l !== "timeout" && l !== "answered",
      );
      if (!hasTimeout || (!hasAnswered && !hasNonTimeoutOption)) {
        errors.push(
          `ask_question node "${n.id}" must have a "timeout" edge plus either an "answered" edge OR one edge per option id`,
        );
      }
    }
  }

  // Detect orphans — non-start nodes with no incoming edge. Warn, don't fail,
  // because mid-edit drafts often have temporarily-detached steps. (Round 2c
  // could promote to error on publish.)
  // For now we omit the orphan check.

  // Cycle detection. A workflow graph MUST be a DAG. Without this guard,
  // an author wiring A → B → A by accident produces runs that hammer the
  // 100-step ceiling on every fire — 100 step iterations + 100 outbox
  // writes + 100 WorkflowRun updates PER trigger, throttled only by the
  // worker concurrency. We exclude `jump_to_step` (its target is
  // condition-guarded; the runner caps cycles via the step ceiling).
  // Plain edges that form a cycle are always wrong.
  const adjacency = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = adjacency.get(e.from) ?? [];
    list.push(e.to);
    adjacency.set(e.from, list);
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of ids) color.set(id, WHITE);
  const cycle: string[] = [];
  const visit = (id: string, path: string[]): boolean => {
    color.set(id, GRAY);
    path.push(id);
    const outs = adjacency.get(id) ?? [];
    for (const next of outs) {
      const c = color.get(next);
      if (c === GRAY) {
        const start = path.indexOf(next);
        cycle.push(...path.slice(start), next);
        return true;
      }
      if (c === WHITE && visit(next, path)) return true;
    }
    path.pop();
    color.set(id, BLACK);
    return false;
  };
  for (const id of ids) {
    if (color.get(id) === WHITE && visit(id, [])) {
      errors.push(
        `graph.edges form a cycle (${cycle.join(" → ")}) — workflows must be acyclic`,
      );
      break;
    }
  }

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
