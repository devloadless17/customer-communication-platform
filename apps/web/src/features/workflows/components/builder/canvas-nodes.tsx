"use client";

import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  ArrowRightLeft,
  Ticket as TicketIcon,
  CircleSlash,
  Circle,
  Clock,
  Filter,
  Globe,
  HelpCircle,
  MessageSquare,
  RotateCcw,
  Tag as TagIcon,
  UserPlus,
  Webhook,
  Zap,
} from "lucide-react";

import {
  AskQuestionTrailingPlus,
  BranchTrailingPlus,
  NodeActions,
  TrailingPlus,
  type PickerAnchor,
} from "./insert-controls";
import { type StepType, type Trigger, STEP_OPTIONS, TRIGGER_OPTIONS } from "./types";

/**
 * React Flow custom node renderers.
 *
 *   TriggerNode  — single "start" node (no input handle, single output)
 *   StepNode     — generic step (1 input, 1 output)
 *   BranchNode   — special step (1 input, 2 outputs labeled true/false)
 *
 * Wait + jump are rendered with the generic StepNode — wait visually carries
 * a clock icon, jump shows a back-arrow. Their config edits happen in the
 * side drawer; the canvas just shows their identity.
 */

const ICONS: Partial<Record<StepType, React.ComponentType<{ className?: string }>>> = {
  send_message: MessageSquare,
  send_template: MessageSquare,
  add_comment: MessageSquare,
  assign_to: UserPlus,
  set_status: Circle,
  open_conversation: Circle,
  close_conversation: Circle,
  add_tag: TagIcon,
  remove_tag: TagIcon,
  update_field: TagIcon,
  update_lifecycle: TagIcon,
  branch: Filter,
  wait: Clock,
  jump_to_step: RotateCcw,
  noop: CircleSlash,
  ask_question: HelpCircle,
  http_request: Globe,
  trigger_workflow: ArrowRightLeft,
  create_ticket: TicketIcon,
  set_ticket_status: TicketIcon,
  set_ticket_priority: TicketIcon,
  assign_ticket: TicketIcon,
};

export interface NodeData extends Record<string, unknown> {
  label: string;
  description?: string;
  type?: StepType | "trigger";
  trigger?: Trigger;
  selected?: boolean;
  /** Optional shorthand of the step's config for "what does this do" hints. */
  summary?: string;
  hasErrors?: boolean;
  /** Inline-action callbacks injected by WorkflowCanvas. */
  onDuplicate?: () => void;
  onDelete?: () => void;
  /** Whether to render the trailing "+" below this node (leaves only). */
  showTrailingPlus?: boolean;
  onOpenPicker?: (anchor: PickerAnchor) => void;
  /**
   * Branch-only: per-output "does this handle already have a child?".
   * Drives the inline "+" affordances on the true / false handles so the
   * user can add a step on an empty branch without dragging a wire blind.
   */
  branchHasTrueChild?: boolean;
  branchHasFalseChild?: boolean;
  /**
   * ask_question-only counterpart of the branch flags. Drives the inline
   * "+" affordances on the answered / timeout handles.
   */
  askHasAnsweredChild?: boolean;
  askHasTimeoutChild?: boolean;
  /** ask_question answer kind — drives whether to render N option handles
   *  or the generic answered+timeout pair. */
  askAnswerKind?: "free_text" | "buttons" | "list";
  /** Stable ids + labels of the step's options, in declaration order. Populated
   *  when askAnswerKind is "buttons" or "list" (both drive the N-way mode). */
  askOptionIds?: Array<{ id: string; title: string }>;
  /** For each option id, whether an outgoing edge with that label already
   *  exists. Drives the per-option "+" affordances. */
  askOptionChildren?: Record<string, boolean>;
}

const NODE_BASE =
  "rounded-lg border-2 bg-card shadow-xs transition-all hover:shadow-md";

