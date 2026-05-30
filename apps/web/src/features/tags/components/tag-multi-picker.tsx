"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Plus, Search, Tag as TagIcon } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client-fetch";
import { cn } from "@ccp/shared/utils";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import { TAG_COLORS, type Tag, type TagColor } from "@ccp/shared/types";

import { TagChip } from "./tag-chip";

/**
 * Multi-select tag picker.
 *
 *   - Show every team tag as a toggleable row (check appears when selected).
 *   - Type to filter; if the typed string doesn't match an existing tag, an
 *     inline "Create '<name>'" row appears at the bottom with a color picker.
 *   - Controlled: parent owns `selectedIds`. `onSelectedChange` fires every
 *     toggle; `onCreated` fires when the user creates a brand-new tag (parent
 *     should splice it into its `tags` array AND auto-select it).
 *
 * The picker is render-as-popover — pass `open` + `onOpenChange` and place
 * inside any positioned parent. It auto-focuses the search input on open.
 */
export function TagMultiPicker({
  tags,
  selectedIds,
  onSelectedChange,
  onCreated,
  className,
}: {
  tags: Tag[];
  selectedIds: string[];
  onSelectedChange: (next: string[]) => void;
  onCreated: (tag: Tag) => void;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newColor, setNewColor] = useState<TagColor>("sky");
  const [createError, setCreateError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter((t) => t.name.toLowerCase().includes(q));
  }, [tags, query]);

  const exactMatch = useMemo(() => {
    const q = query.trim();
    if (!q) return null;
    return tags.find((t) => t.name.toLowerCase() === q.toLowerCase()) ?? null;
  }, [tags, query]);

  const canCreate = query.trim().length > 0 && !exactMatch;

  function toggle(id: string) {
    if (selectedIds.includes(id)) {
      onSelectedChange(selectedIds.filter((x) => x !== id));
    } else {
      onSelectedChange([...selectedIds, id]);
    }
  }

  async function createTag() {
    const name = query.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await apiFetch("/api/team/tags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color: newColor }),
      });
      const data = (await res.json()) as { tag?: Tag; error?: string; detail?: string };
      if (!res.ok || !data.tag) {
        throw new Error(
          [data.error, data.detail].filter(Boolean).join(": ") ||
            `HTTP ${res.status}`,
        );
      }
      onCreated(data.tag);
      setQuery("");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div
      className={cn(
        "flex max-h-90 min-w-65 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-xl",
        className,
      )}
    >
      <div className="border-b border-border px-2.5 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCreateError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canCreate) {
                e.preventDefault();
                void createTag();
              }
            }}
            placeholder="Search or create a tag…"
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && !canCreate ? (
          <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">
            No tags yet. Type a name to create one.
          </div>
        ) : (
          <ul>
            {filtered.map((t) => {
              const selected = selectedIds.includes(t.id);
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => toggle(t.id)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-accent/60",
                      selected && "bg-accent/30",
                    )}
                  >
                    <TagChip tag={t} size="xs" />
                    <span className="flex-1" />
                    {selected ? (
                      <Check className="size-3.5 text-primary" />
                    ) : (
                      <span className="size-3.5" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <AnimatePresence>
        {canCreate && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-t border-border bg-muted/30"
          >
            <div className="px-2.5 py-2">
              <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                Create new
              </div>
              <div className="flex items-center gap-2">
                <TagChip
                  tag={{
                    id: "preview",
                    teamId: "preview",
                    name: query.trim() || "new tag",
                    color: newColor,
                  }}
                  size="sm"
                />
                <button
                  type="button"
                  onClick={() => void createTag()}
                  disabled={creating}
                  className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                >
                  {creating ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Plus className="size-3" />
                  )}
                  Create
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {TAG_COLORS.map((c) => {
                  const colors = tagColorClasses(c);
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setNewColor(c)}
                      className={cn(
                        "size-5 cursor-pointer rounded-full ring-1 ring-border transition-transform",
                        colors.solid,
                        newColor === c && "ring-2 ring-offset-2 ring-offset-popover ring-foreground/60 scale-110",
                      )}
                      aria-label={`${c} color`}
                    />
                  );
                })}
              </div>
              {createError && (
                <div className="mt-2 text-[10px] text-destructive">{createError}</div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Convenience hook: derive the Tag objects from the catalog given a set of
 * ids. Returns them in catalog order (alphabetical) so chip rows stay stable.
 */
export function pickTags(tags: Tag[], ids: string[]): Tag[] {
  const set = new Set(ids);
  return tags.filter((t) => set.has(t.id));
}

/**
 * Re-export TagIcon so call sites can use a consistent icon set without
 * pulling from lucide directly.
 */
export { TagIcon };
