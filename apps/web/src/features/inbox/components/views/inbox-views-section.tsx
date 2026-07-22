"use client";

import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Users,
} from "lucide-react";

import {
  summarizeInboxViewFilters,
  type InboxView,
} from "@ccp/shared/inbox-views/types";
import type { ContactStage, Tag, User } from "@ccp/shared/types";
import { cn } from "@ccp/shared/utils";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { CHANNEL_LABEL } from "@/features/inbox/components/channel-badge";
import type { Filter } from "@/features/inbox/components/inbox-controls";
import { useInboxViews } from "@/features/inbox/contexts/inbox-views-context";
import { ViewBuilderDialog } from "./view-builder-dialog";
import { viewIcon } from "./view-icon";

/**
 * The "Views" block of the inbox rail — saved filters, shared ones first.
 *
 * Sits directly under the built-in Filters block because it is the same kind
 * of thing (a way to slice the list), and above Stages because a view is the
 * slice a team actually works from day to day. A shared view carries a small
 * people glyph so it is obvious at a glance which rows every teammate can see
 * — without it, "did I just rename something for everyone?" is unanswerable
 * from the rail.
 */
export function InboxViewsSection({
  filter,
  onFilterChange,
  canShare,
  stages,
  tags,
  teammates,
}: {
  filter: Filter;
  onFilterChange: (f: Filter) => void;
  canShare: boolean;
  stages: ContactStage[];
  tags: Tag[];
  teammates: User[];
}) {
  const { views, counts, createView, updateView, deleteView } = useInboxViews();
  const [open, setOpen] = useState(true);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<InboxView | null>(null);
  // `confirmDialog` is the portal element — it must be rendered, or the
  // promise from `confirm()` never resolves and Delete silently does nothing.
  const { confirm, confirmDialog } = useConfirm();

  const lookup = useMemo(
    () => ({
      stageNames: Object.fromEntries(stages.map((s) => [s.id, s.name])),
      tagNames: Object.fromEntries(tags.map((t) => [t.id, t.name])),
      userNames: Object.fromEntries(teammates.map((u) => [u.id, u.name])),
      channelLabels: CHANNEL_LABEL,
    }),
    [stages, tags, teammates],
  );

  function openCreate() {
    setEditing(null);
    setBuilderOpen(true);
  }

  function openEdit(view: InboxView) {
    setEditing(view);
    setBuilderOpen(true);
  }

  async function handleDelete(view: InboxView) {
    const ok = await confirm({
      title: `Delete “${view.name}”?`,
      description:
        view.visibility === "shared"
          ? "This removes it from every teammate's sidebar. Conversations are not affected."
          : "Conversations are not affected — only this saved filter is removed.",
      confirmLabel: "Delete view",
      destructive: true,
    });
    if (!ok) return;
    const deleted = await deleteView(view.id);
    // If the deleted view was the active filter, the list would keep asking
    // for an id that now 404s. Fall back to the default preset.
    if (deleted && filter.kind === "view" && filter.viewId === view.id) {
      onFilterChange({ kind: "preset", id: "active" });
    }
  }

  return (
    <div className="mt-3">
      <div className="flex items-center gap-1 px-4 pb-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex flex-1 cursor-pointer items-center gap-1.5 text-left text-2xs font-semibold uppercase tracking-wider text-muted-foreground/80 transition-colors hover:text-foreground"
        >
          {open ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
          <span className="flex-1 truncate">Views</span>
          {!open && views.length > 0 && (
            <span className="tabular-nums text-3xs font-medium text-muted-foreground">
              {views.length}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={openCreate}
          title="New view"
          aria-label="New view"
          className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      {open && (
        <div className="flex flex-col gap-0.5 px-2">
          {views.length === 0 ? (
            <button
              type="button"
              onClick={openCreate}
              className="cursor-pointer rounded-md px-2 py-1.5 text-left text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Save a filter as a view →
            </button>
          ) : (
            views.map((view) => {
              const active = filter.kind === "view" && filter.viewId === view.id;
              const Icon = viewIcon(view.icon);
              const count = counts?.[view.id];
              return (
                <div
                  key={view.id}
                  className={cn(
                    "group flex h-8 items-center rounded-md pr-1 transition-colors",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => onFilterChange({ kind: "view", viewId: view.id })}
                    title={`${view.name} — ${summarizeInboxViewFilters(view.filters, lookup)}`}
                    className={cn(
                      "flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2.5 text-sm",
                      active && "font-medium",
                    )}
                  >
                    <Icon
                      className={cn(
                        "size-4 shrink-0",
                        active ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-left">{view.name}</span>
                    {view.visibility === "shared" && (
                      <Users
                        className="size-3 shrink-0 text-muted-foreground/60"
                        aria-label="Shared with the workspace"
                      />
                    )}
                    {!!count?.total && (
                      <span
                        className={cn(
                          "tabular-nums text-3xs",
                          active ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {count.total > 999 ? "999+" : count.total}
                      </span>
                    )}
                    {!!count?.unread && (
                      <span
                        className="flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-3xs font-bold tabular-nums text-primary-foreground"
                        title={`${count.unread} unread`}
                      >
                        {count.unread > 99 ? "99+" : count.unread}
                      </span>
                    )}
                  </button>

                  {view.isEditable && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        aria-label={`Actions for ${view.name}`}
                        className={cn(
                          "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-background hover:text-foreground",
                          // Revealed on hover / keyboard focus. `focus-within`
                          // is what keeps it reachable by Tab — opacity-0 alone
                          // would hide it from sighted keyboard users.
                          "opacity-0 group-hover:opacity-100 focus:opacity-100",
                        )}
                      >
                        <MoreHorizontal className="size-3.5" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => openEdit(view)}>
                          <Pencil className="size-3.5" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onSelect={() => void handleDelete(view)}
                        >
                          <Trash2 className="size-3.5" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {confirmDialog}

      <ViewBuilderDialog
        open={builderOpen}
        onClose={() => setBuilderOpen(false)}
        existing={editing}
        canShare={canShare}
        stages={stages}
        tags={tags}
        teammates={teammates}
        onSubmit={async (input) => {
          if (editing) {
            const updated = await updateView(editing.id, input);
            return !!updated;
          }
          const created = await createView(input);
          // Switch straight to what was just built — the reason for creating a
          // view is to look at it.
          if (created) onFilterChange({ kind: "view", viewId: created.id });
          return !!created;
        }}
      />
    </div>
  );
}
