"use client";

import { useCallback, useRef } from "react";
import { Tag as TagIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ContactFieldDefinition } from "@ccp/shared/types";
import { FieldTokenPicker } from "@/features/templates/components/field-token-picker";
import { TokenHighlightTextarea } from "@/features/templates/components/token-highlight";

import { ConditionGroupEditor } from "./condition-group";
import { OpenWindowContactCombobox } from "./open-window-contact-combobox";
import { type BuilderCatalogs, type Trigger, type WorkflowGraph, toGroup } from "./types";

/**
 * Body editor wrapper: token-highlight textarea + insert-variable picker.
 *
 * Shared between send_message / add_comment / template-variable editors so
 * a single change to the picker styling propagates everywhere. The parent
 * owns the value (config.body or whatever); we just thread keystrokes back
 * out through onChange and splice token inserts at the live cursor.
 *
 * Tokens are stored verbatim in the saved config and resolved at run time
 * by `resolveFieldTokens` (see @ccp/shared/field-tokens). That's why the
 * server's step handler doesn't need to know about the picker.
 */
/**
 * Trigger → which workflow-context namespaces should the picker expose.
 * Centralised here so adding a new trigger doesn't require touching every
 * step editor — bump this lookup and every `BodyTokenEditor` reflects it.
 */
function workflowNamespacesForTrigger(trigger: Trigger): {
  includeMessage: boolean;
  includeConversation: boolean;
} {
  switch (trigger) {
    case "message_received":
      return { includeMessage: true, includeConversation: true };
    case "conversation_created":
    case "conversation_opened":
    case "conversation_closed":
    case "conversation_assigned":
    case "conversation_status_changed":
      return { includeMessage: false, includeConversation: true };
    case "manual_trigger":
      // Manual_trigger CAN carry a conversation but it's optional; expose
      // the tokens — they'll resolve to empty when fired without one, same
      // behavior as any optional snapshot.
      return { includeMessage: false, includeConversation: true };
    default:
      return { includeMessage: false, includeConversation: false };
  }
}

function BodyTokenEditor({
  value,
  onChange,
  fieldDefinitions,
  rows = 4,
  placeholder,
  includeAgent,
  hint,
  trigger,
}: {
  value: string;
  onChange: (next: string) => void;
  fieldDefinitions: ContactFieldDefinition[];
  rows?: number;
  placeholder?: string;
  includeAgent?: boolean;
  hint?: string;
  /** Workflow's trigger — drives which extra token namespaces are exposed. */
  trigger?: Trigger;
}) {
  const { includeMessage, includeConversation } = trigger
    ? workflowNamespacesForTrigger(trigger)
    : { includeMessage: false, includeConversation: false };
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const insert = useCallback(
    (token: string) => {
      const el = ref.current;
      if (!el) {
        onChange(value + token);
        return;
      }
      const start = el.selectionStart ?? value.length;
      const end = el.selectionEnd ?? value.length;
      const next = value.slice(0, start) + token + value.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + token.length;
        el.setSelectionRange(pos, pos);
      });
    },
    [value, onChange],
  );
  return (
    <>
      <div className="flex justify-end">
        <FieldTokenPicker
          fieldDefinitions={fieldDefinitions}
          onInsert={insert}
          label="Insert variable"
          includeAgent={includeAgent}
          includeMessage={includeMessage}
          includeConversation={includeConversation}
          hint={hint}
        />
      </div>
      <TokenHighlightTextarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        fieldDefinitions={fieldDefinitions}
        includeAgent={includeAgent}
        includeMessage={includeMessage}
        includeConversation={includeConversation}
      />
    </>
  );
}

/**
 * Adapter — BuilderCatalogs.fields has just key+label; the picker + highlight
 * components want full ContactFieldDefinition. The other fields are unused by
 * both consumers so a thin cast is safe and avoids a refactor of the catalog
 * loader.
 */
function asFieldDefs(
  fields: BuilderCatalogs["fields"],
): ContactFieldDefinition[] {
  return fields as unknown as ContactFieldDefinition[];
}

