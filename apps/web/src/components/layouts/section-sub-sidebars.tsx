"use client";

import { usePathname } from "next/navigation";
import {
  FileText,
  Megaphone,
  Settings2,
  Sparkles,
  Users2,
  Workflow as WorkflowIcon,
} from "lucide-react";

import {
  SubSidebar,
  SubSidebarItem,
  SubSidebarSection,
} from "./sub-sidebar";
import {
  OUTREACH_CHANNEL_LABEL,
  useOutreachChannel,
  type OutreachChannel,
} from "@/features/broadcasts/hooks/use-outreach-channel";

/**
 * Section sub-sidebars without their own dedicated file. Each is small
 * (just a few nav items) — keeping them colocated avoids spawning a file
 * per section. Inbox / Contacts / Settings get their own files because
 * they own more state.
 */

/**
 * Outreach, organized BY CHANNEL.
 *
 * A campaign is WhatsApp or Messenger or Instagram — never a mix — and each
 * channel has genuinely different assets behind it: WhatsApp has a template
 * catalogue and Meta's template library, the social channels have neither. So
 * the section leads with the channel and shows only what that channel actually
 * has, instead of one flat list where "Templates" is silently WhatsApp-only.
 *
 * The selection is a client-side scope, not a route segment: it drives which
 * links are OFFERED and pre-scopes the composer. Broadcast history stays at one
 * URL so a link someone shared keeps working.
 */
export function BroadcastsSubSidebar() {
  const pathname = usePathname() ?? "";
  const { channel, setChannel, available } = useOutreachChannel();

  const isActive = (href: string) => {
    if (href === "/broadcasts") {
      // /broadcasts/groups should NOT highlight the parent — it has its own row.
      return pathname === "/broadcasts" || /^\/broadcasts\/(?!groups($|\/))/.test(pathname);
    }
    return pathname === href || pathname.startsWith(href + "/");
  };

  return (
    <SubSidebar title="Outreach">
      {available.length > 1 && (
        <div className="px-2 pb-2">
          <label className="flex flex-col gap-1">
            <span className="px-1 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
              Channel
            </span>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as OutreachChannel)}
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
            >
              {available.map((c) => (
                <option key={c} value={c}>
                  {OUTREACH_CHANNEL_LABEL[c]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <SubSidebarSection>
        <SubSidebarItem
          href={`/broadcasts?channel=${channel}`}
          label="Broadcasts"
          leading={<Megaphone className="size-4" />}
          active={isActive("/broadcasts")}
        />
        <SubSidebarItem
          href="/broadcasts/groups"
          label="Audience groups"
          leading={<Users2 className="size-4" />}
          active={isActive("/broadcasts/groups")}
        />
        {/* Templates and the library are a WhatsApp capability. Messenger and
            Instagram have no template catalogue at all, so listing these under
            them would be a dead end rather than a feature. */}
        {channel === "whatsapp" && (
          <>
            <SubSidebarItem
              href="/templates"
              label="Templates"
              leading={<FileText className="size-4" />}
              active={pathname === "/templates" || /^\/templates\/(?!library($|\/))/.test(pathname)}
            />
            <SubSidebarItem
              href="/templates/library"
              label="Template library"
              leading={<Sparkles className="size-4" />}
              active={isActive("/templates/library")}
            />
          </>
        )}
        <SubSidebarItem
          href={`/settings/${channel}`}
          label="Channel settings"
          leading={<Settings2 className="size-4" />}
          active={isActive(`/settings/${channel}`)}
        />
      </SubSidebarSection>
    </SubSidebar>
  );
}

export function WorkflowsSubSidebar() {
  return (
    <SubSidebar title="Workflows" subtitle="Triggers and automations">
      <SubSidebarSection>
        <SubSidebarItem
          href="/workflows"
          label="All workflows"
          leading={<WorkflowIcon className="size-4" />}
          active
        />
      </SubSidebarSection>
    </SubSidebar>
  );
}

/**
 * Team chat sub-sidebar — channels list. The existing `ChannelList` inside
 * `team-chat-workspace.tsx` already renders a rich channel list with unread
 * counts; we keep that one as the canonical UI. This minimal version is
 * shown when the workspace hasn't mounted yet (loading + sub-routes without
 * a selected channel).
 */
