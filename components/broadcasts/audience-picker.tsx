"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, FolderHeart, Search, Tag as TagIcon, Users, X, UserPlus } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { cn, initials, formatPhone } from "@/lib/utils";
import { TagChip } from "@/components/tags/tag-chip";
import type { Contact, Tag } from "@/lib/types";
import type { AudienceGroupDto } from "@/lib/queries";

/**
 * Two-mode audience picker for the broadcast wizard.
 *
 *   "all"      — every contact in the team becomes a recipient at send time.
 *                The server expands the audience server-side so the snapshot
 *                is consistent even if contacts get added mid-flight.
 *   "selected" — agent builds a list of specific contacts. The chip input is
 *                a search-as-you-type field; suggestions appear in a dropdown
 *                below; clicking adds a chip; X removes one.
 *
 * The picker is fully presentational. The parent owns the selected ids and
 * is responsible for resolving them to contact rows.
 */

export type AudienceMode = "all" | "selected" | "by_tag" | "group";

export interface AudienceState {
  mode: AudienceMode;
  selectedIds: string[];
  selectedTagIds: string[];
  selectedGroupId: string | null;
}

export function AudiencePicker({
  contacts,
  tags,
  groups,
  totalContactCount,
  value,
  onChange,
}: {
  /** All contacts the agent can pick from. Already loaded by the page. */
  contacts: Contact[];
  /** All team tags available for by-tag mode. */
  tags: Tag[];
  /** All saved audience groups for "from group" mode. */
  groups: AudienceGroupDto[];
  /** Same as contacts.length on first render — kept separate so the "All
   *  contacts" hint can stay accurate while the list is filtered. */
  totalContactCount: number;
  value: AudienceState;
  onChange: (next: AudienceState) => void;
}) {
  // For by_tag mode: count contacts that have at least one of the selected
  // tags. Computed client-side from the in-memory list so the agent sees a
  // live count as they pick tags. Server re-validates at send time.
  const taggedCount = useMemo(() => {
    if (value.selectedTagIds.length === 0) return 0;
    const tagSet = new Set(value.selectedTagIds);
    return contacts.filter((c) =>
      (c.tagIds ?? []).some((id) => tagSet.has(id)),
    ).length;
  }, [contacts, value.selectedTagIds]);

  return (
    <div className="flex flex-col gap-4">
      <ModeToggle value={value.mode} onChange={(mode) => onChange({ ...value, mode })} />

      <AnimatePresence mode="wait" initial={false}>
        {value.mode === "all" ? (
          <motion.div
            key="all"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
          >
            <AllContactsCard count={totalContactCount} />
          </motion.div>
        ) : value.mode === "by_tag" ? (
          <motion.div
            key="by_tag"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
          >
            <TagAudienceSelector
              tags={tags}
              selectedTagIds={value.selectedTagIds}
              onChange={(selectedTagIds) => onChange({ ...value, selectedTagIds })}
              recipientCount={taggedCount}
            />
          </motion.div>
        ) : value.mode === "group" ? (
          <motion.div
            key="group"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
          >
            <GroupSelector
              groups={groups}
              selectedGroupId={value.selectedGroupId}
              onChange={(selectedGroupId) => onChange({ ...value, selectedGroupId })}
            />
          </motion.div>
        ) : (
          <motion.div
            key="selected"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
          >
            <SelectedContactsInput
              contacts={contacts}
              selectedIds={value.selectedIds}
              onChange={(selectedIds) => onChange({ ...value, selectedIds })}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ModeToggle({
  value,
  onChange,
}: {
  value: AudienceMode;
  onChange: (next: AudienceMode) => void;
}) {
  return (
    <div className="inline-flex w-fit flex-wrap rounded-md border border-border bg-muted/40 p-0.5">
      <ModeButton active={value === "group"} onClick={() => onChange("group")} icon={FolderHeart}>
        Saved group
      </ModeButton>
      <ModeButton active={value === "selected"} onClick={() => onChange("selected")} icon={UserPlus}>
        Pick contacts
      </ModeButton>
      <ModeButton active={value === "by_tag"} onClick={() => onChange("by_tag")} icon={TagIcon}>
        By tag
      </ModeButton>
      <ModeButton active={value === "all"} onClick={() => onChange("all")} icon={Users}>
        All contacts
      </ModeButton>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Users;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium transition-colors",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {active && (
        <motion.span
          layoutId="audience-mode-pill"
          className="absolute inset-0 rounded bg-card shadow-xs ring-1 ring-border"
          transition={{ type: "spring", duration: 0.25, bounce: 0.18 }}
        />
      )}
      <Icon className="relative size-3.5" />
      <span className="relative">{children}</span>
    </button>
  );
}

function TagAudienceSelector({
  tags,
  selectedTagIds,
  onChange,
  recipientCount,
}: {
  tags: Tag[];
  selectedTagIds: string[];
  onChange: (next: string[]) => void;
  recipientCount: number;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter((t) => t.name.toLowerCase().includes(q));
  }, [tags, query]);

  function toggle(id: string) {
    onChange(
      selectedTagIds.includes(id)
        ? selectedTagIds.filter((x) => x !== id)
        : [...selectedTagIds, id],
    );
  }

  if (tags.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-4 text-center text-[12px] text-muted-foreground">
        No tags yet. Tag some contacts first (Contacts page) then come back.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tags…"
          className="h-9 pl-8"
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {filtered.map((t) => (
          <TagChip
            key={t.id}
            tag={t}
            size="md"
            onClick={() => toggle(t.id)}
            selected={selectedTagIds.includes(t.id)}
          />
        ))}
        {filtered.length === 0 && (
          <span className="text-[12px] text-muted-foreground">
            No tags match &quot;{query}&quot;.
          </span>
        )}
      </div>

      <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-3">
        <div className="flex items-center gap-2 text-sm">
          <TagIcon className="size-4 text-sky-700 dark:text-sky-300" />
          <span className="font-medium text-sky-700 dark:text-sky-300">
            {selectedTagIds.length === 0
              ? "Pick at least one tag"
              : `Broadcast to ${recipientCount} contact${recipientCount === 1 ? "" : "s"}`}
          </span>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {selectedTagIds.length > 1
            ? "Contacts carrying ANY of the selected tags will receive the broadcast."
            : "Snapshot is taken when you send — contacts re-tagged later won't be added retroactively."}
        </p>
      </div>
    </div>
  );
}

function GroupSelector({
  groups,
  selectedGroupId,
  onChange,
}: {
  groups: AudienceGroupDto[];
  selectedGroupId: string | null;
  onChange: (id: string | null) => void;
}) {
  if (groups.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-[12px]">
        <FolderHeart className="mx-auto mb-1 size-5 text-muted-foreground" />
        <div className="text-foreground">No saved groups yet.</div>
        <p className="mt-1 text-muted-foreground">
          Create a reusable audience first.
        </p>
        <Link
          href="/broadcasts/groups/new"
          className="mt-2 inline-flex cursor-pointer items-center gap-1 rounded-md bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
        >
          New group
        </Link>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <ul className="overflow-hidden rounded-xl border border-border bg-background">
        {groups.map((g) => {
          const selected = g.id === selectedGroupId;
          return (
            <li key={g.id} className="border-b border-border last:border-b-0">
              <button
                type="button"
                onClick={() => onChange(selected ? null : g.id)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition-colors",
                  "hover:bg-accent/50 focus:bg-accent/50 focus:outline-none",
                  selected && "bg-primary/5 hover:bg-primary/5",
                )}
              >
                <div
                  className={cn(
                    "inline-flex size-8 shrink-0 items-center justify-center rounded-md",
                    selected
                      ? "bg-primary text-primary-foreground"
                      : "bg-primary/10 text-primary",
                  )}
                >
                  <FolderHeart className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{g.name}</span>
                    <span className="rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                      {g.memberCount} member{g.memberCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  {g.description && (
                    <div className="line-clamp-1 text-[11px] text-muted-foreground">
                      {g.description}
                    </div>
                  )}
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    {g.tagIds.length > 0 && (
                      <span>
                        {g.tagIds.length} tag{g.tagIds.length === 1 ? "" : "s"}
                      </span>
                    )}
                    {g.tagIds.length > 0 && g.contactIds.length > 0 && (
                      <span> · </span>
                    )}
                    {g.contactIds.length > 0 && (
                      <span>
                        {g.contactIds.length} manual contact
                        {g.contactIds.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                </div>
                {selected ? (
                  <span className="text-[11px] font-medium text-primary">Selected</span>
                ) : (
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          Members are resolved at send time — newly-tagged contacts added later
          don&apos;t join in-flight broadcasts.
        </span>
        <Link
          href="/broadcasts/groups"
          className="text-primary hover:underline"
        >
          Manage groups →
        </Link>
      </div>
    </div>
  );
}

function AllContactsCard({ count }: { count: number }) {
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex items-start gap-3">
        <div className="inline-flex size-9 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-300">
          <Users className="size-4" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-medium text-amber-700 dark:text-amber-300">
            Broadcast to <span className="tabular-nums">{count}</span> contact
            {count === 1 ? "" : "s"}
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            Every contact in this team will receive the template. Marketing
            templates are billed per recipient by Meta — double-check the
            preview before sending.
          </p>
        </div>
      </div>
    </div>
  );
}

function SelectedContactsInput({
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

  const byId = useMemo(
    () => new Map(contacts.map((c) => [c.id, c] as const)),
    [contacts],
  );
  const selected = useMemo(
    () => selectedIds.map((id) => byId.get(id)).filter((x): x is Contact => Boolean(x)),
    [selectedIds, byId],
  );

  // Hide the dropdown when clicking outside the chip container.
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

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

  function addContact(id: string) {
    if (selectedIds.includes(id)) return;
    onChange([...selectedIds, id]);
    setQuery("");
    inputRef.current?.focus();
  }
  function removeContact(id: string) {
    onChange(selectedIds.filter((x) => x !== id));
    inputRef.current?.focus();
  }

  return (
    <div ref={containerRef} className="relative">
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
              className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 py-0.5 pl-0.5 pr-1.5 text-xs text-foreground"
            >
              <Avatar className="size-5">
                <AvatarFallback className="text-[9px]">{initials(c.name)}</AvatarFallback>
              </Avatar>
              <span className="font-medium">{c.name}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeContact(c.id);
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
              if (lastId) removeContact(lastId);
            }
          }}
          placeholder={selected.length === 0 ? "Search by name, phone, or email…" : "Add another…"}
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
            className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-border bg-popover shadow-xl"
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
                      onClick={() => addContact(c.id)}
                      className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent/60 focus:bg-accent/60 focus:outline-none"
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

      <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          {selected.length} recipient{selected.length === 1 ? "" : "s"} selected
        </span>
        {selected.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-muted-foreground hover:text-foreground hover:underline"
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}