// Step target — which contact / phone does this step act on? -------------------

/**
 * Wire shape for the step's `target` config field. Mirrors the server-side
 * StepTarget type in apps/api/src/lib/workflows/steps/target.ts. Keeping the
 * type duplicated here (instead of importing from @ccp/shared) because the
 * server side parses the raw JSON anyway; the web type is just a UI hint.
 */
export type StepTarget =
  | { kind: "trigger_contact" }
  | { kind: "phone"; phoneNumber: string };

/**
 * Target selector — radio between "trigger contact" (default) and "custom
 * phone". When phone is picked, a single-line input collects the E.164
 * number. The server normalizes + validates on save, so a typo here
 * surfaces in the workflow's stepErrors block on save.
 *
 * `extraHint` is rendered below the phone input when set — used by
 * send_message to mention the 24h window caveat for cold reachout.
 */
function TargetSelector({
  target,
  onChange,
  extraHint,
}: {
  target: StepTarget | undefined;
  onChange: (next: StepTarget | undefined) => void;
  extraHint?: string;
}) {
  const mode = target?.kind ?? "trigger_contact";
  const phone = target?.kind === "phone" ? target.phoneNumber : "";
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Target
      </div>
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="radio"
          name="target-mode"
          checked={mode === "trigger_contact"}
          onChange={() => onChange(undefined)}
          className="size-3.5"
        />
        <span>Contact from the trigger</span>
        <span className="text-[10.5px] text-muted-foreground">(default)</span>
      </label>
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="radio"
          name="target-mode"
          checked={mode === "phone"}
          onChange={() =>
            onChange({ kind: "phone", phoneNumber: phone })
          }
          className="size-3.5"
        />
        <span>Custom phone number</span>
      </label>
      {mode === "phone" && (
        <div className="ml-6 flex flex-col gap-1">
          <OpenWindowContactCombobox
            value={phone ? { phoneNumber: phone } : null}
            onChange={(next) =>
              onChange(
                next
                  ? { kind: "phone", phoneNumber: next.phoneNumber }
                  : { kind: "phone", phoneNumber: "" },
              )
            }
          />
          <span className="text-[10.5px] text-muted-foreground">
            Pick from contacts who messaged you in the last 24h. Cold reachout
            (outside the window) requires a Send Template step.
          </span>
          {extraHint && (
            <span className="text-[10.5px] text-amber-600 dark:text-amber-400">
              {extraHint}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Single-line variable input + an inline "Insert variable" button. Used for
 * Send Template variables where each `{{n}}` placeholder is a separate slot.
 * Splices the picked token at the input's caret position (same pattern as
 * the multiline body editor above).
 */
function TemplateVariableRow({
  idx,
  value,
  onChange,
  fieldDefinitions,
  trigger,
}: {
  idx: number;
  value: string;
  onChange: (next: string) => void;
  fieldDefinitions: ContactFieldDefinition[];
  trigger?: Trigger;
}) {
  const { includeMessage, includeConversation } = trigger
    ? workflowNamespacesForTrigger(trigger)
    : { includeMessage: false, includeConversation: false };
  const ref = useRef<HTMLInputElement | null>(null);
  const insert = useCallback(
    (token: string) => {
      const el = ref.current;
      if (!el) {
        onChange(value + token);
        return;
      }
      const start = el.selectionStart ?? value.length;
      const end = el.selectionEnd ?? value.length;
      const next = value.slice(0, start) + token + value.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + token.length;
        el.setSelectionRange(pos, pos);
      });
    },
    [value, onChange],
  );
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">{`{{${idx + 1}}}`}</span>
      <Input ref={ref} value={value} onChange={(e) => onChange(e.target.value)} />
      <FieldTokenPicker
        fieldDefinitions={fieldDefinitions}
        onInsert={insert}
        label="Variable"
        includeMessage={includeMessage}
        includeConversation={includeConversation}
      />
    </div>
  );
}

/**
 * Per-step editors. Each editor takes the (typed) config + onChange + the
 * subset of catalogs it needs. Kept in one file because most are small
 * (10-50 lines) and the import noise of one-file-per-editor was outweighing
 * its readability.
 */

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium">{label}</label>
      {children}
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

// send_message --------------------------------------------------------------

export function SendMessageEditor({
  config,
  onChange,
  fields,
  trigger,
}: {
  config: { body?: string; target?: StepTarget };
  onChange: (c: Record<string, unknown>) => void;
  fields: BuilderCatalogs["fields"];
  trigger: Trigger;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Message"
        hint="Tokens like $var.contact.name resolve per contact. Outside the 24h window this step fails — use Send Template instead."
      >
        <BodyTokenEditor
          value={config.body ?? ""}
          onChange={(body) => onChange({ ...config, body })}
          fieldDefinitions={asFieldDefs(fields)}
          rows={4}
          placeholder="Hi $var.contact.name, thanks for reaching out!"
          hint="Contact tokens resolve against the selected target."
          trigger={trigger}
        />
      </Field>
      <TargetSelector
        target={config.target}
        onChange={(target) => onChange({ ...config, target })}
        extraHint="Free-form sends require the contact to have messaged you in the last 24h. For cold reachout, use a Send Template step."
      />
    </div>
  );
}

// send_template -------------------------------------------------------------

function countPlaceholders(text: string): number {
  const found = new Set<number>();
  const re = /\{\{\s*(\d+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) found.add(Number.parseInt(m[1]!, 10));
  return found.size;
}

export function SendTemplateEditor({
  config,
  onChange,
  templates,
  fields,
  trigger,
}: {
  config: { templateId?: string; variables?: { body?: string[]; header?: string } };
  onChange: (c: Record<string, unknown>) => void;
  templates: BuilderCatalogs["templates"];
  fields: BuilderCatalogs["fields"];
  trigger: Trigger;
}) {
  const approved = templates.filter((t) => t.status === "approved");
  const selected = templates.find((t) => t.id === config.templateId);
  const bodyVarCount = selected ? countPlaceholders(selected.bodyText) : 0;
  const bodyVars = config.variables?.body ?? [];

  function pickTemplate(id: string) {
    const t = templates.find((x) => x.id === id);
    if (!t) {
      onChange({ templateId: id, variables: { body: [] } });
      return;
    }
    const count = countPlaceholders(t.bodyText);
    const next = Array.from({ length: count }, (_, i) => bodyVars[i] ?? "");
    onChange({ templateId: id, variables: { body: next } });
  }

  function setVar(idx: number, val: string) {
    const next = bodyVars.slice();
    while (next.length <= idx) next.push("");
    next[idx] = val;
    onChange({ ...config, variables: { ...config.variables, body: next } });
  }

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Template"
        hint={
          approved.length === 0
            ? "No approved templates yet — submit one in Templates → New first."
            : "Only approved templates can be sent."
        }
      >
        <select
          value={config.templateId ?? ""}
          onChange={(e) => pickTemplate(e.target.value)}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="">Select a template…</option>
          {approved.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.language})
            </option>
          ))}
        </select>
      </Field>
      {selected && (
        <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Preview</div>
          <pre className="mt-1 whitespace-pre-wrap font-sans text-sm">{selected.bodyText}</pre>
        </div>
      )}
      {bodyVarCount > 0 && (
        <Field label={`Variables (${bodyVarCount})`} hint="Plain text or $var.contact.* tokens resolved per run.">
          <div className="flex flex-col gap-2">
            {Array.from({ length: bodyVarCount }).map((_, i) => (
              <TemplateVariableRow
                key={i}
                idx={i}
                value={bodyVars[i] ?? ""}
                onChange={(v) => setVar(i, v)}
                fieldDefinitions={asFieldDefs(fields)}
                trigger={trigger}
              />
            ))}
          </div>
        </Field>
      )}
    </div>
  );
}

