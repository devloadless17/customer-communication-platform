"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import {
  AlertTriangle,
  Check,
  Loader2,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { apiErrorMessageFrom } from "@ccp/shared/api/error-message";
import { apiFetch } from "@/lib/api/client-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/layouts/page-header";
import { LocalTime } from "@/components/local-time";
import { FieldTokenPicker } from "@/features/templates/components/field-token-picker";
import { TokenHighlightTextarea } from "@/features/templates/components/token-highlight";
import {
  findUnknownTokens,
  resolveFieldTokens,
  SAMPLE_AGENT,
  SAMPLE_CONTACT,
} from "@ccp/shared/field-tokens";
import type { ContactFieldDefinition } from "@ccp/shared/types";

/**
 * Team snippet manager.
 *
 * List + editor, styled to match the Tags / Stages settings pages:
 *   - Single full-width list card (`rounded-lg border bg-card`, `divide-y`
 *     rows) with a search bar and a footer summary line.
 *   - Create / edit happens in the app's canonical Dialog modal — the snippet
 *     editor is too big for an inline row (trigger + label + body with token
 *     picker + live preview), so it gets a proper dialog instead of the
 *     inline-rename pattern the simpler catalogs use.
 *
 * The editor inserts tokens via the same FieldTokenPicker the broadcast form
 * uses; the live preview renders against SAMPLE_CONTACT so the author sees
 * what an agent will paste.
 */

interface SnippetDto {
  id: string;
  name: string;
  label: string;
  body: string;
  createdById: string | null;
  createdByName: string;
  updatedAt: string;
}