export function TriggerNode({ data }: NodeProps) {
  const d = data as NodeData;
  const trigger = TRIGGER_OPTIONS.find((t) => t.value === d.trigger);
  return (
    <div
      className={`${NODE_BASE} w-64 border-amber-500/40 ${
        d.selected ? "shadow-md ring-2 ring-amber-500" : ""
      }`}
    >
      <div className="flex items-center gap-2 border-b border-border bg-amber-500/10 px-3 py-2">
        <Zap className="size-4 text-amber-600 dark:text-amber-400" />
        <div className="flex-1">
          <div className="text-3xs font-medium uppercase tracking-wider text-amber-700 dark:text-amber-300">
            Trigger
          </div>
          <div className="truncate text-sm font-medium leading-tight">{trigger?.label ?? "Pick a trigger"}</div>
        </div>
      </div>
      {trigger?.description && (
        <div className="px-3 py-2 text-2xs text-muted-foreground">{trigger.description}</div>
      )}
      <Handle type="source" position={Position.Bottom} id="default" />
      {/* Empty-graph affordance — when no startNode is wired yet, the
          trigger gets the trailing "+" so the user can drop the first
          step inline. sourceId=null tells insertStepAfter "this is the new
          start node." */}
      {d.showTrailingPlus && d.onOpenPicker && (
        <TrailingPlus
          visible
          nodeId="__trigger__"
          sourceHandle={null}
          onInsert={(anchor) =>
            d.onOpenPicker?.({ ...anchor, sourceId: null })
          }
        />
      )}
    </div>
  );
}

