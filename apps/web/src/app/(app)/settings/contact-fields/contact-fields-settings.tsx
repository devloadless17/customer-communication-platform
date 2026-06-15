"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Plus,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/layouts/page-header";
import { apiFetch } from "@/lib/api/client-fetch";
import { isReservedFieldKey } from "@ccp/shared/contacts/reserved-fields";
import type {
  ContactFieldDefinition,
  ContactPanelBuiltins,
} from "@ccp/shared/types";

/**
 * Team-wide contact custom-field manager. Mirrors the Stages settings pattern:
 * inline add, click-to-rename, up/down reorder, delete-with-confirm. Deleting
 * here strips the key from EVERY contact's customFields JSON in the same
 * transaction server-side — that's the irreversible piece the confirm dialog
 * has to convey.
 */
export function ContactFieldsSettings({
  initialDefinitions,
  initialBuiltins,
}: {
  initialDefinitions: ContactFieldDefinition[];
  initialBuiltins: ContactPanelBuiltins;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const [defs, setDefs] = useState<ContactFieldDefinition[]>(initialDefinitions);
  const [builtins, setBuiltins] = useState<ContactPanelBuiltins>(initialBuiltins);
  // Adopt SSR-re-run results so teammate edits propagate without a manual
  // refresh (router.refresh from useCatalogSync fires on team:catalog:changed
  // with scope=contact-fields).
  useEffect(() => {
    setDefs(initialDefinitions);
  }, [initialDefinitions]);
  useEffect(() => {
    setBuiltins(initialBuiltins);
  }, [initialBuiltins]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const newInputRef = useRef<HTMLInputElement>(null);
  const newFieldErrorId = useId();

  const sorted = useMemo(() => [...defs].sort(byOrder), [defs]);

  const openCreate = useCallback(() => {
    setCreating(true);
    setNewLabel("");
    setError(null);
    requestAnimationFrame(() => newInputRef.current?.focus());
  }, []);

  const createField = useCallback(async () => {
    const label = newLabel.trim();
    if (!label) {
      setError("Field needs a name.");
      return;
    }
    setBusyId("__new__");
    setError(null);
    try {
      const res = await apiFetch("/api/team/contact-fields", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        definition?: ContactFieldDefinition;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !body.definition) {
        setError(body.detail || body.error || `Couldn't create (HTTP ${res.status})`);
        return;
      }
      setDefs((cur) => [...cur, body.definition!].sort(byOrder));
      setCreating(false);
      setNewLabel("");
    } finally {
      setBusyId(null);
    }
  }, [newLabel]);

  const toggleBuiltin = useCallback(
    async (key: keyof ContactPanelBuiltins) => {
      const prev = builtins;
      const next = { ...builtins, [key]: !builtins[key] };
      setBuiltins(next);
      setError(null);
      try {
        const res = await apiFetch("/api/team/contact-fields/builtins", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ [key]: next[key] }),
        });
        if (!res.ok) {
          setBuiltins(prev);
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          setError(body.detail || body.error || `Update failed (HTTP ${res.status})`);
        }
      } catch {
        setBuiltins(prev);
        setError("Network error");
      }
    },
    [builtins],
  );

  // Visibility is a pure optimistic toggle — mirrors `toggleBuiltin` above, NOT
  // `patchField`. patchField's setBusyId disables + dims the row for the whole
  // PATCH round-trip, which made the eye icon flip then grey out for ~100-300ms
  // (read as lag). Here the icon flips instantly and stays interactive; the
  // value rolls back only if the server rejects. router.refresh() from
  // useCatalogSync still re-syncs the canonical state afterward.
  const toggleVisibility = useCallback(
    async (field: ContactFieldDefinition) => {
      const next = !field.isVisible;
      const prev = defs;
      setError(null);
      setDefs((cur) =>
        cur.map((f) => (f.id === field.id ? { ...f, isVisible: next } : f)),
      );
      try {
        const res = await apiFetch(`/api/team/contact-fields/${field.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ isVisible: next }),
        });
        if (!res.ok) {
          setDefs(prev);
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          setError(body.detail || body.error || `Update failed (HTTP ${res.status})`);
        }
      } catch {
        setDefs(prev);
        setError("Network error");
      }
    },
    [defs],
  );

  const patchField = useCallback(
    async (
      id: string,
      patch: Partial<Pick<ContactFieldDefinition, "label" | "order" | "isVisible">>,
    ) => {
      setBusyId(id);
      setError(null);
      const prev = defs;
      setDefs((cur) => cur.map((f) => (f.id === id ? { ...f, ...patch } : f)));
      try {
        const res = await apiFetch(`/api/team/contact-fields/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          setDefs(prev);
          setError(body.detail || body.error || `Update failed (HTTP ${res.status})`);
        }
      } catch {
        setDefs(prev);
        setError("Network error");
      } finally {
        setBusyId(null);
      }
    },
    [defs],
  );

  const reorder = useCallback(
    async (id: string, direction: "up" | "down") => {
      const list = [...defs].sort(byOrder);
      const idx = list.findIndex((f) => f.id === id);
      const swapIdx = direction === "up" ? idx - 1 : idx + 1;
      if (idx < 0 || swapIdx < 0 || swapIdx >= list.length) return;
      const a = list[idx]!;
      const b = list[swapIdx]!;
      // No bulk reorder endpoint — swap the two affected `order` values with
      // two PATCHes. With the field cap at 50 per team and reorder being
      // human-paced, the cost is fine; if it ever isn't, add /reorder
      // mirroring the stages route.
      const prev = defs;
      setDefs((cur) =>
        cur.map((f) => {
          if (f.id === a.id) return { ...f, order: b.order };
          if (f.id === b.id) return { ...f, order: a.order };
          return f;
        }),
      );
      setBusyId(id);
      try {
        const res = await Promise.all([
          apiFetch(`/api/team/contact-fields/${a.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ order: b.order }),
          }),
          apiFetch(`/api/team/contact-fields/${b.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ order: a.order }),
          }),
        ]);
        if (!res.every((r) => r.ok)) {
          setDefs(prev);
          setError("Reorder failed");
        }
      } catch {
        setDefs(prev);
        setError("Network error");
      } finally {
        setBusyId(null);
      }
    },
    [defs],
  );

  const deleteField = useCallback(
    async (field: ContactFieldDefinition) => {
      const ok = await confirm({
        title: `Delete "${field.label}"?`,
        description:
          "This removes the field from the team and clears any value stored on every contact. It can't be undone.",
        confirmLabel: "Delete field",
        destructive: true,
      });
      if (!ok) return;
      setBusyId(field.id);
      setError(null);
      try {
        const res = await apiFetch(`/api/team/contact-fields/${field.id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          setError(body.detail || body.error || `Delete failed (HTTP ${res.status})`);
          return;
        }
        setDefs((cur) => cur.filter((f) => f.id !== field.id));
      } finally {
        setBusyId(null);
      }
    },
    [confirm],
  );

  return (
    <div>
      <PageHeader
        title="Contact fields"
        description="Custom fields that show up on every contact (order ID, plan, account manager…). Add one here and it appears on every contact panel; delete it and the value is removed from every contact at once."
        action={
          <Button onClick={openCreate} disabled={creating}>
            <Plus className="size-4" />
            Add field
          </Button>
        }
        className="mb-6"
      />

      {error && (
        <div className="mb-3 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {(() => {
        // One-shot banner for legacy rows that were created before the
        // collision guard landed. Surfaces the names so the admin can rename
        // them; the server still serves both the built-in column AND the
        // custom field, which causes write-vs-read confusion in the panel.
        const shadowed = defs.filter((d) => isReservedFieldKey(d.label));
        if (shadowed.length === 0) return null;
        return (
          <div className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
            <div className="font-medium text-amber-700 dark:text-amber-400">
              {shadowed.length === 1 ? "A custom field" : `${shadowed.length} custom fields`} shadow built-in contact columns.
            </div>
            <div className="mt-1 text-muted-foreground">
              {shadowed.map((d) => (
                <span
                  key={d.id}
                  className="mr-1 inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5"
                >
                  {d.label}
                </span>
              ))}
              Rename to avoid two fields with the same meaning in the contact
              panel.
            </div>
          </div>
        );
      })()}

      <section className="mb-6 overflow-hidden rounded-lg border border-border bg-card">
        <header className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Built-in fields</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Toggle which built-in fields show up on the contact panel and the
            contact details drawer. Phone and name are always shown — phone is
            the WhatsApp identity, name is the heading.
          </p>
        </header>
        <ul className="divide-y divide-border">
          <BuiltinRow
            label="First name"
            description="Contact's given name."
            visible={builtins.firstName}
            onToggle={() => void toggleBuiltin("firstName")}
          />
          <BuiltinRow
            label="Last name"
            description="Contact's family name."
            visible={builtins.lastName}
            onToggle={() => void toggleBuiltin("lastName")}
          />
          <BuiltinRow
            label="Email"
            description="Contact's email address."
            visible={builtins.email}
            onToggle={() => void toggleBuiltin("email")}
          />
          <BuiltinRow
            label="Location"
            description="Free-form location string (city, region, etc.)."
            visible={builtins.location}
            onToggle={() => void toggleBuiltin("location")}
          />
          <BuiltinRow
            label="Language"
            description="BCP-47 language tag (e.g. en, ar). Used for WhatsApp template selection."
            visible={builtins.language}
            onToggle={() => void toggleBuiltin("language")}
          />
          <BuiltinRow
            label="Country"
            description="ISO 3166-1 alpha-2 country code (e.g. US, LB). Derived from phone when blank."
            visible={builtins.country}
            onToggle={() => void toggleBuiltin("country")}
          />
          <BuiltinRow
            label="First contacted"
            description="Timestamp of the earliest message in this thread."
            visible={builtins.firstContacted}
            onToggle={() => void toggleBuiltin("firstContacted")}
          />
        </ul>
      </section>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <ul className="divide-y divide-border">
          {sorted.map((field, idx) => (
            <FieldRow
              key={field.id}
              field={field}
              isFirst={idx === 0}
              isLast={idx === sorted.length - 1}
              busy={busyId === field.id}
              onRename={(label) => patchField(field.id, { label })}
              onMoveUp={() => reorder(field.id, "up")}
              onMoveDown={() => reorder(field.id, "down")}
              onToggleVisibility={() => toggleVisibility(field)}
              onDelete={() => deleteField(field)}
            />
          ))}
          {creating && (
            <li className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  ref={newInputRef}
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void createField();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setCreating(false);
                    }
                  }}
                  placeholder="New field name…"
                  aria-label="New field name"
                  className="h-8 max-w-xs text-sm"
                  disabled={busyId === "__new__"}
                  aria-invalid={isReservedFieldKey(newLabel) || undefined}
                  aria-describedby={
                    isReservedFieldKey(newLabel) ? newFieldErrorId : undefined
                  }
                />
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setCreating(false)}
                    disabled={busyId === "__new__"}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void createField()}
                    disabled={
                      busyId === "__new__" ||
                      !newLabel.trim() ||
                      isReservedFieldKey(newLabel)
                    }
                  >
                    {busyId === "__new__" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Check className="size-3.5" />
                    )}
                    Create
                  </Button>
                </div>
              </div>
              {isReservedFieldKey(newLabel) && (
                <div id={newFieldErrorId} role="alert" className="mt-2 text-2xs text-destructive">
                  &ldquo;{newLabel}&rdquo; is a built-in contact field — pick a
                  different name.
                </div>
              )}
            </li>
          )}
        </ul>
        {sorted.length === 0 && !creating && (
          <EmptyState
            icon={SlidersHorizontal}
            title="No custom fields yet"
            description="Custom fields capture structured data on every contact — and show up in imports, exports, and the contact panel."
            action={
              <Button size="sm" onClick={openCreate}>
                <Plus className="size-4" />
                Add field
              </Button>
            }
            className="rounded-none border-0 bg-transparent"
          />
        )}
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        {sorted.length} field{sorted.length === 1 ? "" : "s"} · max 50 per team.
      </p>

      {confirmDialog}
    </div>
  );
}

function FieldRow({
  field,
  isFirst,
  isLast,
  busy,
  onRename,
  onMoveUp,
  onMoveDown,
  onToggleVisibility,
  onDelete,
}: {
  field: ContactFieldDefinition;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
  onRename: (label: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggleVisibility: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(field.label);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEditing() {
    setDraft(field.label);
    setEditing(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }

  function commit() {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === field.label) return;
    onRename(next);
  }

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={isFirst || busy}
          aria-label="Move up"
          className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent pointer-coarse:size-9"
        >
          <ArrowUp className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={isLast || busy}
          aria-label="Move down"
          className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent pointer-coarse:size-9"
        >
          <ArrowDown className="size-3.5" />
        </button>
      </div>

      {editing ? (
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          className="h-8 max-w-xs text-sm"
        />
      ) : (
        <button
          type="button"
          onClick={startEditing}
          className="group inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-sm font-medium hover:bg-accent"
        >
          <span>{field.label}</span>
          <Pencil className="size-3 opacity-0 transition-opacity group-hover:opacity-50" />
        </button>
      )}

      {/* The key is immutable — surface it so admins know what JSON path
          shows up in exports / API responses. */}
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
        {field.key}
      </code>

      {!field.isVisible && (
        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-3xs font-medium text-amber-700 dark:text-amber-400">
          Hidden
        </span>
      )}

      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={onToggleVisibility}
          disabled={busy}
          aria-label={field.isVisible ? `Hide ${field.label}` : `Show ${field.label}`}
          title={field.isVisible ? "Hide from contact panel" : "Show on contact panel"}
          className="inline-flex size-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50 pointer-coarse:size-9"
        >
          {field.isVisible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          aria-label={`Delete ${field.label}`}
          className="inline-flex size-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 pointer-coarse:size-9"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
        </button>
      </div>
    </li>
  );
}

function BuiltinRow({
  label,
  description,
  visible,
  onToggle,
}: {
  label: string;
  description: string;
  visible: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          {!visible && (
            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-3xs font-medium text-amber-700 dark:text-amber-400">
              Hidden
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <button
        type="button"
        onClick={onToggle}
        aria-label={visible ? `Hide ${label}` : `Show ${label}`}
        title={visible ? "Hide from contact panel" : "Show on contact panel"}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-9"
      >
        {visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
      </button>
    </li>
  );
}

function byOrder(a: ContactFieldDefinition, b: ContactFieldDefinition): number {
  return a.order - b.order;
}
