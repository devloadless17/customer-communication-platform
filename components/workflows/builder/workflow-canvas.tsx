"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { BranchNode, StepNode, TriggerNode } from "./canvas-nodes";
import type { StepType, WorkflowEdge, WorkflowGraph, WorkflowNode } from "./types";
import { cuidLike, emptyConfigFor } from "./types";

/**
 * React Flow wrapper that converts between the canonical WorkflowGraph
 * shape and React Flow's nodes/edges shape. Adds:
 *   - drag-drop step palette (palette lives in the parent; canvas exposes
 *     `addStep(type, position)` via props for it to call)
 *   - selection routing (parent listens for selected node to open editor)
 *   - branch edges with true/false labels (handled via Connection.sourceHandle)
 */

const nodeTypes = {
  trigger: TriggerNode,
  step: StepNode,
  branch: BranchNode,
};

export interface WorkflowCanvasProps {
  graph: WorkflowGraph;
  /** Currently-selected step id, for highlight. Trigger has its own toggle. */
  selectedStepId: string | null;
  triggerSelected: boolean;
  /** Label shown on the trigger node. */
  triggerLabel: string;
  triggerDescription: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  triggerType: any;
  onChange: (graph: WorkflowGraph) => void;
  onSelectStep: (id: string | null) => void;
  onSelectTrigger: () => void;
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

const TRIGGER_NODE_ID = "__trigger__";

function CanvasInner({
  graph,
  selectedStepId,
  triggerSelected,
  triggerLabel,
  triggerDescription,
  triggerType,
  onChange,
  onSelectStep,
  onSelectTrigger,
}: WorkflowCanvasProps) {
  // Build React Flow nodes/edges from canonical graph + add a synthetic
  // trigger node at the top. The trigger node never appears in graph.nodes —
  // it's a visual stand-in for the workflow's `trigger` property.
  const rfNodes = useMemo<Node[]>(() => {
    const stepNodes: Node[] = graph.nodes.map((n) => ({
      id: n.id,
      type: n.type === "branch" ? "branch" : "step",
      position: n.position ?? { x: 0, y: 0 },
      data: {
        label: n.id,
        type: n.type,
        selected: n.id === selectedStepId,
        summary: describeNode(n),
      },
    }));
    const triggerNode: Node = {
      id: TRIGGER_NODE_ID,
      type: "trigger",
      position: { x: 0, y: 0 },
      data: {
        label: triggerLabel,
        description: triggerDescription,
        trigger: triggerType,
        selected: triggerSelected,
      },
      draggable: true,
    };
    return [triggerNode, ...stepNodes];
  }, [graph, selectedStepId, triggerSelected, triggerLabel, triggerDescription, triggerType]);

  const rfEdges = useMemo<Edge[]>(() => {
    const edges: Edge[] = graph.edges.map((e, i) => ({
      id: `e_${i}_${e.from}_${e.label ?? ""}_${e.to}`,
      source: e.from,
      target: e.to,
      sourceHandle: e.label ?? "default",
      label: e.label === "true" ? "true" : e.label === "false" ? "false" : undefined,
      labelStyle: { fontSize: 11 },
    }));
    // Synthetic edge from trigger to startNode for visual clarity. The runner
    // doesn't read this — startNodeId on the graph is what it walks from.
    if (graph.startNodeId) {
      edges.unshift({
        id: "e_trigger_start",
        source: TRIGGER_NODE_ID,
        target: graph.startNodeId,
        sourceHandle: "default",
        style: { strokeDasharray: "4 4" },
      });
    }
    return edges;
  }, [graph]);

  // Local position state — drives React Flow's node positions during drag
  // so the canvas feels responsive. Committed back to `graph` on drag end.
  const [positionOverrides, setPositionOverrides] = useState<Record<string, { x: number; y: number }>>({});
  useEffect(() => {
    setPositionOverrides({});
  }, [graph.startNodeId]);

  const nodesWithOverrides = useMemo(
    () =>
      rfNodes.map((n) =>
        positionOverrides[n.id] ? { ...n, position: positionOverrides[n.id]! } : n,
      ),
    [rfNodes, positionOverrides],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Track positions locally for smooth dragging; only persist on drag end.
      const next = { ...positionOverrides };
      let dragEnded = false;
      for (const ch of changes) {
        if (ch.type === "position" && ch.position) {
          next[ch.id] = ch.position;
          if (ch.dragging === false) dragEnded = true;
        }
      }
      setPositionOverrides(next);

      if (dragEnded) {
        // Commit positions back to the canonical graph (skip the trigger
        // node — it's synthetic and doesn't live in graph.nodes).
        onChange({
          ...graph,
          nodes: graph.nodes.map((n) =>
            next[n.id] ? { ...n, position: next[n.id] } : n,
          ),
        });
      }

      // React Flow built-in `applyNodeChanges` is only relevant to local
      // state we don't keep; the position-only changes are reflected via
      // positionOverrides above. Selection changes flow through React Flow's
      // own internal state — we don't need to mirror them.
      applyNodeChanges(changes, nodesWithOverrides);
    },
    [graph, nodesWithOverrides, onChange, positionOverrides],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      let next = [...graph.edges];
      let mutated = false;
      for (const ch of changes) {
        if (ch.type === "remove") {
          if (ch.id === "e_trigger_start") continue; // synthetic; ignore deletes
          // Decode the edge id pattern e_{i}_{from}_{label}_{to}
          const found = rfEdges.find((e) => e.id === ch.id);
          if (!found) continue;
          next = next.filter(
            (e) =>
              !(
                e.from === found.source &&
                e.to === found.target &&
                (e.label ?? "default") === (found.sourceHandle ?? "default")
              ),
          );
          mutated = true;
        }
      }
      if (mutated) onChange({ ...graph, edges: next });
      applyEdgeChanges(changes, rfEdges);
    },
    [graph, rfEdges, onChange],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      // Connecting from the trigger node sets the workflow's startNodeId.
      // The actual edge isn't stored in graph.edges — it's a synthetic.
      if (conn.source === TRIGGER_NODE_ID) {
        onChange({ ...graph, startNodeId: conn.target });
        return;
      }
      const label =
        conn.sourceHandle && conn.sourceHandle !== "default" ? conn.sourceHandle : undefined;
      const exists = graph.edges.some(
        (e) =>
          e.from === conn.source &&
          e.to === conn.target &&
          (e.label ?? null) === (label ?? null),
      );
      if (exists) return;
      const newEdge: WorkflowEdge = {
        from: conn.source,
        to: conn.target,
        ...(label ? { label } : {}),
      };
      onChange({ ...graph, edges: [...graph.edges, newEdge] });
      // React Flow's built-in addEdge is only useful when we'd otherwise
      // mirror the edges array; since we project from `graph` every render,
      // calling it is unnecessary. Kept import for future use.
      void addEdge;
    },
    [graph, onChange],
  );

  function onNodeClick(_: unknown, node: Node) {
    if (node.id === TRIGGER_NODE_ID) {
      onSelectTrigger();
      return;
    }
    onSelectStep(node.id);
  }

  function onPaneClick() {
    onSelectStep(null);
  }

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodesWithOverrides}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        <Controls />
      </ReactFlow>
    </div>
  );
}