// add_comment --------------------------------------------------------------

export function AddCommentEditor({
  config,
  onChange,
  fields,
  trigger,
}: {
  config: { body?: string };
  onChange: (c: Record<string, unknown>) => void;
  fields: BuilderCatalogs["fields"];
  trigger: Trigger;
}) {
  return (
    <Field
      label="Note"
      hint="Internal — never sent to the contact. Tokens like $var.contact.name resolve per run."
    >
      <BodyTokenEditor
        value={config.body ?? ""}
        onChange={(body) => onChange({ body })}
        fieldDefinitions={asFieldDefs(fields)}
        rows={3}
        placeholder="Customer asking for $var.contact.email — needs invoice"
        trigger={trigger}
      />
    </Field>
  );
}

// assign_to ----------------------------------------------------------------

export function AssignToEditor({
  config,
  onChange,
  users,
}: {
  config: { mode?: "user" | "unassign"; userId?: string };
  onChange: (c: Record<string, unknown>) => void;
  users: BuilderCatalogs["users"];
}) {
  return (
    <Field label="Mode">
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="assign-mode"
            checked={config.mode === "user"}
            onChange={() => onChange({ mode: "user", userId: config.userId ?? users[0]?.id ?? "" })}
          />
          Assign to a teammate
        </label>
        {config.mode === "user" && (
          <select
            value={config.userId ?? ""}
            onChange={(e) => onChange({ mode: "user", userId: e.target.value })}
            className="ml-6 h-8 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">Select a user…</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="assign-mode"
            checked={config.mode === "unassign"}
            onChange={() => onChange({ mode: "unassign" })}
          />
          Unassign
        </label>
      </div>
    </Field>
  );
}

// set_status / open_conversation / close_conversation ----------------------

export function SetStatusEditor({
  config,
  onChange,
}: {
  config: { status?: "open" | "pending" | "closed" };
  onChange: (c: Record<string, unknown>) => void;
}) {
  return (
    <Field label="Target status">
      <select
        value={config.status ?? "open"}
        onChange={(e) => onChange({ status: e.target.value })}
        className="h-9 rounded-md border border-border bg-background px-2 text-sm"
      >
        <option value="open">Open</option>
        <option value="pending">Pending</option>
        <option value="closed">Closed</option>
      </select>
    </Field>
  );
}

export function OpenConversationEditor() {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      Opens the conversation. No further configuration.
    </div>
  );
}

export function CloseConversationEditor({
  config,
  onChange,
}: {
  config: { category?: string; summary?: string };
  onChange: (c: Record<string, unknown>) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="Category" hint="Optional. Shown in the inbox close-history.">
        <Input
          value={config.category ?? ""}
          onChange={(e) => onChange({ ...config, category: e.target.value })}
          placeholder="resolved / abandoned / spam"
        />
      </Field>
      <Field label="Summary" hint="Optional. Free-form note about what happened.">
        <Textarea
          value={config.summary ?? ""}
          onChange={(e) => onChange({ ...config, summary: e.target.value })}
          rows={3}
        />
      </Field>
    </div>
  );
}

// add_tag / remove_tag ------------------------------------------------------

export function TagEditor({
  config,
  onChange,
  tags,
  verb,
}: {
  config: { tagId?: string; target?: StepTarget };
  onChange: (c: Record<string, unknown>) => void;
  tags: BuilderCatalogs["tags"];
  verb: "Add" | "Remove";
}) {
  const selected = tags.find((t) => t.id === config.tagId);
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Tag"
        hint={tags.length === 0 ? "No tags yet — create them in Settings → Tags." : `${verb} this tag from the contact.`}
      >
        <div className="flex flex-col gap-2">
          <select
            value={config.tagId ?? ""}
            onChange={(e) => onChange({ ...config, tagId: e.target.value })}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">Select a tag…</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {selected && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <TagIcon className="size-3.5" />
              <span className="inline-flex items-center rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
                {selected.name}
              </span>
            </div>
          )}
        </div>
      </Field>
      <TargetSelector
        target={config.target}
        onChange={(target) => onChange({ ...config, target })}
      />
    </div>
  );
}

