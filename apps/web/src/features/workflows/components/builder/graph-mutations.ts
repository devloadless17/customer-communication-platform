import type {
  StepType,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
} from "./types";
import { cuidLike, emptyConfigFor } from "./types";

/**
 * Pure graph mutations — extracted out of `workflow-canvas.tsx` so callers
 * (the workflow builder shell, future test harnesses) can import them without
 * dragging `@xyflow/react` + its CSS into their bundle. The canvas re-exports
 * these from here for backwards compatibility, but new call sites should
 * import from this file directly.
 *
 * No React, no React Flow — just pure WorkflowGraph → WorkflowGraph.
 */

/** Remove a step + any edges touching it. */
export function removeStep(graph: WorkflowGraph, nodeId: string): WorkflowGraph {
  // If the removed node sat between A → removed → B, splice the gap so
  // execution keeps flowing. Without this, deleting a middle step orphans
  // every downstream node and the user has to manually rewire.
  const incoming = graph.edges.find((e) => e.to === nodeId);
  const outgoing = graph.edges.filter((e) => e.from === nodeId);
  const splicedEdges: WorkflowEdge[] = [];
  if (incoming && outgoing.length === 1) {
    splicedEdges.push({
      from: incoming.from,
      to: outgoing[0]!.to,
      ...(incoming.label ? { label: incoming.label } : {}),
    });
  }
  return {
    // If we just removed the start, promote the (single) downstream node so
    // the workflow still has a valid entry point. Common case after
    // deleting the first step.
    startNodeId:
      graph.startNodeId === nodeId
        ? outgoing[0]?.to ?? ""
        : graph.startNodeId,
    nodes: graph.nodes.filter((n) => n.id !== nodeId),
    edges: [
      ...graph.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
      ...splicedEdges,
    ],
  };
}

/**
 * How many currently-reachable steps would become unreachable from the start
 * node if `nodeId` were removed via removeStep(). Drives a WARN before a delete
 * that drops a downstream subtree (a multi-output node — branch/ask_question —
 * or a start-node delete that abandons sibling branches). Returns 0 for the
 * happy-path single-output splice (the spliced edge keeps everything reachable)
 * and 0 for already-unreachable targets. Excludes the removed node itself.
 *
 * Pure + read-only: it calls removeStep but DISCARDS the result. Reachability
 * follows only real graph.edges (matching how the canvas renders connectivity);
 * a draft graph may legally contain cycles, so the Set guard prevents infinite
 * loops.
 */
export function countDisconnectedByRemoval(
  graph: WorkflowGraph,
  nodeId: string,
): number {
  const reachable = (g: WorkflowGraph): Set<string> => {
    const seen = new Set<string>();
    if (!g.startNodeId) return seen;
    const adj = new Map<string, string[]>();
    for (const e of g.edges) {
      const list = adj.get(e.from) ?? [];
      list.push(e.to);
      adj.set(e.from, list);
    }
    const stack = [g.startNodeId];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of adj.get(id) ?? []) if (!seen.has(next)) stack.push(next);
    }
    return seen;
  };
  const before = reachable(graph);
  const after = reachable(removeStep(graph, nodeId));
  let count = 0;
  for (const id of before) {
    if (id === nodeId) continue; // the removed node is an expected disappearance
    if (!after.has(id)) count += 1;
  }
  return count;
}

/**
 * Insert a new step immediately downstream of `sourceId` on the specified
 * source handle. If an outgoing edge already exists on that handle, it gets
 * rewired through the new node (A → new → B). Otherwise we just append (A →
 * new). `sourceId === TRIGGER` means "insert at the start of the workflow."
 *
 * `positionOverride` lets the caller place the node at a specific canvas
 * coordinate — used by the drag-from-handle-to-empty-canvas flow (n8n
 * style) so the new node lands where the user dropped the connection,
 * not at the autoplaced "below source" slot. When omitted, the helper
 * computes a sensible default: directly below the source for normal
 * steps, with a sideways offset for branch outputs (true→left, false→
 * right) so the two branches fan out visibly instead of stacking on top
 * of each other.
 */