export function SnippetsSettings({
  initialSnippets,
  fieldDefinitions,
}: {
  initialSnippets: SnippetDto[];
  fieldDefinitions: ContactFieldDefinition[];
}) {
  const { confirm, confirmDialog } = useConfirm();
  const softRefresh = useSoftRefresh();
  const [snippets, setSnippets] = useState<SnippetDto[]>(initialSnippets);
  // Sync FROM props: when router.refresh() (from useCatalogSync's
  // team:catalog:changed handler — fired by THIS user's mutations or by
  // a teammate's edits broadcasting through the bus) re-runs SSR with
  // fresh initialSnippets, adopt them. Without this, useState's
  // first-mount initializer froze the local copy and additions from
  // other tabs / teammates never showed up here.
  useEffect(() => {
    setSnippets(initialSnippets);
  }, [initialSnippets]);
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return snippets;
    return snippets.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.label.toLowerCase().includes(q) ||
        s.body.toLowerCase().includes(q),
    );
  }, [snippets, query]);

  const editing = useMemo<SnippetDto | null>(() => {
    if (editingId === null) return null;
    if (editingId === "new") {
      return { id: "new", name: "", label: "", body: "", createdById: "", createdByName: "", updatedAt: "" };
    }
    return snippets.find((s) => s.id === editingId) ?? null;
  }, [editingId, snippets]);

  // Hold the last-open snippet so the editor content doesn't blank out during
  // the dialog's 150ms exit animation (editing → null happens immediately on
  // close). Refreshed on every open; only ever read while the dialog fades.
  const lastEditingRef = useRef<SnippetDto | null>(null);
  if (editing) lastEditingRef.current = editing;
  const editorSnippet = editing ?? lastEditingRef.current;

  const reload = useCallback(async () => {
    const res = await apiFetch("/api/workspace/snippets");
    if (!res.ok) return;
    const data = (await res.json()) as { snippets?: SnippetDto[] };
    if (data.snippets) setSnippets(data.snippets);
  }, []);

  const onSaved = useCallback(
    (saved: SnippetDto) => {
      setSnippets((cur) => {
        const idx = cur.findIndex((s) => s.id === saved.id);
        if (idx === -1) return [...cur, saved].sort((a, b) => a.label.localeCompare(b.label));
        const copy = cur.slice();
        copy[idx] = saved;
        return copy;
      });
      setEditingId(saved.id);
      // The API route's revalidateTag("snippets") clears the SERVER-side
      // unstable_cache, but the Next App Router's CLIENT-side cache still
      // holds the inbox layout's RSC payload (with the old snippet list)
      // until something invalidates it. Without router.refresh(), an agent
      // who just added a snippet won't see it in the reply-box `/menu`
      // until a hard reload. The reload() call below keeps THIS page's
      // local list in sync; refresh() takes care of the inbox.
      void reload();
      softRefresh();
    },
    [reload, softRefresh],
  );

  const askDelete = useCallback(
    async (target: SnippetDto) => {
      // The confirm dialog stacks OVER the editor dialog (both role=dialog) so a
      // cancel returns the agent to the editor — intentional. The confirm's
      // z-60 overlay covers the editor beneath it.
      const ok = await confirm({
        title: `Delete /${target.name}?`,
        description: `"${target.label}" will be removed. Agents who already had it pasted into a draft are not affected.`,
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!ok) return;
      const res = await apiFetch(`/api/workspace/snippets/${target.id}`, { method: "DELETE" });
      if (!res.ok) {
        setError(`Delete failed (HTTP ${res.status})`);
        return;
      }
      setSnippets((cur) => cur.filter((s) => s.id !== target.id));
      if (editingId === target.id) setEditingId(null);
      // Same reasoning as onSaved — invalidate the inbox layout's RSC so
      // the deleted snippet stops appearing in the reply-box `/menu` for
      // other agents (and this user, if they navigate away and back).
      softRefresh();
    },
    [confirm, editingId, softRefresh],
  );

  return (
    <div>
      <PageHeader
        title="Snippets"
        description={
          <>
            Saved replies your team can paste into a conversation by typing{" "}
            <code className="rounded-sm bg-muted px-1 text-xs">/name</code> in
            the reply box. Use{" "}
            <code className="rounded-sm bg-muted px-1 text-xs">$var.contact.name</code>{" "}
            for per-recipient values, or{" "}
            <code className="rounded-sm bg-muted px-1 text-xs">$var.agent.name</code>{" "}
            for sign-offs that use whoever inserted the snippet.
          </>
        }
        action={
          <Button type="button" onClick={() => setEditingId("new")}>
            <Plus className="size-4" />
            New snippet
          </Button>
        }
        className="mb-6"
      />

      {snippets.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-50 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search snippets…"
              aria-label="Search snippets"
              className="h-9 pl-8 pr-8"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="wrap-break-word">{error}</span>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <ul className="divide-y divide-border">
          {filtered.map((s) => (
            <SnippetRow
              key={s.id}
              snippet={s}
              onEdit={() => setEditingId(s.id)}
              onDelete={() => askDelete(s)}
            />
          ))}
        </ul>
        {snippets.length === 0 && (
          <EmptyState
            icon={Sparkles}
            title="No snippets yet"
            description="Saved replies your team can paste into a conversation by typing / in the reply box. Create one to get started."
            action={
              <Button size="sm" onClick={() => setEditingId("new")}>
                <Plus className="size-4" />
                New snippet
              </Button>
            }
            className="rounded-none border-0 bg-transparent"
          />
        )}
        {snippets.length > 0 && filtered.length === 0 && (
          <div className="px-6 py-10 text-center text-sm text-muted-foreground">
            No snippets match <span className="font-medium">“{query.trim()}”</span>.
          </div>
        )}
      </div>

      <div className="mt-6 text-xs text-muted-foreground">
        <p>
          {query.trim()
            ? `${filtered.length} of ${snippets.length} snippet${snippets.length === 1 ? "" : "s"}`
            : `${snippets.length} snippet${snippets.length === 1 ? "" : "s"}`}
          .
        </p>
      </div>

      <Dialog open={editingId !== null} onClose={() => setEditingId(null)}>
        {editorSnippet && (
          <DialogContent
            className="max-w-2xl"
            ariaLabel={editorSnippet.id === "new" ? "New snippet" : "Edit snippet"}
          >
            <SnippetEditor
              key={editorSnippet.id}
              snippet={editorSnippet}
              fieldDefinitions={fieldDefinitions}
              onCancel={() => setEditingId(null)}
              onSaved={onSaved}
              onDelete={
                editorSnippet.id !== "new" ? () => askDelete(editorSnippet) : undefined
              }
            />
          </DialogContent>
        )}
      </Dialog>

      {confirmDialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SnippetRow({
  snippet,
  onEdit,
  onDelete,
}: {
  snippet: SnippetDto;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="group flex items-center gap-3 px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <Sparkles className="size-4" />
      </span>

      <button
        type="button"
        onClick={onEdit}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card active:scale-[0.995]"
      >
        <span className="flex items-center gap-1.5 max-w-full">
          <span className="truncate text-sm font-medium">{snippet.label}</span>
          <Pencil className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-50" />
        </span>
        <span className="truncate font-mono text-2xs text-muted-foreground">
          /{snippet.name}
        </span>
      </button>

      <span className="ml-auto hidden text-2xs text-muted-foreground sm:block">
        {snippet.updatedAt ? (
          <>
            Updated <LocalTime iso={snippet.updatedAt} format="localeDate" />
          </>
        ) : null}
      </span>

      <button
        type="button"
        onClick={onDelete}
        aria-label={`Delete /${snippet.name}`}
        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive hover:ring-1 hover:ring-destructive/30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-destructive/40 pointer-coarse:size-9"
      >
        <Trash2 className="size-3.5" />
      </button>
    </li>
  );
}

function SnippetEditor({
  snippet,
  fieldDefinitions,
  onCancel,
  onSaved,
  onDelete,
}: {
  snippet: SnippetDto;
  fieldDefinitions: ContactFieldDefinition[];
  onCancel: () => void;
  onSaved: (saved: SnippetDto) => void;
  onDelete?: () => void;
}) {
  const isNew = snippet.id === "new";
  const [name, setName] = useState(snippet.name);
  const [label, setLabel] = useState(snippet.label);
  const [body, setBody] = useState(snippet.body);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const nameValid = /^[a-z0-9_]{1,64}$/.test(name);
  const labelValid = label.trim().length > 0 && label.length <= 80;
  const bodyValid = body.trim().length > 0 && body.length <= 4000;
  const canSave = nameValid && labelValid && bodyValid && !saving;

  const unknown = useMemo(
    () => findUnknownTokens(body, fieldDefinitions, { includeAgent: true }),
    [body, fieldDefinitions],
  );
  const preview = useMemo(
    () => resolveFieldTokens(body, SAMPLE_CONTACT, SAMPLE_AGENT),
    [body],
  );

  const insertToken = useCallback(
    (token: string) => {
      const el = bodyRef.current;
      if (!el) {
        setBody((cur) => cur + token);
        return;
      }
      const start = el.selectionStart ?? body.length;
      const end = el.selectionEnd ?? body.length;
      const next = body.slice(0, start) + token + body.slice(end);
      setBody(next);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + token.length;
        el.setSelectionRange(pos, pos);
      });
    },
    [body],
  );

  const save = useCallback(async () => {
    if (!canSave) return;
    setErr(null);
    setSaving(true);
    try {
      const path = isNew ? "/api/workspace/snippets" : `/api/workspace/snippets/${snippet.id}`;
      const method = isNew ? "POST" : "PATCH";
      const res = await apiFetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, label, body }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        id?: string;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !data.ok) {
        // `detail` → humanized key → fallback, instead of prefixing the copy
        // the server wrote with its own snake_case key.
        throw new Error(apiErrorMessageFrom(data, `Couldn't save (HTTP ${res.status})`));
      }
      const id = isNew ? (data.id ?? snippet.id) : snippet.id;
      onSaved({
        id,
        name,
        label,
        body,
        createdById: snippet.createdById,
        createdByName: snippet.createdByName,
        updatedAt: new Date().toISOString(),
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [canSave, isNew, name, label, body, snippet, onSaved]);

  return (
    <div className="flex flex-col">
      <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">
            {isNew ? "New snippet" : "Edit snippet"}
          </h2>
          {!isNew && snippet.createdByName && (
            <p className="mt-0.5 text-2xs text-muted-foreground">
              Created by {snippet.createdByName} · last updated{" "}
              <LocalTime iso={snippet.updatedAt} format="localeDate" />
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="-mr-1 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Close"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="flex flex-col gap-4 px-5 py-4">
        <Field
          label="Trigger"
          hint="Agents type /{name} in the reply box to insert this snippet. Lowercase letters, digits, underscores only."
          error={name.length > 0 && !nameValid ? "Invalid characters or too long." : null}
        >
          {(ids) => (
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm text-muted-foreground">/</span>
              <Input
                {...ids}
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                placeholder="welcome_new_user"
                maxLength={64}
                className="font-mono text-sm aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/30"
              />
            </div>
          )}
        </Field>

        <Field label="Label" hint="What the picker shows the agent.">
          {(ids) => (
            <Input
              {...ids}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Welcome a new customer"
              maxLength={80}
            />
          )}
        </Field>

        <Field
          label="Body"
          hint="The text agents paste. Use $var.contact.* tokens to personalize."
        >
          {(ids) => (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-2xs text-muted-foreground">{body.length}/4000</span>
                <FieldTokenPicker
                  fieldDefinitions={fieldDefinitions}
                  onInsert={insertToken}
                  includeAgent
                  hint="Contact tokens resolve against the active conversation. Agent tokens resolve to whoever inserted the snippet — great for sign-offs."
                />
              </div>
              <TokenHighlightTextarea
                {...ids}
                ref={bodyRef}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Hi $var.contact.name, welcome to our service! — $var.agent.name"
                maxLength={4500}
                rows={5}
                className="font-mono text-sm"
                fieldDefinitions={fieldDefinitions}
                includeAgent
              />
              {unknown.length > 0 && (
                <p className="text-2xs text-warning-fg">
                  Unknown token{unknown.length === 1 ? "" : "s"}:{" "}
                  {unknown.join(", ")} — these will resolve to empty.
                </p>
              )}
            </>
          )}
        </Field>

        <div>
          <div className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            Sample preview
          </div>
          <div className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-sm leading-relaxed">
            {preview || <span className="text-muted-foreground italic">(empty)</span>}
          </div>
          <p className="mt-1 text-2xs text-muted-foreground">
            Rendered against a sample contact ({SAMPLE_CONTACT.name}) and a sample
            agent ({SAMPLE_AGENT.name}). In the inbox, those resolve to the live
            contact and the agent inserting the snippet.
          </p>
        </div>

        {err && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="wrap-break-word">{err}</span>
          </div>
        )}
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
        <div>
          {onDelete && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDelete}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
              Delete
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={!canSave} className="gap-1.5">
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            {isNew ? "Create snippet" : "Save"}
          </Button>
        </div>
      </footer>
    </div>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  /**
   * Render-prop so the label/hint/error can be associated with the control:
   * callers spread the supplied ids onto their <Input> (`id`,
   * `aria-describedby`, `aria-invalid`). The wrapping div is the labelled
   * region for AT that walk the label → control relationship.
   */
  children: (ids: {
    id: string;
    "aria-describedby": string | undefined;
    "aria-invalid": true | undefined;
  }) => React.ReactNode;
}) {
  const controlId = useId();
  const hintId = useId();
  const errorId = useId();
  const describedBy = error ? errorId : hint ? hintId : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={controlId} className="text-xs font-medium">
        {label}
      </label>
      {children({
        id: controlId,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
      })}
      {hint && !error && (
        <span id={hintId} className="text-2xs text-muted-foreground">
          {hint}
        </span>
      )}
      {error && (
        <span id={errorId} role="alert" className="text-2xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
