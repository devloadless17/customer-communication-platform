"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  Loader2,
  Milestone,
  Pencil,
  Plus,
  Star,
  Trash2,
  Users,
} from "lucide-react";

import { apiFetch } from "@/lib/api/client-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import { TAG_COLORS, type ContactStage, type TagColor } from "@ccp/shared/types";
import { cn } from "@ccp/shared/utils";

/**
 * Customer-lifecycle stage manager.
 *
 * Reorder is up/down buttons rather than drag-and-drop on purpose:
 * stages cap at ~30 per team, and the dep cost of a sortable lib for that
 * scale isn't worth it. Each row carries:
 *   - star button (promote to default — the stage new contacts land in)
 *   - color swatch row (clickable; persists on click)
 *   - inline-rename input (click the name to edit)
 *   - delete button (blocked server-side while contacts are parked)
 *
 * Bottom row: contact-count summary per stage + a link back to /contacts
 * scoped to the stage filter, so the admin can bulk-move before deleting.
 */

export function StagesSettings({
  initialStages,
  countsByStageId,
  unassignedCount,
}: {
  initialStages: ContactStage[];
  countsByStageId: Record<string, number>;
  unassignedCount: number;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const [stages, setStages] = useState<ContactStage[]>(initialStages);
  // Sync from SSR-re-runs (router.refresh from useCatalogSync) so a teammate's
  // additions/edits show up without manual refresh. See snippets-settings.tsx
  // for the full rationale.
  useEffect(() => {
    setStages(initialStages);
  }, [initialStages]);
  const [counts, setCounts] = useState<Record<string, number>>(countsByStageId);
  useEffect(() => {
    setCounts(countsByStageId);
  }, [countsByStageId]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<TagColor>("sky");
  const [busyId, setBusyId] = useState<string | null>(null);
  const newInputRef = useRef<HTMLInputElement>(null);

  const totalContacts =
    Object.values(counts).reduce((a, b) => a + b, 0) + unassignedCount;

  const openCreate = useCallback(() => {
    setCreating(true);
    setNewName("");
    setNewColor("sky");
    setError(null);
    requestAnimationFrame(() => newInputRef.current?.focus());
  }, []);

  const createStage = useCallback(async () => {
    const name = newName.trim();
    if (!name) {
      setError("Stage needs a name.");
      return;
    }
    setBusyId("__new__");
    setError(null);
    try {
      const res = await apiFetch("/api/team/stages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color: newColor }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        stage?: ContactStage;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !body.stage) {
        setError(body.detail || body.error || `Couldn't create (HTTP ${res.status})`);
        return;
      }
      setStages((cur) => [...cur, body.stage!].sort(byPosition));
      setCreating(false);
      setNewName("");
    } finally {
      setBusyId(null);
    }
  }, [newName, newColor]);

  const patchStage = useCallback(
    async (id: string, patch: Partial<Pick<ContactStage, "name" | "color" | "isDefault">>) => {
      setBusyId(id);
      setError(null);
      // Optimistic: paint the change immediately, rollback on failure. For
      // `isDefault` we ALSO have to clear isDefault on the previously-set
      // row so two rows aren't both starred for a frame.
      const prev = stages;
      setStages((cur) =>
        cur.map((s) => {
          if (s.id === id) return { ...s, ...patch };
          if (patch.isDefault === true && s.isDefault) return { ...s, isDefault: false };
          return s;
        }),
      );
      try {
        const res = await apiFetch(`/api/team/stages/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          setStages(prev);
          setError(body.detail || body.error || `Update failed (HTTP ${res.status})`);
        }
      } catch {
        setStages(prev);
        setError("Network error");
      } finally {
        setBusyId(null);
      }
    },
    [stages],
  );

  const reorder = useCallback(
    async (id: string, direction: "up" | "down") => {
      const sorted = [...stages].sort(byPosition);
      const idx = sorted.findIndex((s) => s.id === id);
      const swapIdx = direction === "up" ? idx - 1 : idx + 1;
      if (idx < 0 || swapIdx < 0 || swapIdx >= sorted.length) return;
      const next = sorted.slice();
      [next[idx], next[swapIdx]] = [next[swapIdx]!, next[idx]!];
      // Renumber positions so the local state matches what the server will
      // persist on success.
      const renumbered = next.map((s, i) => ({ ...s, position: i }));
      const prev = stages;
      setStages(renumbered);
      setBusyId(id);
      try {
        const res = await apiFetch("/api/team/stages/reorder", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orderedIds: renumbered.map((s) => s.id) }),
        });
        if (!res.ok) {
          setStages(prev);
          setError(`Reorder failed (HTTP ${res.status})`);
        }
      } catch {
        setStages(prev);
        setError("Network error");
      } finally {
        setBusyId(null);
      }
    },
    [stages],
  );

  const deleteStage = useCallback(
    async (stage: ContactStage) => {
      const used = counts[stage.id] ?? 0;
      if (used > 0) {
        await confirm({
          title: `Can't delete "${stage.name}"`,
          description: `${used} contact${used === 1 ? " is" : "s are"} still in this stage. Move them to another stage first — open Contacts, filter by "${stage.name}", and bulk-update.`,
          confirmLabel: "OK",
          destructive: false,
        });
        return;
      }
      if (stage.isDefault && stages.length > 1) {
        await confirm({
          title: `Can't delete the default stage`,
          description: `"${stage.name}" is the default stage new contacts land in. Promote another stage to default first (click the star).`,
          confirmLabel: "OK",
          destructive: false,
        });
        return;
      }
      const ok = await confirm({
        title: `Delete "${stage.name}"?`,
        description: "This removes the stage from the team. It can't be undone.",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!ok) return;
      setBusyId(stage.id);
      setError(null);
      try {
        const res = await apiFetch(`/api/team/stages/${stage.id}`, { method: "DELETE" });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          setError(body.detail || body.error || `Delete failed (HTTP ${res.status})`);
          return;
        }
        setStages((cur) => cur.filter((s) => s.id !== stage.id));
        setCounts((cur) => {
          const { [stage.id]: _drop, ...rest } = cur;
          void _drop;
          return rest;
        });
      } finally {
        setBusyId(null);
      }
    },
    [confirm, counts, stages.length],
  );

  const sortedStages = useMemo(() => [...stages].sort(byPosition), [stages]);

  return (
    <div>
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Customer stages</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pipeline buckets for your contacts. New contacts land in the default
            stage; agents move them as the relationship progresses. Use stages
            to filter Contacts and target stage-specific broadcasts.
          </p>
        </div>
        <Button onClick={openCreate} disabled={creating}>
          <Plus className="size-4" />
          Add stage
        </Button>
      </header>

      {error && (
        <div className="mb-3 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <ul className="divide-y divide-border">
          {sortedStages.map((stage, idx) => (
            <StageRow
              key={stage.id}
              stage={stage}
              count={counts[stage.id] ?? 0}
              isFirst={idx === 0}
              isLast={idx === sortedStages.length - 1}
              busy={busyId === stage.id}
              onRename={(name) => patchStage(stage.id, { name })}
              onRecolor={(color) => patchStage(stage.id, { color })}
              onPromote={() => patchStage(stage.id, { isDefault: true })}
              onMoveUp={() => reorder(stage.id, "up")}
              onMoveDown={() => reorder(stage.id, "down")}
              onDelete={() => deleteStage(stage)}
            />
          ))}
          {creating && (
            <li className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <StageDot color={newColor} />
                <Input
                  ref={newInputRef}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void createStage();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setCreating(false);
                    }
                  }}
                  placeholder="New stage name…"
                  aria-label="New stage name"
                  className="h-8 max-w-xs text-sm"
                  disabled={busyId === "__new__"}
                />
                <ColorSwatches selected={newColor} onChange={setNewColor} />
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
                    onClick={() => void createStage()}
                    disabled={busyId === "__new__" || !newName.trim()}
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
            </li>
          )}
        </ul>
        {sortedStages.length === 0 && !creating && (
          <EmptyState
            icon={Milestone}
            title="No stages yet"
            description="Stages track where each contact sits in your customer lifecycle. Add one to start segmenting."
            action={
              <Button size="sm" onClick={openCreate}>
                <Plus className="size-4" />
                Add stage
              </Button>
            }
            className="rounded-none border-0 bg-transparent"
          />
        )}
      </div>

      <div className="mt-6 text-xs text-muted-foreground">
        <p>
          {totalContacts} total contacts across {sortedStages.length}{" "}
          stage{sortedStages.length === 1 ? "" : "s"}.
          {unassignedCount > 0 && (
            <>
              {" "}
              <span className="font-medium text-foreground">
                {unassignedCount} unassigned
              </span>{" "}
              — view in{" "}
              <a
                href="/contacts?stage=none"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Contacts
              </a>{" "}
              to park them.
            </>
          )}
        </p>
      </div>

      {confirmDialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StageRow({
  stage,
  count,
  isFirst,
  isLast,
  busy,
  onRename,
  onRecolor,
  onPromote,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  stage: ContactStage;
  count: number;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
  onRename: (name: string) => void;
  onRecolor: (color: TagColor) => void;
  onPromote: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(stage.name);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEditing() {
    setDraft(stage.name);
    setEditing(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }

  function commit() {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === stage.name) return;
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

      <StageDot color={stage.color} />

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
          <span>{stage.name}</span>
          <Pencil className="size-3 opacity-0 transition-opacity group-hover:opacity-50" />
        </button>
      )}

      {stage.isDefault ? (
        <span
          title="Default — new contacts land here"
          className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-3xs font-medium text-amber-700 dark:text-amber-300"
        >
          <Star className="size-3 fill-current" />
          Default
        </span>
      ) : (
        <button
          type="button"
          onClick={onPromote}
          disabled={busy}
          title="Make this the default stage"
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-3xs text-muted-foreground transition-colors hover:border-amber-500/50 hover:bg-amber-500/10 hover:text-amber-700 disabled:opacity-50 dark:hover:text-amber-300"
        >
          <Star className="size-3" />
          Set default
        </button>
      )}

      <ColorSwatches selected={stage.color} onChange={onRecolor} compact />

      <a
        href={`/contacts?stage=${stage.id}`}
        title={`View contacts in "${stage.name}"`}
        className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Users className="size-3" />
        <span className="tabular-nums">{count}</span>
      </a>

      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        aria-label={`Delete ${stage.name}`}
        className="inline-flex size-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 pointer-coarse:size-9"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
      </button>
    </li>
  );
}

function StageDot({ color }: { color: TagColor }) {
  const cls = tagColorClasses(color);
  return <span className={cn("inline-block size-3 shrink-0 rounded-full", cls.solid)} />;
}

function ColorSwatches({
  selected,
  onChange,
  compact = false,
}: {
  selected: TagColor;
  onChange: (color: TagColor) => void;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-1", compact && "ml-2")}>
      {TAG_COLORS.map((c) => {
        const classes = tagColorClasses(c);
        return (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            aria-label={`${c} color`}
            className={cn(
              "size-4 cursor-pointer rounded-full ring-1 ring-border transition-transform",
              classes.solid,
              selected === c && "ring-2 ring-foreground/60 ring-offset-1 ring-offset-card scale-110",
            )}
          >
            {selected === c && (
              <CheckCircle2 className="size-3 text-background opacity-0" />
            )}
          </button>
        );
      })}
    </div>
  );
}

function byPosition(a: ContactStage, b: ContactStage): number {
  return a.position - b.position;
}
