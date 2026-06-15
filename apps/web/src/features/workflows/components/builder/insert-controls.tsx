"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BaseEdge,
  EdgeLabelRenderer,
  NodeToolbar,
  Position,
  getSmoothStepPath,
  useReactFlow,
  type EdgeProps,
} from "@xyflow/react";
import { Copy, Plus, Search, Trash2, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@ccp/shared/utils";

import {
  CONTACT_ACTING_STEPS,
  NEEDS_CONTACT_TRIGGER_HINT,
  STEP_OPTIONS,
  type StepType,
  type Trigger,
  triggerCarriesContact,
} from "./types";

/**
 * Inline-insert UI for the workflow canvas. Three pieces:
 *
 *   - `InsertEdge`   — custom React Flow edge that renders the standard path
 *                       with a "+" button at the midpoint. Click → opens the
 *                       step picker anchored to the button.
 *
 *   - `TrailingPlus` — "+" rendered as a NodeToolbar below leaf step nodes
 *                       (those with no outgoing edge). Lets the user extend
 *                       the workflow without going to the left palette.
 *
 *   - `NodeActions`  — NodeToolbar at the top-right of each step with copy
 *                       and delete buttons.
 *
 *   - `StepPickerPopover` — floating searchable list of step types.
 *
 * The popover position + payload live in WorkflowCanvas (`pickerState`); the
 * components below just call the supplied openers / handlers.
 */

// ---- Shared anchor / payload type ----------------------------------------

export interface PickerAnchor {
  /**
   * Optional flow-coordinate position to place the new node at — only set
   * when the picker was opened by dropping a connection onto empty canvas
   * (drag-from-handle-to-empty-canvas, n8n style). When undefined, the
   * inserter falls back to its computed default position (below source,
   * or sideways for branch outputs).
   */
  flowPosition?: { x: number; y: number };
  /** Screen coordinates for the picker — usually the rect center of the "+". */
  x: number;
  y: number;
  /** Source node id to insert AFTER. `null` = insert before the current start. */
  sourceId: string | null;
  /** Source handle for branch outputs ("true" / "false"). */
  sourceHandle: string | null;
}

// ---- Custom edge with midpoint "+" ---------------------------------------

interface InsertEdgeData extends Record<string, unknown> {
  onInsert?: (anchor: PickerAnchor) => void;
  isSyntheticTrigger?: boolean;
}

export function InsertEdge(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    source,
    sourceHandleId,
    selected,
    style,
    markerEnd,
    data,
  } = props;
  const d = (data ?? {}) as InsertEdgeData;
  const [hovered, setHovered] = useState(false);
  const { setEdges } = useReactFlow();
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition: sourcePosition ?? Position.Bottom,
    targetX,
    targetY,
    targetPosition: targetPosition ?? Position.Top,
  });

  // Color the edge to match its source handle so a glance tells you which
  // branch / ask_question path you're looking at. Falls back to the
  // muted-foreground stroke for non-branched edges (the synthetic
  // trigger→start edge keeps its dashed style applied via the `style` prop
  // from the canvas projection — we spread it last so the caller can still
  // override).
  //
  // Reserved handle ids ("default", "true"/"false", "answered"/"timeout")
  // pick a fixed color. Any OTHER handle id is treated as an ask_question
  // option id and gets the emerald success colour — the only non-reserved
  // handle ids in this codebase come from ask_question N-way mode.
  const handleStroke =
    sourceHandleId === "true" || sourceHandleId === "answered"
      ? "rgb(16 185 129)" // emerald-500
      : sourceHandleId === "false"
        ? "rgb(244 63 94)" // rose-500
        : sourceHandleId === "timeout"
          ? "rgb(245 158 11)" // amber-500
          : sourceHandleId && sourceHandleId !== "default"
            ? "rgb(16 185 129)" // option-id edge — match the handle dot
            : undefined;
  const mergedStyle: React.CSSProperties = {
    strokeWidth: selected ? 3 : 2,
    ...(handleStroke ? { stroke: handleStroke } : {}),
    ...(style ?? {}),
  };

  function onInsertClick(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    d.onInsert?.({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      // Synthetic trigger edge → insert at start (sourceId=null marker).
      sourceId: d.isSyntheticTrigger ? null : source,
      sourceHandle:
        sourceHandleId && sourceHandleId !== "default" ? sourceHandleId : null,
    });
  }

  // Delete this connection. Routes through `onEdgesChange` (via setEdges
  // with a "remove" change), which is where the canonical graph picks up
  // the removal and persists it. Hidden on the synthetic trigger→start
  // edge — that edge is controlled by `graph.startNodeId`, not by the
  // edge array, so a manual delete would just re-project next render.
  function onDeleteClick(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    setEdges((eds) => eds.filter((edge) => edge.id !== id));
  }

  const showDelete = (hovered || selected) && !d.isSyntheticTrigger;

  return (
    <>
      <BaseEdge id={id} path={path} style={mergedStyle} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div
          // pointer-events-none on the wrapper so the invisible label area
          // doesn't eat clicks on the canvas behind it; the buttons below
          // re-enable them for themselves.
          className="pointer-events-none absolute flex items-center gap-1"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <button
            type="button"
            onClick={onInsertClick}
            aria-label="Insert step"
            className="pointer-events-auto inline-flex size-6 cursor-pointer items-center justify-center rounded-full border border-primary/40 bg-background text-primary shadow-sm transition-all hover:scale-110 hover:bg-primary hover:text-primary-foreground"
          >
            <Plus className="size-3.5" />
          </button>
          {showDelete && (
            <button
              type="button"
              onClick={onDeleteClick}
              aria-label="Delete connection"
              title="Delete connection"
              className="pointer-events-auto inline-flex size-6 cursor-pointer items-center justify-center rounded-full border border-destructive/40 bg-background text-destructive shadow-sm transition-all hover:scale-110 hover:bg-destructive hover:text-destructive-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

// ---- Trailing "+" (NodeToolbar at bottom of leaf nodes) ------------------

export function TrailingPlus({
  visible,
  onInsert,
  nodeId,
  sourceHandle,
}: {
  visible: boolean;
  onInsert: (anchor: PickerAnchor) => void;
  nodeId: string;
  sourceHandle: string | null;
}) {
  if (!visible) return null;
  return (
    <NodeToolbar
      isVisible
      position={Position.Bottom}
      offset={12}
      // The default centered alignment is what we want.
    >
      <button
        type="button"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onInsert({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            sourceId: nodeId,
            sourceHandle,
          });
        }}
        aria-label="Add step below"
        className="inline-flex size-6 cursor-pointer items-center justify-center rounded-full border border-primary/40 bg-background text-primary shadow-sm transition-all hover:scale-110 hover:bg-primary hover:text-primary-foreground"
      >
        <Plus className="size-3.5" />
      </button>
    </NodeToolbar>
  );
}

// ---- Branch outputs "+" (per-handle for true / false) --------------------
//
// Rendered below a Branch node when one or both of its outputs has no child
// yet. Without this, the user had to drag a connection out of the bare
// handle blind — there was no visible affordance saying "add a step on
// the true path." Each button is anchored under its own handle's x-offset
// (25% for true, 75% for false) so the visual relationship to the handle
// stays clear regardless of zoom.
//
// Uses two NodeToolbars (one anchored start, one anchored end) instead of
// one toolbar with two buttons because React Flow's NodeToolbar respects
// `align` per-toolbar — we get correct positioning at any zoom level
// without manually computing pixel offsets.
export function BranchTrailingPlus({
  hasTrueChild,
  hasFalseChild,
  onInsert,
  nodeId,
}: {
  hasTrueChild: boolean;
  hasFalseChild: boolean;
  onInsert: (anchor: PickerAnchor) => void;
  nodeId: string;
}) {
  if (hasTrueChild && hasFalseChild) return null;
  return (
    <>
      {!hasTrueChild && (
        <NodeToolbar
          isVisible
          position={Position.Bottom}
          offset={12}
          align="start"
        >
          <BranchPlusButton
            label="Add step on the true path"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              onInsert({
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                sourceId: nodeId,
                sourceHandle: "true",
              });
            }}
            color="emerald"
          />
        </NodeToolbar>
      )}
      {!hasFalseChild && (
        <NodeToolbar
          isVisible
          position={Position.Bottom}
          offset={12}
          align="end"
        >
          <BranchPlusButton
            label="Add step on the false path"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              onInsert({
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                sourceId: nodeId,
                sourceHandle: "false",
              });
            }}
            color="rose"
          />
        </NodeToolbar>
      )}
    </>
  );
}

