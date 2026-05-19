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
import {
  InsertEdge,
  StepPickerPopover,
  type PickerAnchor,
} from "./insert-controls";
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

const edgeTypes = {
  insert: InsertEdge,
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
  /** Insert a step on an existing edge (or before the start when sourceId=null). */
  onInsertStep: (
    sourceId: string | null,
    sourceHandle: string | null,
    type: StepType,
  ) => void;
  /** Duplicate the given step in place. */
  onDuplicateStep: (id: string) => void;
  /** Delete a step (with auto-splice of incoming/outgoing edges). */
  onDeleteStep: (id: string) => void;
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
  onInsertStep,
  onDuplicateStep,
  onDeleteStep,
}: WorkflowCanvasProps) {
  // Picker state — when set, a floating step picker is rendered anchored to
  // the "+" that was clicked. The anchor carries where to insert (sourceId
  // + sourceHandle).
  const [picker, setPicker] = useState<PickerAnchor | null>(null);
  const openPicker = useCallback((anchor: PickerAnchor) => {
    setPicker(anchor);
  }, []);
  const closePicker = useCallback(() => setPicker(null), []);

  // Set of nodes that already have an outgoing edge on their default handle.
  // Used to decide whether to render the trailing "+" below a step (only
  // leaves get one; non-leaves already have an in-edge "+").
  const leafSet = useMemo(() => {
    const hasOut = new Set<string>();
    for (const e of graph.edges) {
      if ((e.label ?? "default") === "default") hasOut.add(e.from);
    }
    const leaves = new Set<string>();
    for (const n of graph.nodes) {
      if (!hasOut.has(n.id) && n.type !== "branch") leaves.add(n.id);
    }
    return leaves;
  }, [graph.edges, graph.nodes]);
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
        // Inline action toolbar handlers — wired through node data because
        // React Flow's custom node renderers only have access to data, not
        // refs back to the canvas.
        onDuplicate: () => onDuplicateStep(n.id),
        onDelete: () => onDeleteStep(n.id),
        // Trailing-"+" data: only leaves render the bottom toolbar. Branch
        // nodes are never leaves (they have two outputs each with their own
        // edge "+" buttons).
        showTrailingPlus: leafSet.has(n.id),
        onOpenPicker: openPicker,
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
        // Empty-graph case — show a "+" under the trigger so the user can
        // drop the first step inline. Anything with a startNode gets the
        // dashed edge "+" instead.
        showTrailingPlus: !graph.startNodeId,
        onOpenPicker: openPicker,
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
      type: "insert",
      label: e.label === "true" ? "true" : e.label === "false" ? "false" : undefined,
      labelStyle: { fontSize: 11 },
      data: { onInsert: openPicker },
    }));
    // Synthetic edge from trigger to startNode for visual clarity. The runner
    // doesn't read this — startNodeId on the graph is what it walks from.
    // Clicking the "+" on THIS edge inserts at the start of the workflow.
    if (graph.startNodeId) {
      edges.unshift({
        id: "e_trigger_start",
        source: TRIGGER_NODE_ID,
        target: graph.startNodeId,
        sourceHandle: "default",
        type: "insert",
        style: { strokeDasharray: "4 4" },
        data: { onInsert: openPicker, isSyntheticTrigger: true },
      });
    }
    return edges;
  }, [graph, openPicker]);

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
        edgeTypes={edgeTypes}
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
      {picker && (
        <StepPickerPopover
          anchor={picker}
          onPick={(type, anchor) => {
            onInsertStep(anchor.sourceId, anchor.sourceHandle, type);
            closePicker();
          }}
          onClose={closePicker}
        />
      )}
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
 * Insert a new step immediately downstream of `sourceId` on the specified
 * source handle. If an outgoing edge already exists on that handle, it gets
 * rewired through the new node (A → new → B). Otherwise we just append (A →
 * new). `sourceId === TRIGGER` means "insert at the start of the workflow."
 */
export function insertStepAfter(
  graph: WorkflowGraph,
  sourceId: string | null, // null = inserting before the current startNode
  sourceHandle: string | null,
  type: StepType,
): { graph: WorkflowGraph; newNodeId: string } {
  const newId = cuidLike();
  // Anchor the new node below the source (or below the trigger when there's
  // no source). User can drag afterwards; this is just a sensible default.
  const sourceNode = sourceId
    ? graph.nodes.find((n) => n.id === sourceId)
    : null;
  const anchorY = sourceNode?.position?.y ?? 0;
  const anchorX = sourceNode?.position?.x ?? 80;
  const newNode: WorkflowNode = {
    id: newId,
    type,
    config: emptyConfigFor(type),
    position: { x: anchorX, y: anchorY + 140 },
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
