"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Download,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Send,
  Tag as TagIcon,
  Trash2,
  Upload,
  X,
  TagsIcon,
  MinusCircle,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WindowBadge } from "@/components/inbox/window-badge";
import { avatarGradient } from "@/lib/avatar-color";
import { cn, formatListTime, formatPhone, initials } from "@/lib/utils";
import { TagChip, TagAddButton } from "@/components/tags/tag-chip";
import { TagMultiPicker } from "@/components/tags/tag-multi-picker";
import { tagColorClasses } from "@/lib/tag-colors";
import {
  TAG_COLORS,
  type TagColor,
} from "@/lib/types";
import type {
  ContactFieldDefinition,
  ContactListItem,
  ContactSource,
  ContactStage,
  Tag,
} from "@/lib/types";
import {
  ContactFilterBar,
  useContactList,
  type StageFilter,
} from "@/components/contacts/contact-browser";
import { SelectAllRow } from "@/components/contacts/contact-browser/select-all-row";
import { ContactStagePicker } from "@/components/contacts/contact-stage-picker";
import { useConfirm } from "@/components/ui/confirm-dialog";

import { ImportContactsDialog } from "./import-dialog";
import { NewContactDialog } from "./new-contact-dialog";
import { EditContactDialog } from "./edit-contact-dialog";

/**
 * Contacts directory.
 *
 * Search / filter / pagination all live in the shared `useContactList` hook
 * (the same one the contact-picker dialog uses), so this component only owns
 * the page-specific bits: bulk-action selection, the create/import/edit
 * dialogs, and the team tag + field catalogs.
 */
