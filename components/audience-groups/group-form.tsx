"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Loader2,
  Save,
  Search,
  Send,
  Tag as TagIcon,
  Trash2,
  Users,
  UserPlus,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TagChip } from "@/components/tags/tag-chip";
import { cn, formatPhone, initials } from "@/lib/utils";
import type { Contact, Tag } from "@/lib/types";
import type { AudienceGroupDto } from "@/lib/queries";

/**
 * Reusable form for creating or editing an audience group.
 *
 * One page, two halves:
 *   - Top: name, optional description.
 *   - Middle: TAG section (every contact carrying ANY selected tag joins).
 *   - Bottom: MANUAL section (chip input — hand-picked contacts always in).
 *
 * Members at send time = union of both. The form shows a live count
 * (recomputed in-memory against the contacts list) so the agent can sanity-
 * check before saving.
 */

export interface GroupFormProps {
  /** When set, the form starts in "edit" mode pre-filled from this dto. */
  initial?: AudienceGroupDto;
  contacts: Contact[];
  tags: Tag[];
}

export function GroupForm({ initial, contacts, tags }: GroupFormProps) {
  const router = useRouter();

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [tagIds, setTagIds] = useState<string[]>(initial?.tagIds ?? []);
  const [manualContactIds, setManualContactIds] = useState<string[]>(
    initial?.contactIds ?? [],
  );
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const contactById = useMemo(
    () => new Map(contacts.map((c) => [c.id, c] as const)),
    [contacts],
  );
  const tagById = useMemo(
    () => new Map(tags.map((t) => [t.id, t] as const)),
    [tags],
  );

  // Resolved live member count — same union logic the server uses.
  const memberPreview = useMemo(() => {
    const tagSet = new Set(tagIds);
    const manualSet = new Set(manualContactIds);
    const matched = new Set<string>(manualContactIds);
    if (tagSet.size > 0) {
      for (const c of contacts) {
        if (matched.has(c.id)) continue;
        if ((c.tagIds ?? []).some((id) => tagSet.has(id))) {
          matched.add(c.id);
        }
      }
    }
    return {
      total: matched.size,
      manualCount: manualSet.size,
      taggedOnlyCount: matched.size - manualSet.size,
    };
  }, [contacts, tagIds, manualContactIds]);

  async function submit() {
    setError(null);
    if (!name.trim()) {
      setError("Group name is required");
      return;
    }
    setSubmitting(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        tagIds,
        contactIds: manualContactIds,
      };
      const res = initial
        ? await fetch(`/api/team/audience-groups/${initial.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        : await fetch("/api/team/audience-groups", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
        };
        setError(
          [data.error, data.detail].filter(Boolean).join(": ") ||
            `HTTP ${res.status}`,
        );
        return;
      }
      router.push("/broadcasts/groups");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteGroup() {
    if (!initial) return;
    if (
      !confirm(
        `Delete group "${initial.name}"? Past broadcasts that used it stay in your history. Can't be undone.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(`/api/team/audience-groups/${initial.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      router.push("/broadcasts/groups");
      router.refresh();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-2">
        <Link
          href="/broadcasts/groups"
          className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to groups
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {initial ? "Edit group" : "New audience group"}
        </h1>
        <p className="text-sm text-muted-foreground">
          A reusable list of contacts you can broadcast to in one click. Mix
          tag-based membership (dynamic) with hand-picked contacts (manual) —
          the group is the union of both at send time.
        </p>
      </header>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Name <span className="text-destructive">*</span>
            </span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ramadan customers, Important customers"
              maxLength={80}
              autoFocus
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Description <span className="text-muted-foreground">(optional)</span>
            </span>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Anything that helps you remember who this group is for."
              rows={2}
              maxLength={500}
            />
          </label>
        </div>
      </section>

      <TagSection
        tags={tags}
        selectedTagIds={tagIds}
        onChange={setTagIds}
      />

      <ManualContactsSection
        contacts={contacts}
        selectedIds={manualContactIds}
        onChange={setManualContactIds}
      />

      <PreviewCard
        total={memberPreview.total}
        manualCount={memberPreview.manualCount}
        taggedCount={memberPreview.taggedOnlyCount}
        sampleManual={manualContactIds
          .slice(0, 5)
          .map((id) => contactById.get(id))
          .filter((c): c is Contact => Boolean(c))}
        sampleTags={tagIds
          .slice(0, 5)
          .map((id) => tagById.get(id))
          .filter((t): t is Tag => Boolean(t))}
      />

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}

      <div className="sticky bottom-0 -mx-6 border-t border-border bg-background/95 px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-2">
          {initial && (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={deleteGroup}
                disabled={deleting || submitting}
                className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                {deleting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                Delete group
              </Button>
              <Link
                href={`/broadcasts/new?groupId=${initial.id}`}
                className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent"
                title="Start a broadcast with this group as the audience"
              >
                <Send className="size-3.5" />
                Send broadcast
              </Link>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Link
              href="/broadcasts/groups"
              className="inline-flex h-9 cursor-pointer items-center rounded-md px-4 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Cancel
            </Link>
            <Button
              type="button"
              onClick={submit}
              disabled={submitting || !name.trim()}
              className="gap-1.5"
            >
              {submitting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              {initial ? "Save changes" : "Create group"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TagSection({
  tags,
  selectedTagIds,
  onChange,
}: {
  tags: Tag[];
  selectedTagIds: string[];
  onChange: (next: string[]) => void;
}) {
  function toggle(id: string) {
    onChange(
      selectedTagIds.includes(id)
        ? selectedTagIds.filter((x) => x !== id)
        : [...selectedTagIds, id],
    );
  }
  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="inline-flex size-7 items-center justify-center rounded-md bg-sky-500/10 text-sky-700 dark:text-sky-300">
            <TagIcon className="size-3.5" />
          </div>
          <div>
            <div className="text-sm font-semibold">By tag (dynamic)</div>
            <div className="text-[11px] text-muted-foreground">
              Every contact carrying ANY selected tag joins automatically.
            </div>
          </div>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {selectedTagIds.length} selected
        </span>
      </header>
      <div className="px-4 py-3">
        {tags.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-4 text-center text-[12px] text-muted-foreground">
            No tags yet. Tag some contacts on the Contacts page first.
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <TagChip
                key={t.id}
                tag={t}
                size="md"
                onClick={() => toggle(t.id)}
                selected={selectedTagIds.includes(t.id)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ManualContactsSection({
  contacts,
  selectedIds,
  onChange,
}: {
  contacts: Contact[];
  selectedIds: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const byId = useMemo(
    () => new Map(contacts.map((c) => [c.id, c] as const)),
    [contacts],
  );
  const selected = useMemo(
    () => selectedIds.map((id) => byId.get(id)).filter((c): c is Contact => Boolean(c)),
    [selectedIds, byId],
  );
  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    const picked = new Set(selectedIds);
    return contacts
      .filter((c) => !picked.has(c.id))
      .filter((c) => {
        if (q.length === 0) return true;
        return (
          c.name.toLowerCase().includes(q) ||
          c.phoneNumber.toLowerCase().includes(q) ||
          (c.email ?? "").toLowerCase().includes(q)
        );
      })
      .slice(0, 50);
  }, [contacts, selectedIds, query]);

  function add(id: string) {
    if (selectedIds.includes(id)) return;
    onChange([...selectedIds, id]);
    setQuery("");
    inputRef.current?.focus();
  }
  function remove(id: string) {
    onChange(selectedIds.filter((x) => x !== id));
  }

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="inline-flex size-7 items-center justify-center rounded-md bg-violet-500/10 text-violet-700 dark:text-violet-300">
            <UserPlus className="size-3.5" />
          </div>
          <div>
            <div className="text-sm font-semibold">Hand-picked contacts (manual)</div>
            <div className="text-[11px] text-muted-foreground">
              These specific contacts are always in the group, regardless of tags.
            </div>
          </div>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {selected.length} selected
        </span>
      </header>
      <div ref={containerRef} className="relative px-4 py-3">
        <div
          className={cn(
            "flex min-h-[44px] flex-wrap items-center gap-1.5 rounded-xl border border-input bg-background px-2 py-1.5 shadow-xs transition-colors",
            open && "ring-2 ring-ring",
          )}
          onClick={() => {
            inputRef.current?.focus();
            setOpen(true);
          }}
        >
          {selected.length === 0 && (
            <Search className="ml-1 size-3.5 shrink-0 text-muted-foreground" />
          )}
          <AnimatePresence initial={false}>
            {selected.map((c) => (
              <motion.span
                key={c.id}
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92 }}
                transition={{ duration: 0.12 }}
                className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 py-0.5 pl-0.5 pr-1.5 text-xs"
              >
                <Avatar className="size-5">
                  <AvatarFallback className="text-[9px]">{initials(c.name)}</AvatarFallback>
                </Avatar>
                <span className="font-medium">{c.name}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(c.id);
                  }}
                  className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                  aria-label={`Remove ${c.name}`}
                >
                  <X className="size-3" />
                </button>
              </motion.span>
            ))}
          </AnimatePresence>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Backspace" && query.length === 0 && selectedIds.length > 0) {
                e.preventDefault();
                const lastId = selectedIds[selectedIds.length - 1];
                if (lastId) remove(lastId);
              }
            }}
            placeholder={
              selected.length === 0 ? "Search by name, phone, or email…" : "Add another…"
            }
            className="min-w-[140px] flex-1 border-0 bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.12 }}
              className="absolute left-4 right-4 z-20 mt-1 max-h-72 overflow-y-auto rounded-xl border border-border bg-popover shadow-xl"
            >
              {suggestions.length === 0 ? (
                <div className="px-4 py-3 text-[12px] text-muted-foreground">
                  {query.trim().length > 0
                    ? `No contacts match "${query}".`
                    : "No more contacts to add."}
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {suggestions.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => add(c.id)}
                        className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent/60"
                      >
                        <Avatar className="size-7">
                          <AvatarFallback className="text-[10px]">{initials(c.name)}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{c.name}</div>
                          <div className="truncate text-[11px] text-muted-foreground">
                            {formatPhone(c.phoneNumber)}
                          </div>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

function PreviewCard({
  total,
  manualCount,
  taggedCount,
  sampleManual,
  sampleTags,
}: {
  total: number;
  manualCount: number;
  taggedCount: number;
  sampleManual: Contact[];
  sampleTags: Tag[];
}) {
  return (
    <section className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
      <div className="flex items-center gap-2 text-sm">
        <Users className="size-4 text-emerald-700 dark:text-emerald-300" />
        <span className="font-medium text-emerald-700 dark:text-emerald-300">
          {total === 0
            ? "No members yet"
            : `${total} member${total === 1 ? "" : "s"} right now`}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        {manualCount} hand-picked · {taggedCount} via tag membership · live count, recomputed at send time
      </div>
      {(sampleTags.length > 0 || sampleManual.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {sampleTags.map((t) => (
            <TagChip key={t.id} tag={t} size="xs" />
          ))}
          {sampleManual.map((c) => (
            <span
              key={c.id}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[11px]"
            >
              <Avatar className="size-3.5">
                <AvatarFallback className="text-[8px]">{initials(c.name)}</AvatarFallback>
              </Avatar>
              {c.name}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
