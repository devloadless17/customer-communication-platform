"use client";

import { useMemo, useState } from "react";
import {
  AtSign,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Inbox as InboxIcon,
  type LucideIcon,
  UserPlus,
} from "lucide-react";

import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import { cn } from "@ccp/shared/utils";
import type { ContactStage, ConversationWithRefs, User } from "@ccp/shared/types";
import type {
  Filter,
  PresetFilterId,
} from "@/features/inbox/components/inbox-controls";

import { SubSidebar, SubSidebarSection } from "./sub-sidebar";

/**
 * Inbox sub-sidebar — All / Mine / Unassigned / Closed presets, plus the
 * per-stage filter rows. Renders inside the `SubSidebar` shell so the
 * column lines up with every other section's sub-sidebar.
 */
interface PresetDef {
  id: PresetFilterId;
  label: string;
  icon: LucideIcon;
}

const PRESETS: PresetDef[] = [
  { id: "all", label: "All", icon: InboxIcon },
  { id: "mine", label: "Mine", icon: AtSign },
  { id: "unassigned", label: "Unassigned", icon: UserPlus },
  { id: "closed", label: "Closed", icon: CheckCircle2 },
];

export function InboxSubSidebar({
  currentUser,
  conversations,
  stages,
  filter,
  onFilterChange,
}: {
  currentUser: User;
  conversations: ConversationWithRefs[];
  stages: ContactStage[];
  filter: Filter;
  onFilterChange: (f: Filter) => void;
}) {
  const [stagesOpen, setStagesOpen] = useState(filter.kind === "stage");

  const presetCounts = useMemo(() => {
    const c = conversations.map((x) => x.conversation);
    return {
      all: c.filter((x) => x.status !== "closed").length,
      mine: c.filter((x) => x.assignedUserId === currentUser.id && x.status !== "closed").length,
      unassigned: c.filter((x) => x.assignedUserId === null && x.status !== "closed").length,
      closed: c.filter((x) => x.status === "closed").length,
    } satisfies Record<PresetFilterId, number>;
  }, [conversations, currentUser.id]);

  const stageCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const { conversation, contact } of conversations) {
      if (conversation.status === "closed") continue;
      const sid = contact.stageId;
      if (!sid) continue;
      out[sid] = (out[sid] ?? 0) + 1;
    }
    return out;
  }, [conversations]);

  return (
    <SubSidebar title="Inbox">
      <SubSidebarSection>
        {PRESETS.map(({ id, label, icon: Icon }) => {
          const active = filter.kind === "preset" && filter.id === id;
          const count = presetCounts[id];
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
        })}
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
    </SubSidebar>
  );
}
