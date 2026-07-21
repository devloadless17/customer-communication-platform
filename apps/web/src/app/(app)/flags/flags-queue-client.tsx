"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Flag, Loader2, MessageSquare, RotateCcw, X } from "lucide-react";

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
  const [tab, setTab] = useState<StatusTab>("open");
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [mineOnly, setMineOnly] = useState(false);
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
    return p;
  }, [tab, definitionId, mineOnly]);

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
  useEffect(() => {
    const socket = getClientSocket();
    const onFlag = () => {
      void load();
      void loadCounts();
    };
    socket.on("message:flag", onFlag);
    return () => {
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
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <TabButton active={tab === "open"} onClick={() => setTab("open")}>
            Open
            {totalOpen > 0 && <Pill>{totalOpen}</Pill>}
          </TabButton>
          <TabButton active={tab === "resolved"} onClick={() => setTab("resolved")}>
            Handled
          </TabButton>
          <span className="mx-1 h-5 w-px bg-border" />
          <TabButton active={mineOnly} onClick={() => setMineOnly((m) => !m)}>
            Assigned to me
            {counts?.mineOpen ? <Pill>{counts.mineOpen}</Pill> : null}
          </TabButton>
          <span className="mx-1 h-5 w-px bg-border" />
          <TabButton active={definitionId === null} onClick={() => setDefinitionId(null)}>
            All flags
          </TabButton>
          {definitions.map((d) => (
            <TabButton
              key={d.id}
              active={definitionId === d.id}
              onClick={() => setDefinitionId(d.id)}
            >
              <span
                className={cn("size-2 rounded-full", tagColorClasses(d.color).solid)}
              />
              {d.name}
              {counts?.openByDefinition[d.id] ? (
                <Pill>{counts.openByDefinition[d.id]}</Pill>
              ) : null}
            </TabButton>
          ))}
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
            filtered={definitionId !== null || mineOnly}
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

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
        active
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-foreground/10 px-1.5 text-[10px] leading-4">
      {children}
    </span>
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
