"use client";

import { Plus, X, Layers } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  type Condition,
  type ConditionField,
  type ConditionGroup as Group,
  type ConditionOp,
  type GroupOp,
  type Trigger,
  FIELDS_BY_TRIGGER,
  FIELD_LABELS,
  OP_OPTIONS,
  isGroup,
} from "./types";

/**
 * Recursive AND/OR group editor. Same component is used at the trigger level
 * (trigger conditions, scoped to FIELDS_BY_TRIGGER[trigger]) and inside a
 * `branch` step (any field is allowed — pass trigger="message_received" to
 * still get a useful default set).
 */

const MAX_DEPTH = 3;

interface Props {
  trigger: Trigger;
  group: Group;
  onChange: (group: Group) => void;
  depth?: number;
  onRemove?: () => void;
  /** When true, ALL condition fields are offered (used by branch steps). */
  allowAllFields?: boolean;
}

export function ConditionGroupEditor({
  trigger,
  group,
  onChange,
  depth = 0,
  onRemove,
  allowAllFields,
}: Props) {
  const allowedFields = allowAllFields
    ? (Array.from(new Set(Object.values(FIELDS_BY_TRIGGER).flat())) as ConditionField[])
    : FIELDS_BY_TRIGGER[trigger];
  const isRoot = depth === 0;
  const canNestMore = depth < MAX_DEPTH - 1;

  function setOp(op: GroupOp) {
    onChange({ ...group, op });
  }

  function addCondition() {
    const field = allowedFields[0];
    if (!field) return;
    onChange({
      ...group,
      children: [...group.children, { field, op: "contains", value: "" }],
    });
  }

  function addGroup() {
    onChange({
      ...group,
      children: [...group.children, { op: "OR", children: [] }],
    });
  }

  function updateChild(idx: number, child: Condition | Group) {
    onChange({
      ...group,
      children: group.children.map((c, i) => (i === idx ? child : c)),
    });
  }

  function removeChild(idx: number) {
    onChange({ ...group, children: group.children.filter((_, i) => i !== idx) });
  }

  const empty = group.children.length === 0;

  return (
    <div
      className={
        "flex flex-col gap-2 rounded-md border p-2 " +
        (isRoot ? "border-border bg-card" : "border-dashed border-border bg-muted/30")
      }
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Layers className="size-3.5 text-muted-foreground" />
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {isRoot ? "Match" : "Group"}
          </span>
          <div className="ml-1 flex overflow-hidden rounded-md border border-border bg-background text-[11px]">
            <button
              type="button"
              onClick={() => setOp("AND")}
              className={
                "px-2 py-0.5 transition-colors " +
                (group.op === "AND" ? "bg-primary text-primary-foreground" : "hover:bg-accent/40")
              }
            >
              AND
            </button>
            <button
              type="button"
              onClick={() => setOp("OR")}
              className={
                "px-2 py-0.5 transition-colors " +
                (group.op === "OR" ? "bg-primary text-primary-foreground" : "hover:bg-accent/40")
              }
            >
              OR
            </button>
          </div>
        </div>
        {onRemove && !isRoot && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onRemove}
            aria-label="Remove group"
            className="size-6 text-muted-foreground hover:text-destructive"
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>

      {empty && (
        <div className="rounded-md border border-dashed border-border bg-background/40 px-3 py-2 text-[11px] text-muted-foreground">
          {isRoot ? "No filters — fires on every event." : "Empty group."}
        </div>
      )}

      {group.children.map((child, idx) => {
        if (isGroup(child)) {
          return (
            <ConditionGroupEditor
              key={idx}
              trigger={trigger}
              group={child}
              depth={depth + 1}
              onChange={(g) => updateChild(idx, g)}
              onRemove={() => removeChild(idx)}
              allowAllFields={allowAllFields}
            />
          );
        }
        return (
          <ConditionRow
            key={idx}
            allowedFields={allowedFields}
            condition={child}
            onChange={(c) => updateChild(idx, c)}
            onRemove={() => removeChild(idx)}
          />
        );
      })}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" variant="outline" size="sm" onClick={addCondition}>
          <Plus className="size-3.5" />
          Condition
        </Button>
        {canNestMore && (
          <Button type="button" variant="ghost" size="sm" onClick={addGroup}>
            <Plus className="size-3.5" />
            Group
          </Button>
        )}
      </div>
    </div>
  );
}

function ConditionRow({
  allowedFields,
  condition,
  onChange,
  onRemove,
}: {
  allowedFields: ConditionField[];
  condition: Condition;
  onChange: (c: Condition) => void;
  onRemove: () => void;
}) {
  const op = OP_OPTIONS.find((o) => o.value === condition.op) ?? OP_OPTIONS[0]!;
  const fieldValid = allowedFields.includes(condition.field);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background p-2">
      <select
        value={condition.field}
        onChange={(e) => onChange({ ...condition, field: e.target.value as ConditionField })}
        className={
          "h-8 rounded-md border bg-background px-2 text-sm " +
          (fieldValid ? "border-border" : "border-destructive")
        }
      >
        {!fieldValid && <option value={condition.field}>{condition.field} (invalid)</option>}
        {allowedFields.map((f) => (
          <option key={f} value={f}>
            {FIELD_LABELS[f]}
          </option>
        ))}
      </select>
      <select
        value={condition.op}
        onChange={(e) => onChange({ ...condition, op: e.target.value as ConditionOp })}
        className="h-8 rounded-md border border-border bg-background px-2 text-sm"
      >
        {OP_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {op.needsValue && (
        <Input
          className="h-8 max-w-[240px] flex-1"
          value={condition.value}
          onChange={(e) => onChange({ ...condition, value: e.target.value })}
        />
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onRemove}
        aria-label="Remove condition"
        className="ml-auto size-7 text-muted-foreground hover:text-destructive"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
