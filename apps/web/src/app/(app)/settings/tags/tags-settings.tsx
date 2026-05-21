"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpDown,
  Check,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Users,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import { TAG_COLORS, type Tag, type TagColor } from "@ccp/shared/types";
import { cn } from "@ccp/shared/utils";

/**
 * Tag catalog manager — mirrors the stages-settings UX so admins don't have
 * to relearn the pattern. Each row:
 *   - color swatch row (clickable; persists on click)
 *   - inline-rename input (click the name to edit)
 *   - usage count + "view contacts" link
 *   - delete button (always safe — just unlinks contacts; the tag itself
 *     vanishes from their chip rows on the next page render)
 *
 * The list has a search box (filter by name) and a sort control (newest /
 * oldest / name / usage); the choice persists per-browser in localStorage.
 * Default order is newest-first by creation time. No reorder UI (ordering is
 * by sort key, not positional) and no "default tag" (the catalog has no
 * implicit default — contacts start with an empty tag set).
 */
export function TagsSettings({
  initialTags,
  initialUsage,
}: {
  initialTags: Tag[];
  initialUsage: Record<string, number>;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const [tags, setTags] = useState<Tag[]>(initialTags);
  const [usage, setUsage] = useState<Record<string, number>>(initialUsage);
  // Sync from SSR-re-runs (router.refresh from useCatalogSync) so a teammate's
  // tag additions/renames show up without manual refresh.
  useEffect(() => {
    setTags(initialTags);
  }, [initialTags]);
  useEffect(() => {
    setUsage(initialUsage);
  }, [initialUsage]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<TagColor>("sky");
  const [busyId, setBusyId] = useState<string | null>(null);
  const newInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("newest");
  // Restore the saved sort after mount (not via a lazy initializer) so the
  // SSR markup and first client render agree on "newest" — reading
  // localStorage during render would hydration-mismatch.
  useEffect(() => {
    const saved = localStorage.getItem(SORT_STORAGE_KEY);
    if (saved && SORT_OPTIONS.some((o) => o.key === saved)) {
      setSortBy(saved as SortKey);
    }
  }, []);
  const changeSort = useCallback((key: SortKey) => {
    setSortBy(key);
    try {
      localStorage.setItem(SORT_STORAGE_KEY, key);
    } catch {
      // storage disabled (private mode) — sort still works for the session
    }
  }, []);

  const totalUsage = useMemo(
    () => Object.values(usage).reduce((a, b) => a + b, 0),
    [usage],
  );

  const openCreate = useCallback(() => {
    setCreating(true);
    setNewName("");
    setNewColor("sky");
    setError(null);
    requestAnimationFrame(() => newInputRef.current?.focus());
  }, []);

  const createTag = useCallback(async () => {
    const name = newName.trim();
    if (!name) {
      setError("Tag needs a name.");
      return;
    }
    setBusyId("__new__");
    setError(null);
    try {
      const res = await fetch("/api/team/tags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color: newColor }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        tag?: Tag;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !body.tag) {
        setError(body.detail || body.error || `Couldn't create (HTTP ${res.status})`);
        return;
      }
      setTags((cur) => [body.tag!, ...cur]);
      setUsage((cur) => ({ ...cur, [body.tag!.id]: 0 }));
      setCreating(false);
      setNewName("");
    } finally {
      setBusyId(null);
    }
  }, [newName, newColor]);

  const patchTag = useCallback(
    async (id: string, patch: Partial<Pick<Tag, "name" | "color">>) => {
      setBusyId(id);
      setError(null);
      // Optimistic update; rollback on failure. The server validates the
      // 40-char limit + 409 on duplicate name, so the optimistic state can
      // momentarily disagree with the server.
      const prev = tags;
      setTags((cur) =>
        cur.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      );
      try {
        const res = await fetch(`/api/team/tags/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          setTags(prev);
          setError(body.detail || body.error || `Update failed (HTTP ${res.status})`);
        }
      } catch {
        setTags(prev);
        setError("Network error");
      } finally {
        setBusyId(null);
      }
    },
    [tags],
  );

  const deleteTag = useCallback(
    async (tag: Tag) => {
      const used = usage[tag.id] ?? 0;
      const ok = await confirm({
        title: `Delete "${tag.name}"?`,
        description:
          used > 0
            ? `${used} contact${used === 1 ? " currently carries" : "s currently carry"} this tag. Deleting it removes the tag from those contacts — their other tags are unaffected. The action can't be undone.`
            : `This tag isn't on any contact right now. Deleting it can't be undone.`,
        confirmLabel: "Delete tag",
        destructive: true,
      });
      if (!ok) return;
      setBusyId(tag.id);
      setError(null);
      try {
        const res = await fetch(`/api/team/tags/${tag.id}`, { method: "DELETE" });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          setError(body.detail || body.error || `Delete failed (HTTP ${res.status})`);
          return;
        }
        setTags((cur) => cur.filter((t) => t.id !== tag.id));
        setUsage((cur) => {
          const { [tag.id]: _drop, ...rest } = cur;
          void _drop;
          return rest;
        });
      } finally {
        setBusyId(null);
      }
    },
    [confirm, usage],
  );

  const visibleTags = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? tags.filter((t) => t.name.toLowerCase().includes(q))
      : tags;
    return sortTags(filtered, sortBy, usage);
  }, [tags, query, sortBy, usage]);

  const sortLabel =
    SORT_OPTIONS.find((o) => o.key === sortBy)?.label ?? "Newest first";

  return (
    <div>
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Tags</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Labels for segmenting contacts. Use tags to filter the contacts
            list and to target audience-based broadcasts. Removing a tag from
            a contact only unlinks it — the tag itself stays in the catalog
            until you delete it here.
          </p>
        </div>
        <Button onClick={openCreate} disabled={creating}>
          <Plus className="size-4" />
          Add tag
        </Button>
      </header>

      {tags.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-50 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tags…"
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-9 shrink-0">
                <ArrowUpDown className="size-4" />
                {sortLabel}
                <ChevronDown className="size-3.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuLabel>Sort by</DropdownMenuLabel>
              {SORT_OPTIONS.map((opt) => (
                <DropdownMenuCheckboxItem
                  key={opt.key}
                  checked={sortBy === opt.key}
                  onCheckedChange={() => changeSort(opt.key)}
                >
                  {opt.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {error && (
        <div className="mb-3 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <ul className="divide-y divide-border">
          {creating && (
            <li className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <TagDot color={newColor} />
                <Input
                  ref={newInputRef}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void createTag();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setCreating(false);
                    }
                  }}
                  placeholder="New tag name…"
                  maxLength={40}
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
                    onClick={() => void createTag()}
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
          {visibleTags.map((tag) => (
            <TagRow
              key={tag.id}
              tag={tag}
              count={usage[tag.id] ?? 0}
              busy={busyId === tag.id}
              onRename={(name) => patchTag(tag.id, { name })}
              onRecolor={(color) => patchTag(tag.id, { color })}
              onDelete={() => deleteTag(tag)}
            />
          ))}
        </ul>
        {tags.length === 0 && !creating && (
          <div className="px-6 py-10 text-center text-sm text-muted-foreground">
            No tags yet. Click <span className="font-medium">Add tag</span> to create one.
          </div>
        )}
        {tags.length > 0 && visibleTags.length === 0 && !creating && (
          <div className="px-6 py-10 text-center text-sm text-muted-foreground">
            No tags match <span className="font-medium">“{query.trim()}”</span>.
          </div>
        )}
      </div>

      <div className="mt-6 text-xs text-muted-foreground">
        <p>
          {query.trim()
            ? `${visibleTags.length} of ${tags.length} tag${tags.length === 1 ? "" : "s"}`
            : `${tags.length} tag${tags.length === 1 ? "" : "s"}`}{" "}
          · {totalUsage} total contact-tag link{totalUsage === 1 ? "" : "s"}.
        </p>
      </div>

      {confirmDialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TagRow({
  tag,
  count,
  busy,
  onRename,
  onRecolor,
  onDelete,
}: {
  tag: Tag;
  count: number;
  busy: boolean;
  onRename: (name: string) => void;
  onRecolor: (color: TagColor) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tag.name);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEditing() {
    setDraft(tag.name);
    setEditing(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }

  function commit() {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === tag.name) return;
    onRename(next);
  }

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <TagDot color={tag.color} />

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
          maxLength={40}
          className="h-8 max-w-xs text-sm"
        />
      ) : (
        <button
          type="button"
          onClick={startEditing}
          className="group inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-sm font-medium hover:bg-accent"
        >
          <span>{tag.name}</span>
          <Pencil className="size-3 opacity-0 transition-opacity group-hover:opacity-50" />
        </button>
      )}

      <ColorSwatches selected={tag.color} onChange={onRecolor} compact />

      <a
        href={`/contacts?tag=${tag.id}`}
        title={`View contacts tagged "${tag.name}"`}
        className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Users className="size-3" />
        <span className="tabular-nums">{count}</span>
      </a>

      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        aria-label={`Delete ${tag.name}`}
        className="inline-flex size-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
      </button>
    </li>
  );
}

function TagDot({ color }: { color: TagColor }) {
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
            {selected === c && <CheckCircle2 className="size-3 text-background opacity-0" />}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search + sort
// ---------------------------------------------------------------------------

type SortKey =
  | "newest"
  | "oldest"
  | "name-asc"
  | "name-desc"
  | "usage-desc"
  | "usage-asc";

const SORT_STORAGE_KEY = "tags-settings:sort";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "newest", label: "Newest first" },
  { key: "oldest", label: "Oldest first" },
  { key: "name-asc", label: "Name (A–Z)" },
  { key: "name-desc", label: "Name (Z–A)" },
  { key: "usage-desc", label: "Most used" },
  { key: "usage-asc", label: "Least used" },
];

/**
 * Pure sort over a copy. `createdAt` is an ISO-8601 string, so a lexical
 * compare is chronological. Usage sorts tie-break on name so equal-count tags
 * stay stable and alphabetical.
 */
function sortTags(
  tags: Tag[],
  sortBy: SortKey,
  usage: Record<string, number>,
): Tag[] {
  const out = [...tags];
  switch (sortBy) {
    case "newest":
      return out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    case "oldest":
      return out.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    case "name-asc":
      return out.sort((a, b) => a.name.localeCompare(b.name));
    case "name-desc":
      return out.sort((a, b) => b.name.localeCompare(a.name));
    case "usage-desc":
      return out.sort(
        (a, b) => (usage[b.id] ?? 0) - (usage[a.id] ?? 0) || a.name.localeCompare(b.name),
      );
    case "usage-asc":
      return out.sort(
        (a, b) => (usage[a.id] ?? 0) - (usage[b.id] ?? 0) || a.name.localeCompare(b.name),
      );
  }
}