// update_field --------------------------------------------------------------

export function UpdateFieldEditor({
  config,
  onChange,
  fields,
}: {
  config: { fieldKey?: string; value?: string; target?: StepTarget };
  onChange: (c: Record<string, unknown>) => void;
  fields: BuilderCatalogs["fields"];
}) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="Field" hint="The contact's custom fields. Add new ones in Settings → Contact Fields.">
        <select
          value={config.fieldKey ?? ""}
          onChange={(e) => onChange({ ...config, fieldKey: e.target.value })}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="">Select a field…</option>
          {fields.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label} ({f.key})
            </option>
          ))}
        </select>
      </Field>
      <Field label="Value" hint="Tokens like $var.contact.email resolve per run.">
        <Input
          value={config.value ?? ""}
          onChange={(e) => onChange({ ...config, value: e.target.value })}
        />
      </Field>
      <TargetSelector
        target={config.target}
        onChange={(target) => onChange({ ...config, target })}
      />
    </div>
  );
}

// update_lifecycle ----------------------------------------------------------

export function UpdateLifecycleEditor({
  config,
  onChange,
  stages,
}: {
  config: { stageId?: string; target?: StepTarget };
  onChange: (c: Record<string, unknown>) => void;
  stages: BuilderCatalogs["stages"];
}) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="Stage">
        <select
          value={config.stageId ?? ""}
          onChange={(e) => onChange({ ...config, stageId: e.target.value })}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="">Select a stage…</option>
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      <TargetSelector
        target={config.target}
        onChange={(target) => onChange({ ...config, target })}
      />
    </div>
  );
}

