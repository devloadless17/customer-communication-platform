"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AtSign,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Inbox as InboxIcon,
  Layers,
  type LucideIcon,
  Phone,
  UserPlus,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import { cn, initials } from "@ccp/shared/utils";
import {
  AVAILABILITY_DOT_CLASSES,
  AVAILABILITY_LABELS,
} from "@ccp/shared/presence";
import type { ContactStage, ConversationWithRefs, User } from "@ccp/shared/types";
import type {
  Filter,
  PresetFilterId,
} from "@/features/inbox/components/inbox-controls";
import { useConversationCounts } from "@/features/inbox/hooks/use-conversation-counts";
import { useLiveCalls } from "@/features/calls/hooks/use-live-calls";

import { SubSidebar, SubSidebarSection } from "./sub-sidebar";

/**
 * Inbox sub-sidebar — Active / All / Mine / Unassigned / Closed presets,
 * plus the per-stage filter rows. Renders inside the `SubSidebar` shell so
 * the column lines up with every other section's sub-sidebar.
 *
 * "Active" = open + pending (everyday working view, default for new users).
 * "All"    = truly everything, including closed.
 */
interface PresetDef {
  id: PresetFilterId;
  label: string;
  icon: LucideIcon;
}

const PRESETS: PresetDef[] = [
  { id: "active", label: "Active", icon: InboxIcon },
  { id: "all", label: "All", icon: Layers },
  { id: "mine", label: "Mine", icon: AtSign },
  { id: "unassigned", label: "Unassigned", icon: UserPlus },
  { id: "closed", label: "Closed", icon: CheckCircle2 },
];

