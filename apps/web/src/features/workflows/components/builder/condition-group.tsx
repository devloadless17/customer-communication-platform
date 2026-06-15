"use client";

import { Plus, X, Layers } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";

import {
  type BuilderCatalogs,
  type Condition,
  type ConditionField,
  type ConditionGroup as Group,
  type ConditionOp,
  type GroupOp,
  type Trigger,
  CONTACT_SCOPED_FIELDS,
  DIRECTION_VALUES,
  FIELDS_BY_TRIGGER,
  FIELD_LABELS,
  FIELD_VALUE_KIND,
  OP_OPTIONS,
  STATUS_VALUES,
  TAG_CHANGE_KIND_VALUES,
  isGroup,
  triggerCarriesContact,
} from "./types";

/**
 * Stable client-side React key per child. We stamp `_id` directly on each
 * Condition/Group at insert (see `addCondition` / `addGroup`) and on
 * first render of server-hydrated rows. Spreads (`{...condition, value}`)
 * carry `_id` forward, so the changed slot keeps the same key across
 * edits — input doesn't remount, focus stays on the keystroke.
 *
 * Earlier iterations tried WeakMap-keyed-by-reference; that broke focus
 * on every keystroke because the immutable spread produces a NEW
 * reference for the row being edited, which got a NEW key, which
 * remounted the input on every character. The fix is to give the row a
 * key that survives the spread — `_id` does that since it's just a
 * field on the object.
 *
 * `_id` is optional in the type for back-compat with persisted graphs
 * that pre-date this scheme; stampLazyId mutates on first render.
 */
function stampLazyId<T extends { _id?: string }>(child: T): string {
  if (!child._id) {
    child._id = `c-${Math.random().toString(36).slice(2, 11)}`;
  }
  return child._id;
}

/**
 * Recursive AND/OR group editor. Same component is used at the trigger level
 * (trigger conditions, scoped to FIELDS_BY_TRIGGER[trigger]) and inside a
 * `branch` step (any field is allowed — pass trigger="message_received" to
 * still get a useful default set).
 */

/** Recursively count the leaf Conditions inside a group — drives the
 *  "remove this group and its N conditions?" confirmation. */
function countLeafConditions(group: Group): number {
  let n = 0;
  for (const child of group.children) {
    n += isGroup(child) ? countLeafConditions(child) : 1;
  }
  return n;
}

const MAX_DEPTH = 3;

interface Props {
  trigger: Trigger;
  group: Group;
  onChange: (group: Group) => void;
  depth?: number;
  onRemove?: () => void;
  /** When true, ALL condition fields are offered (used by branch steps). */
  allowAllFields?: boolean;
  /**
   * Optional catalogs — when provided, ID-valued fields (stage / tag / user
   * / field_key) render as dropdowns of the team's rows instead of free-text
   * inputs. Without catalogs the row falls back to a plain Input so the
   * component still works in contexts that don't have one (tests, isolated
   * preview pages).
   */
  catalogs?: BuilderCatalogs;
}