// branch --------------------------------------------------------------------

/**
 * Wire shape for the Branch step's `preset` config field. Mirrors the
 * server-side BranchPreset type in apps/api/src/lib/workflows/branch-presets.ts.
 * Duplicated here (not imported) for the same reason as StepTarget — the
 * server parses the raw JSON anyway and we don't drag server-only modules
 * into the client bundle.
 */
export type BranchPreset =
  | { type: "window_open" }
  | { type: "has_tag"; tagId: string }
  | { type: "in_stage"; stageId: string }
  | { type: "field_equals"; fieldKey: string; value: string }
  | { type: "message_contains"; needle: string; caseSensitive?: boolean };

const BRANCH_PRESET_OPTIONS: Array<{
  type: BranchPreset["type"];
  label: string;
  description: string;
}> = [
  { type: "window_open", label: "Is 24h window open?", description: "true → contact messaged in the last 24h. Wire true to Send Message, false to Send Template." },
  { type: "has_tag", label: "Contact has tag", description: "true → contact carries the selected tag." },
  { type: "in_stage", label: "Contact in stage", description: "true → contact is in the selected lifecycle stage." },
  { type: "field_equals", label: "Custom field equals", description: "true → the contact's custom field matches the value." },
  { type: "message_contains", label: "Message contains text", description: "true → the triggering message body contains the substring (only for message_received)." },
];

