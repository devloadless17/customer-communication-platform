"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ContactFieldDefinition } from "@ccp/shared/types";
import type { TemplateComponent } from "@ccp/shared/providers/types";
import type {
  ContactFieldKey,
  VariableBinding,
  VariableBindings,
  VariableSource,
} from "@ccp/shared/template-bindings";
import { cn } from "@ccp/shared/utils";

/**
 * Per-variable editor. For every `{{n}}` in the template body (and the header
 * if it's text with a placeholder), the agent picks one of:
 *
 *   - Manual:       agent fills the value at broadcast time (legacy default).
 *   - Contact:      pulled per recipient from a built-in contact field
 *                   (name / phone / email / location).
 *   - Custom field: pulled per recipient from `Contact.customFields[key]`
 *                   for one of the team-defined ContactFieldDefinitions.
 *
 * A short label and optional default value are stored alongside. The default
 * kicks in only when the binding resolves to an empty string for a recipient.
 *
 * Two modes:
 *   - With `templateId` set, "Save" PATCHes the row directly. Used inside
 *     the templates list drawer.
 *   - Without `templateId` (create wizard), the parent owns persistence and
 *     reads the live state via `onChange`. We still keep the same UI shape
 *     so the agent's mental model doesn't change between create and edit.
 */

const CONTACT_FIELDS: Array<{ key: ContactFieldKey; label: string }> = [
  { key: "name", label: "Contact name" },
  { key: "phoneNumber", label: "Phone number" },
  { key: "email", label: "Email" },
  { key: "location", label: "Location" },
];

export function VariableBindingsEditor({
  templateId,
  components,
  initialBindings,
  fieldDefinitions,
  onSaved,
  onChange,
}: {
  /** Set in the drawer (drives PATCH on save). Omitted in the create wizard. */
  templateId?: string;
  components: TemplateComponent[];
  initialBindings: VariableBindings;
  fieldDefinitions: ContactFieldDefinition[];
  /** Drawer mode — fires after a successful PATCH. */
  onSaved?: (bindings: VariableBindings) => void;
  /** Create-wizard mode — fires on every keystroke for live preview. */
  onChange?: (bindings: VariableBindings) => void;
}) {
  const body = components.find((c) => c.type === "BODY");
  const header = components.find((c) => c.type === "HEADER");

  const bodyVarCount = body?.text ? countPlaceholders(body.text) : 0;
  const headerHasVar = header?.format === "TEXT" && header.text
    ? countPlaceholders(header.text) > 0
    : false;

  const [bindings, setBindings] = useState<VariableBindings>(() =>
    normalize(initialBindings, bodyVarCount, headerHasVar),
  );
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Resync if the underlying template changes (e.g. drawer opens a different one).
  useEffect(() => {
    setBindings(normalize(initialBindings, bodyVarCount, headerHasVar));
    setSavedAt(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, bodyVarCount, headerHasVar]);

  // Live propagation for the create wizard.
  useEffect(() => {
    onChange?.(bindings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindings]);

  const setBody = useCallback((i: number, next: VariableBinding) => {
    setBindings((cur) => {
      const copy = cur.body.slice();
      copy[i] = next;
      return { ...cur, body: copy };
    });
    setSavedAt(null);
  }, []);

  const setHeader = useCallback((next: VariableBinding) => {
    setBindings((cur) => ({ ...cur, header: next }));
    setSavedAt(null);
  }, []);

  const save = useCallback(async () => {
    if (!templateId) return;
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/team/whatsapp/templates/${templateId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ variableBindings: bindings }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string; detail?: string }
          | null;
        throw new Error(
          [data?.error, data?.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
        );
      }
      setSavedAt(Date.now());
      onSaved?.(bindings);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [bindings, templateId, onSaved]);

  if (bodyVarCount === 0 && !headerHasVar) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-3 text-[12px] text-muted-foreground">
        This template has no <code className="rounded bg-muted px-1 text-[11px]">{"{{n}}"}</code> variables.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {headerHasVar && bindings.header && (
        <BindingRow
          slot="Header {{1}}"
          binding={bindings.header}
          onChange={setHeader}
          fieldDefinitions={fieldDefinitions}
        />
      )}
      {bindings.body.map((b, i) => (
        <BindingRow
          key={i}
          slot={`Body {{${i + 1}}}`}
          binding={b}
          onChange={(next) => setBody(i, next)}
          fieldDefinitions={fieldDefinitions}
        />
      ))}

      {templateId && (
        <div className="flex items-center justify-end gap-2">
          {error && (
            <span className="mr-auto text-[11px] text-destructive">{error}</span>
          )}
          {savedAt !== null && !saving && !error && (
            <span className="mr-auto inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400">
              <Check className="size-3" />
              Saved
            </span>
          )}
          <Button
            type="button"
            size="sm"
            onClick={save}
            disabled={saving}
            className="gap-1.5"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            Save bindings
          </Button>
        </div>
      )}
    </div>
  );
}

function BindingRow({
  slot,
  binding,
  onChange,
  fieldDefinitions,
}: {
  slot: string;
  binding: VariableBinding;
  onChange: (next: VariableBinding) => void;
  fieldDefinitions: ContactFieldDefinition[];
}) {
  const onLabelChange = (label: string) => onChange({ ...binding, label });
  const onDefaultChange = (defaultValue: string) =>
    onChange({ ...binding, defaultValue: defaultValue.length > 0 ? defaultValue : undefined });

  const onSourceChange = (source: VariableSource) => onChange({ ...binding, source });

  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] font-medium text-primary">{slot}</span>
        <Input
          value={binding.label}
          onChange={(e) => onLabelChange(e.target.value)}
          placeholder="label (e.g. first_name)"
          className="h-7 max-w-[180px] text-[12px]"
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        <SourcePill
          active={binding.source.kind === "manual"}
          onClick={() => onSourceChange({ kind: "manual" })}
        >
          Manual
        </SourcePill>
        {CONTACT_FIELDS.map((f) => (
          <SourcePill
            key={f.key}
            active={
              binding.source.kind === "contact_field" && binding.source.field === f.key
            }
            onClick={() => onSourceChange({ kind: "contact_field", field: f.key })}
          >
            {f.label}
          </SourcePill>
        ))}
        {fieldDefinitions.map((def) => (
          <SourcePill
            key={def.id}
            active={
              binding.source.kind === "contact_custom_field" && binding.source.key === def.key
            }
            onClick={() => onSourceChange({ kind: "contact_custom_field", key: def.key })}
          >
            {def.label}
          </SourcePill>
        ))}
      </div>

      {binding.source.kind !== "manual" && (
        <label className="mt-2 flex items-center gap-2 text-[11px]">
          <span className="shrink-0 text-muted-foreground">Default if empty:</span>
          <Input
            value={binding.defaultValue ?? ""}
            onChange={(e) => onDefaultChange(e.target.value)}
            placeholder="(optional)"
            className="h-7 text-[12px]"
          />
        </label>
      )}
    </div>
  );
}

function SourcePill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function normalize(
  src: VariableBindings,
  bodyVarCount: number,
  headerHasVar: boolean,
): VariableBindings {
  const body: VariableBinding[] = Array.from({ length: bodyVarCount }, (_, i) => {
    const existing = src.body[i];
    return existing ?? { label: "", source: { kind: "manual" } };
  });
  const header = headerHasVar
    ? src.header ?? { label: "", source: { kind: "manual" } }
    : undefined;
  return header ? { body, header } : { body };
}

function countPlaceholders(text: string): number {
  let max = 0;
  const re = /\{\{(\d+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}
