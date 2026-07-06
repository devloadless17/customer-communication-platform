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
        initiallyCollapsed
      />

      {previousStepNode && (
        <ShapeTree
          label={`previousStep (${previousStepNode.type})`}
          path={["previousStep"]}
          shape={STEP_OUTPUT_SHAPES[previousStepNode.type]}
          onInsertToken={onInsertToken}
          initiallyCollapsed
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
      <div className="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="text-2xs text-muted-foreground">{subtitle}</div>
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
        className="flex w-full items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <span className="font-medium">{title}</span>
        {subtitle && <span className="text-2xs opacity-70">· {subtitle}</span>}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

/**
 * One collapsible namespace (trigger / previousStep / output). Collapsed it's
 * a single compact row ("trigger · 25 fields"); expanded, the leaves are
 * grouped by their top segment (contact / message / conversation) under tiny
 * sub-labels so a 25-field trigger reads as three short lists instead of one
 * long flat dump. Each leaf is click-to-insert.
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
  // Group by the first path segment when the shape is nested (trigger), else
  // keep one flat group (step outputs are 1-deep: messageId, externalId…).
  const groups = useMemo(() => {
    const nested = leaves.some((l) => l.path.length >= 2);
    if (!nested) return [{ name: null as string | null, leaves }];
    const map = new Map<string, typeof leaves>();
    for (const l of leaves) {
      const g = l.path[0]!;
      map.set(g, [...(map.get(g) ?? []), l]);
    }
    return [...map.entries()].map(([name, ls]) => ({ name, leaves: ls }));
  }, [leaves]);
  const [open, setOpen] = useState(!initiallyCollapsed);
  return (
    <div className="rounded-lg border border-border/70 bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-2xs font-medium text-foreground transition-colors hover:bg-accent/40"
      >
        {open ? (
          <ChevronDown className="size-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 text-muted-foreground" />
        )}
        <span className="truncate">{label}</span>
        <span className="ml-auto text-3xs tabular-nums text-muted-foreground/70">
          {leaves.length}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 px-1.5 pb-1.5">
          {groups.map((grp) => (
            <div key={grp.name ?? "_flat"} className="flex flex-col">
              {grp.name && (
                <div className="px-1.5 pb-0.5 pt-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                  {grp.name}
                </div>
              )}
              {grp.leaves.map((leaf) => {
                const fullPath = [...path, ...leaf.path];
                const token = `$var.${fullPath.join(".")}`;
                // Drop the group prefix from the visible label when grouped —
                // "id" reads cleaner than "contact.id" under a "CONTACT" header.
                const display = grp.name
                  ? leaf.path.slice(1).join(".")
                  : leaf.path.join(".");
                return (
                  <button
                    key={fullPath.join(".")}
                    type="button"
                    onClick={() => onInsertToken(token)}
                    disabled={readOnly}
                    className={cn(
                      "group flex items-center gap-2 rounded px-1.5 py-1 text-left text-2xs transition-colors",
                      readOnly ? "cursor-default" : "cursor-pointer hover:bg-accent/60",
                    )}
                    title={readOnly ? leaf.description ?? leaf.type : "Copy variable"}
                    aria-label={readOnly ? undefined : "Copy variable"}
                  >
                    <span className="truncate font-mono text-2xs">{display}</span>
                    <span className="ml-auto shrink-0 text-[9px] lowercase text-muted-foreground/50">
                      {leaf.type}
                    </span>
                    {!readOnly && (
                      <Copy className="size-2.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-60" />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
