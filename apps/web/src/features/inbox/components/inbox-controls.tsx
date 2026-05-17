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

/**
 * Inbox-only filter & stages controls. Lives BELOW the "Inbox" item in the
 * shared AppSidebar, but only when /inbox is the active route — on every
 * other page these UI bits would do nothing useful.
 *
 * Pulled out of the old Sidebar component so the global sidebar shell can
 * stay free of inbox-specific state / props. The filter type is exported
 * here too because it's a piece of inbox semantics, not navigation.
 */

export type PresetFilterId = "all" | "mine" | "unassigned" | "closed";

/**
 * Active inbox filter. Presets and stage filters are mutually exclusive —
 * selecting one clears the other. The discriminated shape lets the
 * conversation list switch on `kind` instead of parsing magic strings, and
 * lets the header render the stage's real name.
 */
export type Filter =
  | { kind: "preset"; id: PresetFilterId }
  | { kind: "stage"; stageId: string };

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

export function InboxControls({
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
  // Auto-expand the Stages sub-section when a stage filter is active so the
  // selected row is visible without a manual click.
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

  // Per-stage open-chat counts — same "non-closed" rule as the All preset so
  // the badge matches what the user sees when they click in.
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
    // Indented from the Inbox row so visually they read as a sub-tree, not as
    // peers of the next nav section.
    <div className="ml-3 mt-0.5 mb-1 flex flex-col gap-0.5 border-l border-sidebar-border/60 pl-1.5">
      {PRESETS.map(({ id, label, icon: Icon }) => {
        const active = filter.kind === "preset" && filter.id === id;
        const count = presetCounts[id];
        return (
          <button
            key={id}
            type="button"
            onClick={() => onFilterChange({ kind: "preset", id })}
            className={cn(
              "group flex h-7 items-center gap-2 rounded-md px-2 text-[13px] transition-colors",
              "hover:bg-accent hover:text-accent-foreground",
              active
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground",
            )}
          >
            <Icon
              className={cn(
                "size-3.5 shrink-0",
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

      <button
        type="button"
        onClick={() => setStagesOpen((v) => !v)}
        aria-expanded={stagesOpen}
        className="mt-1 flex h-7 items-center gap-1.5 rounded-md px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80 transition-colors hover:text-foreground"
      >
        {stagesOpen ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        <span className="flex-1 text-left">Stages</span>
        {!stagesOpen && stages.length > 0 && (
          <span className="tabular-nums text-[10px] font-medium text-muted-foreground/70">
            {stages.length}
          </span>
        )}
      </button>

      {stagesOpen && (
        <div className="flex flex-col gap-0.5">
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
                    "group flex h-7 items-center gap-2 rounded-md px-2 text-[13px] transition-colors",
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
  );
}
