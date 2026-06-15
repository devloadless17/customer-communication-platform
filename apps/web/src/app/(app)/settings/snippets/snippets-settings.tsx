"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import {
  AlertTriangle,
  Check,
  Loader2,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { apiFetch } from "@/lib/api/client-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";
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
import { cn } from "@ccp/shared/utils";

/**
 * Team snippet manager.
 *
 * Two halves on one screen:
 *   - List of saved snippets (left, scrollable). Click → opens the editor.
 *   - Editor (right) — create or edit. Insert tokens via the same
 *     FieldTokenPicker the broadcast form uses; live preview against the
 *     SAMPLE_CONTACT so the author sees what an agent will paste.
 *
 * Trigger preview at the top of the editor shows `/<name>` so the author
 * understands exactly what they'll type in the reply box.
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

  const reload = useCallback(async () => {
    const res = await apiFetch("/api/team/snippets");
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
      const ok = await confirm({
        title: `Delete /${target.name}?`,
        description: `"${target.label}" will be removed. Agents who already had it pasted into a draft are not affected.`,
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!ok) return;
      const res = await apiFetch(`/api/team/snippets/${target.id}`, { method: "DELETE" });
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
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Snippets</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Saved replies your team can paste into a conversation by typing{" "}
          <code className="rounded bg-muted px-1 text-[12px]">/name</code> in
          the reply box. Use{" "}
          <code className="rounded bg-muted px-1 text-[12px]">$var.contact.name</code>{" "}
          for per-recipient values, or{" "}
          <code className="rounded bg-muted px-1 text-[12px]">$var.agent.name</code>{" "}
          for sign-offs that use whoever inserted the snippet.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="wrap-break-word">{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[260px_1fr]">
        {/* ----- List ----- */}
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                className="h-9 pl-8"
              />
            </div>
            <Button
              type="button"
              size="sm"
              onClick={() => setEditingId("new")}
              className="h-9 gap-1.5"
            >
              <Plus className="size-3.5" />
              New
            </Button>
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-card px-3 py-6 text-center text-[12px] text-muted-foreground">
              {snippets.length === 0
                ? "No snippets yet. Create one to get started."
                : `No snippets match "${query}".`}
            </div>
          ) : (
            <ul className="flex flex-col gap-1 overflow-hidden rounded-lg border border-border bg-card">
              {filtered.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setEditingId(s.id)}
                    className={cn(
                      "group flex w-full items-start gap-2 px-3 py-2 text-left transition-colors",
                      "hover:bg-accent/40",
                      editingId === s.id && "bg-primary/5",
                    )}
                  >
                    <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{s.label}</div>
                      <div className="truncate font-mono text-[10.5px] text-muted-foreground">
                        /{s.name}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ----- Editor ----- */}
        <div>
          {editing ? (
            <SnippetEditor
              key={editing.id}
              snippet={editing}
              fieldDefinitions={fieldDefinitions}
              onCancel={() => setEditingId(null)}
              onSaved={onSaved}
              onDelete={editing.id !== "new" ? () => askDelete(editing) : undefined}
            />
          ) : (
            <div className="flex h-full min-h-65 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-10 text-center">
              <div className="inline-flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Sparkles className="size-4" />
              </div>
              <p className="max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
                Pick a snippet to edit, or create a new one. Snippets show up
                in the reply box when an agent types{" "}
                <code className="rounded bg-muted px-1 text-2xs">/</code>.
              </p>
              <Button type="button" size="sm" onClick={() => setEditingId("new")}>
                <Plus className="size-3.5" />
                New snippet
              </Button>
            </div>
          )}
        </div>
      </div>

      {confirmDialog}
    </div>
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
      const path = isNew ? "/api/team/snippets" : `/api/team/snippets/${snippet.id}`;
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
        throw new Error(
          [data.error, data.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
        );
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
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">
            {isNew ? "New snippet" : "Edit snippet"}
          </div>
          {!isNew && snippet.createdByName && (
            <div className="mt-0.5 text-2xs text-muted-foreground">
              Created by {snippet.createdByName} · last updated{" "}
              <LocalTime iso={snippet.updatedAt} format="localeDate" />
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Close"
        >
          <X className="size-4" />
        </button>
      </div>

      <Field
        label="Trigger"
        hint="Agents type /{name} in the reply box to insert this snippet. Lowercase letters, digits, underscores only."
        error={name.length > 0 && !nameValid ? "Invalid characters or too long." : null}
      >
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-muted-foreground">/</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            placeholder="welcome_new_user"
            maxLength={64}
            className="font-mono text-sm"
          />
        </div>
      </Field>

      <Field label="Label" hint="What the picker shows the agent.">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Welcome a new customer"
          maxLength={80}
        />
      </Field>

      <Field
        label="Body"
        hint="The text agents paste. Use $var.contact.* tokens to personalize."
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10.5px] text-muted-foreground">{body.length}/4000</span>
          <FieldTokenPicker
            fieldDefinitions={fieldDefinitions}
            onInsert={insertToken}
            includeAgent
            hint="Contact tokens resolve against the active conversation. Agent tokens resolve to whoever inserted the snippet — great for sign-offs."
          />
        </div>
        <TokenHighlightTextarea
          ref={bodyRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Hi $var.contact.name, welcome to our service! — $var.agent.name"
          maxLength={4500}
          rows={5}
          className="font-mono text-[13px]"
          fieldDefinitions={fieldDefinitions}
          includeAgent
        />
        {unknown.length > 0 && (
          <p className="text-[10.5px] text-amber-600 dark:text-amber-400">
            Unknown token{unknown.length === 1 ? "" : "s"}:{" "}
            {unknown.join(", ")} — these will resolve to empty.
          </p>
        )}
      </Field>

      <div>
        <div className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          Sample preview
        </div>
        <div className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-[13px] leading-relaxed">
          {preview || <span className="text-muted-foreground italic">(empty)</span>}
        </div>
        <p className="mt-1 text-[10.5px] text-muted-foreground">
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

      <div className="flex items-center justify-between gap-2">
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
      </div>
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
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12px] font-medium">{label}</label>
      {children}
      {hint && !error && <span className="text-[10.5px] text-muted-foreground">{hint}</span>}
      {error && <span className="text-[10.5px] text-destructive">{error}</span>}
    </div>
  );
}

