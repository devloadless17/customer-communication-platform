"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
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
import { ColorSwatchPicker } from "@/components/ui/color-swatch-picker";
import { PageHeader } from "@/components/layouts/page-header";
import { apiFetch } from "@/lib/api/client-fetch";
import { isReservedFieldKey } from "@ccp/shared/contacts/reserved-fields";
import { cn } from "@ccp/shared/utils";
import type {
  ContactFieldDefinition,
  ContactFieldOption,
  ContactPanelBuiltins,
  TagColor,
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
  // The field's kind, chosen at create time and immutable after — a select
  // field's values are option IDs, so converting an existing text field's
  // free-text history is a data migration, not an edit.
  const [newType, setNewType] = useState<"text" | "select">("text");
  const [busyId, setBusyId] = useState<string | null>(null);
  const newInputRef = useRef<HTMLInputElement>(null);
  const newFieldErrorId = useId();

  const sorted = useMemo(() => [...defs].sort(byOrder), [defs]);

  const openCreate = useCallback(() => {
    setCreating(true);
    setNewLabel("");
    setNewType("text");
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
      const res = await apiFetch("/api/workspace/contact-fields", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label, ...(newType === "select" ? { type: "select" } : {}) }),
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
      setNewType("text");
    } finally {
      setBusyId(null);
    }
  }, [newLabel, newType]);

  /** Swap one definition in place — the options editor reports back through
   *  this after every option mutation so the row re-renders with the fresh
   *  catalog. */
  const replaceDef = useCallback((next: ContactFieldDefinition) => {
    setDefs((cur) => cur.map((f) => (f.id === next.id ? next : f)));
  }, []);

  const toggleBuiltin = useCallback(
    async (key: keyof ContactPanelBuiltins) => {
      const prev = builtins;
      const next = { ...builtins, [key]: !builtins[key] };
      setBuiltins(next);
      setError(null);
      try {
        const res = await apiFetch("/api/workspace/contact-fields/builtins", {
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
        const res = await apiFetch(`/api/workspace/contact-fields/${field.id}`, {
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
        const res = await apiFetch(`/api/workspace/contact-fields/${id}`, {
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
      const next = list.slice();
      [next[idx], next[swapIdx]] = [next[swapIdx]!, next[idx]!];
      // Renumber orders so the local state matches what the server will
      // persist on success.
      const renumbered = next.map((f, i) => ({ ...f, order: i }));
      // One transactional /reorder endpoint renumbers every field server-side
      // — the previous two parallel PATCHes could half-fail and leave
      // duplicate `order` values. Mirrors the stages reorder route.
      const prev = defs;
      setDefs(renumbered);
      setBusyId(id);
      try {
        const res = await apiFetch("/api/workspace/contact-fields/reorder", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orderedIds: renumbered.map((f) => f.id) }),
        });
        if (!res.ok) {
          setDefs(prev);
          setError(`Reorder failed (HTTP ${res.status})`);
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
        const res = await apiFetch(`/api/workspace/contact-fields/${field.id}`, {
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
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
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
          <div className="mb-3 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-xs">
            <div className="font-medium text-warning-fg">
              {shadowed.length === 1 ? "A custom field" : `${shadowed.length} custom fields`} shadow built-in contact columns.
            </div>
            <div className="mt-1 text-muted-foreground">
              {shadowed.map((d) => (
                <span
                  key={d.id}
                  className="mr-1 inline-flex items-center gap-1 rounded-sm border border-warning-border bg-warning-bg px-1.5 py-0.5"
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
              onReplace={replaceDef}
              confirm={confirm}
            />
          ))}
          {creating && (
            <li
              className={cn(
                "px-4 py-3 transition-opacity",
                busyId === "__new__" && "opacity-60",
              )}
            >
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
                  className="h-8 max-w-xs text-sm aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/30"
                  disabled={busyId === "__new__"}
                  aria-invalid={isReservedFieldKey(newLabel) || undefined}
                  aria-describedby={
                    isReservedFieldKey(newLabel) ? newFieldErrorId : undefined
                  }
                />
                <div
                  className="inline-flex items-center rounded-md border border-border p-0.5"
                  role="radiogroup"
                  aria-label="Field type"
                >
                  {(["text", "select"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      role="radio"
                      aria-checked={newType === t}
                      onClick={() => setNewType(t)}
                      disabled={busyId === "__new__"}
                      className={cn(
                        "rounded-[5px] px-2 py-1 text-xs transition-colors",
                        newType === t
                          ? "bg-accent font-medium text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {t === "text" ? "Text" : "Dropdown"}
                    </button>
                  ))}
                </div>
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
  onReplace,
  confirm,
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
  /** Swap the definition in the parent list (fresh options after a mutation). */
  onReplace: (next: ContactFieldDefinition) => void;
  confirm: ReturnType<typeof useConfirm>["confirm"];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(field.label);
  const [optionsOpen, setOptionsOpen] = useState(false);
  // Same reserved-name guard the create form runs — without it the doomed
  // PATCH round-trips just to land the same message in the page-level banner.
  const [renameReserved, setRenameReserved] = useState(false);
  const renameErrorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  function startEditing() {
    setDraft(field.label);
    setRenameReserved(false);
    setEditing(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }

  function commit() {
    const next = draft.trim();
    if (next && next !== field.label && isReservedFieldKey(next)) {
      // Stay in edit mode so the error has an anchor and the user can fix it.
      // No refocus — commit() also runs on blur, and yanking focus back would
      // trap a user who clicked away deliberately.
      setRenameReserved(true);
      return;
    }
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
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30 disabled:hover:bg-transparent pointer-coarse:size-9"
        >
          <ArrowUp className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={isLast || busy}
          aria-label="Move down"
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30 disabled:hover:bg-transparent pointer-coarse:size-9"
        >
          <ArrowDown className="size-3.5" />
        </button>
      </div>

      {editing ? (
        <Input
          ref={inputRef}
          value={draft}
          aria-invalid={renameReserved || undefined}
          aria-describedby={renameReserved ? renameErrorId : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            setRenameReserved(false);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setRenameReserved(false);
              setEditing(false);
            }
          }}
          className="h-8 max-w-xs text-sm"
        />
      ) : (
        <button
          type="button"
          onClick={startEditing}
          className="group inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card active:scale-[0.98]"
        >
          <span>{field.label}</span>
          <Pencil className="size-3 opacity-0 transition-opacity group-hover:opacity-50" />
        </button>
      )}

      {/* The key is immutable — surface it so admins know what JSON path
          shows up in exports / API responses. */}
      <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
        {field.key}
      </code>

      {field.type === "select" && (
        <button
          type="button"
          onClick={() => setOptionsOpen((v) => !v)}
          aria-expanded={optionsOpen}
          className="inline-flex items-center gap-1 rounded-sm bg-info-bg px-1.5 py-0.5 text-3xs font-medium text-info-fg transition-colors hover:opacity-80"
          title="Show options"
        >
          Dropdown · {(field.options ?? []).length} option
          {(field.options ?? []).length === 1 ? "" : "s"}
          <ChevronDown
            className={cn("size-3 transition-transform", optionsOpen && "rotate-180")}
          />
        </button>
      )}

      {!field.isVisible && (
        <span className="rounded-sm bg-warning-bg px-1.5 py-0.5 text-3xs font-medium text-warning-fg">
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
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 pointer-coarse:size-9"
        >
          {field.isVisible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          aria-label={`Delete ${field.label}`}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive hover:ring-1 hover:ring-destructive/30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-destructive/40 disabled:opacity-50 pointer-coarse:size-9"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
        </button>
      </div>

      {renameReserved && (
        <div
          id={renameErrorId}
          role="alert"
          className="basis-full text-2xs text-destructive"
        >
          &ldquo;{draft.trim()}&rdquo; is a built-in contact field — pick a different
          name.
        </div>
      )}

      {field.type === "select" && optionsOpen && (
        <OptionsEditor field={field} onReplace={onReplace} confirm={confirm} />
      )}
    </li>
  );
}

/**
 * Inline option catalog editor for one select field. Follows the stages
 * interaction patterns (inline add, click-to-rename, swatch recolor, up/down
 * reorder, delete guarded by usage) — deliberately copied, not extracted:
 * stages stay untouched by this feature.
 *
 * Every mutation replaces the whole definition in the parent list via
 * `onReplace`, so the row badge, the pickers, and this editor all re-render
 * from one source.
 */
function OptionsEditor({
  field,
  onReplace,
  confirm,
}: {
  field: ContactFieldDefinition;
  onReplace: (next: ContactFieldDefinition) => void;
  confirm: ReturnType<typeof useConfirm>["confirm"];
}) {
  const options = useMemo(
    () => [...(field.options ?? [])].sort((a, b) => a.position - b.position),
    [field.options],
  );
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  // Per-option usage counts — loaded once when the editor opens; refreshed
  // after a delete. Drives the count badge and the delete dialog copy.
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await apiFetch(
          `/api/workspace/contact-fields/${field.id}/option-counts`,
        );
        if (!res.ok) return;
        const body = (await res.json()) as { countsByOptionId?: Record<string, number> };
        if (alive && body.countsByOptionId) setCounts(body.countsByOptionId);
      } catch {
        // Counts are decorative here; the server re-checks on delete anyway.
      }
    })();
    return () => {
      alive = false;
    };
  }, [field.id]);

  const withOptions = useCallback(
    (nextOptions: ContactFieldOption[]) => {
      onReplace({ ...field, options: nextOptions });
    },
    [field, onReplace],
  );

  const addOption = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    setBusyId("__new__");
    setError(null);
    try {
      const res = await apiFetch(`/api/workspace/contact-fields/${field.id}/options`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        option?: ContactFieldOption;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !body.option) {
        setError(body.detail || body.error || `Couldn't add option (HTTP ${res.status})`);
        return;
      }
      withOptions([...options, body.option]);
      setNewName("");
    } finally {
      setBusyId(null);
    }
  }, [field.id, newName, options, withOptions]);

  const patchOption = useCallback(
    async (optionId: string, patch: { name?: string; color?: TagColor }) => {
      setBusyId(optionId);
      setError(null);
      const prev = options;
      withOptions(options.map((o) => (o.id === optionId ? { ...o, ...patch } : o)));
      try {
        const res = await apiFetch(
          `/api/workspace/contact-fields/${field.id}/options/${optionId}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          withOptions(prev);
          setError(body.detail || body.error || `Update failed (HTTP ${res.status})`);
        }
      } catch {
        withOptions(prev);
        setError("Network error");
      } finally {
        setBusyId(null);
      }
    },
    [field.id, options, withOptions],
  );

  const reorderOption = useCallback(
    async (optionId: string, direction: "up" | "down") => {
      const idx = options.findIndex((o) => o.id === optionId);
      const swapIdx = direction === "up" ? idx - 1 : idx + 1;
      if (idx < 0 || swapIdx < 0 || swapIdx >= options.length) return;
      const next = options.slice();
      [next[idx], next[swapIdx]] = [next[swapIdx]!, next[idx]!];
      const renumbered = next.map((o, i) => ({ ...o, position: i }));
      const prev = options;
      withOptions(renumbered);
      setBusyId(optionId);
      try {
        const res = await apiFetch(
          `/api/workspace/contact-fields/${field.id}/options/reorder`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ orderedIds: renumbered.map((o) => o.id) }),
          },
        );
        if (!res.ok) {
          withOptions(prev);
          setError(`Reorder failed (HTTP ${res.status})`);
        }
      } catch {
        withOptions(prev);
        setError("Network error");
      } finally {
        setBusyId(null);
      }
    },
    [field.id, options, withOptions],
  );

  const deleteOption = useCallback(
    async (option: ContactFieldOption) => {
      const used = counts[option.id] ?? 0;
      const ok = await confirm({
        title: `Delete "${option.name}"?`,
        description:
          used > 0
            ? `${used} contact${used === 1 ? " has" : "s have"} this option — deleting will clear their "${field.label}" value. It can't be undone.`
            : "This removes the option from the dropdown. It can't be undone.",
        confirmLabel: used > 0 ? "Clear & delete" : "Delete",
        destructive: true,
      });
      if (!ok) return;
      setBusyId(option.id);
      setError(null);
      try {
        const res = await apiFetch(
          `/api/workspace/contact-fields/${field.id}/options/${option.id}`,
          {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            // Explicit null = clear the value on every carrying contact in
            // the same transaction. The count shown above may be seconds
            // stale, so we always send it rather than risk a surprise 409.
            body: JSON.stringify({ moveToOptionId: null }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          setError(body.detail || body.error || `Delete failed (HTTP ${res.status})`);
          return;
        }
        withOptions(options.filter((o) => o.id !== option.id));
        setCounts((cur) => {
          const { [option.id]: _drop, ...rest } = cur;
          void _drop;
          return rest;
        });
      } finally {
        setBusyId(null);
      }
    },
    [confirm, counts, field.id, field.label, options, withOptions],
  );

  return (
    <div className="mt-2 w-full basis-full rounded-md border border-border bg-muted/30 p-2">
      {error && (
        <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-2xs text-destructive">
          {error}
        </div>
      )}
      <ul className="space-y-0.5">
        {options.map((option, idx) => (
          <li key={option.id} className="flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-accent/40">
            <ColorSwatchPicker
              selected={option.color}
              onChange={(color) => void patchOption(option.id, { color })}
              disabled={busyId === option.id}
              label={`colour for "${option.name}"`}
            />
            <OptionName
              name={option.name}
              busy={busyId === option.id}
              onRename={(name) => void patchOption(option.id, { name })}
            />
            {(counts[option.id] ?? 0) > 0 && (
              <span
                className="rounded-full bg-muted px-1.5 py-0.5 text-3xs tabular-nums text-muted-foreground"
                title={`${counts[option.id]} contact${counts[option.id] === 1 ? "" : "s"}`}
              >
                {counts[option.id]}
              </span>
            )}
            <div className="ml-auto flex items-center">
              <button
                type="button"
                onClick={() => void reorderOption(option.id, "up")}
                disabled={idx === 0 || busyId !== null}
                aria-label={`Move ${option.name} up`}
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
              >
                <ArrowUp className="size-3" />
              </button>
              <button
                type="button"
                onClick={() => void reorderOption(option.id, "down")}
                disabled={idx === options.length - 1 || busyId !== null}
                aria-label={`Move ${option.name} down`}
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
              >
                <ArrowDown className="size-3" />
              </button>
              <button
                type="button"
                onClick={() => void deleteOption(option)}
                disabled={busyId !== null}
                aria-label={`Delete ${option.name}`}
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive disabled:opacity-50"
              >
                {busyId === option.id ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Trash2 className="size-3" />
                )}
              </button>
            </div>
          </li>
        ))}
        {options.length === 0 && (
          <li className="px-1 py-2 text-2xs text-muted-foreground">
            No options yet — add the first one below.
          </li>
        )}
      </ul>
      <div className="mt-1.5 flex items-center gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void addOption();
            }
          }}
          placeholder="Add option…"
          aria-label={`Add option to ${field.label}`}
          className="h-7 max-w-52 text-xs"
          disabled={busyId === "__new__"}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => void addOption()}
          disabled={busyId === "__new__" || !newName.trim()}
          className="h-7"
        >
          {busyId === "__new__" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Plus className="size-3" />
          )}
          Add
        </Button>
        <span className="text-3xs text-muted-foreground">
          {options.length}/30
        </span>
      </div>
    </div>
  );
}

/** Click-to-rename, mirroring the field label editor above. */
function OptionName({
  name,
  busy,
  onRename,
}: {
  name: string;
  busy: boolean;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  function start() {
    setDraft(name);
    setEditing(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }

  function commit() {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === name) return;
    onRename(next);
  }

  if (editing) {
    return (
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
        className="h-6 max-w-44 text-xs"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={start}
      disabled={busy}
      className="group inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs transition-colors hover:bg-accent"
    >
      <span>{name}</span>
      <Pencil className="size-2.5 opacity-0 transition-opacity group-hover:opacity-50" />
    </button>
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
            <span className="rounded-sm bg-warning-bg px-1.5 py-0.5 text-3xs font-medium text-warning-fg">
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
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-9"
      >
        {visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
      </button>
    </li>
  );
}

function byOrder(a: ContactFieldDefinition, b: ContactFieldDefinition): number {
  return a.order - b.order;
}
