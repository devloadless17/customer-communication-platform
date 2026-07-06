"use client";

import { useState } from "react";
import {
  Check,
  ChevronRight,
  FolderHeart,
  Loader2,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";

import { cn } from "@ccp/shared/utils";
import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AudienceBuilder } from "@/features/broadcasts/components/audience-builder";
import type { ContactLabel } from "@/features/contacts/components/contact-select-dialog";
import type { ContactFieldDefinition, ContactStage, Tag } from "@ccp/shared/types";
import type { AudienceGroupDto } from "@ccp/shared/dtos";

/**
 * Audience picker for the broadcast wizard. Three choices:
 *
 *   "all"    — every contact in the team. Expanded server-side at send time.
 *   "group"  — a saved audience group (reusable).
 *   "custom" — a one-off audience built inline with the shared
 *              {@link AudienceBuilder}: tag membership ∪ hand-picked contacts.
 *              The same union a group stores, just not saved — with a
 *              "save as group" shortcut for when it's worth keeping.
 *
 * Fully presentational: the parent owns the selected ids/tags/group and the
 * resolved counts. No team-wide contact list is ever loaded here.
 */

export type AudienceMode = "all" | "group" | "custom";

export interface AudienceState {
  mode: AudienceMode;
  /** custom: hand-picked contact ids. */
  selectedIds: string[];
  /** custom: tag ids (dynamic membership). */
  selectedTagIds: string[];
  /** group: the chosen saved group. */
  selectedGroupId: string | null;
}

export function AudiencePicker({
  tags,
  fieldDefinitions = [],
  stages = [],
  groups,
  totalContactCount,
  initialContactLabels = [],
  value,
  onChange,
  onCustomCountChange,
  onGroupSaved,
}: {
  tags: Tag[];
  fieldDefinitions?: ContactFieldDefinition[];
  stages?: ContactStage[];
  groups: AudienceGroupDto[];
  totalContactCount: number;
  initialContactLabels?: ContactLabel[];
  value: AudienceState;
  onChange: (next: AudienceState) => void;
  /** Mirror the live custom-audience count up to the parent's send summary. */
  onCustomCountChange?: (count: number, loading: boolean) => void;
  /** Called after "Save as group" succeeds, so the parent can show it. */
  onGroupSaved?: (group: AudienceGroupDto) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <ModeToggle value={value.mode} onChange={(mode) => onChange({ ...value, mode })} />

      <AnimatePresence mode="wait" initial={false}>
        {value.mode === "all" ? (
          <ModePanel key="all">
            <AllContactsCard count={totalContactCount} />
          </ModePanel>
        ) : value.mode === "group" ? (
          <ModePanel key="group">
            <GroupSelector
              groups={groups}
              selectedGroupId={value.selectedGroupId}
              onChange={(selectedGroupId) => onChange({ ...value, selectedGroupId })}
            />
          </ModePanel>
        ) : (
          <ModePanel key="custom">
            <AudienceBuilder
              value={{ tagIds: value.selectedTagIds, contactIds: value.selectedIds }}
              onChange={(v) =>
                onChange({ ...value, selectedTagIds: v.tagIds, selectedIds: v.contactIds })
              }
              tags={tags}
              fieldDefinitions={fieldDefinitions}
              stages={stages}
              initialContactLabels={initialContactLabels}
              noun="recipient"
              contactDialogTitle="Pick broadcast recipients"
              contactConfirmLabel="Use these recipients"
              showPreview={false}
              onCountChange={onCustomCountChange}
            />
            <SaveAudienceAsGroup
              tagIds={value.selectedTagIds}
              contactIds={value.selectedIds}
              onSaved={onGroupSaved}
            />
          </ModePanel>
        )}
      </AnimatePresence>
    </div>
  );
}

function ModePanel({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.15 }}
      className="flex flex-col gap-3"
    >
      {children}
    </motion.div>
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
      <ModeButton active={value === "all"} onClick={() => onChange("all")} icon={Users}>
        Everyone
      </ModeButton>
      <ModeButton active={value === "group"} onClick={() => onChange("group")} icon={FolderHeart}>
        Saved group
      </ModeButton>
      <ModeButton
        active={value === "custom"}
        onClick={() => onChange("custom")}
        icon={SlidersHorizontal}
      >
        Custom
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
      aria-pressed={active}
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

