"use client";

import { memo } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { WindowBadge } from "@/features/inbox/components/window-badge";
import { TagChip } from "@/features/tags/components/tag-chip";
import { avatarGradient } from "@ccp/shared/utils/avatar-color";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import { cn, formatPhone, initials } from "@ccp/shared/utils";
import type { ContactListItem, ContactStage, Tag } from "@ccp/shared/types";

/**
 * Selection-only contact row for the picker. Same lean single-line rhythm as
 * the Contacts page row, minus the inline editing — picking is the only job
 * here, so the whole row is one big checkbox label.
 */
export const BrowserRow = memo(function BrowserRow({
  item,
  tagById,
  stageById,
  selected,
  onSelectChange,
}: {
  item: ContactListItem;
  tagById: Map<string, Tag>;
  stageById: Map<string, ContactStage>;
  selected: boolean;
  // id-parameterized so the parent passes one stable callback for all rows.
  onSelectChange: (id: string, next: boolean) => void;
}) {
  const { contact, lastInboundAt } = item;
  const contactTags = (contact.tagIds ?? [])
    .map((id) => tagById.get(id))
    .filter((t): t is Tag => Boolean(t));
  const shownTags = contactTags.slice(0, 2);
  const extraTags = contactTags.length - shownTags.length;
  const stage = contact.stageId ? stageById.get(contact.stageId) ?? null : null;
  const label = contact.name || formatPhone(contact.phoneNumber);

  return (
    <li>
      <label
        className={cn(
          "flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/40",
          selected && "bg-primary/5 hover:bg-primary/5",
        )}
      >
        <input
          type="checkbox"
          className="size-4 shrink-0 cursor-pointer accent-primary"
          checked={selected}
          onChange={(e) => onSelectChange(contact.id, e.target.checked)}
          aria-label={`Select ${label}`}
        />
        <Avatar className="size-8 shrink-0">
          <AvatarFallback
            className="text-xs text-white"
            style={{ backgroundImage: avatarGradient(contact.id) }}
          >
            {initials(contact.name || contact.phoneNumber || "?")}
          </AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-medium">{label}</span>
          <span className="hidden shrink-0 font-mono text-2xs text-muted-foreground sm:inline">
            {formatPhone(contact.phoneNumber)}
          </span>
        </div>
        <div className="hidden shrink-0 items-center gap-1 md:flex">
          {shownTags.map((t) => (
            <TagChip key={t.id} tag={t} size="xs" />
          ))}
          {extraTags > 0 && (
            <span className="text-3xs text-muted-foreground">+{extraTags}</span>
          )}
        </div>
        {stage && (
          <span
            className={cn(
              "hidden shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-3xs font-medium sm:inline-flex",
              tagColorClasses(stage.color).pill,
            )}
            title={`Stage: ${stage.name}`}
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                tagColorClasses(stage.color).solid,
              )}
            />
            {stage.name}
          </span>
        )}
        <WindowBadge
          lastInboundAt={lastInboundAt}
          size="xs"
          className="hidden shrink-0 lg:inline-flex"
        />
      </label>
    </li>
  );
});