export function StepNode({ id, data }: NodeProps) {
  const d = data as NodeData;
  const [hovered, setHovered] = useState(false);
  const step = STEP_OPTIONS.find((s) => s.value === d.type);
  const Icon = (d.type && ICONS[d.type as StepType]) ?? Webhook;
  const borderColor = d.hasErrors ? "border-destructive/60" : "border-primary/30";
  // Show inline actions when the node is either hovered or selected — the
  // hover path is for "I'm about to interact", the selected path is for
  // touch / keyboard users who don't have hover.
  const actionsVisible = hovered || !!d.selected;
  return (
    <div
      className={`${NODE_BASE} w-64 ${borderColor} ${
        d.selected ? "shadow-md ring-2 ring-primary" : ""
      }`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Handle type="target" position={Position.Top} />
      <div className="flex items-center gap-2 border-b border-border bg-primary/5 px-3 py-2">
        <Icon className="size-4 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-3xs font-medium uppercase tracking-wider text-muted-foreground">
            {step?.label ?? d.type}
          </div>
          <div className="truncate text-sm font-medium leading-tight">{d.label}</div>
        </div>
      </div>
      {d.summary && (
        <div className="truncate px-3 py-2 text-2xs text-muted-foreground">{d.summary}</div>
      )}
      <Handle type="source" position={Position.Bottom} id="default" />
      <NodeActions
        visible={actionsVisible}
        onDuplicate={() => d.onDuplicate?.()}
        onDelete={() => d.onDelete?.()}
      />
      {d.showTrailingPlus && d.onOpenPicker && (
        <TrailingPlus
          visible
          nodeId={id}
          sourceHandle={null}
          onInsert={d.onOpenPicker}
        />
      )}
    </div>
  );
}

export function BranchNode({ id, data }: NodeProps) {
  const d = data as NodeData;
  const [hovered, setHovered] = useState(false);
  const actionsVisible = hovered || !!d.selected;
  return (
    <div
      className={`${NODE_BASE} w-64 border-indigo-500/40 ${
        d.selected ? "shadow-md ring-2 ring-indigo-500" : ""
      }`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Handle type="target" position={Position.Top} />
      <NodeActions
        visible={actionsVisible}
        onDuplicate={() => d.onDuplicate?.()}
        onDelete={() => d.onDelete?.()}
      />
      <div className="flex items-center gap-2 border-b border-border bg-indigo-500/10 px-3 py-2">
        <Filter className="size-4 text-indigo-600 dark:text-indigo-400" />
        <div className="min-w-0 flex-1">
          <div className="text-3xs font-medium uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
            Branch
          </div>
          <div className="truncate text-sm font-medium leading-tight">{d.label}</div>
        </div>
      </div>
      <div className="flex items-center justify-between px-3 py-2 text-2xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-emerald-500" /> true
        </span>
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-destructive" /> false
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        id="true"
        style={{ left: "25%", background: "var(--success-fg)" }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="false"
        // --destructive is an oklch() token, so it must be used directly — the
        // old hsl(var(--destructive)) wrapper was invalid and rendered black.
        style={{ left: "75%", background: "var(--destructive)" }}
      />
      {/* Per-output "+" affordances for empty handles. Without these, a
          freshly-added Branch step had two bare handles and the only way
          to wire a child was to drag a connection blind — every test
          user got stuck here. The two buttons are color-matched to their
          handle so the visual link is obvious. Once a child is wired,
          the edge "+" takes over and the handle's button disappears. */}
      {d.onOpenPicker && (
        <BranchTrailingPlus
          hasTrueChild={!!d.branchHasTrueChild}
          hasFalseChild={!!d.branchHasFalseChild}
          nodeId={id}
          onInsert={d.onOpenPicker}
        />
      )}
    </div>
  );
}

/**
 * Ask-question node: sends a question to the contact, pauses the run, then
 * branches based on the answer.
 *
 *   Free-text mode → 2 handles: "answered" (emerald) + "timeout" (amber).
 *   Buttons/list mode (1-N options) → N+1 handles: one per option id + "timeout".
 *
 * The N-way path keeps option workflows clean — author wires each option's edge
 * directly to the next step instead of forcing a Branch in between. Buttons cap
 * at 3 (Meta limit); list caps at 10. List MUST render the N handles too —
 * otherwise edges already wired to per-option handles silently drop off the
 * canvas (they can't resolve to a handle that isn't rendered). At 10 options the
 * per-option id labels squeeze on a w-64 (256px) node, but they truncate with a
 * `title` tooltip and the per-option "+" lives in a width-unconstrained floating
 * toolbar, so wiring stays usable.
 */
export function AskQuestionNode({ id, data }: NodeProps) {
  const d = data as NodeData;
  const [hovered, setHovered] = useState(false);
  const actionsVisible = hovered || !!d.selected;
  const options = d.askOptionIds ?? [];
  const nWay =
    (d.askAnswerKind === "buttons" || d.askAnswerKind === "list") &&
    options.length > 0;
  return (
    <div
      className={`${NODE_BASE} w-64 border-violet-500/40 ${
        d.selected ? "shadow-md ring-2 ring-violet-500" : ""
      }`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Handle type="target" position={Position.Top} />
      <NodeActions
        visible={actionsVisible}
        onDuplicate={() => d.onDuplicate?.()}
        onDelete={() => d.onDelete?.()}
      />
      <div className="flex items-center gap-2 border-b border-border bg-violet-500/10 px-3 py-2">
        <HelpCircle className="size-4 text-violet-600 dark:text-violet-400" />
        <div className="min-w-0 flex-1">
          <div className="text-3xs font-medium uppercase tracking-wider text-violet-700 dark:text-violet-300">
            Ask a Question
          </div>
          <div className="truncate text-sm font-medium leading-tight">{d.label}</div>
        </div>
      </div>
      {d.summary && (
        <div className="truncate px-3 py-2 text-2xs text-muted-foreground">{d.summary}</div>
      )}
      {nWay ? (
        <div className="flex items-center justify-between px-3 py-2 text-2xs text-muted-foreground">
          {options.map((opt) => (
            <span key={opt.id} className="flex min-w-0 items-center gap-1" title={opt.id}>
              <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
              <span className="truncate">{opt.id}</span>
            </span>
          ))}
          <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
            <span className="size-1.5 shrink-0 rounded-full bg-amber-500" /> timeout
          </span>
        </div>
      ) : (
        <div className="flex items-center justify-between px-3 py-2 text-2xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-emerald-500" /> answered
          </span>
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-amber-500" /> timeout
          </span>
        </div>
      )}
      {nWay
        ? (() => {
            // N+1 handles evenly spaced. With N=3 buttons + 1 timeout, the
            // 4 positions land at 12.5 / 37.5 / 62.5 / 87.5 % — same gutter
            // either side as the 2-handle layout's 25 / 75 %.
            const slots = options.length + 1;
            return (
              <>
                {options.map((opt, idx) => (
                  <Handle
                    key={opt.id}
                    type="source"
                    position={Position.Bottom}
                    id={opt.id}
                    style={{
                      left: `${((idx + 0.5) / slots) * 100}%`,
                      background: "var(--success-fg)",
                    }}
                  />
                ))}
                <Handle
                  type="source"
                  position={Position.Bottom}
                  id="timeout"
                  style={{
                    left: `${((options.length + 0.5) / slots) * 100}%`,
                    background: "var(--warning-fg)",
                  }}
                />
              </>
            );
          })()
        : (
            <>
              <Handle
                type="source"
                position={Position.Bottom}
                id="answered"
                style={{ left: "25%", background: "var(--success-fg)" }}
              />
              <Handle
                type="source"
                position={Position.Bottom}
                id="timeout"
                style={{ left: "75%", background: "var(--warning-fg)" }}
              />
            </>
          )}
      {d.onOpenPicker && (
        <AskQuestionTrailingPlus
          hasAnsweredChild={!!d.askHasAnsweredChild}
          hasTimeoutChild={!!d.askHasTimeoutChild}
          options={nWay ? options : null}
          optionHasChild={d.askOptionChildren ?? {}}
          nodeId={id}
          onInsert={d.onOpenPicker}
        />
      )}
    </div>
  );
}
