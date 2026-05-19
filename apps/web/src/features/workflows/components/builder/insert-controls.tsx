"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BaseEdge,
  EdgeLabelRenderer,
  NodeToolbar,
  Position,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";
import { Copy, Plus, Search, Trash2 } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@ccp/shared/utils";

import { STEP_OPTIONS, type StepType } from "./types";

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
    style,
    markerEnd,
    data,
  } = props;
  const d = (data ?? {}) as InsertEdgeData;
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition: sourcePosition ?? Position.Bottom,
    targetX,
    targetY,
    targetPosition: targetPosition ?? Position.Top,
  });

  function onClick(e: React.MouseEvent<HTMLButtonElement>) {
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

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div
          // pointer-events-none on the wrapper so the invisible label area
          // doesn't eat clicks on the canvas behind it; the button below
          // re-enables them for itself.
          className="pointer-events-none absolute"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
        >
          <button
            type="button"
            onClick={onClick}
            aria-label="Insert step"
            className="pointer-events-auto inline-flex size-6 cursor-pointer items-center justify-center rounded-full border border-primary/40 bg-background text-primary shadow-sm transition-all hover:scale-110 hover:bg-primary hover:text-primary-foreground"
          >
            <Plus className="size-3.5" />
          </button>
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
          className="inline-flex size-7 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
          className="inline-flex size-7 cursor-pointer items-center justify-center rounded text-destructive transition-colors hover:bg-destructive/10"
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
}: {
  anchor: PickerAnchor;
  onPick: (type: StepType, anchor: PickerAnchor) => void;
  onClose: () => void;
}) {
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
            className="h-7 w-36 pl-7 text-xs"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {Object.entries(grouped).map(([group, options]) => (
          <div key={group} className="mb-2 last:mb-0">
            <div className="px-1.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {GROUP_LABELS[group] ?? group}
            </div>
            <div className="flex flex-col">
              {options.map((o) => (
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
                  <span className="text-[13px] font-medium leading-tight">
                    {o.label}
                  </span>
                  <span className="line-clamp-1 text-[11px] text-muted-foreground">
                    {o.description}
                  </span>
                </button>
              ))}
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