function BranchPlusButton({
  label,
  onClick,
  color,
}: {
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  color: "emerald" | "rose" | "amber";
}) {
  // Per-handle color matches the handle dot itself so the user reads
  // "this + adds onto the emerald (true) handle" without a tooltip.
  const ring =
    color === "emerald"
      ? "border-emerald-500/60 text-emerald-600 hover:bg-emerald-500 hover:text-white"
      : color === "rose"
        ? "border-rose-500/60 text-rose-600 hover:bg-rose-500 hover:text-white"
        : "border-amber-500/60 text-amber-600 hover:bg-amber-500 hover:text-white";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`inline-flex size-6 cursor-pointer items-center justify-center rounded-full border bg-background shadow-sm transition-all hover:scale-110 ${ring}`}
    >
      <Plus className="size-3.5" />
    </button>
  );
}

/**
 * ask_question counterpart of BranchTrailingPlus. Two render modes:
 *
 *   - Default (`options` null/empty): answered (emerald) + timeout
 *     (amber) buttons under the corresponding handles.
 *   - N-way (`options` non-empty): one emerald "+" per option id + a
 *     timeout (amber) "+" at the right. Rendered inline in a single
 *     center-aligned toolbar so the buttons row stays compact under the
 *     N-handle node.
 */
export function AskQuestionTrailingPlus({
  hasAnsweredChild,
  hasTimeoutChild,
  options,
  optionHasChild,
  onInsert,
  nodeId,
}: {
  hasAnsweredChild: boolean;
  hasTimeoutChild: boolean;
  options: Array<{ id: string; title: string }> | null;
  optionHasChild: Record<string, boolean>;
  onInsert: (anchor: PickerAnchor) => void;
  nodeId: string;
}) {
  if (options && options.length > 0) {
    const allOptsWired = options.every((o) => optionHasChild[o.id]);
    if (allOptsWired && hasTimeoutChild) return null;
    return (
      <NodeToolbar
        isVisible
        position={Position.Bottom}
        offset={12}
        align="center"
      >
        <div className="flex items-center gap-1.5">
          {options.map((opt) =>
            optionHasChild[opt.id] ? null : (
              <BranchPlusButton
                key={opt.id}
                label={`Add step on the "${opt.id}" path`}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  onInsert({
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                    sourceId: nodeId,
                    sourceHandle: opt.id,
                  });
                }}
                color="emerald"
              />
            ),
          )}
          {!hasTimeoutChild && (
            <BranchPlusButton
              label="Add step on the timeout path"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                onInsert({
                  x: rect.left + rect.width / 2,
                  y: rect.top + rect.height / 2,
                  sourceId: nodeId,
                  sourceHandle: "timeout",
                });
              }}
              color="amber"
            />
          )}
        </div>
      </NodeToolbar>
    );
  }
  if (hasAnsweredChild && hasTimeoutChild) return null;
  return (
    <>
      {!hasAnsweredChild && (
        <NodeToolbar isVisible position={Position.Bottom} offset={12} align="start">
          <BranchPlusButton
            label="Add step on the answered path"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              onInsert({
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                sourceId: nodeId,
                sourceHandle: "answered",
              });
            }}
            color="emerald"
          />
        </NodeToolbar>
      )}
      {!hasTimeoutChild && (
        <NodeToolbar isVisible position={Position.Bottom} offset={12} align="end">
          <BranchPlusButton
            label="Add step on the timeout path"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              onInsert({
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                sourceId: nodeId,
                sourceHandle: "timeout",
              });
            }}
            color="amber"
          />
        </NodeToolbar>
      )}
    </>
  );
}

