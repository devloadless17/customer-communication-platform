"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
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
  // Trigger position. The trigger node is synthetic — it isn't stored in
  // graph.nodes, so a hardcoded position in the projection would slam it
  // back to (0,0) every time the user changed the trigger type or anything
  // else triggered a projection rebuild. Keep its position in local
  // canvas state so it survives rebuilds within the session.
  //
  // Not persisted to the database (the trigger isn't part of WorkflowGraph
  // and adding a schema field is a bigger change than this UX issue warrants
  // for the pilot). A page reload resets to (0, 0).
  const [triggerPos, setTriggerPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Project the canonical WorkflowGraph into React Flow's node/edge shape.
  // The synthetic trigger node lives only on the canvas; it stands in for
  // the workflow's `trigger` property and never appears in graph.nodes.
  const projectedNodes = useMemo<Node[]>(() => {
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
      position: triggerPos,
      data: {
        label: triggerLabel,
        description: triggerDescription,
        trigger: triggerType,
        selected: triggerSelected,
      },
      draggable: true,
    };
    return [triggerNode, ...stepNodes];
  }, [graph, selectedStepId, triggerSelected, triggerLabel, triggerDescription, triggerType, triggerPos]);

  const projectedEdges = useMemo<Edge[]>(() => {
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

  // React Flow's recommended controlled pattern: useNodesState owns the
  // internal copy that applyNodeChanges feeds. The previous shape called
  // applyNodeChanges and discarded the return value, leaving React Flow's
  // selection / drag / dimension changes unapplied — nodes flickered or
  // vanished on click/move because the prop'd nodes and the internal store
  // disagreed on which one was active.
  //
  // Sync from projection → internal store happens via the useEffect below
  // (fires when graph changes from outside, e.g. step palette add). User
  // drag/select happens via onNodesChange and commits back to graph on
  // drag end.
  const [nodes, setNodes, onNodesChangeInternal] = useNodesState(projectedNodes);
  const [edges, setEdges, onEdgesChangeInternal] = useEdgesState(projectedEdges);

  // Adopt the projection whenever the canonical graph changes from above.
  // Internal selection / drag state lives in the hook's internal store and
  // would be lost on every prop'd graph change — that's intentional: a
  // graph mutation should reset the canvas's view of "which one is in
  // motion." Position + data fields adopt the projection's values cleanly.
  useEffect(() => {
    setNodes(projectedNodes);
  }, [projectedNodes, setNodes]);
  useEffect(() => {
    setEdges(projectedEdges);
  }, [projectedEdges, setEdges]);

  // Drag-end commit. Step nodes get pushed back into the canonical graph so
  // persist() picks them up. The trigger node updates local `triggerPos`
  // instead (it isn't part of graph.nodes — see the state declaration).
  // Position-during-drag is handled entirely inside React Flow's internal
  // store via onNodesChangeInternal — the canvas stays smooth without us
  // touching `graph` on every mouse-move.
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChangeInternal(changes);
      const positionEnds = changes.filter(
        (c): c is NodeChange & { type: "position"; id: string; position: { x: number; y: number }; dragging: false } =>
          c.type === "position" && c.dragging === false && !!c.position,
      );
      if (positionEnds.length === 0) return;
      // Trigger node — persist locally so a trigger-type change (or any
      // other projection rebuild) doesn't snap it back to (0, 0).
      const triggerEnd = positionEnds.find((c) => c.id === TRIGGER_NODE_ID);
      if (triggerEnd) setTriggerPos(triggerEnd.position);
      // Step nodes — commit back into the canonical graph.
      const stepEnds = positionEnds.filter((c) => c.id !== TRIGGER_NODE_ID);
      if (stepEnds.length === 0) return;
      const positions = new Map(stepEnds.map((c) => [c.id, c.position]));
      onChange({
        ...graph,
        nodes: graph.nodes.map((n) =>
          positions.has(n.id) ? { ...n, position: positions.get(n.id)! } : n,
        ),
      });
    },
    [graph, onChange, onNodesChangeInternal],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      onEdgesChangeInternal(changes);
      // Persist only edge removals (additions go through onConnect). Ignore
      // the synthetic trigger→start edge — startNodeId controls it.
      let next = [...graph.edges];
      let mutated = false;
      for (const ch of changes) {
        if (ch.type !== "remove") continue;
        if (ch.id === "e_trigger_start") continue;
        const found = projectedEdges.find((e) => e.id === ch.id);
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
      if (mutated) onChange({ ...graph, edges: next });
    },
    [graph, projectedEdges, onChange, onEdgesChangeInternal],
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
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        // fitView fires only on first render. Re-fitting on every graph
        // update would yank the viewport whenever a step was added and
        // make the canvas feel unstable.
        fitView
        fitViewOptions={{ padding: 0.2 }}
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
