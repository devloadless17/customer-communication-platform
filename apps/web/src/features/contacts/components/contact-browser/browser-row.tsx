"use client";

import { memo } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ChannelBadge } from "@/features/inbox/components/channel-badge";
import { WindowBadge } from "@/features/inbox/components/window-badge";
import { TagChip } from "@/features/tags/components/tag-chip";
import { AccountLabel } from "@/features/channels/components/account-label";
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
          "flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/50",
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
          {contact.avatarUrl ? <AvatarImage src={contact.avatarUrl} alt="" /> : null}
          <AvatarFallback
            className="text-xs text-white"
            style={{ backgroundImage: avatarGradient(contact.id) }}
          >
            {initials(contact.name || contact.phoneNumber || "?")}
          </AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-medium">{label}</span>
          {contact.identityChannel && (
            <ChannelBadge
              channel={contact.identityChannel}
              className="size-3.5 shrink-0"
            />
          )}
          {/* WHICH of our numbers this person talks to. The directory could
              already FILTER by account, but the rows never SHOWED it — so
              clearing the filter made two people who message two different
              numbers look identical again. Hidden on single-account channels. */}
          <AccountLabel
            channel={contact.identityChannel ?? undefined}
            accountId={item.channelConnectionId}
            verb="Received on"
          />
          <span className="hidden shrink-0 whitespace-nowrap font-mono text-2xs tabular-nums text-muted-foreground sm:inline">
            {formatPhone(contact.phoneNumber)}
          </span>
        </div>
        <div className="hidden shrink-0 items-center gap-1 md:flex">
          {shownTags.map((t) => (
            <TagChip key={t.id} tag={t} size="md" />
          ))}
          {extraTags > 0 && (
            <span className="rounded-full border border-border bg-muted/30 px-1.5 py-0.5 text-3xs font-medium text-muted-foreground">
              +{extraTags}
            </span>
          )}
        </div>
        {contactTags.length > 0 && (
          // Below md the tag chips are hidden — surface a compact count so the
          // row still signals "this contact has tags" (tap-through reveals them
          // in the detail drawer). Tooltip lists the names for a quick peek.
          <span
            className="shrink-0 rounded-full border border-border bg-muted/30 px-1.5 py-0.5 text-3xs font-medium text-muted-foreground md:hidden"
            title={contactTags.map((t) => t.name).join(", ")}
          >
            {contactTags.length} {contactTags.length === 1 ? "tag" : "tags"}
          </span>
        )}
        {stage && (
          <span
            className={cn(
              "hidden max-w-30 shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-3xs font-medium sm:inline-flex",
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
            <span className="min-w-0 truncate">{stage.name}</span>
          </span>
        )}
        <WindowBadge
          lastInboundAt={lastInboundAt}
          channel={contact.identityChannel ?? undefined}
          size="xs"
          className="hidden shrink-0 lg:inline-flex"
        />
      </label>
    </li>
  );
});