/**
 * "Save this one-off audience for reuse." Collapsed by default; expands to a
 * name field that POSTs the current `{ tagIds, contactIds }` to the same
 * endpoint the group form uses. On success the parent gets the new group so it
 * appears (and is selectable) in "Saved group" mode immediately.
 */
function SaveAudienceAsGroup({
  tagIds,
  contactIds,
  onSaved,
}: {
  tagIds: string[];
  contactIds: string[];
  onSaved?: (group: AudienceGroupDto) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const empty = tagIds.length === 0 && contactIds.length === 0;
  if (empty) return null;

  async function save() {
    if (!name.trim()) {
      setError("Give the group a name");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch("/api/team/audience-groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), tagIds, contactIds }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        group?: AudienceGroupDto;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !data.group) {
        setError(
          [data.error, data.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
        );
        return;
      }
      toast.success(`Saved "${data.group.name}" — reusable from "Saved group"`);
      onSaved?.(data.group);
      setOpen(false);
      setName("");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex w-fit items-center gap-1.5 text-2xs font-medium text-primary hover:underline"
      >
        <FolderHeart className="size-3.5" />
        Save this audience as a reusable group
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
          placeholder="Group name, e.g. Ramadan customers"
          aria-label="Group name"
          maxLength={80}
          autoFocus
          className="h-8 flex-1"
        />
        <Button type="button" size="sm" onClick={save} disabled={saving} className="h-8 gap-1.5">
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          Save
        </Button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="text-2xs text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>
      {error && (
        <span role="alert" className="text-2xs text-destructive">
          {error}
        </span>
      )}
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
      <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-xs">
        <FolderHeart className="mx-auto mb-1 size-5 text-muted-foreground" />
        <div className="text-foreground">No saved groups yet.</div>
        <p className="mt-1 text-muted-foreground">
          Build a custom audience below and save it, or create one from scratch.
        </p>
        <Link
          href="/broadcasts/groups/new"
          className="mt-2 inline-flex cursor-pointer items-center gap-1 rounded-md bg-primary px-3 py-1 text-2xs font-medium text-primary-foreground hover:bg-primary/90"
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
                    <span className="rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-3xs tabular-nums text-muted-foreground">
                      {g.memberCount} member{g.memberCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  {g.description && (
                    <div className="line-clamp-1 text-2xs text-muted-foreground">
                      {g.description}
                    </div>
                  )}
                  <div className="mt-0.5 text-3xs text-muted-foreground">
                    {g.tagIds.length > 0 && (
                      <span>
                        {g.tagIds.length} tag{g.tagIds.length === 1 ? "" : "s"}
                      </span>
                    )}
                    {g.tagIds.length > 0 && g.contactIds.length > 0 && <span> · </span>}
                    {g.contactIds.length > 0 && (
                      <span>
                        {g.contactIds.length} manual contact
                        {g.contactIds.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                </div>
                {selected ? (
                  <span className="text-2xs font-medium text-primary">Selected</span>
                ) : (
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between text-2xs text-muted-foreground">
        <span>
          Members are resolved at send time — newly-tagged contacts added later
          don&apos;t join in-flight broadcasts.
        </span>
        <Link href="/broadcasts/groups" className="text-primary hover:underline">
          Manage groups →
        </Link>
      </div>
    </div>
  );
}

function AllContactsCard({ count }: { count: number }) {
  return (
    <div className="rounded-xl border border-warning-border bg-warning-bg p-4">
      <div className="flex items-start gap-3">
        <div className="inline-flex size-9 items-center justify-center rounded-full bg-warning-bg text-warning-fg">
          <Users className="size-4" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-medium text-warning-fg">
            Broadcast to <span className="tabular-nums">{count}</span> contact
            {count === 1 ? "" : "s"}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Every contact in this team will receive the template. Marketing
            templates are billed per recipient by Meta — double-check the
            preview before sending.
          </p>
        </div>
      </div>
    </div>
  );
}
