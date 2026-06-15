"use client";

import { memo, useCallback, useDeferredValue, useMemo, useState } from "react";
import Link from "next/link";
import { Hash, Plus, Search, X } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { TeamChannelListItemDto } from "@ccp/shared/team-chat/types";
import type { Role } from "@ccp/shared/types";
import { cn } from "@ccp/shared/utils";

import { canCreateChannel } from "@ccp/shared/team-chat/permissions";

/**
 * Left column inside /team. Lists every channel with unread + mention badges,
 * a name filter, and virtualization for large channel sets.
 *
 * Virtualized via @tanstack/react-virtual — mirrors the customer inbox
 * conversation-list pattern so a team with hundreds of channels doesn't pay
 * the DOM cost for off-screen rows. Channel names are filtered client-side
 * (the full list is already loaded; case-insensitive substring match is
 * effectively free). `useDeferredValue` keeps each keystroke responsive
 * even on slower devices.
 */
const ROW_HEIGHT = 32; // matches the h-8 row class
const OVERSCAN = 8;

export function ChannelList({
  channels,
  activeChannelId,
  currentRole,
  onlinePresenceCount,
  onCreate,
  onOpenWorkspaceSearch,
}: {
  channels: TeamChannelListItemDto[];
  activeChannelId: string;
  currentRole: Role;
  onlinePresenceCount: number;
  onCreate: () => void;
  /** Opens the workspace-wide message search overlay. */
  onOpenWorkspaceSearch: () => void;
}) {
  const [query, setQuery] = useState("");
  // Keep typing responsive on slow devices — defers the filter pass without
  // adding a debounce timer. The filter is cheap (one .filter over an in-
  // memory array) so this is mostly insurance for very large channel sets.
  const deferredQuery = useDeferredValue(query);
  const visible = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return channels;
    return channels.filter((c) => c.name.toLowerCase().includes(q));
  }, [channels, deferredQuery]);

  // Direct viewport ref via ScrollArea's `viewportRef` prop — callback ref
  // fires synchronously on attach, no useLayoutEffect + querySelector
  // round-trip. Virtualizer sees a real scrollElement on the first render
  // after mount.
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const viewportRef = useCallback((node: HTMLDivElement | null) => {
    setScrollEl(node);
  }, []);

  const rowVirtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: (idx) => visible[idx]!.id,
  });

  // Fallback rendering for the brief window before the virtualizer has a
  // scroll element resolved — keeps the list painted on first render so the
  // sidebar doesn't flash empty during hydration.
  const virtualItems = rowVirtualizer.getVirtualItems();
  type RenderItem = { key: string; index: number; start: number; measured: boolean };
  const renderItems: RenderItem[] =
    virtualItems.length > 0
      ? virtualItems.map((v) => ({
          key: String(v.key),
          index: v.index,
          start: v.start,
          measured: true,
        }))
      : visible.slice(0, 30).map((c, idx) => ({
          key: c.id,
          index: idx,
          start: idx * ROW_HEIGHT,
          measured: false,
        }));
  const totalHeight =
    virtualItems.length > 0
      ? rowVirtualizer.getTotalSize()
      : visible.length * ROW_HEIGHT;

  return (
    <div className="flex h-full w-full shrink-0 flex-col border-r border-border bg-card/40 md:w-64">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <div>
          <div className="text-sm font-semibold">Team chat</div>
          <div className="text-2xs text-muted-foreground">
            {onlinePresenceCount} online
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onOpenWorkspaceSearch}
            className="pointer-coarse:size-9"
            aria-label="Search messages across every channel"
            title="Search messages"
          >
            <Search className="size-4" />
          </Button>
          {canCreateChannel(currentRole) && (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={onCreate}
              className="pointer-coarse:size-9"
              aria-label="Create channel"
            >
              <Plus className="size-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter channels"
            aria-label="Filter channels"
            className="h-7 pl-7 pr-7 text-xs"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear filter"
              className="absolute right-1 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>

      <div className="px-4 pb-1 text-3xs font-semibold uppercase tracking-wider text-muted-foreground/80">
        Channels
      </div>

      <ScrollArea viewportRef={viewportRef} className="flex-1">
        {visible.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            {query ? "No matches." : "No channels yet."}
          </div>
        ) : (
          <div
            className="relative w-full px-2 pb-3"
            style={{ height: `${totalHeight}px` }}
          >
            {renderItems.map((row) => {
              const c = visible[row.index]!;
              return (
                <div
                  key={row.key}
                  ref={row.measured ? rowVirtualizer.measureElement : undefined}
                  data-index={row.index}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  <ChannelRow channel={c} active={c.id === activeChannelId} />
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

/**
 * One channel row. Memoized so a `team:catalog:changed` re-render of the
 * parent list (or a per-row unread-count change on a SIBLING channel)
 * doesn't re-render every row — only the ones whose props actually changed.
 */
const ChannelRow = memo(function ChannelRow({
  channel: c,
  active,
}: {
  channel: TeamChannelListItemDto;
  active: boolean;
}) {
  return (
    <Link
      href={`/team/${c.id}`}
      className={cn(
        "group flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors",
        active
          ? "bg-accent text-accent-foreground font-medium"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <Hash
        className={cn(
          "size-3.5 shrink-0",
          active ? "text-primary" : "text-muted-foreground",
        )}
      />
      <span
        className={cn(
          "flex-1 truncate",
          c.unreadForMe && !active && "font-semibold text-foreground",
        )}
      >
        {c.name}
      </span>
      {c.unreadMentionCount > 0 && (
        <Badge
          variant="default"
          className="h-4 min-w-4 rounded-full bg-red-500 px-1 text-3xs"
        >
          {c.unreadMentionCount}
        </Badge>
      )}
      {c.unreadMentionCount === 0 && c.unreadForMe && !active && (
        <span className="size-1.5 rounded-full bg-primary" />
      )}
    </Link>
  );
});