export function BranchEditor({
  config,
  trigger,
  onChange,
  catalogs,
}: {
  config: { preset?: BranchPreset; conditions?: unknown };
  /** Workflow's trigger — scopes which condition fields are offered.
   *  Earlier this editor always set allowAllFields, which exposed fields
   *  like stage_from / stage_to ("Previous stage" / "New stage") that are
   *  only populated by the contact_lifecycle_updated trigger. On a
   *  message_received workflow those conditions silently never matched —
   *  users picked them and wondered why nothing fired. Scoping to the
   *  trigger removes the confusion (contact_stage_id stays available for
   *  every trigger because the runner reads it off the live contact row). */
  trigger: Trigger;
  onChange: (c: Record<string, unknown>) => void;
  catalogs: BuilderCatalogs;
}) {
  const mode: "preset" | "custom" = config.preset ? "preset" : "custom";
  const preset = config.preset;

  function switchToPreset() {
    // Default to window_open — most-asked check.
    onChange({ ...config, preset: { type: "window_open" } });
  }
  function switchToCustom() {
    const next = { ...config };
    delete next.preset;
    onChange(next);
  }
  function setPreset(p: BranchPreset) {
    onChange({ ...config, preset: p });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-muted-foreground">
        Step routes to the <strong>true</strong> branch when the check passes,
        otherwise to <strong>false</strong>. Connect both edges in the canvas.
      </div>
      <div className="inline-flex w-fit items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5 text-xs">
        <button
          type="button"
          onClick={switchToPreset}
          className={
            mode === "preset"
              ? "rounded px-2.5 py-1 font-medium bg-background text-foreground shadow-sm"
              : "rounded px-2.5 py-1 text-muted-foreground hover:text-foreground"
          }
        >
          Preset
        </button>
        <button
          type="button"
          onClick={switchToCustom}
          className={
            mode === "custom"
              ? "rounded px-2.5 py-1 font-medium bg-background text-foreground shadow-sm"
              : "rounded px-2.5 py-1 text-muted-foreground hover:text-foreground"
          }
        >
          Custom expression
        </button>
      </div>
      {mode === "preset" && preset && (
        <BranchPresetEditor
          preset={preset}
          onChange={setPreset}
          catalogs={catalogs}
          trigger={trigger}
        />
      )}
      {mode === "custom" && (
        <ConditionGroupEditor
          trigger={trigger}
          group={toGroup(config.conditions)}
          onChange={(g) => onChange({ ...config, conditions: g })}
          catalogs={catalogs}
        />
      )}
    </div>
  );
}

