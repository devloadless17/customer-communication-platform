"use client";

import { ChevronRight, FolderHeart, Loader2, Tag as TagIcon, Users, UserPlus } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";

import { cn } from "@/lib/utils";
import { TagFilterControl } from "@/components/contacts/contact-browser";
import { ContactMultiSelectField } from "@/components/contacts/contact-multi-select-field";
import type { ContactLabel } from "@/components/contacts/contact-select-dialog";
import type { ContactFieldDefinition, ContactStage, Tag } from "@/lib/types";
import type { AudienceGroupDto } from "@/lib/queries";

/**
 * Audience picker for the broadcast wizard. Four modes:
 *
 *   "all"      — every contact in the team. Expanded server-side at send time.
 *   "by_tag"   — contacts carrying ANY of the chosen tags. The recipient
 *                count is resolved server-side (the parent owns the fetch).
 *   "group"    — a saved audience group.
 *   "selected" — a hand-picked list, via the shared contact picker dialog.
 *
 * Fully presentational: the parent owns the selected ids/tags and supplies
 * any server-resolved counts. No team-wide contact list is ever loaded here
 * — it doesn't scale.
 */

export type AudienceMode = "all" | "selected" | "by_tag" | "group";

export interface AudienceState {
  mode: AudienceMode;
  selectedIds: string[];
  selectedTagIds: string[];
  selectedGroupId: string | null;
}

export function AudiencePicker({
  tags,
  fieldDefinitions = [],
  stages = [],
  groups,
  totalContactCount,
  taggedRecipientCount,
  taggedRecipientLoading = false,
  initialContactLabels = [],
  value,
  onChange,
}: {
  /** All team tags — used both for by-tag mode and for filtering in the picker. */
  tags: Tag[];
  /** Custom-field defs — used for the "filter by field" pills in the picker. */
  fieldDefinitions?: ContactFieldDefinition[];
  /** Lifecycle stages — used for the stage filter inside the "Pick contacts" dialog. */
  stages?: ContactStage[];
  /** All saved audience groups for "from group" mode. */
  groups: AudienceGroupDto[];
  /** Total contacts in the team — the "All contacts" recipient count. */
  totalContactCount: number;
  /** Server-resolved count of contacts matching `value.selectedTagIds`. */
  taggedRecipientCount: number;
  /** True while the parent is (re)fetching `taggedRecipientCount`. */
  taggedRecipientLoading?: boolean;
  /** Seed labels for any preselected contact ids (avoids a chip-label flash). */
  initialContactLabels?: ContactLabel[];
  value: AudienceState;
  onChange: (next: AudienceState) => void;
}) {
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
              recipientCount={taggedRecipientCount}
              recipientLoading={taggedRecipientLoading}
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
              tags={tags}
              fieldDefinitions={fieldDefinitions}
              stages={stages}
              initialContactLabels={initialContactLabels}
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
  recipientLoading,
}: {
  tags: Tag[];
  selectedTagIds: string[];
  onChange: (next: string[]) => void;
  recipientCount: number;
  recipientLoading: boolean;
}) {
  if (tags.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-4 text-center text-[12px] text-muted-foreground">
        No tags yet. Tag some contacts first (Contacts page) then come back.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <TagFilterControl
        tags={tags}
        selectedTagIds={selectedTagIds}
        onChange={onChange}
        label=""
        emptyTriggerLabel="Search & add tags"
      />

      <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-3">
        <div className="flex items-center gap-2 text-sm">
          <TagIcon className="size-4 text-sky-700 dark:text-sky-300" />
          <span className="flex items-center gap-1.5 font-medium text-sky-700 dark:text-sky-300">
            {selectedTagIds.length === 0 ? (
              "Pick at least one tag"
            ) : recipientLoading ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Counting recipients…
              </>
            ) : (
              `Broadcast to ${recipientCount} contact${recipientCount === 1 ? "" : "s"}`
            )}
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
                  "hover:bg-accent/50 focus:bg-accent/50 focus:outline-hidden",
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
  tags,
  fieldDefinitions,
  stages,
  initialContactLabels,
  selectedIds,
  onChange,
}: {
  tags: Tag[];
  fieldDefinitions: ContactFieldDefinition[];
  stages: ContactStage[];
  initialContactLabels: ContactLabel[];
  selectedIds: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <ContactMultiSelectField
        tags={tags}
        fieldDefinitions={fieldDefinitions}
        stages={stages}
        initialLabels={initialContactLabels}
        selectedIds={selectedIds}
        onChange={onChange}
        dialogTitle="Pick broadcast recipients"
        dialogDescription="Filter by name, number, tag, or any field — same view as the Contacts page."
        confirmLabel="Use these recipients"
        emptyHint="No recipients picked yet — click below to choose."
      />
      <p className="text-[11px] text-muted-foreground">
        {selectedIds.length} recipient{selectedIds.length === 1 ? "" : "s"} selected ·
        snapshot is taken when you send.
      </p>
    </div>
  );
}
