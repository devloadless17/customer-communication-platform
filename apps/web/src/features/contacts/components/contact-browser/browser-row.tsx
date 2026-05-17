"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { WindowBadge } from "@/features/inbox/components/window-badge";
import { TagChip } from "@/features/tags/components/tag-chip";
import { avatarGradient } from "@ccp/shared/utils/avatar-color";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import { cn, formatPhone, initials } from "@ccp/shared/utils";
import type {
  ContactFieldDefinition,
  ContactListItem,
  ContactStage,
  Tag,
} from "@ccp/shared/types";

export function BrowserRow({
  item,
  fieldDefinitions,
  tagById,
  stageById,
  selected,
  onSelectChange,
}: {
  item: ContactListItem;
  fieldDefinitions: ContactFieldDefinition[];
  tagById: Map<string, Tag>;
  stageById: Map<string, ContactStage>;
  selected: boolean;
  onSelectChange: (next: boolean) => void;
}) {
  const { contact, lastInboundAt } = item;
  const filledFields = fieldDefinitions
    .map((def) => ({ def, value: contact.customFields[def.key] }))
    .filter((f): f is { def: ContactFieldDefinition; value: string } => Boolean(f.value));
  const contactTags = (contact.tagIds ?? [])
    .map((id) => tagById.get(id))
    .filter((t): t is Tag => Boolean(t));
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
          onChange={(e) => onSelectChange(e.target.checked)}
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
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{label}</span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {formatPhone(contact.phoneNumber)}
            </span>
          </div>
          {(contact.email || contact.location || filledFields.length > 0) && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              {contact.email && <span className="truncate">{contact.email}</span>}
              {contact.location && <span className="truncate">{contact.location}</span>}
              {filledFields.map(({ def, value }) => (
                <Badge key={def.id} variant="muted" className="text-[10px]">
                  <span className="opacity-60">{def.label}:</span>
                  <span className="ml-1">{value}</span>
                </Badge>
              ))}
            </div>
          )}
          {contactTags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {contactTags.map((t) => (
                <TagChip key={t.id} tag={t} size="xs" />
              ))}
            </div>
          )}
        </div>
        {stage && (
          <span
            className={cn(
              "hidden shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] sm:inline-flex",
              tagColorClasses(stage.color).chip,
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
        <WindowBadge lastInboundAt={lastInboundAt} size="xs" className="hidden shrink-0 sm:inline-flex" />
      </label>
    </li>
  );
}