export function insertStepAfter(
  graph: WorkflowGraph,
  sourceId: string | null, // null = inserting before the current startNode
  sourceHandle: string | null,
  type: StepType,
  positionOverride?: { x: number; y: number },
): { graph: WorkflowGraph; newNodeId: string } {
  const newId = cuidLike();
  // Anchor the new node below the source (or below the trigger when there's
  // no source). User can drag afterwards; this is just a sensible default.
  const sourceNode = sourceId
    ? graph.nodes.find((n) => n.id === sourceId)
    : null;
  const anchorY = sourceNode?.position?.y ?? 0;
  const anchorX = sourceNode?.position?.x ?? 80;
  // Branch + ask_question outputs spread horizontally — without this both
  // children pile on top of each other at sourceX, and the user has to drag
  // one out before they can even see the second is there. 140 = enough to
  // clear a w-64 (256px) node's half-width plus the edge label.
  //
  // Option-id edges (anything that isn't true/false/answered/timeout) are
  // also ask_question paths; treat them like "answered" — slot to the left
  // of the source so a freshly added per-option child doesn't collide with
  // the timeout child on the right.
  const branchOffset =
    sourceHandle === "true" || sourceHandle === "answered"
      ? -140
      : sourceHandle === "false" || sourceHandle === "timeout"
        ? 140
        : sourceHandle && sourceHandle !== "default"
          ? -140
          : 0;
  const newNode: WorkflowNode = {
    id: newId,
    type,
    config: emptyConfigFor(type),
    position: positionOverride ?? {
      x: anchorX + branchOffset,
      y: anchorY + 140,
    },
  };

  // Case 1: empty graph OR inserting before the start node.
  if (sourceId === null) {
    return {
      graph: {
        startNodeId: newId,
        nodes: [...graph.nodes, newNode],
        // Rewire trigger → start by connecting new → old start.
        edges: graph.startNodeId
          ? [...graph.edges, { from: newId, to: graph.startNodeId }]
          : graph.edges,
      },
      newNodeId: newId,
    };
  }

  // Case 2: inserting on an existing edge from sourceId.
  const handle = sourceHandle ?? null;
  const existing = graph.edges.find(
    (e) => e.from === sourceId && (e.label ?? null) === handle,
  );
  if (existing) {
    const rewired = graph.edges.map((e) =>
      e === existing ? { ...e, to: newId } : e,
    );
    return {
      graph: {
        startNodeId: graph.startNodeId || newId,
        nodes: [...graph.nodes, newNode],
        edges: [...rewired, { from: newId, to: existing.to }],
      },
      newNodeId: newId,
    };
  }

  // Case 3: appending — no existing outgoing edge on that handle.
  const newEdge: WorkflowEdge = {
    from: sourceId,
    to: newId,
    ...(handle ? { label: handle } : {}),
  };
  return {
    graph: {
      startNodeId: graph.startNodeId || newId,
      nodes: [...graph.nodes, newNode],
      edges: [...graph.edges, newEdge],
    },
    newNodeId: newId,
  };
}

/**
 * Edge reconciliation needed alongside an ask_question option-config edit:
 * a rename re-labels the matching per-option edge, a remove drops it. Shared
 * between the editor (which produces the op) and the builder (which applies
 * it to the live graph snapshot).
 */
export type AskOptionEdgeOp =
  | { kind: "rename"; oldId: string; newId: string }
  | { kind: "remove"; optionId: string };

/**
 * Re-label an ask_question option edge when its option id is renamed. The
 * canvas wires a per-option child as an edge labeled with the option id; if
 * the author renames the id in the editor without this, that edge keeps the
 * OLD label — orphaning the child subtree (a phantom reappearing "+") and
 * dead-ending the run when the tapped option matches no edge.
 *
 * Only touches the single outgoing edge from `nodeId` whose label === oldId.
 * No-op when old === new, oldId is empty, or no such edge exists.
 */
export function renameOptionEdge(
  graph: WorkflowGraph,
  nodeId: string,
  oldId: string,
  newId: string,
): WorkflowGraph {
  if (!oldId || oldId === newId) return graph;
  let mutated = false;
  const edges = graph.edges.map((e) => {
    if (e.from === nodeId && e.label === oldId) {
      mutated = true;
      // Empty newId means the author cleared the id field mid-edit — drop the
      // label so the now-unlabeled edge is the caller's to fix, rather than
      // leaving a stale-labeled dangling edge.
      return newId ? { ...e, label: newId } : { from: e.from, to: e.to };
    }
    return e;
  });
  return mutated ? { ...graph, edges } : graph;
}

/**
 * Drop the ask_question option edge whose label === optionId when that option
 * is removed from the editor. Mirrors removeStep's edge cleanup: a removed
 * option must not leave a dangling edge that orphans its child + reappears as
 * a phantom "+". No-op when no edge carries that label.
 */
export function removeOptionEdge(
  graph: WorkflowGraph,
  nodeId: string,
  optionId: string,
): WorkflowGraph {
  if (!optionId) return graph;
  const edges = graph.edges.filter(
    (e) => !(e.from === nodeId && e.label === optionId),
  );
  return edges.length === graph.edges.length ? graph : { ...graph, edges };
}

/**
 * Duplicate a step in place. Copies type + config, places the clone slightly
 * offset so it's visible, and DOES NOT rewire any edges — the duplicate is
 * orphaned by default and the user wires it where they want. Mirrors how
 * Figma / Miro duplicate works.
 */
export function duplicateStep(
  graph: WorkflowGraph,
  nodeId: string,
): { graph: WorkflowGraph; newNodeId: string } {
  const source = graph.nodes.find((n) => n.id === nodeId);
  if (!source) return { graph, newNodeId: nodeId };
  const newId = cuidLike();
  const newNode: WorkflowNode = {
    id: newId,
    type: source.type,
    // Deep-copy config so editing the duplicate doesn't mutate the original.
    config: JSON.parse(JSON.stringify(source.config)) as Record<string, unknown>,
    position: {
      x: (source.position?.x ?? 0) + 40,
      y: (source.position?.y ?? 0) + 40,
    },
  };
  return {
    graph: { ...graph, nodes: [...graph.nodes, newNode] },
    newNodeId: newId,
  };
}
