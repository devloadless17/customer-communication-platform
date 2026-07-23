"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, Flag, Loader2, Plus, Trash2 } from "lucide-react";

import { apiFetch } from "@/lib/api/client-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/layouts/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import { type TagColor } from "@ccp/shared/types";
import type { MessageFlagDefinitionWithUsage } from "@ccp/shared/message-flags/types";
import { cn } from "@ccp/shared/utils";
import { ColorSwatchPicker } from "@/components/ui/color-swatch-picker";

/**
 * Message-flag catalog manager — deliberately the same shape as the tags
 * settings page so an admin doesn't have to relearn the pattern:
 *   - color swatch row (click to persist)
 *   - inline-rename input
 *   - a one-line description shown as helper text in the inbox picker
 *   - usage counts ("12 raised · 3 open")
 *
 * The one real difference is DELETE vs ARCHIVE. A definition that has ever
 * been raised cannot be deleted — the triage history under it has to stay
 * readable, and the FK is `onDelete: Restrict` to guarantee it. Used
 * definitions therefore offer Archive (hidden from the picker, history
 * intact); only a never-used definition shows Delete.
 */
export function MessageFlagsSettings({
  initialDefinitions,
}: {
  initialDefinitions: MessageFlagDefinitionWithUsage[];
}) {
  const { confirm, confirmDialog } = useConfirm();
  const [definitions, setDefinitions] = useState(initialDefinitions);
  // Re-sync on SSR re-runs (router.refresh from useCatalogSync), so a
  // teammate's edit lands here without a manual reload.
  useEffect(() => {
    setDefinitions(initialDefinitions);
  }, [initialDefinitions]);

  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newColor, setNewColor] = useState<TagColor>("rose");
  const [busyId, setBusyId] = useState<string | null>(null);
  const newInputRef = useRef<HTMLInputElement>(null);

  const active = definitions.filter((d) => !d.archived);
  const archived = definitions.filter((d) => d.archived);

  /** Re-pull the catalog after any mutation — one small request, and it keeps
   *  the usage counts honest without hand-patching them client-side. */
  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch("/api/workspace/message-flags/usage");
      if (!res.ok) return;
      const body = (await res.json()) as { definitions: MessageFlagDefinitionWithUsage[] };
      setDefinitions(body.definitions);
    } catch {
      // Non-fatal — the next router.refresh (from team:catalog:changed) converges.
    }
  }, []);

  const call = useCallback(
    async (
      path: string,
      method: "POST" | "PATCH" | "DELETE",
      body?: unknown,
    ): Promise<boolean> => {
      setError(null);
      try {
        const res = await apiFetch(path, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as {
            detail?: string;
            error?: string;
          };
          setError(d.detail || d.error || "Something went wrong.");
          return false;
        }
        await refresh();
        return true;
      } catch {
        setError("Network error — try again.");
        return false;
      }
    },
    [refresh],
  );

  const openCreate = useCallback(() => {
    setCreating(true);
    setNewName("");
    setNewDescription("");
    setNewColor("rose");
    setError(null);
    requestAnimationFrame(() => newInputRef.current?.focus());
  }, []);

  const create = useCallback(async () => {
    const name = newName.trim();
    if (!name) {
      setError("Give the flag a name.");
      return;
    }
    setBusyId("__new__");
    const ok = await call("/api/workspace/message-flags", "POST", {
      name,
      color: newColor,
      ...(newDescription.trim() ? { description: newDescription.trim() } : {}),
    });
    setBusyId(null);
    if (ok) setCreating(false);
  }, [call, newName, newColor, newDescription]);

  const patch = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      setBusyId(id);
      await call(`/api/workspace/message-flags/${id}`, "PATCH", body);
      setBusyId(null);
    },
    [call],
  );

  const remove = useCallback(
    async (def: MessageFlagDefinitionWithUsage) => {
      const ok = await confirm({
        title: `Delete “${def.name}”?`,
        description: "This flag has never been raised, so nothing is lost.",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!ok) return;
      setBusyId(def.id);
      await call(`/api/workspace/message-flags/${def.id}`, "DELETE");
      setBusyId(null);
    },
    [call, confirm],
  );

  const archive = useCallback(
    async (def: MessageFlagDefinitionWithUsage) => {
      const ok = await confirm({
        title: `Archive “${def.name}”?`,
        description:
          `It will disappear from the flag picker, but the ${def.totalCount} message(s) ` +
          "already flagged with it keep showing it. You can un-archive at any time.",
        confirmLabel: "Archive",
      });
      if (!ok) return;
      await patch(def.id, { archived: true });
    },
    [confirm, patch],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Message flags"
        description="Triage labels an agent puts on a single message — “Complaint”, “Refund request” — each with an open / resolved lifecycle. Different from contact tags, which label a person and drive broadcast audiences."
        action={
          !creating && (
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-3.5" />
              New flag
            </Button>
          )
        }
      />

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {creating && (
        <div className="space-y-3 rounded-lg border p-4">
          <Input
            ref={newInputRef}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Flag name (e.g. Complaint)"
            maxLength={40}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
              if (e.key === "Escape") setCreating(false);
            }}
          />
          <Input
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            placeholder="What does this flag mean? (optional — shown in the picker)"
            maxLength={200}
          />
          <ColorRow value={newColor} onChange={setNewColor} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={busyId === "__new__"} onClick={() => void create()}>
              {busyId === "__new__" && <Loader2 className="size-3.5 animate-spin" />}
              Create
            </Button>
          </div>
        </div>
      )}

      {active.length === 0 && !creating ? (
        <EmptyState
          icon={Flag}
          title="No message flags yet"
          description="Create one — “Complaint”, “Refund request”, “Bug report” — and agents can flag any message from its ⋯ menu in the inbox. Flagged messages collect in the Flagged queue until someone resolves them."
          action={
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-3.5" />
              New flag
            </Button>
          }
        />
      ) : (
        <ul className="divide-y rounded-lg border">
          {active.map((def) => (
            <DefinitionRow
              key={def.id}
              def={def}
              busy={busyId === def.id}
              onPatch={(body) => void patch(def.id, body)}
              onArchive={() => void archive(def)}
              onDelete={() => void remove(def)}
            />
          ))}
        </ul>
      )}

      {archived.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Archived</h2>
          <ul className="divide-y rounded-lg border opacity-70">
            {archived.map((def) => (
              <li key={def.id} className="flex items-center gap-3 px-4 py-3">
                <span
                  className={cn("size-2.5 rounded-full", tagColorClasses(def.color).solid)}
                />
                <span className="min-w-0 flex-1 truncate text-sm">{def.name}</span>
                <span className="shrink-0 text-2xs text-muted-foreground">
                  {def.totalCount} raised
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyId === def.id}
                  onClick={() => void patch(def.id, { archived: false })}
                >
                  <ArchiveRestore className="size-3.5" />
                  Un-archive
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {confirmDialog}
    </div>
  );
}

function DefinitionRow({
  def,
  busy,
  onPatch,
  onArchive,
  onDelete,
}: {
  def: MessageFlagDefinitionWithUsage;
  busy: boolean;
  onPatch: (body: Record<string, unknown>) => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(def.name);
  const [description, setDescription] = useState(def.description ?? "");
  useEffect(() => setName(def.name), [def.name]);
  useEffect(() => setDescription(def.description ?? ""), [def.description]);

  // Never used → a real delete is safe. Used → the history must survive, so
  // Archive is the only option (and the server rejects the delete regardless).
  const deletable = def.totalCount === 0;

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3">
      {/* The colour picker IS the row's colour indicator — it used to sit on
          its own line under the description while a second, non-interactive dot
          sat beside the name. Two swatches saying the same thing, and a wasted
          line of height per flag. One control, leading the row. */}
      <ColorRow
        value={def.color as TagColor}
        onChange={(color) => onPatch({ color })}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              const next = name.trim();
              if (next && next !== def.name) onPatch({ name: next });
              else setName(def.name);
            }}
            maxLength={40}
            className="h-7 border-transparent bg-transparent px-1 text-sm font-medium hover:border-border focus:border-border"
          />
        </div>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => {
            const next = description.trim();
            if (next !== (def.description ?? "")) onPatch({ description: next || null });
          }}
          placeholder="Add a description…"
          maxLength={200}
          className="h-7 border-transparent bg-transparent px-1 text-xs text-muted-foreground hover:border-border focus:border-border"
        />
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <span className="text-2xs text-muted-foreground">
          {def.totalCount} raised
          {def.openCount > 0 && (
            <>
              {" · "}
              <span className="font-medium text-foreground">{def.openCount} open</span>
            </>
          )}
        </span>
        {busy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        {deletable ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-destructive"
            title="Delete"
            aria-label="Delete"
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            title="Archive — hides it from the picker, keeps the history"
            aria-label="Archive"
            onClick={onArchive}
          >
            <Archive className="size-3.5" />
          </Button>
        )}
      </div>
    </li>
  );
}

function ColorRow({
  value,
  onChange,
}: {
  value: TagColor;
  onChange: (color: TagColor) => void;
  compact?: boolean;
}) {
  return (
    <ColorSwatchPicker selected={value} onChange={onChange} label="flag colour" />
  );
}
