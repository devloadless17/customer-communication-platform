"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Copy } from "lucide-react";

import { cn } from "@ccp/shared/utils";
import {
  flattenShape,
  STEP_OUTPUT_SHAPES,
  TRIGGER_SHAPES,
  type FieldShape,
} from "@ccp/shared/workflow-shapes";

import type { Trigger, WorkflowGraph, WorkflowNode } from "./types";

/**
 * n8n-inspired Input / Output inspector that lives inside the step editor
 * drawer. Shows the author what data is reachable at THIS point in the
 * workflow:
 *
 *   Input section
 *     - trigger.* (per WorkflowTriggerEvent)
 *     - previousStep.* (output shape of the step immediately upstream)
 *     - steps.<id>.* (output shape of each REACHABLE upstream step)
 *
 *   Output section
 *     - The current step's documented output shape — what downstream
 *       steps will see as `$var.previousStep.*`.
 *
 * No live values in this version — those need the Run-with-sample
 * endpoint (PR 3). The static schema alone is already the biggest UX
 * win: the author stops guessing token paths and discovers the shape
 * inline.
 *
 * Click-to-insert: each leaf is a button that calls `onInsertToken` with
 * the canonical `$var.<...>` string. The parent (BodyTokenEditor etc.)
 * splices into the focused input at the live cursor.
 */
interface Props {
  /** Current step the drawer is showing. Drives the Output shape. */
  selectedNode: WorkflowNode;
  /** Full graph — used to compute the upstream chain reachable from
   *  `selectedNode`. */
  graph: WorkflowGraph;
  /** Workflow trigger — selects the right TRIGGER_SHAPES entry. */
  trigger: Trigger;
  /** Inserts the token string into the parent's focused input. */
  onInsertToken: (token: string) => void;
}

export function DataInspector({
  selectedNode,
  graph,
  trigger,
  onInsertToken,
}: Props) {
  // Walk upstream from selectedNode (BFS over reversed edges) so the
  // picker only lists step outputs the runner could ACTUALLY have
  // produced before reaching here. Without this filter, sibling branches
  // appear as reachable and confuse the author.
  const upstreamSteps = useMemo(() => {
    const reverseAdj = new Map<string, string[]>();
    for (const e of graph.edges) {
      const arr = reverseAdj.get(e.to) ?? [];
      arr.push(e.from);
      reverseAdj.set(e.to, arr);
    }
    const visited = new Set<string>();
    const order: string[] = [];
    const queue: string[] = reverseAdj.get(selectedNode.id) ?? [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      order.push(id);
      const parents = reverseAdj.get(id) ?? [];
      for (const p of parents) queue.push(p);
    }
    return order;
  }, [graph, selectedNode.id]);

  const triggerShape = TRIGGER_SHAPES[trigger];
  const outputShape = STEP_OUTPUT_SHAPES[selectedNode.type];

  // Previous step in the EXECUTION sense = the closest upstream node on
  // the unlabeled default path. Branch/ask_question step children have
  // labeled edges, but the runner sets previousStepId = whichever
  // upstream step it actually came from regardless of label, so the
  // first entry of `upstreamSteps` is the canonical answer here.
  const previousStepNode = upstreamSteps[0]
    ? graph.nodes.find((n) => n.id === upstreamSteps[0])
    : null;

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <SectionHeader title="Input" subtitle="Data reachable at this step" />

      <ShapeTree
        label="trigger"
        path={["trigger"]}
        shape={triggerShape}
        onInsertToken={onInsertToken}
      />

      {previousStepNode && (
        <ShapeTree
          label={`previousStep (${previousStepNode.type})`}
          path={["previousStep"]}
          shape={STEP_OUTPUT_SHAPES[previousStepNode.type]}
          onInsertToken={onInsertToken}
        />
      )}

      {upstreamSteps.length > 0 && (
        <CollapsibleGroup
          title="All upstream steps"
          subtitle={`${upstreamSteps.length} reachable`}
          defaultOpen={false}
        >
          <div className="flex flex-col gap-2">
            {upstreamSteps.map((stepId) => {
              const node = graph.nodes.find((n) => n.id === stepId);
              if (!node) return null;
              return (
                <ShapeTree
                  key={stepId}
                  label={`${node.name ?? stepId.slice(0, 6)} (${node.type})`}
                  path={["steps", stepId]}
                  shape={STEP_OUTPUT_SHAPES[node.type]}
                  onInsertToken={onInsertToken}
                  initiallyCollapsed
                />
              );
            })}
          </div>
        </CollapsibleGroup>
      )}

      <SectionHeader title="Output" subtitle="What downstream steps see as $var.previousStep.*" />
      <ShapeTree
        label={`${selectedNode.type} output`}
        path={[]}
        shape={outputShape}
        onInsertToken={() => undefined}
        readOnly
      />
    </div>
  );
}

function SectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="text-[11px] text-muted-foreground">{subtitle}</div>
    </div>
  );
}

function CollapsibleGroup({
  title,
  subtitle,
  defaultOpen,
  children,
}: {
  title: string;
  subtitle?: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <span className="font-medium">{title}</span>
        {subtitle && <span className="text-[10.5px] opacity-70">· {subtitle}</span>}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

/**
 * Renders a single ShapeTree — a labeled root + flat list of clickable
 * leaves underneath. The flat-leaf view (instead of nested toggles) keeps
 * the inspector compact; deep paths still show their full dotted form
 * inline so authors can scan.
 */
function ShapeTree({
  label,
  path,
  shape,
  onInsertToken,
  readOnly,
  initiallyCollapsed,
}: {
  label: string;
  /** Path segments before the shape. `["trigger"]` → tokens like
   *  `$var.trigger.contact.name`. `[]` → bare leaves (used by Output). */
  path: string[];
  shape: FieldShape;
  onInsertToken: (token: string) => void;
  readOnly?: boolean;
  initiallyCollapsed?: boolean;
}) {
  const leaves = useMemo(() => flattenShape(shape), [shape]);
  const [open, setOpen] = useState(!initiallyCollapsed);
  return (
    <div className="rounded-md border border-border bg-muted/20 px-2 py-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 text-[11px] font-medium text-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <span className="truncate">{label}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {leaves.length} field{leaves.length === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div className="mt-1.5 flex flex-col gap-0.5">
          {leaves.map((leaf) => {
            const fullPath = [...path, ...leaf.path];
            const token = `$var.${fullPath.join(".")}`;
            return (
              <button
                key={fullPath.join(".")}
                type="button"
                onClick={() => onInsertToken(token)}
                disabled={readOnly}
                className={cn(
                  "group flex items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[11px] transition-colors",
                  readOnly
                    ? "cursor-default"
                    : "cursor-pointer hover:bg-accent/60",
                )}
                title={leaf.description ?? leaf.type}
              >
                <span className="truncate font-mono text-[10.5px]">
                  {leaf.path.join(".")}
                </span>
                <span className="rounded bg-muted px-1 py-0 text-[9.5px] uppercase tracking-wider text-muted-foreground">
                  {leaf.type}
                </span>
                {!readOnly && (
                  <Copy className="ml-auto size-2.5 opacity-0 transition-opacity group-hover:opacity-60" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
