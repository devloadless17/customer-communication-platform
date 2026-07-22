"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, Flag, Loader2, MessageSquare, RotateCcw, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layouts/page-header";
import { LocalTime } from "@/components/local-time";
import { ChannelBadge } from "@/features/inbox/components/channel-badge";
import { apiFetch } from "@/lib/api/client-fetch";
import { getClientSocket } from "@/lib/socket-client";
import { toast } from "@/lib/toast";
import { cn } from "@ccp/shared/utils";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import type { Channel, MessageFlagDefinition } from "@ccp/shared/types";
import type {
  MessageFlagCounts,
  MessageFlagQueueItem,
  MessageFlagStatus,
} from "@ccp/shared/message-flags/types";

/**
 * The triage queue.
 *
 * Live-patched by the `message:flag` socket frame rather than polled: when a
 * teammate resolves a complaint, the row leaves everyone's open queue at once.
 * The frame carries the whole flag, but NOT the conversation context a queue
 * row renders (contact name, message excerpt), so a flag that becomes newly
 * visible under the current filter triggers a refetch instead of being spliced
 * in from partial data — a row with a blank contact name would be worse than a
 * beat of latency.
 */

type StatusTab = "open" | "resolved";

export function FlagsQueueClient({
  definitions,
}: {
  definitions: MessageFlagDefinition[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  // View state lives in the URL and is owned by the sidebar — linkable, and
  // one source of truth instead of a chip row that could disagree with it.
  const tab: StatusTab = params.get("status") === "resolved" ? "resolved" : "open";
  const definitionId = params.get("definitionId");
  const mineOnly = params.get("assignee") === "me";
  // Search stays LOCAL: pushing a history entry per keystroke would make the
  // back button useless.
  const [search, setSearch] = useState("");
  // Debounced mirror of `search`. The query key (and therefore the fetch) is
  // built from THIS, so typing doesn't fire a request per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const [items, setItems] = useState<MessageFlagQueueItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState<MessageFlagCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Guards a late response for a filter the user has since changed away from
  // (the classic out-of-order-fetch bug). Bumped on every filter change; a
  // response whose token no longer matches is dropped.
  const requestToken = useRef(0);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    // The "resolved" tab shows both terminal states — an agent looking back at
    // what was handled wants the dismissed ones in the same place.
    if (tab === "open") p.set("status", "open");
    else p.set("status", "resolved,dismissed");
    if (definitionId) p.set("definitionId", definitionId);
    if (mineOnly) p.set("assignedTo", "me");
    if (debouncedSearch) p.set("q", debouncedSearch);
    return p;
  }, [tab, definitionId, mineOnly, debouncedSearch]);

  const load = useCallback(
    async (cursor?: string) => {
      const token = cursor ? requestToken.current : ++requestToken.current;
      if (cursor) setLoadingMore(true);
      else setLoading(true);
      try {
        const p = new URLSearchParams(query);
        if (cursor) p.set("cursor", cursor);
        const res = await apiFetch(`/api/message-flags?${p.toString()}`);
        if (!res.ok) throw new Error("Couldn't load flags");
        const body = (await res.json()) as {
          items: MessageFlagQueueItem[];
          nextCursor: string | null;
        };
        if (token !== requestToken.current) return;
        setItems((prev) => (cursor ? [...prev, ...body.items] : body.items));
        setNextCursor(body.nextCursor);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't load flags");
      } finally {
        if (cursor) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [query],
  );

  const loadCounts = useCallback(async () => {
    try {
      const res = await apiFetch("/api/message-flags/counts");
      if (!res.ok) return;
      const body = (await res.json()) as { counts: MessageFlagCounts };
      setCounts(body.counts);
    } catch {
      // Non-fatal: the rail badges just stay at their last value.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);

  // Live convergence. Every flag mutation — ours, a teammate's, or one made
  // from the inbox bubble — arrives here as the same frame.
  //
  // COALESCED, because `message:flag` is team-wide: one teammate bulk-triaging
  // 20 flags fired 40 un-debounced requests per open tab, and `load()` does a
  // full `setItems` replace, so a supervisor five pages deep got yanked back to
  // page 1 on every frame. One trailing refresh per burst converges to the same
  // state (both fetches read current server state when they run) at a fraction
  // of the cost — `/counts` in particular is a groupBy over every open flag in
  // the team. CLAUDE.md §10/§15: coalesce socket bursts.
  useEffect(() => {
    const socket = getClientSocket();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onFlag = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void load();
        void loadCounts();
      }, 400);
    };
    socket.on("message:flag", onFlag);
    return () => {
      if (timer) clearTimeout(timer);
      socket.off("message:flag", onFlag);
    };
  }, [load, loadCounts]);

  const setStatus = async (flagId: string, status: MessageFlagStatus) => {
    try {
      const res = await apiFetch(`/api/message-flags/${flagId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        throw new Error(d.detail || d.error || "Couldn't update this flag");
      }
      // The row leaves / re-enters the list via the socket frame above, so
      // there's no optimistic splice to reconcile.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update this flag");
    }
  };

  // Bumped per click so opening the SAME row twice re-fires the jump. The
  // inbox strips `m`/`n` from the URL once it has consumed them, so without a
  // changing nonce the second click would push an identical href and the
  // anchor would be a dead no-op.
  const jumpNonce = useRef(0);

  const openThread = (item: MessageFlagQueueItem) => {
    // Deep-link into the inbox ANCHORED on the flagged message, so "come back
    // to it later" lands on the exact message — even one buried thousands of
    // messages deep. The inbox loads a context window around it, swaps the
    // slice in, then scrolls and flashes it.
    jumpNonce.current += 1;
    const params = new URLSearchParams({
      c: item.conversationId,
      m: item.messageId,
      n: String(jumpNonce.current),
    });
    router.push(`/inbox?${params.toString()}`);
  };

  const totalOpen = counts?.totalOpen ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-6 py-4">
        <PageHeader
          title="Flagged messages"
          description={
            totalOpen > 0
              ? `${totalOpen} open ${totalOpen === 1 ? "item" : "items"} needing follow-up`
              : "Messages your team marked for follow-up"
          }
        />
        <div className="relative mt-4">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search the message, the contact, or a flag note…"
            aria-label="Search flagged messages"
            className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-3 text-sm outline-hidden placeholder:text-muted-foreground focus:border-primary/50"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            tab={tab}
            hasDefinitions={definitions.length > 0}
            filtered={definitionId !== null || mineOnly || debouncedSearch !== ""}
          />
        ) : (
          <ul className="divide-y">
            {items.map((item) => (
              <QueueRow
                key={item.id}
                item={item}
                onOpen={() => openThread(item)}
                onSetStatus={(status) => void setStatus(item.id, status)}
              />
            ))}
          </ul>
        )}

        {nextCursor && (
          <div className="flex justify-center p-4">
            <Button
              variant="outline"
              size="sm"
              disabled={loadingMore}
              onClick={() => void load(nextCursor)}
            >
              {loadingMore ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Load more
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function QueueRow({
  item,
  onOpen,
  onSetStatus,
}: {
  item: MessageFlagQueueItem;
  onOpen: () => void;
  onSetStatus: (status: MessageFlagStatus) => void;
}) {
  const open = item.status === "open";
  const colors = tagColorClasses(item.definition.color);

  return (
    <li className="group flex items-start gap-3 px-6 py-3 transition-colors hover:bg-muted/40">
      <ChannelBadge channel={item.channel as Channel} className="mt-0.5 shrink-0" />

      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 text-left"
        title="Open this message in the inbox"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-2xs leading-tight",
              open ? colors.pill : "border-border/60 text-muted-foreground line-through",
            )}
          >
            <Flag className="size-2.5" />
            {item.definition.name}
          </span>
          <span className="truncate text-sm font-medium">{item.contactName}</span>
          {item.source === "ai" && (
            <span className="rounded-sm bg-foreground/10 px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
              AI
            </span>
          )}
          <span className="text-2xs text-muted-foreground">
            <LocalTime iso={item.createdAt} format="listTime" />
          </span>
        </div>

        <p className="mt-0.5 truncate text-sm text-muted-foreground" dir="auto">
          {item.messageExcerpt || <i className="opacity-60">No text content</i>}
        </p>

        {(item.note || item.assignedToName || (!open && item.resolvedByName)) && (
          <p className="mt-0.5 truncate text-2xs text-muted-foreground/80">
            {item.note ? `“${item.note}”` : null}
            {item.note && item.assignedToName ? " · " : null}
            {item.assignedToName ? `Owner: ${item.assignedToName}` : null}
            {!open && item.resolvedByName
              ? `${item.note || item.assignedToName ? " · " : ""}${
                  item.status === "dismissed" ? "Dismissed" : "Resolved"
                } by ${item.resolvedByName}`
              : null}
          </p>
        )}
      </button>

      {/* Actions stay mounted (not hover-only) on touch, and reveal on hover on
          pointer devices — a queue is worked through quickly and hunting for a
          hidden control per row would be the wrong trade. */}
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          title="Open in inbox"
          aria-label="Open in inbox"
          onClick={onOpen}
        >
          <MessageSquare className="size-3.5" />
        </Button>
        {open ? (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              title="Mark resolved"
              aria-label="Mark resolved"
              onClick={() => onSetStatus("resolved")}
            >
              <Check className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              title="Dismiss — this wasn't one"
              aria-label="Dismiss"
              onClick={() => onSetStatus("dismissed")}
            >
              <X className="size-3.5" />
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            title="Reopen"
            aria-label="Reopen"
            onClick={() => onSetStatus("open")}
          >
            <RotateCcw className="size-3.5" />
          </Button>
        )}
      </div>
    </li>
  );
}

function EmptyState({
  tab,
  hasDefinitions,
  filtered,
}: {
  tab: StatusTab;
  hasDefinitions: boolean;
  filtered: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <Flag className="size-6 text-muted-foreground/50" />
      {!hasDefinitions ? (
        <>
          <p className="text-sm font-medium">No message flags configured yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Create flags like “Complaint” or “Refund request” in Settings, then flag any
            message from its ⋯ menu in the inbox to start tracking it here.
          </p>
        </>
      ) : tab === "open" ? (
        <>
          <p className="text-sm font-medium">
            {filtered ? "Nothing matches this filter" : "Nothing needs follow-up"}
          </p>
          <p className="text-sm text-muted-foreground">
            {filtered
              ? "Try clearing the filters above."
              : "Flag a message from its ⋯ menu in the inbox and it will show up here."}
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing has been handled yet.</p>
      )}
    </div>
  );
}
