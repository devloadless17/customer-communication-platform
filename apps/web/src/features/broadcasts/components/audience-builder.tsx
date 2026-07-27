"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Tag as TagIcon, UserPlus, Users } from "lucide-react";

import { useAudienceCount } from "@/hooks/use-audience-count";
import { TagChip } from "@/features/tags/components/tag-chip";
import { TagFilterControl } from "@/features/contacts/components/contact-browser";
import { ContactMultiSelectField } from "@/features/contacts/components/contact-multi-select-field";
import { RecipientsPreviewDialog } from "@/features/broadcasts/components/recipients-preview-dialog";
import type { ContactLabel } from "@/features/contacts/components/contact-select-dialog";
import type { ContactFieldDefinition, ContactStage, Tag } from "@ccp/shared/types";

/**
 * The one place an "audience" is built, anywhere in the app.
 *
 * An audience is a UNION of two memberships:
 *   - BY TAG (dynamic)  — every contact carrying ANY selected tag.
 *   - HAND-PICKED        — specific contacts, always in.
 *
 * This is exactly what a saved {@link AudienceGroup} stores, so the group form
 * and the broadcast "custom audience" step render the *same* builder — one
 * mental model, one live count, one preview. The value is the raw
 * `{ tagIds, contactIds }`; the server resolves the union (count / preview /
 * send) so the browser never loads the team contact list.
 */

export interface AudienceValue {
  tagIds: string[];
  contactIds: string[];
}

export function AudienceBuilder({
  value,
  onChange,
  tags,
  fieldDefinitions = [],
  stages = [],
  initialContactLabels = [],
  initialCount = 0,
  noun = "member",
  contactDialogTitle = "Add contacts",
  contactDialogDescription = "Filter by name, number, tag, or any field — same view as the Contacts page.",
  contactConfirmLabel = "Use these contacts",
  showPreview = true,
  onCountChange,
  channel,
  accountId,
  includeOtherAccounts,
}: {
  value: AudienceValue;
  onChange: (next: AudienceValue) => void;
  tags: Tag[];
  fieldDefinitions?: ContactFieldDefinition[];
  stages?: ContactStage[];
  /** Server labels for preselected contact ids — avoids a chip-label flash. */
  initialContactLabels?: ContactLabel[];
  /** Seed count (e.g. an existing group's memberCount) so it doesn't flash 0. */
  initialCount?: number;
  /** Singular noun for the count line: "member" (group) | "recipient" (broadcast). */
  noun?: string;
  contactDialogTitle?: string;
  contactDialogDescription?: string;
  contactConfirmLabel?: string;
  /** Show the inline "Preview" affordance. Off when a parent owns preview. */
  showPreview?: boolean;
  /** Mirror the resolved count to a parent (broadcast summary + send button). */
  onCountChange?: (count: number, loading: boolean) => void;
  /** Scope the recipient count to a broadcast's target channel (so a freeform
   *  Messenger broadcast counts only Messenger contacts). Omit = all channels
   *  (the audience-group form, which is channel-agnostic). */
  channel?: string;
  /** Scope the count to the broadcast's "Send from" account, mirroring the
   *  send's own audience scoping — see use-audience-count. */
  accountId?: string | null;
  includeOtherAccounts?: boolean;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const { count, loading } = useAudienceCount(value.tagIds, value.contactIds, {
    initial: initialCount,
    channel,
    accountId,
    includeOtherAccounts,
  });

  useEffect(() => {
    onCountChange?.(count, loading);
  }, [count, loading, onCountChange]);

  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t] as const)), [tags]);
  const manualCount = value.contactIds.length;
  const taggedOnlyCount = Math.max(0, count - manualCount);
  const sampleTags = value.tagIds
    .slice(0, 6)
    .map((id) => tagById.get(id))
    .filter((t): t is Tag => Boolean(t));

  return (
    <div className="flex flex-col gap-4">
      {/* By tag (dynamic) */}
      <Section
        icon={TagIcon}
        tone="sky"
        title="By tag (dynamic)"
        hint="Every contact carrying ANY selected tag joins automatically."
        count={value.tagIds.length}
      >
        {tags.length === 0 ? (
          <EmptyHint>No tags yet. Tag some contacts on the Contacts page first.</EmptyHint>
        ) : (
          <TagFilterControl
            tags={tags}
            selectedTagIds={value.tagIds}
            onChange={(tagIds) => onChange({ ...value, tagIds })}
            label=""
            emptyTriggerLabel="Search & add tags"
          />
        )}
      </Section>

      {/* Hand-picked (manual) */}
      <Section
        icon={UserPlus}
        tone="violet"
        title="Hand-picked contacts"
        hint="These specific contacts are always included, regardless of tags."
        count={manualCount}
      >
        <ContactMultiSelectField
          tags={tags}
          fieldDefinitions={fieldDefinitions}
          stages={stages}
          initialLabels={initialContactLabels}
          selectedIds={value.contactIds}
          onChange={(contactIds) => onChange({ ...value, contactIds })}
          dialogTitle={contactDialogTitle}
          dialogDescription={contactDialogDescription}
          confirmLabel={contactConfirmLabel}
          emptyHint="No contacts picked yet — click below to choose."
        />
      </Section>

      {/* Resolved count + preview */}
      <section className="rounded-xl border border-success-border bg-success-bg px-4 py-3">
        <div className="flex items-center gap-2 text-sm">
          <Users className="size-4 text-success-fg" />
          <span className="flex items-center gap-1.5 font-medium text-success-fg">
            {loading ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Counting {noun}s…
              </>
            ) : count === 0 ? (
              `No ${noun}s yet`
            ) : (
              `${count} ${noun}${count === 1 ? "" : "s"} right now`
            )}
          </span>
          {showPreview && count > 0 && (
            <button
              type="button"
              onClick={() => setPreviewOpen(true)}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-success-border bg-background/60 px-2 py-0.5 text-2xs font-medium text-success-fg hover:bg-background"
            >
              <Users className="size-3" />
              Preview
            </button>
          )}
        </div>
        <div className="mt-1 text-2xs text-muted-foreground">
          {manualCount} hand-picked · {taggedOnlyCount} via tag membership · resolved at
          send time
        </div>
        {sampleTags.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {sampleTags.map((t) => (
              <TagChip key={t.id} tag={t} size="xs" />
            ))}
          </div>
        )}
      </section>

      {showPreview && (
        <RecipientsPreviewDialog
          open={previewOpen}
          onClose={() => setPreviewOpen(false)}
          payload={{ tagIds: value.tagIds, contactIds: value.contactIds }}
          title={`${noun[0]?.toUpperCase()}${noun.slice(1)}s`}
          subtitle={`${manualCount} hand-picked · the rest matched by ${value.tagIds.length} tag${value.tagIds.length === 1 ? "" : "s"}`}
        />
      )}
    </div>
  );
}

const TONES = {
  sky: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  violet: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
} as const;

function Section({
  icon: Icon,
  tone,
  title,
  hint,
  count,
  children,
}: {
  icon: typeof TagIcon;
  tone: keyof typeof TONES;
  title: string;
  hint: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-2">
          <div
            className={`inline-flex size-7 items-center justify-center rounded-md ${TONES[tone]}`}
          >
            <Icon className="size-3.5" />
          </div>
          <div>
            <div className="text-sm font-semibold">{title}</div>
            <div className="text-2xs text-muted-foreground">{hint}</div>
          </div>
        </div>
        <span className="text-2xs text-muted-foreground">{count} selected</span>
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}