function BranchPresetEditor({
  preset,
  onChange,
  catalogs,
  trigger,
}: {
  preset: BranchPreset;
  onChange: (p: BranchPreset) => void;
  catalogs: BuilderCatalogs;
  trigger: Trigger;
}) {
  const meta = BRANCH_PRESET_OPTIONS.find((o) => o.type === preset.type);
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-3">
      <Field label="Check">
        <select
          value={preset.type}
          onChange={(e) => {
            const type = e.target.value as BranchPreset["type"];
            // Reset secondary fields when switching type so the saved config
            // never carries stale fields from another preset shape.
            onChange(emptyPreset(type));
          }}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        >
          {BRANCH_PRESET_OPTIONS.map((o) => (
            <option key={o.type} value={o.type}>
              {o.label}
            </option>
          ))}
        </select>
        {meta && (
          <div className="text-xs text-muted-foreground">{meta.description}</div>
        )}
      </Field>
      {preset.type === "has_tag" && (
        <Field label="Tag">
          <select
            value={preset.tagId}
            onChange={(e) => onChange({ type: "has_tag", tagId: e.target.value })}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">Select a tag…</option>
            {catalogs.tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {preset.type === "in_stage" && (
        <Field label="Stage">
          <select
            value={preset.stageId}
            onChange={(e) => onChange({ type: "in_stage", stageId: e.target.value })}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">Select a stage…</option>
            {catalogs.stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {preset.type === "field_equals" && (
        <>
          <Field label="Custom field">
            <select
              value={preset.fieldKey}
              onChange={(e) => onChange({ ...preset, fieldKey: e.target.value })}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            >
              <option value="">Select a field…</option>
              {catalogs.fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Equals">
            <Input
              value={preset.value}
              onChange={(e) => onChange({ ...preset, value: e.target.value })}
              placeholder="VIP"
            />
          </Field>
        </>
      )}
      {preset.type === "message_contains" && (
        <>
          <Field
            label="Substring"
            hint={
              trigger === "message_received"
                ? undefined
                : "This trigger doesn't carry a message body — the check will always be false."
            }
          >
            <Input
              value={preset.needle}
              onChange={(e) => onChange({ ...preset, needle: e.target.value })}
              placeholder="refund"
            />
          </Field>
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={preset.caseSensitive ?? false}
              onChange={(e) =>
                onChange({
                  ...preset,
                  ...(e.target.checked ? { caseSensitive: true } : { caseSensitive: undefined }),
                })
              }
              className="size-3.5"
            />
            <span>Case sensitive</span>
          </label>
        </>
      )}
    </div>
  );
}

function emptyPreset(type: BranchPreset["type"]): BranchPreset {
  switch (type) {
    case "window_open":
      return { type: "window_open" };
    case "has_tag":
      return { type: "has_tag", tagId: "" };
    case "in_stage":
      return { type: "in_stage", stageId: "" };
    case "field_equals":
      return { type: "field_equals", fieldKey: "", value: "" };
    case "message_contains":
      return { type: "message_contains", needle: "" };
  }
}

// wait ----------------------------------------------------------------------

export function WaitEditor({
  config,
  onChange,
}: {
  config: { delayMs?: number };
  onChange: (c: Record<string, unknown>) => void;
}) {
  const ms = config.delayMs ?? 60_000;
  // Pick a sensible default unit based on size of the current value.
  const initialUnit: "s" | "m" | "h" | "d" =
    ms >= 86_400_000 ? "d" : ms >= 3_600_000 ? "h" : ms >= 60_000 ? "m" : "s";

  const multipliers: Record<typeof initialUnit, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };

  const value = Math.round(ms / multipliers[initialUnit]);

  return (
    <Field label="Duration" hint="The run pauses here. Resume is scheduled via BullMQ.">
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={1}
          value={value}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n > 0) {
              onChange({ delayMs: n * multipliers[initialUnit] });
            }
          }}
          className="max-w-[120px]"
        />
        <select
          value={initialUnit}
          onChange={(e) => {
            const unit = e.target.value as typeof initialUnit;
            onChange({ delayMs: value * multipliers[unit] });
          }}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="s">seconds</option>
          <option value="m">minutes</option>
          <option value="h">hours</option>
          <option value="d">days</option>
        </select>
      </div>
    </Field>
  );
}

// jump_to_step --------------------------------------------------------------

export function JumpToStepEditor({
  config,
  onChange,
  graph,
  selfId,
}: {
  config: { targetStepId?: string; maxJumps?: number };
  onChange: (c: Record<string, unknown>) => void;
  graph: WorkflowGraph;
  selfId: string;
}) {
  const otherNodes = graph.nodes.filter((n) => n.id !== selfId);
  return (
    <div className="flex flex-col gap-4">
      <Field label="Target step">
        <select
          value={config.targetStepId ?? ""}
          onChange={(e) => onChange({ ...config, targetStepId: e.target.value })}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="">Select a step…</option>
          {otherNodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.id} ({n.type})
            </option>
          ))}
        </select>
      </Field>
      <Field label="Max jumps (optional)" hint="Per-run cap. The global ceiling is 100 steps regardless.">
        <Input
          type="number"
          min={1}
          value={config.maxJumps ?? ""}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            onChange({
              ...config,
              maxJumps: Number.isFinite(n) && n > 0 ? n : undefined,
            });
          }}
          className="max-w-[120px]"
        />
      </Field>
    </div>
  );
}

// ask_question -------------------------------------------------------------

export function AskQuestionEditor({
  config,
  onChange,
  fields,
  trigger,
}: {
  config: { question?: string; timeoutHours?: number };
  onChange: (c: Record<string, unknown>) => void;
  fields: BuilderCatalogs["fields"];
  trigger: Trigger;
}) {
  const hours = config.timeoutHours ?? 24;
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Question"
        hint="Sent to the trigger contact via WhatsApp. $var tokens resolve. The run pauses until they reply or the timeout expires."
      >
        <BodyTokenEditor
          value={config.question ?? ""}
          onChange={(question) => onChange({ ...config, question })}
          fieldDefinitions={asFieldDefs(fields)}
          rows={3}
          placeholder="Want to schedule a callback? Reply YES or NO."
          trigger={trigger}
        />
      </Field>
      <Field label="Timeout (hours)" hint="If no reply within this window the workflow takes the 'timeout' edge.">
        <Input
          type="number"
          min={1}
          max={24 * 7}
          value={hours}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n > 0) {
              onChange({ ...config, timeoutHours: n });
            }
          }}
          className="max-w-[140px]"
        />
      </Field>
      <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
        Downstream steps can read the answer via{" "}
        <code className="rounded bg-muted px-1 font-mono">$var.previousStep.answer</code>.
        Pair with a Branch step (preset: message contains) to route on
        specific replies.
      </div>
    </div>
  );
}