function describeNode(n: WorkflowNode): string | undefined {
  // Cheap inline preview of a node's config — full describe lives server-side
  // (lib/workflows/steps/index.ts) but we can mirror the common cases for
  // immediate canvas feedback. Falls through to undefined when there's
  // nothing useful to say.
  const c = n.config as Record<string, unknown>;
  switch (n.type) {
    case "send_message":
    case "add_comment":
      return typeof c.body === "string" ? clip(c.body) : undefined;
    case "send_template":
      return typeof c.templateId === "string" ? `Template ${c.templateId}` : undefined;
    case "assign_to":
      return c.mode === "unassign" ? "Unassign" : c.userId ? `→ ${c.userId}` : undefined;
    case "set_status":
      return c.status ? `→ ${c.status}` : undefined;
    case "close_conversation":
      return typeof c.category === "string" ? c.category : undefined;
    case "add_tag":
    case "remove_tag":
      return typeof c.tagId === "string" ? `Tag ${c.tagId}` : undefined;
    case "update_field":
      return c.fieldKey ? `${c.fieldKey} = ${typeof c.value === "string" ? clip(c.value) : ""}` : undefined;
    case "update_lifecycle":
      return c.stageId ? `→ stage ${c.stageId}` : undefined;
    case "wait":
      return typeof c.delayMs === "number" ? humanize(c.delayMs) : undefined;
    case "jump_to_step":
      return typeof c.targetStepId === "string" ? `→ ${c.targetStepId}` : undefined;
    case "http_request":
      return typeof c.url === "string" ? `POST ${clip(c.url, 40)}` : undefined;
    case "trigger_workflow":
      return typeof c.workflowId === "string" ? `→ ${c.workflowId}` : undefined;
    default:
      return undefined;
  }
}

function clip(s: string, n: number = 60): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function humanize(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/**
 * Standalone helper: place a new node below the lowest existing node, and
 * return a WorkflowGraph with the node + an edge from the last node added.
 * Used by the step palette to drop a new step into the graph.
 */
export function appendStep(graph: WorkflowGraph, type: StepType): WorkflowGraph {
  const lowest = graph.nodes.reduce<number>(
    (acc, n) => Math.max(acc, n.position?.y ?? 0),
    0,
  );
  const id = cuidLike();
  const newNode: WorkflowNode = {
    id,
    type,
    config: emptyConfigFor(type),
    position: { x: 80, y: lowest + 140 },
  };
  // If the graph was empty, set startNodeId. Otherwise connect from the
  // most-recently-added node (highest position OR last in array). The user
  // can rewire as needed.
  if (graph.nodes.length === 0) {
    return {
      startNodeId: id,
      nodes: [newNode],
      edges: [],
    };
  }
  const last = graph.nodes[graph.nodes.length - 1]!;
  return {
    startNodeId: graph.startNodeId || id,
    nodes: [...graph.nodes, newNode],
    edges: [...graph.edges, { from: last.id, to: id }],
  };
}

/** Remove a step + any edges touching it. */
export function removeStep(graph: WorkflowGraph, nodeId: string): WorkflowGraph {
  return {
    startNodeId: graph.startNodeId === nodeId ? "" : graph.startNodeId,
    nodes: graph.nodes.filter((n) => n.id !== nodeId),
    edges: graph.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
  };
}