// ---- Top-right action toolbar (copy + trash) -----------------------------

export function NodeActions({
  visible,
  onDuplicate,
  onDelete,
}: {
  visible: boolean;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  if (!visible) return null;
  return (
    <NodeToolbar isVisible position={Position.Right} offset={8} align="start">
      <div className="flex items-center gap-1 rounded-md border border-border bg-background/95 px-1 py-1 shadow-sm backdrop-blur">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDuplicate();
          }}
          aria-label="Duplicate step"
          title="Duplicate"
          className="inline-flex size-7 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-9"
        >
          <Copy className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label="Delete step"
          title="Delete"
          className="inline-flex size-7 cursor-pointer items-center justify-center rounded text-destructive transition-colors hover:bg-destructive/10 pointer-coarse:size-9"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </NodeToolbar>
  );
}

// ---- Floating step picker ------------------------------------------------

const GROUP_LABELS: Record<string, string> = {
  message: "Messaging",
  convo: "Conversation",
  contact: "Contact",
  control: "Control flow",
  external: "External",
};

export function StepPickerPopover({
  anchor,
  onPick,
  onClose,
  trigger,
}: {
  anchor: PickerAnchor;
  onPick: (type: StepType, anchor: PickerAnchor) => void;
  onClose: () => void;
  /** Workflow's trigger — drives the "needs a contact-scoped trigger" badge on
   *  contact/conversation-acting steps when the trigger carries no contact
   *  (incoming_webhook). Optional so isolated callers still render the palette. */
  trigger?: Trigger;
}) {
  // Steps that act on the trigger's contact / conversation no-op on a
  // contact-less trigger. Badge them so the author sees the limitation before
  // dropping the step rather than debugging a silent no-op later.
  const noContactTrigger = !!trigger && !triggerCarriesContact(trigger);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Autofocus the search the moment the popover opens so the user can start
  // typing without an extra click.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on outside-click / Escape — matches dropdown-menu behavior.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    // Defer one tick so the click that opened us doesn't immediately close it.
    const t = window.setTimeout(() => {
      window.addEventListener("mousedown", onDocClick);
    }, 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return STEP_OPTIONS.filter(
      (s) =>
        !needle ||
        s.label.toLowerCase().includes(needle) ||
        s.description.toLowerCase().includes(needle),
    );
  }, [q]);
  const grouped = useMemo(() => {
    return filtered.reduce<Record<string, typeof STEP_OPTIONS>>((acc, s) => {
      (acc[s.group] ??= []).push(s);
      return acc;
    }, {});
  }, [filtered]);

  // Clamp to viewport — the picker is 320px wide / ~420px tall. If the "+"
  // sits near the right or bottom of the screen, shift the popover so it
  // never paints under the chrome.
  const WIDTH = 320;
  const HEIGHT = 420;
  const GUTTER = 8;
  const left =
    typeof window === "undefined"
      ? anchor.x
      : Math.min(anchor.x + 16, window.innerWidth - WIDTH - GUTTER);
  const top =
    typeof window === "undefined"
      ? anchor.y
      : Math.min(anchor.y - 16, window.innerHeight - HEIGHT - GUTTER);

  // Render into document.body so the canvas's `transform` doesn't trap us
  // and the popover can overlap React Flow's controls without z-index gymnastics.
  if (typeof window === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Add step"
      className="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
      style={{ left, top, width: WIDTH, maxHeight: HEIGHT }}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="text-sm font-semibold">Add Step</div>
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search"
            aria-label="Search steps"
            className="h-7 w-36 pl-7 text-xs"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {Object.entries(grouped).map(([group, options]) => (
          <div key={group} className="mb-2 last:mb-0">
            <div className="px-1.5 pb-1 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
              {GROUP_LABELS[group] ?? group}
            </div>
            <div className="flex flex-col">
              {options.map((o) => {
                const needsContact =
                  noContactTrigger && CONTACT_ACTING_STEPS.has(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => {
                      onPick(o.value, anchor);
                    }}
                    className={cn(
                      "flex flex-col items-start rounded-md px-2 py-1.5 text-left transition-colors",
                      "hover:bg-accent/60",
                    )}
                  >
                    <span className="flex w-full items-center gap-1.5 text-sm font-medium leading-tight">
                      {o.label}
                      {needsContact && (
                        <span
                          title={NEEDS_CONTACT_TRIGGER_HINT}
                          className="rounded-sm border border-warning-border bg-warning-bg px-1 py-px text-[9px] font-medium uppercase tracking-wide text-warning-fg"
                        >
                          {NEEDS_CONTACT_TRIGGER_HINT}
                        </span>
                      )}
                    </span>
                    <span className="line-clamp-1 text-2xs text-muted-foreground">
                      {o.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            No steps match
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
