"use client";

import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Tabular conditions editor. Each row picks a field + an operator (and value
 * when the op needs one). Field options depend on the parent's trigger.
 *
 * Mirrors the server-side validation in lib/automations/conditions.ts —
 * keeping them in lockstep matters because a typo here would silently never
 * fire (the evaluator fails closed on unknown ops).
 */

type Trigger =
  | "message_received"
  | "conversation_assigned"
  | "conversation_status_changed";

export type ConditionField =
  | "body"
  | "body_lower"
  | "direction"
  | "status_from"
  | "status_to"
  | "assigned_user_id"
  | "contact_phone"
  | "contact_name";

export type ConditionOp =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "regex"
  | "is_null"
  | "is_not_null";

export interface ConditionRow {
  field: ConditionField;
  op: ConditionOp;
  value: string;
}

const FIELDS_BY_TRIGGER: Record<Trigger, ConditionField[]> = {
  message_received: ["body", "body_lower", "direction", "contact_phone", "contact_name"],
  conversation_assigned: ["assigned_user_id", "contact_phone", "contact_name"],
  conversation_status_changed: ["status_from", "status_to", "contact_phone", "contact_name"],
};

const FIELD_LABELS: Record<ConditionField, string> = {
  body: "Message body",
  body_lower: "Message body (lowercased)",
  direction: "Direction (in/out)",
  status_from: "Previous status",
  status_to: "New status",
  assigned_user_id: "Assigned user id",
  contact_phone: "Contact phone",
  contact_name: "Contact name",
};

const OPS: Array<{ value: ConditionOp; label: string; needsValue: boolean }> = [
  { value: "equals", label: "equals", needsValue: true },
  { value: "not_equals", label: "does not equal", needsValue: true },
  { value: "contains", label: "contains", needsValue: true },
  { value: "not_contains", label: "does not contain", needsValue: true },
  { value: "starts_with", label: "starts with", needsValue: true },
  { value: "ends_with", label: "ends with", needsValue: true },
  { value: "regex", label: "matches regex", needsValue: true },
  { value: "is_null", label: "is empty", needsValue: false },
  { value: "is_not_null", label: "is not empty", needsValue: false },
];

interface Props {
  trigger: Trigger;
  conditions: ConditionRow[];
  onChange: (conditions: ConditionRow[]) => void;
}

export function ConditionBuilder({ trigger, conditions, onChange }: Props) {
  const allowedFields = FIELDS_BY_TRIGGER[trigger];

  function addRow() {
    const field = allowedFields[0];
    if (!field) return;
    onChange([
      ...conditions,
      { field, op: "contains", value: "" },
    ]);
  }

  function update(idx: number, patch: Partial<ConditionRow>) {
    const next = conditions.map((c, i) => (i === idx ? { ...c, ...patch } : c));
    onChange(next);
  }

  function remove(idx: number) {
    onChange(conditions.filter((_, i) => i !== idx));
  }

  return (
    <div className="flex flex-col gap-2">
      {conditions.length === 0 && (
        <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
          No conditions — the automation will fire on every {trigger.replace(/_/g, " ")}.
        </div>
      )}

      {conditions.map((c, idx) => {
        const op = OPS.find((o) => o.value === c.op) ?? OPS[0]!;
        // If the trigger changed and the row's field is no longer valid,
        // surface that with a red border instead of silently dropping the
        // row (so the user can pick a replacement field).
        const fieldValid = allowedFields.includes(c.field);
        return (
          <div
            key={idx}
            className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-2"
          >
            <select
              value={c.field}
              onChange={(e) => update(idx, { field: e.target.value as ConditionField })}
              className={
                "h-8 rounded-md border bg-background px-2 text-sm " +
                (fieldValid ? "border-border" : "border-destructive")
              }
            >
              {!fieldValid && <option value={c.field}>{c.field} (invalid)</option>}
              {allowedFields.map((f) => (
                <option key={f} value={f}>
                  {FIELD_LABELS[f]}
                </option>
              ))}
            </select>
            <select
              value={c.op}
              onChange={(e) => update(idx, { op: e.target.value as ConditionOp })}
              className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            >
              {OPS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {op.needsValue && (
              <Input
                className="h-8 max-w-[260px] flex-1"
                value={c.value}
                onChange={(e) => update(idx, { value: e.target.value })}
                placeholder={valuePlaceholder(c.field, c.op)}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => remove(idx)}
              aria-label="Remove condition"
              className="ml-auto size-7 text-muted-foreground hover:text-destructive"
            >
              <X className="size-4" />
            </Button>
          </div>
        );
      })}

      <div>
        <Button type="button" variant="outline" size="sm" onClick={addRow}>
          <Plus className="size-4" />
          Add condition
        </Button>
      </div>
    </div>
  );
}

function valuePlaceholder(field: ConditionField, op: ConditionOp): string {
  if (op === "regex") return "^hello.*$";
  switch (field) {
    case "body":
    case "body_lower":
      return "help";
    case "direction":
      return "in or out";
    case "status_from":
    case "status_to":
      return "open / pending / closed";
    case "contact_phone":
      return "971501234567";
    case "contact_name":
      return "Ahmad";
    case "assigned_user_id":
      return "user id (or empty for unassigned)";
  }
}
