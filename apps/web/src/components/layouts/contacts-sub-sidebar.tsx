"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { ContactRound, Users2 } from "lucide-react";

import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import type { AudienceGroupDto } from "@ccp/shared/dtos";
import type { ContactStage } from "@ccp/shared/types";

import {
  SubSidebar,
  SubSidebarGroup,
  SubSidebarItem,
  SubSidebarSection,
  SubSidebarSubLabel,
} from "./sub-sidebar";

/**
 * Contacts sub-sidebar — All / Lifecycle / Segments.
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
}: {
  stages: ContactStage[];
  audienceGroups: AudienceGroupDto[];
}) {
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const activeStage = searchParams?.get("stage") ?? null;

  const onContactsPage = pathname === "/contacts" || pathname.startsWith("/contacts/");
  const noStageFilter = !activeStage;
  const allActive = onContactsPage && noStageFilter;

  return (
    <SubSidebar title="Contacts">
      <SubSidebarSection>
        <SubSidebarItem
          href="/contacts"
          label="All"
          leading={<ContactRound className="size-4" />}
          active={allActive}
        />
      </SubSidebarSection>

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
                  <span className="text-[10px] tabular-nums text-muted-foreground/70">
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