export function ConditionGroupEditor({
  trigger,
  group,
  onChange,
  depth = 0,
  onRemove,
  allowAllFields,
  catalogs,
}: Props) {
  // When the trigger carries no contact (incoming_webhook), its contact_*
  // fields resolve against a null contact and never match — hide them so the
  // author isn't offered a silent no-op. `allowAllFields` (branch steps) keeps
  // the full set; the branch can still gate on prior step outputs.
  const noContactTrigger = !allowAllFields && !triggerCarriesContact(trigger);
  const allowedFields = allowAllFields
    ? (Array.from(new Set(Object.values(FIELDS_BY_TRIGGER).flat())) as ConditionField[])
    : noContactTrigger
      ? FIELDS_BY_TRIGGER[trigger].filter((f) => !CONTACT_SCOPED_FIELDS.has(f))
      : FIELDS_BY_TRIGGER[trigger];
  const isRoot = depth === 0;
  const canNestMore = depth < MAX_DEPTH - 1;
  const { confirm, confirmDialog } = useConfirm();

  function setOp(op: GroupOp) {
    onChange({ ...group, op });
  }

  function addCondition() {
    const field = allowedFields[0];
    if (!field) return;
    const child: Condition = { field, op: "contains", value: "" };
    stampLazyId(child);
    onChange({
      ...group,
      children: [...group.children, child],
    });
  }

  function addGroup() {
    const child: Group = { op: "OR", children: [] };
    stampLazyId(child);
    onChange({
      ...group,
      children: [...group.children, child],
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
    <>
    <div
      className={
        "flex flex-col gap-2 rounded-md border p-2 " +
        (isRoot ? "border-border bg-card" : "border-dashed border-border bg-muted/30")
      }
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Layers className="size-3.5 text-muted-foreground" />
          <span className="text-3xs font-medium uppercase tracking-wider text-muted-foreground">
            {isRoot ? "Match" : "Group"}
          </span>
          <div className="ml-1 flex overflow-hidden rounded-md border border-border bg-background text-2xs">
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
            onClick={async () => {
              const count = countLeafConditions(group);
              // Empty group removes with no data loss — don't over-confirm.
              if (count > 0) {
                const ok = await confirm({
                  title: `Remove this group and its ${count} condition${count === 1 ? "" : "s"}?`,
                  description:
                    "The group and every condition inside it will be deleted. This can't be undone.",
                  confirmLabel: "Remove",
                  destructive: true,
                });
                if (!ok) return;
              }
              onRemove();
            }}
            aria-label="Remove group"
            className="size-6 text-muted-foreground hover:text-destructive"
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>

      {isRoot && noContactTrigger && (
        <div className="rounded-md border border-dashed border-amber-500/40 bg-amber-500/5 px-3 py-2 text-2xs text-amber-700 dark:text-amber-400">
          This trigger has no contact, so contact filters (phone / name / email
          / stage) aren&apos;t available — match on the webhook body inside a
          Branch step instead.
        </div>
      )}

      {empty && (
        <div className="rounded-md border border-dashed border-border bg-background/40 px-3 py-2 text-2xs text-muted-foreground">
          {isRoot ? "No filters — fires on every event." : "Empty group."}
        </div>
      )}

      {group.children.map((child, idx) => {
        const k = stampLazyId(child);
        if (isGroup(child)) {
          return (
            <ConditionGroupEditor
              key={k}
              trigger={trigger}
              group={child}
              depth={depth + 1}
              onChange={(g) => updateChild(idx, g)}
              onRemove={() => removeChild(idx)}
              allowAllFields={allowAllFields}
              catalogs={catalogs}
            />
          );
        }
        return (
          <ConditionRow
            key={k}
            allowedFields={allowedFields}
            condition={child}
            onChange={(c) => updateChild(idx, c)}
            onRemove={() => removeChild(idx)}
            catalogs={catalogs}
          />
        );
      })}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addCondition}
          disabled={allowedFields.length === 0}
        >
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
    {confirmDialog}
    </>
  );
}

function ConditionRow({
  allowedFields,
  condition,
  onChange,
  onRemove,
  catalogs,
}: {
  allowedFields: ConditionField[];
  condition: Condition;
  onChange: (c: Condition) => void;
  onRemove: () => void;
  catalogs?: BuilderCatalogs;
}) {
  const op = OP_OPTIONS.find((o) => o.value === condition.op) ?? OP_OPTIONS[0]!;
  const fieldValid = allowedFields.includes(condition.field);
  // ID-valued fields only make sense with the equality ops. When the agent
  // picks "tag" or "stage" we narrow the operator list so they don't end up
  // typing "contains" against a CUID and wondering why it never matches.
  const isIdentityField =
    FIELD_VALUE_KIND[condition.field] !== "text" &&
    FIELD_VALUE_KIND[condition.field] !== "field_key";
  const opOptions = isIdentityField
    ? OP_OPTIONS.filter((o) =>
        ["equals", "not_equals", "is_null", "is_not_null"].includes(o.value),
      )
    : OP_OPTIONS;
  // If the field switched to an identity field but the saved op isn't in the
  // narrowed set, force-normalize on change. Avoids "tag is_equal contains"
  // states landing in the database.
  function setField(field: ConditionField) {
    const nextKind = FIELD_VALUE_KIND[field];
    const nextIsIdentity = nextKind !== "text" && nextKind !== "field_key";
    const nextOpAllowed = !nextIsIdentity ||
      ["equals", "not_equals", "is_null", "is_not_null"].includes(condition.op);
    onChange({
      ...condition,
      field,
      op: nextOpAllowed ? condition.op : "equals",
      value: condition.value,
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background p-2">
      <select
        value={condition.field}
        onChange={(e) => setField(e.target.value as ConditionField)}
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
        {opOptions.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {op.needsValue && (
        <ConditionValueControl
          field={condition.field}
          value={condition.value}
          onChange={(value) => onChange({ ...condition, value })}
          catalogs={catalogs}
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

/**
 * Renders the right control for the field's value kind:
 *   - stage / tag / user / field_key  → dropdown of the team's catalog rows
 *   - status / direction / tag_change_kind  → dropdown of fixed enum values
 *   - text → plain Input
 *
 * Catalog-backed pickers append the saved value as a sentinel option when it
 * doesn't match any current row, so a stale id (deleted stage, renamed tag)
 * is visible to the author instead of silently switching to the first row.
 */
function ConditionValueControl({
  field,
  value,
  onChange,
  catalogs,
}: {
  field: ConditionField;
  value: string;
  onChange: (next: string) => void;
  catalogs?: BuilderCatalogs;
}) {
  const kind = FIELD_VALUE_KIND[field];
  const selectClass =
    "h-8 max-w-60 flex-1 rounded-md border border-border bg-background px-2 text-sm";

  if (kind === "status") {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} className={selectClass}>
        <option value="">Select status…</option>
        {STATUS_VALUES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    );
  }
  if (kind === "direction") {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} className={selectClass}>
        <option value="">Select direction…</option>
        {DIRECTION_VALUES.map((d) => (
          <option key={d} value={d}>
            {d === "in" ? "in (inbound)" : "out (outbound)"}
          </option>
        ))}
      </select>
    );
  }
  if (kind === "tag_change_kind") {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} className={selectClass}>
        <option value="">Select change…</option>
        {TAG_CHANGE_KIND_VALUES.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
    );
  }
  if (kind === "stage" && catalogs) {
    return (
      <CatalogSelect
        value={value}
        onChange={onChange}
        rows={catalogs.stages.map((s) => ({ id: s.id, label: s.name }))}
        placeholder="Select stage…"
      />
    );
  }
  if (kind === "tag" && catalogs) {
    return (
      <CatalogSelect
        value={value}
        onChange={onChange}
        rows={catalogs.tags.map((t) => ({ id: t.id, label: t.name }))}
        placeholder="Select tag…"
      />
    );
  }
  if (kind === "user" && catalogs) {
    return (
      <CatalogSelect
        value={value}
        onChange={onChange}
        rows={catalogs.users.map((u) => ({ id: u.id, label: u.name || u.email }))}
        placeholder="Select user…"
      />
    );
  }
  if (kind === "field_key" && catalogs) {
    return (
      <CatalogSelect
        value={value}
        onChange={onChange}
        rows={catalogs.fields.map((f) => ({ id: f.key, label: f.label }))}
        placeholder="Select field…"
      />
    );
  }
  // Fallback — also the path used when catalogs aren't wired (legacy
  // callers, tests). Renders the raw saved value so authors can still see
  // and fix it manually.
  return (
    <Input
      className="h-8 max-w-60 flex-1"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function CatalogSelect({
  value,
  onChange,
  rows,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  rows: Array<{ id: string; label: string }>;
  placeholder: string;
}) {
  const knownIds = new Set(rows.map((r) => r.id));
  const stale = value && !knownIds.has(value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={
        "h-8 max-w-60 flex-1 rounded-md border bg-background px-2 text-sm " +
        (stale ? "border-destructive" : "border-border")
      }
    >
      <option value="">{placeholder}</option>
      {stale && <option value={value}>{value.slice(0, 12)}… (missing)</option>}
      {rows.map((r) => (
        <option key={r.id} value={r.id}>
          {r.label}
        </option>
      ))}
    </select>
  );
}
