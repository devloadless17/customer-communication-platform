"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { ContactRound, Users2 } from "lucide-react";

import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import { LIVE_CHANNELS } from "@ccp/shared/providers/capabilities";
import { CHANNEL_LABEL, ChannelBadge } from "@/features/inbox/components/channel-badge";
import type { AudienceGroupDto } from "@ccp/shared/dtos";
import type { Channel, ContactStage } from "@ccp/shared/types";

import {
  SubSidebar,
  SubSidebarGroup,
  SubSidebarItem,
  SubSidebarSection,
  SubSidebarSubLabel,
} from "./sub-sidebar";

/**
 * Contacts sub-sidebar — All / Channels / Lifecycle / Segments.
 *
 * "All contacts" is the DIRECTORY: everyone with a phone number, whatever
 * channel they arrived on. The Channels group is how you reach the rest —
 * Instagram handles and web-chat visitors who left an email will never have a
 * phone on file, and each link lifts the phone gate (`reach=any`) for that one
 * channel so they are one click away rather than lost. Counts come from a single
 * grouped query (`GET /api/contacts/segment-counts`), so a channel with nobody
 * on it simply doesn't render.
 *
 * Lifecycle stages come from the same `ContactStage` catalog used by /settings
 * and the contacts table. Selecting one navigates to `/contacts?stage=<id>`
 * (or `?stage=none`) which the contacts page already understands. Segments
 * link to the audience-group preview page (`/broadcasts/groups/[id]`); we
 * don't have an in-place contacts filter for them yet.
 *
 * Items deliberately omitted from the mockup ("Create AI Agent", "Blocked
 * Contacts") have no backing page today.
 */
export function ContactsSubSidebar({
  stages,
  audienceGroups,
  segmentCounts,
}: {
  stages: ContactStage[];
  audienceGroups: AudienceGroupDto[];
  /** Directory + per-channel totals for the badges. */
  segmentCounts?: { withPhone: number; byChannel: Partial<Record<Channel, number>> };
}) {
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const activeStage = searchParams?.get("stage") ?? null;
  const activeChannel = searchParams?.get("channel") ?? null;

  const onContactsPage = pathname === "/contacts" || pathname.startsWith("/contacts/");
  const noStageFilter = !activeStage;
  const allActive = onContactsPage && noStageFilter && !activeChannel;
  const count = (n: number | undefined) =>
    n === undefined ? undefined : (
      <span className="text-3xs tabular-nums text-muted-foreground">{n}</span>
    );

  return (
    <SubSidebar title="Contacts">
      <SubSidebarSection>
        <SubSidebarItem
          href="/contacts"
          label="All contacts"
          leading={<ContactRound className="size-4" />}
          active={allActive}
          trailing={count(segmentCounts?.withPhone)}
        />
      </SubSidebarSection>

      {segmentCounts && (
        <SubSidebarGroup label="Channels" defaultOpen>
          {[...LIVE_CHANNELS]
            // Only channels this workspace actually has contacts on — an empty
            // row is a dead end, and the set is per-workspace, not a fixed list.
            .filter((ch) => (segmentCounts.byChannel[ch] ?? 0) > 0)
            .map((ch) => (
              <SubSidebarItem
                key={ch}
                // `reach=any` is the point of these links: lift the directory's
                // phone gate so this channel's email-only people are reachable.
                href={`/contacts?channel=${ch}&reach=any`}
                label={CHANNEL_LABEL[ch]}
                leading={<ChannelBadge channel={ch} className="size-3.5 shrink-0" />}
                active={onContactsPage && activeChannel === ch}
                trailing={count(segmentCounts.byChannel[ch])}
              />
            ))}
        </SubSidebarGroup>
      )}

      {stages.length > 0 && (
        <SubSidebarGroup label="Lifecycle" defaultOpen>
          <SubSidebarSubLabel>Lifecycle Stages</SubSidebarSubLabel>
          {stages.map((stage) => {
            const active =
              onContactsPage && activeStage === stage.id;
            const dot = tagColorClasses(stage.color).solid;
            return (
              <SubSidebarItem
                key={stage.id}
                href={`/contacts?stage=${stage.id}`}
                label={stage.name}
                leading={<span className={`size-2 rounded-full ${dot}`} />}
                active={active}
              />
            );
          })}
        </SubSidebarGroup>
      )}

      {audienceGroups.length > 0 && (
        <SubSidebarGroup label="Segments" defaultOpen>
          {audienceGroups.map((group) => {
            const href = `/broadcasts/groups/${group.id}`;
            const active = pathname === href;
            return (
              <SubSidebarItem
                key={group.id}
                href={href}
                label={group.name}
                leading={<Users2 className="size-3.5" />}
                active={active}
                trailing={
                  <span className="text-3xs tabular-nums text-muted-foreground">
                    {group.memberCount}
                  </span>
                }
              />
            );
          })}
        </SubSidebarGroup>
      )}
    </SubSidebar>
  );
}
