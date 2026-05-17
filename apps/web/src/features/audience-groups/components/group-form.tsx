"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Loader2,
  Save,
  Send,
  Tag as TagIcon,
  Trash2,
  Users,
  UserPlus,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TagChip } from "@/features/tags/components/tag-chip";
import { ContactMultiSelectField } from "@/features/contacts/components/contact-multi-select-field";
import { TagFilterControl } from "@/features/contacts/components/contact-browser";
import { RecipientsPreviewDialog } from "@/features/broadcasts/components/recipients-preview-dialog";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { ContactLabel } from "@/features/contacts/components/contact-select-dialog";
import type { ContactFieldDefinition, ContactStage, Tag } from "@ccp/shared/types";
import type { AudienceGroupDto } from "@ccp/shared/queries";

/**
 * Reusable form for creating or editing an audience group.
 *
 * One page:
 *   - Top: name, optional description.
 *   - TAG section (every contact carrying ANY selected tag joins).
 *   - MANUAL section (chip input — hand-picked contacts always in).
 *
 * Members at send time = union of both. The live count is resolved
 * server-side (`/api/contacts/count`) — the form never loads the team contact
 * list, so it scales to large teams.
 */

export interface GroupFormProps {
  /** When set, the form starts in "edit" mode pre-filled from this dto. */
  initial?: AudienceGroupDto;
  tags: Tag[];
  fieldDefinitions?: ContactFieldDefinition[];
  stages?: ContactStage[];
  /** Server-provided labels for the group's existing manual contacts. */
  initialContactLabels?: ContactLabel[];
}

export function GroupForm({
  initial,
  tags,
  fieldDefinitions = [],
  stages = [],
  initialContactLabels = [],
}: GroupFormProps) {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [tagIds, setTagIds] = useState<string[]>(initial?.tagIds ?? []);
  const [manualContactIds, setManualContactIds] = useState<string[]>(
    initial?.contactIds ?? [],
  );
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t] as const)), [tags]);

  // Live member count — same union the server uses, fetched server-side and
  // debounced so it doesn't fire on every keystroke of the picker.
  const [memberTotal, setMemberTotal] = useState(initial?.memberCount ?? 0);
  const [countLoading, setCountLoading] = useState(false);
  const tagKey = tagIds.join(",");
  const manualKey = manualContactIds.join(",");
  useEffect(() => {
    if (tagIds.length === 0 && manualContactIds.length === 0) {
      setMemberTotal(0);
      setCountLoading(false);
      return;
    }
    let cancelled = false;
    setCountLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch("/api/contacts/count", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tagIds, contactIds: manualContactIds }),
        });
        const data = (await res.json()) as { count?: number };
        if (!cancelled) setMemberTotal(data.count ?? 0);
      } catch {
        if (!cancelled) setMemberTotal(0);
      } finally {
        if (!cancelled) setCountLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagKey, manualKey]);

  const manualCount = manualContactIds.length;
  const taggedOnlyCount = Math.max(0, memberTotal - manualCount);

  // Unsaved-changes guard for the "Send broadcast" shortcut — that link jumps
  // to the broadcast wizard which reads the *saved* group, so edits made here
  // but not saved would be silently ignored.
  const dirty = initial
    ? name.trim() !== initial.name ||
      (description.trim() || "") !== (initial.description ?? "") ||
      [...tagIds].sort().join(",") !== [...(initial.tagIds ?? [])].sort().join(",") ||
      [...manualContactIds].sort().join(",") !==
        [...(initial.contactIds ?? [])].sort().join(",")
    : false;

  async function submit(redirectTo = "/broadcasts/groups") {
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
          [data.error, data.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
        );
        return;
      }
      router.push(redirectTo);
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function goToBroadcast() {
    if (!initial || submitting || deleting) return;
    const target = `/broadcasts/new?groupId=${initial.id}`;
    if (dirty) {
      const ok = await confirm({
        title: "Unsaved changes",
        description:
          "You have unsaved changes to this group. Save them before starting the broadcast?",
        confirmLabel: "Save & continue",
        cancelLabel: "Stay here",
      });
      if (ok) void submit(target);
      return;
    }
    router.push(target);
  }

  async function deleteGroup() {
    if (!initial) return;
    const ok = await confirm({
      title: `Delete group "${initial.name}"?`,
      description:
        "Past broadcasts that used it stay in your history. This can't be undone.",
      confirmLabel: "Delete group",
      destructive: true,
    });
    if (!ok) return;
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

      <TagSection tags={tags} selectedTagIds={tagIds} onChange={setTagIds} />

      <ManualContactsSection
        tags={tags}
        fieldDefinitions={fieldDefinitions}
        stages={stages}
        initialContactLabels={initialContactLabels}
        selectedIds={manualContactIds}
        onChange={setManualContactIds}
      />

      <PreviewCard
        total={memberTotal}
        manualCount={manualCount}
        taggedCount={taggedOnlyCount}
        loading={countLoading}
        onPreview={memberTotal > 0 ? () => setPreviewOpen(true) : undefined}
        sampleTags={tagIds
          .slice(0, 6)
          .map((id) => tagById.get(id))
          .filter((t): t is Tag => Boolean(t))}
      />

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="wrap-break-word">{error}</span>
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
              <button
                type="button"
                onClick={goToBroadcast}
                disabled={submitting || deleting}
                className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                title={
                  dirty
                    ? "You have unsaved changes — you'll be asked to save them first"
                    : "Start a broadcast with this group as the audience"
                }
              >
                <Send className="size-3.5" />
                Send broadcast
                {dirty && <span className="ml-1 text-[10px] text-amber-600 dark:text-amber-400">• unsaved</span>}
              </button>
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
              onClick={() => submit()}
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

      <RecipientsPreviewDialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        payload={{ tagIds, contactIds: manualContactIds }}
        title="Group members"
        subtitle={`${manualCount} hand-picked · the rest matched by ${tagIds.length} tag${tagIds.length === 1 ? "" : "s"}`}
      />
      {confirmDialog}
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
          <TagFilterControl
            tags={tags}
            selectedTagIds={selectedTagIds}
            onChange={onChange}
            label=""
            emptyTriggerLabel="Search & add tags"
          />
        )}
      </div>
    </section>
  );
}