export function InboxSubSidebar({
  currentUser,
  conversations,
  stages,
  teammates,
  onlineUserIds,
  availabilityByUserId,
  filter,
  onFilterChange,
}: {
  currentUser: User;
  conversations: ConversationWithRefs[];
  stages: ContactStage[];
  /** Active teammates rendered under the Stages section with a presence dot. */
  teammates?: User[];
  /** When provided, teammate avatars get a green/grey dot. */
  onlineUserIds?: Set<string>;
  /** Sparse per-user availability badge. Absent entry = "available, no note". */
  availabilityByUserId?: Record<
    string,
    { status: import("@ccp/shared/types").UserAvailabilityStatus; message?: string | null }
  >;
  filter: Filter;
  onFilterChange: (f: Filter) => void;
}) {
  const [stagesOpen, setStagesOpen] = useState(filter.kind === "stage");
  const [teammatesOpen, setTeammatesOpen] = useState(true);

  // Self first, then the rest alphabetically — matches the old app-sidebar
  // ordering so it's obvious which row is "you".
  const orderedTeammates = useMemo(() => {
    if (!teammates || teammates.length === 0) return [];
    const me = teammates.find((u) => u.id === currentUser.id);
    const others = teammates
      .filter((u) => u.id !== currentUser.id)
      .sort((a, b) => a.name.localeCompare(b.name));
    return me ? [me, ...others] : others;
  }, [teammates, currentUser.id]);

  // Server-side counts over the FULL team. Truth source for the badges so
  // they don't lie when an agent has more matching threads than the
  // paginated inbox list has currently loaded. Null on first paint —
  // we fall back to the loaded-slice count below until the GET lands.
  const serverCounts = useConversationCounts();
  const liveCalls = useLiveCalls();

  // Bridge the team-wide non-closed unread total to the page island (InboxShell)
  // so it doesn't have to mount a SECOND useConversationCounts — which would
  // double every counts GET + socket listener set per tab. The sub-sidebar
  // (always mounted on /inbox via the layout) is the single owner; the shell
  // listens for this CustomEvent for its document-title badge. Same window-event
  // bridge the `ccp:contact-stage-delta` path uses to cross the layout/island
  // boundary without a shared React context (no Zustand/Context coupling).
  const activeUnread = serverCounts?.unread.active;
  useEffect(() => {
    if (typeof window === "undefined") return;
    const emit = () => {
      if (activeUnread === undefined) return;
      window.dispatchEvent(
        new CustomEvent("ccp:inbox-unread-total", { detail: { active: activeUnread } }),
      );
    };
    // Emit whenever the value changes...
    emit();
    // ...and answer a late-mounting listener's request (the shell may install
    // its listener after our initial emit; it dispatches this to pull the last
    // known value rather than wait for the next count-changing event).
    window.addEventListener("ccp:inbox-unread-request", emit);
    return () => window.removeEventListener("ccp:inbox-unread-request", emit);
  }, [activeUnread]);

  // Per-bucket UNREAD counts (conversations with unread messages). Server truth
  // when loaded, else derived from the loaded slice for first paint. These drive
  // the filter badges now — a green unread pill styled like the conversation-row
  // badge (request: surface unread on the filters), no separate total count.
  const unreadCounts = useMemo<Record<PresetFilterId, number>>(() => {
    // `?.unread` (not just `serverCounts`): a counts response from before this
    // field shipped (cached, or a version-skewed server mid-deploy) has no
    // `unread` — fall back to the loaded-slice derivation instead of crashing.
    if (serverCounts?.unread) return serverCounts.unread;
    const c = conversations.map((x) => x.conversation);
    const u = (x: (typeof c)[number]) => x.unreadCount > 0;
    return {
      active: c.filter((x) => x.status !== "closed" && u(x)).length,
      all: c.filter(u).length,
      mine: c.filter(
        (x) => x.status !== "closed" && x.assignedUserId === currentUser.id && u(x),
      ).length,
      unassigned: c.filter(
        (x) => x.status !== "closed" && x.assignedUserId === null && u(x),
      ).length,
      closed: c.filter((x) => x.status === "closed" && u(x)).length,
    };
  }, [serverCounts, conversations, currentUser.id]);

  const stageCounts = useMemo(() => {
    if (serverCounts) return serverCounts.byStage;
    // Count ALL conversations per stage (open + closed). Stages model
    // contact lifecycle which is orthogonal to chat status — the badge
    // and the clicked-stage list both follow the same "include closed"
    // rule. See conversations service + queries for the matching
    // server-side change.
    const out: Record<string, number> = {};
    for (const { contact } of conversations) {
      const sid = contact.stageId;
      if (!sid) continue;
      out[sid] = (out[sid] ?? 0) + 1;
    }
    return out;
  }, [serverCounts, conversations]);

  return (
    <SubSidebar title="Inbox">
      <SubSidebarSection>
        {PRESETS.map(({ id, label, icon: Icon }) => {
          const active = filter.kind === "preset" && filter.id === id;
          const unread = unreadCounts[id];
          return (
            <button
              key={id}
              type="button"
              onClick={() => onFilterChange({ kind: "preset", id })}
              className={cn(
                "group flex h-8 cursor-pointer items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors",
                "hover:bg-accent hover:text-accent-foreground",
                active
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-muted-foreground",
              )}
            >
              <Icon
                className={cn(
                  "size-4 shrink-0",
                  active ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                )}
              />
              <span className="flex-1 text-left">{label}</span>
              {unread > 0 && (
                <span
                  className="flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold tabular-nums text-primary-foreground"
                  title={`${unread} unread`}
                >
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </button>
          );
        })}
        {/* Calls — team-wide call history rendered INSIDE the inbox content
            area (not a route), so it behaves like the other filters. Sits
            right under Closed. The live-calls count badge rides on the right. */}
        <button
          type="button"
          onClick={() => onFilterChange({ kind: "calls" })}
          className={cn(
            "group flex h-8 cursor-pointer items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors",
            "hover:bg-accent hover:text-accent-foreground",
            filter.kind === "calls"
              ? "bg-accent text-accent-foreground font-medium"
              : "text-muted-foreground",
          )}
        >
          <Phone
            className={cn(
              "size-4 shrink-0",
              filter.kind === "calls"
                ? "text-primary"
                : "text-muted-foreground group-hover:text-foreground",
            )}
          />
          <span className="flex-1 text-left">Calls</span>
          {liveCalls > 0 && (
            <span
              className="flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-bold tabular-nums text-white"
              title={`${liveCalls} call${liveCalls === 1 ? "" : "s"} in progress`}
            >
              {liveCalls > 99 ? "99+" : liveCalls}
            </span>
          )}
        </button>
      </SubSidebarSection>

      <div className="mt-3">
        <button
          type="button"
          onClick={() => setStagesOpen((v) => !v)}
          aria-expanded={stagesOpen}
          className="flex w-full cursor-pointer items-center gap-1.5 px-4 pb-1 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80 transition-colors hover:text-foreground"
        >
          {stagesOpen ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
          <span className="flex-1 truncate">Stages</span>
          {!stagesOpen && stages.length > 0 && (
            <span className="tabular-nums text-[10px] font-medium text-muted-foreground/70">
              {stages.length}
            </span>
          )}
        </button>

        {stagesOpen && (
          <div className="flex flex-col gap-0.5 px-2">
            {stages.length === 0 ? (
              <p className="px-2 py-1 text-[11px] text-muted-foreground">No stages yet.</p>
            ) : (
              stages.map((stage) => {
                const active = filter.kind === "stage" && filter.stageId === stage.id;
                const count = stageCounts[stage.id] ?? 0;
                const dot = tagColorClasses(stage.color).solid;
                return (
                  <button
                    key={stage.id}
                    type="button"
                    onClick={() => onFilterChange({ kind: "stage", stageId: stage.id })}
                    title={
                      stage.isDefault
                        ? `${stage.name} · default for new contacts`
                        : stage.name
                    }
                    className={cn(
                      "group flex h-8 cursor-pointer items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors",
                      "hover:bg-accent hover:text-accent-foreground",
                      active
                        ? "bg-accent text-accent-foreground font-medium"
                        : "text-muted-foreground",
                    )}
                  >
                    <span className={cn("size-2 shrink-0 rounded-full", dot)} />
                    <span className="flex-1 truncate text-left">{stage.name}</span>
                    {stage.isDefault && (
                      <span
                        className="text-[9px] uppercase tracking-wider text-muted-foreground/70"
                        aria-label="Default stage"
                      >
                        def
                      </span>
                    )}
                    {count > 0 && (
                      <span
                        className={cn(
                          "tabular-nums text-[10px]",
                          active ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {orderedTeammates.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setTeammatesOpen((v) => !v)}
            aria-expanded={teammatesOpen}
            className="flex w-full cursor-pointer items-center gap-1.5 px-4 pb-1 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80 transition-colors hover:text-foreground"
          >
            {teammatesOpen ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
            <span className="flex-1 truncate">Teammates</span>
            {!teammatesOpen && (
              <span className="tabular-nums text-[10px] font-medium text-muted-foreground/70">
                {orderedTeammates.length}
              </span>
            )}
          </button>

          {teammatesOpen && (
            <div className="flex flex-col gap-0.5 px-2">
              {orderedTeammates.map((u) => {
                // Only render presence dots when we actually know status.
                // Otherwise the row is identical for every page.
                const hasPresence = onlineUserIds !== undefined;
                const online = hasPresence ? onlineUserIds.has(u.id) : false;
                // Availability badge — sparse map, absence = "available + no
                // note" (the dot just reflects online/offline). When the user
                // has set busy/away the dot color comes from the shared
                // catalog; an offline-marked teammate falls into the
                // "not online" branch because the server filtered them out of
                // onlineUserIds, so the offline color naturally applies.
                // SEED status + note from the SSR user (`u`) so they render on
                // the FIRST paint. The live presence map (`availabilityByUserId`)
                // is empty until the `user:availability:snapshot` socket frame
                // lands a beat after connect; without the seed the note pops in
                // then — growing the row a line — which is the "teammates
                // vibrate on refresh" jank. Live data takes over the instant it
                // arrives (a present entry is authoritative, even if its note is
                // null = the user cleared it).
                const live = availabilityByUserId?.[u.id];
                const status = live ? live.status : (u.availabilityStatus ?? "available");
                const note = live ? live.message ?? null : (u.availabilityMessage ?? null);
                const dotClass = online
                  ? AVAILABILITY_DOT_CLASSES[status]
                  : AVAILABILITY_DOT_CLASSES.offline;
                const dotLabel = !hasPresence
                  ? ""
                  : online
                    ? AVAILABILITY_LABELS[status]
                    : "Offline";
                const trimmedNote = note?.trim() || null;
                return (
                  <div
                    key={u.id}
                    className="flex min-h-8 items-center gap-2.5 rounded-md px-2.5 py-1 text-[13px] text-muted-foreground"
                    title={dotLabel}
                  >
                    <div className="relative shrink-0">
                      <Avatar className="size-5">
                        <AvatarFallback seed={u.id} className="text-[9px]">
                          {initials(u.name)}
                        </AvatarFallback>
                      </Avatar>
                      {hasPresence && (
                        <span
                          className={cn(
                            "absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-sidebar transition-colors",
                            dotClass,
                          )}
                          aria-label={dotLabel}
                        />
                      )}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate">{u.name}</span>
                        {u.id === currentUser.id && (
                          <Badge variant="muted" className="shrink-0 px-1.5 py-0 text-[10px]">
                            you
                          </Badge>
                        )}
                      </div>
                      {/* Availability note — surfaced inline (was a hover-only
                          `title` tooltip nobody could find). */}
                      {trimmedNote && (
                        <span
                          className="truncate text-[11px] leading-tight text-muted-foreground/70"
                          title={trimmedNote}
                        >
                          {trimmedNote}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </SubSidebar>
  );
}