// noop ---------------------------------------------------------------------

export function NoopEditor() {
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-4 text-xs text-muted-foreground">
      This step does nothing. Useful as an explicit terminator for a branch
      path (e.g. <span className="font-mono">false</span> → Do Nothing) so the
      canvas doesn&apos;t read like an unfinished workflow.
    </div>
  );
}

// http_request --------------------------------------------------------------

export function HttpRequestEditor({
  config,
  onChange,
}: {
  config: {
    url?: string;
    bearerToken?: string;
    bearerTokenSet?: boolean;
    customHeaders?: Record<string, string>;
    timeoutMs?: number;
  };
  onChange: (c: Record<string, unknown>) => void;
}) {
  const tokenSet = config.bearerTokenSet === true;

  function headersToText(h?: Record<string, string>): string {
    if (!h) return "";
    return Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\n");
  }

  function parseHeaders(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(":");
      if (idx === -1) continue;
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim();
      if (k) out[k] = v;
    }
    return out;
  }

  return (
    <div className="flex flex-col gap-4">
      <Field label="URL" hint="HTTPS preferred. $var.contact.* tokens resolve per run.">
        <Input
          value={config.url ?? ""}
          onChange={(e) => onChange({ ...config, url: e.target.value })}
          placeholder="https://api.example.com/webhook"
          required
        />
      </Field>
      <Field
        label="Bearer token (optional)"
        hint={tokenSet ? "Token saved. Leave blank to keep, or enter a new value to overwrite." : ""}
      >
        <Input
          type="password"
          value={config.bearerToken ?? ""}
          onChange={(e) => onChange({ ...config, bearerToken: e.target.value })}
          placeholder={tokenSet ? "•••••••• (saved)" : ""}
        />
      </Field>
      <Field label="Custom headers (optional)" hint="One per line: Header-Name: value">
        <Textarea
          value={headersToText(config.customHeaders)}
          onChange={(e) => {
            const parsed = parseHeaders(e.target.value);
            onChange({
              ...config,
              customHeaders: Object.keys(parsed).length > 0 ? parsed : undefined,
            });
          }}
          rows={3}
        />
      </Field>
      <Field label="Timeout (ms, optional, max 60000)">
        <Input
          type="number"
          value={config.timeoutMs?.toString() ?? ""}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            onChange({
              ...config,
              timeoutMs: Number.isFinite(n) && n > 0 ? n : undefined,
            });
          }}
          placeholder="8000"
          min={1}
          max={60_000}
        />
      </Field>
    </div>
  );
}

// trigger_workflow ----------------------------------------------------------

export function TriggerWorkflowEditor({
  config,
  onChange,
  workflows,
}: {
  config: { workflowId?: string };
  onChange: (c: Record<string, unknown>) => void;
  workflows: BuilderCatalogs["workflows"];
}) {
  const eligible = workflows.filter((w) => w.trigger === "manual_trigger");
  return (
    <Field
      label="Workflow"
      hint={
        eligible.length === 0
          ? "No manual_trigger workflows yet — create one first."
          : "Only workflows with trigger = manual_trigger can be invoked from another workflow."
      }
    >
      <select
        value={config.workflowId ?? ""}
        onChange={(e) => onChange({ workflowId: e.target.value })}
        className="h-9 rounded-md border border-border bg-background px-2 text-sm"
      >
        <option value="">Select a workflow…</option>
        {eligible.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
    </Field>
  );
}
