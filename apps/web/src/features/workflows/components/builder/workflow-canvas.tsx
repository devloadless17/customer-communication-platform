"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
  type OnConnectStartParams,
} from "@xyflow/react";
import { LayoutGrid } from "lucide-react";
import "@xyflow/react/dist/style.css";

import { AskQuestionNode, BranchNode, StepNode, TriggerNode } from "./canvas-nodes";
import {
  InsertEdge,
  StepPickerPopover,
  type PickerAnchor,
} from "./insert-controls";
import type { StepType, WorkflowEdge, WorkflowGraph, WorkflowNode } from "./types";

// Pure graph helpers were extracted to `./graph-mutations` so the workflow
// builder shell can import them without paying for `@xyflow/react`. Re-export
// for any back-compat caller that still reaches into this module.
export {
  removeStep,
  insertStepAfter,
  duplicateStep,
} from "./graph-mutations";

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
  ask_question: AskQuestionNode,
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
   
  triggerType: any;
  onChange: (graph: WorkflowGraph) => void;
  onSelectStep: (id: string | null) => void;
  onSelectTrigger: () => void;
  /** Insert a step on an existing edge (or before the start when sourceId=null).
   *  Optional `positionOverride` lands the new node at a specific canvas
   *  coordinate — used by the drag-to-canvas n8n-style flow. */
  onInsertStep: (
    sourceId: string | null,
    sourceHandle: string | null,
    type: StepType,
    positionOverride?: { x: number; y: number },
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

  // React Flow's screenToFlowPosition lets us project a mouseup pixel
  // coordinate to canvas (graph) coordinates so a node dropped at the
  // cursor lands exactly under the cursor — regardless of zoom or pan.
  // `fitView` is used after a Rearrange so the new layout is centered.
  const { screenToFlowPosition, fitView } = useReactFlow();

  // Rearrange handler — runs the tree-layout helper and commits the
  // resulting positions back into the canonical graph, then refits the
  // viewport so the user sees the new layout without manually zooming
  // out. Lives on the canvas (not the parent builder) because we want
  // access to React Flow's fitView; the builder just hands us `graph`.
  const onRearrange = useCallback(() => {
    onChange(autoLayoutGraph(graph));
    // Schedule fitView for the NEXT frame, after the projection rebuild
    // has actually re-rendered the nodes at their new positions.
    // Without the rAF, fitView measures the OLD positions and centers
    // on those instead.
    requestAnimationFrame(() => {
      fitView({ padding: 0.35, maxZoom: 0.75, duration: 250 });
    });
  }, [graph, onChange, fitView]);

  // Pending-connection bookkeeping for the n8n-style "drag a wire onto
  // empty canvas → pick a node type → it appears here, pre-connected"
  // flow. Lives in a ref because both onConnectStart and the mouseup
  // listener that fires onConnectEnd need to read it without re-binding
  // listeners on every render.
  const pendingConnectionRef = useRef<{
    nodeId: string | null;
    handleId: string | null;
    /**
     * True iff this connection has already been consumed by a normal
     * handle-to-handle connect (onConnect fired). The mouseup-on-pane
     * handler reads this so it doesn't ALSO open the picker for the
     * same drag.
     */
    consumed: boolean;
  } | null>(null);

  const onConnectStart = useCallback(
    (_: unknown, params: OnConnectStartParams) => {
      pendingConnectionRef.current = {
        nodeId: params.nodeId ?? null,
        handleId: params.handleId ?? null,
        consumed: false,
      };
    },
    [],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      const pending = pendingConnectionRef.current;
      pendingConnectionRef.current = null;
      if (!pending || pending.consumed) return;
      if (!pending.nodeId) return; // Dragging from the synthetic trigger? skip.

      // Did we drop on the empty pane (vs. on a node/handle/edge)?
      // React Flow tags its background pane with `react-flow__pane`.
      // If the drop target is anywhere inside a node/edge/handle, the
      // normal `onConnect` path handled it (and set consumed=true), so
      // we'd have already returned above.
      const target = event.target as HTMLElement | null;
      if (!target || !target.classList?.contains("react-flow__pane")) return;

      // Project the mouseup pixel to canvas coordinates. Touch falls back
      // to the first changedTouch — same coord space as `clientX/Y`.
      const point =
        "touches" in event
          ? event.changedTouches[0]
          : (event as MouseEvent);
      if (!point) return;
      const flowPosition = screenToFlowPosition({
        x: point.clientX,
        y: point.clientY,
      });

      // Inserting from the synthetic trigger means "this becomes the
      // start node" — sourceId=null is the canvas's signal for that.
      const sourceId =
        pending.nodeId === TRIGGER_NODE_ID ? null : pending.nodeId;
      const sourceHandle =
        pending.handleId && pending.handleId !== "default"
          ? pending.handleId
          : null;

      openPicker({
        x: point.clientX,
        y: point.clientY,
        sourceId,
        sourceHandle,
        flowPosition,
      });
    },
    [openPicker, screenToFlowPosition],
  );

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
      // Branch and ask_question render their own per-handle "+" affordances
      // and don't use the default-handle trailing "+".
      if (!hasOut.has(n.id) && n.type !== "branch" && n.type !== "ask_question") {
        leaves.add(n.id);
      }
    }
    return leaves;
  }, [graph.edges, graph.nodes]);

  // Per-branch-node: which of its two outputs (true / false) already has
  // a child wired. Drives BranchNode's inline "+" affordances so the user
  // can add a step on each empty branch path with one click — instead of
  // having to drag a connection blind from the bare handle.
  const branchOutputs = useMemo(() => {
    const map = new Map<string, { hasTrue: boolean; hasFalse: boolean }>();
    for (const n of graph.nodes) {
      if (n.type === "branch") map.set(n.id, { hasTrue: false, hasFalse: false });
    }
    for (const e of graph.edges) {
      const out = map.get(e.from);
      if (!out) continue;
      if (e.label === "true") out.hasTrue = true;
      else if (e.label === "false") out.hasFalse = true;
    }
    return map;
  }, [graph.nodes, graph.edges]);

  // ask_question counterpart of branchOutputs — tracks `answered` /
  // `timeout` handle children AND per-option-id children for N-way
  // (buttons-mode) nodes. Also surfaces each ask_question node's own
  // answer-kind + option list to the renderer so it can pick the right
  // handle layout without re-parsing the config.
  const askOutputs = useMemo(() => {
    type Out = {
      hasAnswered: boolean;
      hasTimeout: boolean;
      answerKind: "free_text" | "buttons" | "list";
      options: Array<{ id: string; title: string }>;
      optionHasChild: Record<string, boolean>;
    };
    const map = new Map<string, Out>();
    for (const n of graph.nodes) {
      if (n.type !== "ask_question") continue;
      const cfg = (n.config ?? {}) as {
        answerKind?: "free_text" | "buttons" | "list";
        options?: Array<{ id?: string; title?: string }>;
      };
      const answerKind = cfg.answerKind ?? "free_text";
      const options =
        answerKind === "buttons" && Array.isArray(cfg.options)
          ? cfg.options
              .filter((o) => typeof o?.id === "string" && o.id.length > 0)
              .map((o) => ({ id: o.id as string, title: (o.title ?? o.id) as string }))
          : [];
      const optionHasChild: Record<string, boolean> = {};
      for (const o of options) optionHasChild[o.id] = false;
      map.set(n.id, {
        hasAnswered: false,
        hasTimeout: false,
        answerKind,
        options,
        optionHasChild,
      });
    }
    for (const e of graph.edges) {
      const out = map.get(e.from);
      if (!out) continue;
      if (e.label === "answered") out.hasAnswered = true;
      else if (e.label === "timeout") out.hasTimeout = true;
      else if (e.label && out.optionHasChild[e.label] !== undefined) {
        out.optionHasChild[e.label] = true;
      }
    }
    return map;
  }, [graph.nodes, graph.edges]);
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
    const stepNodes: Node[] = graph.nodes.map((n) => {
      const branchOut = n.type === "branch" ? branchOutputs.get(n.id) : null;
      const askOut = n.type === "ask_question" ? askOutputs.get(n.id) : null;
      return {
        id: n.id,
        type:
          n.type === "branch"
            ? "branch"
            : n.type === "ask_question"
              ? "ask_question"
              : "step",
        position: n.position ?? { x: 0, y: 0 },
        data: {
          // Author-supplied name takes precedence; otherwise fall back to
          // the bare node id so a freshly-inserted unnamed node still has
          // a visible string. The step type ("Send Message" etc.) is
          // rendered above the label inside the node renderer.
          label: n.name && n.name.length > 0 ? n.name : n.id,
          type: n.type,
          selected: n.id === selectedStepId,
          summary: describeNode(n),
          // Inline action toolbar handlers — wired through node data because
          // React Flow's custom node renderers only have access to data, not
          // refs back to the canvas.
          onDuplicate: () => onDuplicateStep(n.id),
          onDelete: () => onDeleteStep(n.id),
          // Trailing-"+" data: only leaves render the bottom toolbar.
          // Branch nodes render their own per-output "+" affordances
          // through `branchHasTrueChild` / `branchHasFalseChild` below.
          showTrailingPlus: leafSet.has(n.id),
          onOpenPicker: openPicker,
          // Branch-only — undefined for other step types, ignored by the
          // generic StepNode/TriggerNode renderers.
          branchHasTrueChild: branchOut?.hasTrue,
          branchHasFalseChild: branchOut?.hasFalse,
          // ask_question-only — undefined elsewhere.
          askHasAnsweredChild: askOut?.hasAnswered,
          askHasTimeoutChild: askOut?.hasTimeout,
          askAnswerKind: askOut?.answerKind,
          askOptionIds: askOut?.options,
          askOptionChildren: askOut?.optionHasChild,
        },
      };
    });
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
  }, [
    graph,
    selectedStepId,
    triggerSelected,
    triggerLabel,
    triggerDescription,
    triggerType,
    triggerPos,
    leafSet,
    branchOutputs,
    askOutputs,
    openPicker,
    onDuplicateStep,
    onDeleteStep,
  ]);

  const projectedEdges = useMemo<Edge[]>(() => {
    const edges: Edge[] = graph.edges.map((e, i) => {
      // Label-text color matches the edge stroke — so "true"/"false" /
      // "answered"/"timeout" tags and the stroke colors visually agree.
      // ask_question option-id edges (anything labeled, but not the four
      // reserved values) also colour emerald — same as "answered".
      const isReserved =
        e.label === "true" ||
        e.label === "false" ||
        e.label === "answered" ||
        e.label === "timeout";
      const isAskQuestionSource =
        graph.nodes.find((n) => n.id === e.from)?.type === "ask_question";
      const labelColor =
        e.label === "true" || e.label === "answered"
          ? "rgb(16 185 129)"
          : e.label === "false"
            ? "rgb(244 63 94)"
            : e.label === "timeout"
              ? "rgb(245 158 11)"
              : isAskQuestionSource && e.label && !isReserved
                ? "rgb(16 185 129)"
                : undefined;
      // Print the bare label for reserved tags AND for option ids on
      // ask_question edges so the canvas reads like the editor's option
      // list.
      const labelText =
        isReserved || (isAskQuestionSource && e.label && !isReserved)
          ? e.label
          : undefined;
      return {
        id: `e_${i}_${e.from}_${e.label ?? ""}_${e.to}`,
        source: e.from,
        target: e.to,
        sourceHandle: e.label ?? "default",
        type: "insert",
        label: labelText,
        labelStyle: {
          fontSize: 11,
          fontWeight: 600,
          ...(labelColor ? { fill: labelColor } : {}),
        },
        // Soft pill background behind the label so it stays readable
        // against the edge stroke at every zoom level.
        labelBgStyle: labelColor
          ? { fill: "var(--background)", fillOpacity: 0.9 }
          : undefined,
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 4,
        data: { onInsert: openPicker },
      };
    });
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
      // Mark the in-flight drag as consumed so onConnectEnd's
      // dropped-on-empty-canvas branch doesn't ALSO open the picker.
      if (pendingConnectionRef.current) {
        pendingConnectionRef.current.consumed = true;
      }
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

  // Canvas-scoped keyboard shortcuts:
  //   - Esc       → deselect the current step (closes the editor drawer)
  //   - Delete    → delete the currently-selected step
  //   - Backspace → same (Mac users expect both)
  //
  // We DON'T bind globally because the editor drawer hosts text inputs
  // and a global Delete handler would eat keystrokes. The listener lives
  // on the canvas container's div (added below) so it only fires when
  // the canvas has keyboard focus. ReactFlow gives nodes focus on
  // click; the wrapper div picks up the bubbling keydown.
  //
  // We deliberately don't bind Cmd+D / duplicate yet — that conflicts
  // with the browser's "Bookmark this page" default and the NodeActions
  // toolbar already exposes the duplicate affordance.
  const onCanvasKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Skip when the user is typing in a form field anywhere inside the
      // canvas tree (the StepPickerPopover hosts a search input).
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
        return;
      }
      if (e.key === "Escape") {
        if (picker) {
          closePicker();
          e.preventDefault();
          return;
        }
        if (selectedStepId !== null || triggerSelected) {
          onSelectStep(null);
          e.preventDefault();
        }
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        // The trigger isn't deletable (it's the workflow root). Only
        // deletes a real step.
        if (selectedStepId && !triggerSelected) {
          onDeleteStep(selectedStepId);
          e.preventDefault();
          return;
        }
        // No selected step → fall through to deleting any selected edges.
        // React Flow marks edges with `selected: true` in the internal
        // store; the existing `onEdgesChange` already persists `remove`
        // changes, so we just route through it. Skip the synthetic
        // trigger→start edge — it's controlled by startNodeId, not
        // graph.edges.
        const selectedEdges = edges.filter(
          (ed) => ed.selected && ed.id !== "e_trigger_start",
        );
        if (selectedEdges.length > 0) {
          onEdgesChange(
            selectedEdges.map((ed) => ({ type: "remove" as const, id: ed.id })),
          );
          e.preventDefault();
        }
      }
    },
    [
      picker,
      closePicker,
      selectedStepId,
      triggerSelected,
      onSelectStep,
      onDeleteStep,
      edges,
      onEdgesChange,
    ],
  );

  return (
    // tabIndex=0 + outline-none so the wrapper can take keyboard focus
    // (needed for Delete / Esc) without showing a focus ring around the
    // entire canvas area — ReactFlow draws its own selection halo.
    <div
      className="h-full w-full outline-none"
      tabIndex={0}
      onKeyDown={onCanvasKeyDown}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        // Disable React Flow's built-in Delete/Backspace handling — onCanvasKeyDown
        // owns deletion so the confirm dialog (handleDeleteStep) governs it. Left
        // active, RF would visually remove the node BEFORE the async confirm
        // resolved and leave the canvas desynced on Cancel.
        deleteKeyCode={null}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        // fitView fires only on first render. Re-fitting on every graph
        // update would yank the viewport whenever a step was added and
        // make the canvas feel unstable.
        fitView
        // `maxZoom: 0.75` caps initial zoom so a 2-3 node workflow doesn't
        // render at canvas-filling size — nodes stay readable but feel
        // like part of a graph, not a poster. `minZoom: 0.25` keeps the
        // user from zooming out so far the diagram becomes unreadable.
        // Padding bumped 0.2 → 0.35 so the framed graph has breathing
        // room on either side, matching the n8n / Make.com canvas feel.
        fitViewOptions={{ padding: 0.35, maxZoom: 0.75 }}
        minZoom={0.25}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        {/* First-run hint — only while the canvas is effectively empty (no
            steps added yet, so just the synthetic trigger). Non-interactive
            (`pointer-events-none`) so it never blocks panning, the trigger
            click, or the trailing "+". Disappears the moment a first step
            lands a startNode. Panel keeps it pinned to the canvas without
            being a flow node, so zoom/pan don't move or scale it. */}
        {graph.nodes.length === 0 && !graph.startNodeId && (
          <Panel
            position="bottom-center"
            className="pointer-events-none select-none text-2xs text-muted-foreground"
          >
            Click <span className="font-medium">+</span> to add your first step ·
            click the trigger to choose when this runs
          </Panel>
        )}
        <Controls />
        {/* Top-right "Rearrange" — opt-in auto-layout. We don't run it on
            every insert because users place nodes deliberately and the
            canvas fighting them would feel hostile. Disabled when there
            are no steps yet (nothing to lay out). */}
        <Panel position="top-right">
          <button
            type="button"
            onClick={onRearrange}
            disabled={graph.nodes.length === 0}
            title="Rearrange layout"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-2xs font-medium text-foreground shadow-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            <LayoutGrid className="size-3.5" />
            Rearrange
          </button>
        </Panel>
        {/* Compact minimap, bottom-right. Color-matches node types so the
            user can scan a large graph quickly: amber=trigger, indigo=
            branch, primary=normal step. `pannable` lets clicking the
            minimap re-center the viewport. */}
        <MiniMap
          pannable
          zoomable
          nodeStrokeWidth={2}
          nodeColor={(n) => {
            if (n.type === "trigger") return "rgb(245 158 11)"; // amber-500
            if (n.type === "branch") return "rgb(99 102 241)"; // indigo-500
            return "var(--primary)";
          }}
          maskColor="rgba(0,0,0,0.05)"
          className="hidden bg-card! border! border-border! rounded-md! lg:block!"
          style={{ height: 110, width: 160 }}
        />
      </ReactFlow>
      {picker && (
        <StepPickerPopover
          anchor={picker}
          trigger={triggerType}
          onPick={(type, anchor) => {
            onInsertStep(
              anchor.sourceId,
              anchor.sourceHandle,
              type,
              anchor.flowPosition,
            );
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
    case "noop":
      return "Do nothing";
    case "ask_question":
      return typeof c.question === "string" ? clip(c.question) : undefined;
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
 * Auto-layout a workflow graph as a top-down tree, fanning branch outputs
 * out horizontally. Triggered by the "Rearrange" canvas button — opt-in
 * because users place nodes deliberately and an on-every-insert auto-layout
 * would feel like the canvas was fighting them.
 *
 * Algorithm (Reingold-Tilford-ish, simplified for our shallow DAGs):
 *
 *   1. Compute children-of map; for each branch source, sort outputs in
 *      a stable order (true first, false second, anything else after) so
 *      "true" reliably lands on the left and "false" on the right.
 *   2. Compute each subtree's "leaf width" — how many columns its leaves
 *      occupy. A leaf is 1 column wide; a branch with N children is the
 *      sum of its childrens' widths.
 *   3. Walk the tree DFS, allocating each subtree its width slice of
 *      horizontal space. Each node sits at the horizontal CENTER of its
 *      allocated slice — that's what makes a branch's true/false outputs
 *      visually balance under the parent.
 *
 * Edge cases:
 *   - **DAG joins** (e.g. true + false branches converging on a common
 *     downstream node): the join target is placed by the FIRST visit
 *     only; subsequent visits skip via the `placed` set. The second
 *     branch's edge then routes to the already-placed node, which is
 *     correct.
 *   - **Cycles**: `visited` set prevents infinite recursion in the
 *     subtree-width DFS. Cycles aren't legal in a valid workflow but
 *     we don't want to crash the rearrange button on a draft graph.
 *   - **Orphans** (nodes unreachable from the start): laid out in a
 *     second row below the main tree so they're visible — the author
 *     can wire them up or delete them.
 */
export function autoLayoutGraph(graph: WorkflowGraph): WorkflowGraph {
  // Tuned to leave room for a w-64 node (256px) + the branch label pill,
  // and enough vertical breathing room for the edge "+" hit target.
  const COL_WIDTH = 320;
  const ROW_HEIGHT = 180;
  // Branch + ask_question outputs read better when the sort order is
  // deterministic: success/affirmative on the left, fallback on the right.
  const sortRank = (label: string | null) =>
    label === "true" || label === "answered"
      ? 0
      : label === "false" || label === "timeout"
        ? 2
        : 1;

  // Build child map (parent → ordered children).
  const childMap = new Map<string, { id: string; label: string | null }[]>();
  for (const e of graph.edges) {
    const arr = childMap.get(e.from) ?? [];
    arr.push({ id: e.to, label: e.label ?? null });
    childMap.set(e.from, arr);
  }
  for (const arr of childMap.values()) {
    arr.sort((a, b) => sortRank(a.label) - sortRank(b.label));
  }

  // Subtree widths in column units (memoized; cycle-safe via `visiting`).
  const widths = new Map<string, number>();
  const visiting = new Set<string>();
  function computeWidth(id: string): number {
    const cached = widths.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 1; // cycle — treat as a leaf so we don't loop
    visiting.add(id);
    const kids = childMap.get(id) ?? [];
    let w = 0;
    for (const k of kids) w += computeWidth(k.id);
    visiting.delete(id);
    const total = Math.max(1, w); // leaves get 1
    widths.set(id, total);
    return total;
  }

  const positions = new Map<string, { x: number; y: number }>();
  const placed = new Set<string>();
  function place(id: string, centerX: number, depth: number) {
    if (placed.has(id)) return;
    placed.add(id);
    positions.set(id, { x: centerX, y: depth * ROW_HEIGHT });
    const kids = childMap.get(id) ?? [];
    if (kids.length === 0) return;
    const myWidth = (widths.get(id) ?? 1) * COL_WIDTH;
    let cursorX = centerX - myWidth / 2;
    for (const k of kids) {
      const kWidth = (widths.get(k.id) ?? 1) * COL_WIDTH;
      place(k.id, cursorX + kWidth / 2, depth + 1);
      cursorX += kWidth;
    }
  }

  if (graph.startNodeId) {
    computeWidth(graph.startNodeId);
    // Start node sits one row below the trigger (which the canvas owns
    // separately via `triggerPos`). The user can drag the trigger around;
    // we just lay out the step subtree from y=ROW_HEIGHT downward.
    place(graph.startNodeId, 0, 1);
  }

  // Orphans: anything we never placed. Drop them in a dedicated row well
  // below the main tree so they're discoverable but don't tangle with it.
  // findIndex-based offset puts them in a neat left-to-right strip.
  const inEdges = new Set(graph.edges.map((e) => e.to));
  const orphans = graph.nodes.filter(
    (n) => !placed.has(n.id) && !inEdges.has(n.id) && n.id !== graph.startNodeId,
  );
  if (orphans.length > 0) {
    // Use the main tree's depth as the row offset so orphans don't
    // overlap leaves.
    const mainMaxDepth = positions.size > 0
      ? Math.max(...Array.from(positions.values()).map((p) => p.y / ROW_HEIGHT))
      : 0;
    const orphanY = (mainMaxDepth + 2) * ROW_HEIGHT;
    orphans.forEach((n, i) => {
      // Center the orphan strip at x=0 so it shares the main tree's axis.
      positions.set(n.id, {
        x: (i - (orphans.length - 1) / 2) * COL_WIDTH,
        y: orphanY,
      });
    });
  }

  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const p = positions.get(n.id);
      return p ? { ...n, position: p } : n;
    }),
  };
}

// removeStep / insertStepAfter / duplicateStep moved to ./graph-mutations and
// re-exported at the top of this file. They are pure functions and must not
// depend on @xyflow/react so the builder shell can use them without the
// canvas bundle.