function ManualContactsSection({
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
          {selectedIds.length} selected
        </span>
      </header>
      <div className="px-4 py-3">
        <ContactMultiSelectField
          tags={tags}
          fieldDefinitions={fieldDefinitions}
          stages={stages}
          initialLabels={initialContactLabels}
          selectedIds={selectedIds}
          onChange={onChange}
          dialogTitle="Add contacts to this group"
          dialogDescription="Filter by name, number, tag, or any field — same view as the Contacts page."
          confirmLabel="Use these contacts"
        />
      </div>
    </section>
  );
}

function PreviewCard({
  total,
  manualCount,
  taggedCount,
  loading,
  onPreview,
  sampleTags,
}: {
  total: number;
  manualCount: number;
  taggedCount: number;
  loading: boolean;
  onPreview?: () => void;
  sampleTags: Tag[];
}) {
  return (
    <section className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
      <div className="flex items-center gap-2 text-sm">
        <Users className="size-4 text-emerald-700 dark:text-emerald-300" />
        <span className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300">
          {loading ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Counting members…
            </>
          ) : total === 0 ? (
            "No members yet"
          ) : (
            `${total} member${total === 1 ? "" : "s"} right now`
          )}
        </span>
        {onPreview && (
          <button
            type="button"
            onClick={onPreview}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-background/60 px-2 py-0.5 text-[11px] font-medium text-emerald-700 hover:bg-background dark:text-emerald-300"
          >
            <Users className="size-3" />
            Preview members
          </button>
        )}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        {manualCount} hand-picked · {taggedCount} via tag membership · resolved at send time
      </div>
      {sampleTags.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {sampleTags.map((t) => (
            <TagChip key={t.id} tag={t} size="xs" />
          ))}
        </div>
      )}
    </section>
  );
}