export function ContactsClient({
  initialItems,
  initialNextCursor,
  fieldDefinitions: initialFieldDefinitions,
  initialTags,
  initialStages,
  initialStageFilter,
  canManageFields,
  canManageStages,
}: {
  initialItems: ContactListItem[];
  initialNextCursor: string | null;
  fieldDefinitions: ContactFieldDefinition[];
  initialTags: Tag[];
  initialStages: ContactStage[];
  initialStageFilter: StageFilter;
  canManageFields: boolean;
  canManageStages: boolean;
}) {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const list = useContactList({
    initialItems,
    initialNextCursor,
    initialStageFilter,
  });
  const { items, setItems, setError } = list;
  // Lifted to state so dialogs can splice in newly-created definitions
  // without waiting on a router.refresh round trip.
  const [fieldDefinitions, setFieldDefinitions] =
    useState<ContactFieldDefinition[]>(initialFieldDefinitions);
  const [tags, setTags] = useState<Tag[]>(initialTags);
  const [stages] = useState<ContactStage[]>(initialStages);
  const tagById = useMemo(
    () => new Map(tags.map((t) => [t.id, t] as const)),
    [tags],
  );

  function patchContactStage(contactId: string, stageId: string | null) {
    setItems((prev) =>
      prev.map((row) =>
        row.contact.id === contactId
          ? { ...row, contact: { ...row.contact, stageId } }
          : row,
      ),
    );
  }
  // Selection state for bulk actions. Set<string> keeps add/remove O(1) and
  // makes "select all on this page" a simple union.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  // Contact id currently being edited — null = dialog closed. Storing the id
  // (not the row) means a list refetch mid-edit doesn't lose the dialog.
  const [editingId, setEditingId] = useState<string | null>(null);

  // Drop any selected ids that aren't in the current items (filter changed).
  useEffect(() => {
    setSelectedIds((prev) => {
      const visibleIds = new Set(items.map((i) => i.contact.id));
      const filtered = Array.from(prev).filter((id) => visibleIds.has(id));
      if (filtered.length === prev.size) return prev;
      return new Set(filtered);
    });
  }, [items]);

  // Patch a single contact's tag list in-place — used when the per-row tag
  // picker saves. Avoids a router.refresh that would also reset selection.
  function patchContactTags(contactId: string, tagIds: string[]) {
    setItems((prev) =>
      prev.map((row) =>
        row.contact.id === contactId
          ? { ...row, contact: { ...row.contact, tagIds } }
          : row,
      ),
    );
  }

  // The search is broad enough — also matches inside customFields JSON — that
  // we don't need a "no results" hint per filter dimension. Just empty state.
  const showEmpty = !list.loading && items.length === 0;

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <header className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Contacts</h1>
          <p className="text-sm text-muted-foreground">
            People who messaged your team, plus anyone you add manually.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            {/* Plain anchor: lets the browser handle Content-Disposition and
                save the file directly without a fetch + Blob round-trip. */}
            <a href="/api/contacts/export" download>
              <Download className="size-4" />
              Export
            </a>
          </Button>
          <Button variant="outline" onClick={() => setImporting(true)}>
            <Upload className="size-4" />
            Import
          </Button>
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            New contact
          </Button>
        </div>
      </header>

      <div className="mb-3">
        <ContactFilterBar
          search={list.search}
          onSearchChange={list.setSearch}
          sourceFilter={list.sourceFilter}
          onSourceChange={list.setSourceFilter}
          windowFilter={list.windowFilter}
          onWindowChange={list.setWindowFilter}
          fieldFilter={list.fieldFilter}
          onFieldChange={list.setFieldFilter}
          fieldDefinitions={fieldDefinitions}
          tags={tags}
          selectedTagIds={list.tagIds}
          onTagsChange={list.setTagIds}
          stages={stages}
          stageFilter={list.stageFilter}
          onStageFilterChange={list.setStageFilter}
        />
      </div>

      {list.error && (
        <div className="mb-3 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {list.error}
        </div>
      )}

      <div className="rounded-lg border border-border bg-card">
        {list.loading && items.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading…
          </div>
        ) : showEmpty ? (
          <div className="px-6 py-16 text-center">
            <p className="text-sm text-muted-foreground">
              {list.search ||
              list.fieldFilter ||
              list.windowFilter !== "any" ||
              list.tagIds.length > 0
                ? "No contacts match your filters."
                : "No contacts yet. Click \"New contact\" to add one."}
            </p>
          </div>
        ) : (
          <>
            <SelectAllRow
              items={items}
              selectedIds={selectedIds}
              onToggleAll={(checked, visibleIds) => {
                // Replace semantics — the page drops non-visible selections
                // whenever filters change (see the effect on `items`), so
                // "select all visible" naturally means "set to visible".
                if (checked) setSelectedIds(new Set(visibleIds));
                else setSelectedIds(new Set());
              }}
              rightSlot={
                <span>
                  {items.length} contact{items.length === 1 ? "" : "s"}
                </span>
              }
            />
            <ul className="divide-y divide-border">
              {items.map((item) => (
                <ContactRow
                  key={item.contact.id}
                  item={item}
                  fieldDefinitions={fieldDefinitions}
                  tagCatalog={tags}
                  tagById={tagById}
                  stageCatalog={stages}
                  canManageStages={canManageStages}
                  selected={selectedIds.has(item.contact.id)}
                  onSelectChange={(next) => {
                    setSelectedIds((prev) => {
                      const copy = new Set(prev);
                      if (next) copy.add(item.contact.id);
                      else copy.delete(item.contact.id);
                      return copy;
                    });
                  }}
                  onTagsChanged={(ids) => patchContactTags(item.contact.id, ids)}
                  onTagCreated={(t) => {
                    setTags((prev) =>
                      prev.some((x) => x.id === t.id) ? prev : [...prev, t].sort((a, b) => a.name.localeCompare(b.name)),
                    );
                  }}
                  onStageChanged={(stageId) => patchContactStage(item.contact.id, stageId)}
                  onEdit={() => setEditingId(item.contact.id)}
                />
              ))}
            </ul>
          </>
        )}
        {list.nextCursor && (
          <div className="border-t border-border p-3 text-center">
            <Button variant="ghost" size="sm" onClick={list.loadMore} disabled={list.loadingMore}>
              {list.loadingMore ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading…
                </>
              ) : (
                "Load more"
              )}
            </Button>
          </div>
        )}
      </div>

      {importing && (
        <ImportContactsDialog
          onClose={() => setImporting(false)}
          onImported={() => {
            setImporting(false);
            // Hard refresh — import might have added many rows; refetching
            // the page is simpler than splicing into local state.
            router.refresh();
          }}
        />
      )}

      <BulkActionBar
        selectedCount={selectedIds.size}
        tags={tags}
        onTagCreatedAndApply={async (tag) => {
          // Splice the new tag into the catalog so the chips render and
          // future picker opens show it. Then apply to the current bulk.
          setTags((prev) =>
            prev.some((x) => x.id === tag.id)
              ? prev
              : [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)),
          );
          const ids = Array.from(selectedIds);
          if (ids.length === 0) return;
          const res = await fetch("/api/contacts/bulk", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "tag-add", contactIds: ids, tagId: tag.id }),
          });
          if (!res.ok) {
            setError(await safeReadError(res));
            return;
          }
          // Patch row tagIds the same way the existing tag-add path does.
          setItems((prev) =>
            prev.map((row) => {
              if (!ids.includes(row.contact.id)) return row;
              const cur = row.contact.tagIds ?? [];
              return cur.includes(tag.id)
                ? row
                : { ...row, contact: { ...row.contact, tagIds: [...cur, tag.id] } };
            }),
          );
        }}
        onClear={() => setSelectedIds(new Set())}
        onSendTemplate={() => {
          const ids = Array.from(selectedIds);
          if (ids.length === 0) return;
          router.push(`/broadcasts/new?contactIds=${ids.join(",")}`);
        }}
        onTagBulk={async (action, tagId) => {
          const ids = Array.from(selectedIds);
          if (ids.length === 0) return;
          const res = await fetch("/api/contacts/bulk", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, contactIds: ids, tagId }),
          });
          if (!res.ok) {
            setError(await safeReadError(res));
            return;
          }
          // Patch each affected row's tagIds locally so the chips update
          // immediately. Adds skip duplicates; removes filter out the tag.
          setItems((prev) =>
            prev.map((row) => {
              if (!ids.includes(row.contact.id)) return row;
              const cur = row.contact.tagIds ?? [];
              const next =
                action === "tag-add"
                  ? cur.includes(tagId)
                    ? cur
                    : [...cur, tagId]
                  : cur.filter((id) => id !== tagId);
              return { ...row, contact: { ...row.contact, tagIds: next } };
            }),
          );
        }}
        onDelete={async () => {
          const ids = Array.from(selectedIds);
          if (ids.length === 0) return;
          const ok = await confirm({
            title: `Delete ${ids.length} contact${ids.length === 1 ? "" : "s"}?`,
            description:
              "This also removes their conversations, messages, and notes. This can't be undone.",
            confirmLabel: "Delete",
            destructive: true,
          });
          if (!ok) return;
          const res = await fetch("/api/contacts/bulk", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "delete", contactIds: ids }),
          });
          if (!res.ok) {
            setError(await safeReadError(res));
            return;
          }
          setItems((prev) => prev.filter((row) => !ids.includes(row.contact.id)));
          setSelectedIds(new Set());
        }}
      />

      {editingId && (() => {
        const target = items.find((x) => x.contact.id === editingId)?.contact;
        if (!target) return null;
        return (
          <EditContactDialog
            contact={target}
            fieldDefinitions={fieldDefinitions}
            canManageFields={canManageFields}
            onClose={() => setEditingId(null)}
            onSaved={(updated) => {
              // Patch the row in place — keeps the agent's scroll position
              // and any selected-row state.
              setItems((prev) =>
                prev.map((row) =>
                  row.contact.id === updated.id
                    ? { ...row, contact: { ...row.contact, ...updated } }
                    : row,
                ),
              );
              setEditingId(null);
            }}
            onTeamWideFieldAdded={(def) => {
              setFieldDefinitions((prev) =>
                prev.some((d) => d.id === def.id)
                  ? prev
                  : [...prev, def].sort((a, b) => a.order - b.order),
              );
            }}
          />
        );
      })()}

      {creating && (
        <NewContactDialog
          fieldDefinitions={fieldDefinitions}
          canManageFields={canManageFields}
          onClose={() => setCreating(false)}
          onCreated={(item) => {
            // Splice to top so the new contact is visible without a refetch.
            // The server-side sort puts contacts with no messages by createdAt,
            // and this one was just created, so this matches the canonical
            // order. router.refresh() also pulls a fresh server render in the
            // background.
            setItems((prev) => [item, ...prev]);
            setCreating(false);
            router.refresh();
          }}
          onTeamWideFieldAdded={(def) => {
            setFieldDefinitions((prev) =>
              // Server enforces unique keys; defensive dedupe in case the
              // server-rendered list already had it (e.g. created in another
              // tab).
              prev.some((d) => d.id === def.id)
                ? prev
                : [...prev, def].sort((a, b) => a.order - b.order),
            );
          }}
        />
      )}
      {confirmDialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ContactRow({
  item,
  fieldDefinitions,
  tagCatalog,
  tagById,
  stageCatalog,
  canManageStages,
  selected,
  onSelectChange,
  onTagsChanged,
  onTagCreated,
  onStageChanged,
  onEdit,
}: {
  item: ContactListItem;
  fieldDefinitions: ContactFieldDefinition[];
  tagCatalog: Tag[];
  tagById: Map<string, Tag>;
  stageCatalog: ContactStage[];
  canManageStages: boolean;
  selected: boolean;
  onSelectChange: (next: boolean) => void;
  onTagsChanged: (tagIds: string[]) => void;
  onTagCreated: (tag: Tag) => void;
  onStageChanged: (stageId: string | null) => void;
  onEdit: () => void;
}) {
  const { contact, activeConversationId, lastMessageAt, lastInboundAt } = item;
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [tagSaveError, setTagSaveError] = useState<string | null>(null);
  const tagBoxRef = useRef<HTMLDivElement>(null);

  // Close on outside click. Avoids the picker hanging around when the agent
  // tabs to another row.
  useEffect(() => {
    if (!tagPickerOpen) return;
    function handler(e: MouseEvent) {
      if (!tagBoxRef.current) return;
      if (!tagBoxRef.current.contains(e.target as Node)) setTagPickerOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [tagPickerOpen]);

  const filledFields = fieldDefinitions
    .map((def) => ({ def, value: contact.customFields[def.key] }))
    .filter((f): f is { def: ContactFieldDefinition; value: string } => Boolean(f.value));

  const contactTags = (contact.tagIds ?? [])
    .map((id) => tagById.get(id))
    .filter((t): t is Tag => Boolean(t));

  async function persistTagIds(nextIds: string[]) {
    // Optimistic: parent already painted the new state; rollback on failure.
    const prevIds = contact.tagIds ?? [];
    onTagsChanged(nextIds);
    setTagSaveError(null);
    try {
      const res = await fetch(`/api/contacts/${contact.id}/tags`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tagIds: nextIds }),
      });
      if (!res.ok) throw new Error(await safeReadError(res));
    } catch (err) {
      onTagsChanged(prevIds);
      setTagSaveError(err instanceof Error ? err.message : "Failed");
    }
  }

  async function persistStage(nextStageId: string) {
    const prev = contact.stageId ?? null;
    onStageChanged(nextStageId);
    const res = await fetch(`/api/contacts/${contact.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stageId: nextStageId }),
    });
    if (!res.ok) {
      onStageChanged(prev);
    }
  }

  return (
    <li
      className={cn(
        "group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40",
        selected && "bg-primary/5 hover:bg-primary/5",
      )}
    >
      {/* Selection checkbox — keyboard accessible via the native control. */}
      <label className="flex shrink-0 cursor-pointer items-center justify-center">
        <input
          type="checkbox"
          className="size-4 cursor-pointer accent-primary"
          checked={selected}
          onChange={(e) => onSelectChange(e.target.checked)}
          aria-label={`Select ${contact.name}`}
        />
      </label>

      <Avatar className="size-9 shrink-0">
        <AvatarFallback
          className="text-sm text-white"
          style={{ backgroundImage: avatarGradient(contact.id) }}
        >
          {initials(contact.name)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{contact.name}</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {formatPhone(contact.phoneNumber)}
          </span>
          <SourceBadge source={contact.source} />
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          {contact.email && <span className="truncate">{contact.email}</span>}
          {contact.email && contact.location && <span>·</span>}
          {contact.location && <span className="truncate">{contact.location}</span>}
        </div>
        {filledFields.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {filledFields.map(({ def, value }) => (
              <Badge key={def.id} variant="muted" className="text-[10px]">
                <span className="opacity-60">{def.label}:</span>
                <span className="ml-1">{value}</span>
              </Badge>
            ))}
          </div>
        )}
        {/* Tag row: chips + inline "add" trigger that opens the multi-picker. */}
        <div ref={tagBoxRef} className="relative mt-1.5 flex flex-wrap items-center gap-1">
          {contactTags.map((t) => (
            <TagChip
              key={t.id}
              tag={t}
              size="xs"
              onRemove={() =>
                void persistTagIds((contact.tagIds ?? []).filter((id) => id !== t.id))
              }
            />
          ))}
          <TagAddButton size="xs" onClick={() => setTagPickerOpen((v) => !v)} />
          {tagSaveError && (
            <span className="text-[10px] text-destructive">{tagSaveError}</span>
          )}
          {tagPickerOpen && (
            <div className="absolute left-0 top-full z-20 mt-1">
              <TagMultiPicker
                tags={tagCatalog}
                selectedIds={contact.tagIds ?? []}
                onSelectedChange={(next) => void persistTagIds(next)}
                onCreated={(tag) => {
                  onTagCreated(tag);
                  void persistTagIds([...(contact.tagIds ?? []), tag.id]);
                }}
              />
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        <div className="hidden md:inline-flex">
          <ContactStagePicker
            stages={stageCatalog}
            currentStageId={contact.stageId}
            onChange={persistStage}
            canManage={canManageStages}
            size="xs"
          />
        </div>
        <WindowBadge lastInboundAt={lastInboundAt} size="xs" className="hidden md:inline-flex" />
        {lastMessageAt && (
          <span className="hidden tabular-nums lg:inline">
            {formatListTime(lastMessageAt)}
          </span>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onEdit();
          }}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
          title="Edit this contact"
        >
          <Pencil className="size-3" />
          Edit
        </button>
        <Link
          href={`/broadcasts/new?contactIds=${contact.id}`}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
          title="Send a pre-approved template to this contact"
        >
          <Send className="size-3" />
          Template
        </Link>
        {activeConversationId ? (
          <Link
            href={`/inbox/${activeConversationId}`}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent hover:text-foreground"
          >
            <MessageSquare className="size-3" />
            Open chat
          </Link>
        ) : (
          <span className="rounded-md border border-dashed border-border px-2.5 py-1 text-xs">
            No thread yet
          </span>
        )}
      </div>
    </li>
  );
}

async function safeReadError(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { error?: string; detail?: string };
    if (json.detail) return `${json.error ?? "error"}: ${json.detail}`;
    return json.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function BulkActionBar({
  selectedCount,
  tags,
  onClear,
  onSendTemplate,
  onTagBulk,
  onTagCreatedAndApply,
  onDelete,
}: {
  selectedCount: number;
  tags: Tag[];
  onClear: () => void;
  onSendTemplate: () => void;
  onTagBulk: (action: "tag-add" | "tag-remove", tagId: string) => void | Promise<void>;
  /** Called by the menu when an agent creates a brand-new tag in-flow.
   *  Parent persists it to the team catalog + applies to the bulk selection. */
  onTagCreatedAndApply: (tag: Tag) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}) {
  // Local UI state for the tag popovers. Kept inside the bar so the parent
  // doesn't have to track which popover is open.
  const [openMenu, setOpenMenu] = useState<null | "add" | "remove">(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openMenu) return;
    function handler(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpenMenu(null);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openMenu]);

  if (selectedCount === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <div
        ref={containerRef}
        className="pointer-events-auto relative flex items-center gap-2 rounded-full border border-border bg-popover px-3 py-2 shadow-2xl ring-1 ring-foreground/5"
      >
        <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-primary/10 px-2.5 text-xs font-medium text-primary tabular-nums">
          {selectedCount} selected
        </span>

        <Button size="sm" className="gap-1.5" onClick={onSendTemplate}>
          <Send className="size-3.5" />
          Send template
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setOpenMenu(openMenu === "add" ? null : "add")}
        >
          <TagsIcon className="size-3.5" />
          Add tag
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setOpenMenu(openMenu === "remove" ? null : "remove")}
        >
          <MinusCircle className="size-3.5" />
          Remove tag
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
          Delete
        </Button>

        <button
          type="button"
          onClick={onClear}
          className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Clear selection"
        >
          <X className="size-4" />
        </button>

        {openMenu && (
          <BulkTagMenu
            tags={tags}
            action={openMenu === "add" ? "tag-add" : "tag-remove"}
            onPick={async (tagId) => {
              setOpenMenu(null);
              await onTagBulk(openMenu === "add" ? "tag-add" : "tag-remove", tagId);
            }}
            onCreated={async (tag) => {
              setOpenMenu(null);
              await onTagCreatedAndApply(tag);
            }}
            onClose={() => setOpenMenu(null)}
          />
        )}
      </div>
    </div>
  );
}

function BulkTagMenu({
  tags,
  action,
  onPick,
  onCreated,
  onClose,
}: {
  tags: Tag[];
  action: "tag-add" | "tag-remove";
  /** Apply an existing tag id to the current bulk selection. */
  onPick: (tagId: string) => void;
  /** Persist a new tag, then apply it. Only used for "tag-add". */
  onCreated: (tag: Tag) => void;
  onClose: () => void;
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

  // Inline create is only meaningful in "add" mode — you can't remove a tag
  // that doesn't exist. Also gated on the typed query being non-empty + not
  // an exact match.
  const canCreate = action === "tag-add" && query.trim().length > 0 && !exactMatch;

  async function createTag() {
    const name = query.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/team/tags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color: newColor }),
      });
      const data = (await res.json()) as { tag?: Tag; error?: string; detail?: string };
      if (!res.ok || !data.tag) {
        throw new Error(
          [data.error, data.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
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
    <div className="absolute bottom-full left-1/2 mb-2 w-72 -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
      <div className="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {action === "tag-add" ? "Add tag to selection" : "Remove tag from selection"}
      </div>

      <div className="border-b border-border px-2 py-2">
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
            placeholder={
              action === "tag-add" ? "Search or create a tag…" : "Search tags…"
            }
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>

      <div className="max-h-56 overflow-y-auto py-1">
        {filtered.length === 0 && !canCreate ? (
          <div className="px-3 py-3 text-center text-[12px] text-muted-foreground">
            {action === "tag-remove"
              ? "No tags to remove."
              : "Type a name above to create your first tag."}
          </div>
        ) : (
          filtered.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onPick(t.id)}
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left hover:bg-accent/60"
            >
              <TagChip tag={t} size="xs" />
            </button>
          ))
        )}
      </div>

      {canCreate && (
        <div className="border-t border-border bg-muted/30 px-3 py-2">
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
              Create &amp; apply
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
      )}

      <button
        type="button"
        onClick={onClose}
        className="block w-full cursor-pointer border-t border-border px-3 py-1.5 text-center text-[11px] text-muted-foreground hover:bg-accent/40"
      >
        Cancel
      </button>
    </div>
  );
}

function SourceBadge({ source }: { source: ContactSource }) {
  if (source === "manual") {
    return (
      <Badge variant="muted" className="text-[10px]">
        Added by you
      </Badge>
    );
  }
  return (
    <Badge variant="success" className="text-[10px]">
      Messaged you
    </Badge>
  );
}

