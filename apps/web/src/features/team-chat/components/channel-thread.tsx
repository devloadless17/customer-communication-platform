"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { ScrollArea } from "@/components/ui/scroll-area";
import { canDeleteMessage } from "@ccp/shared/team-chat/permissions";
import type { TeamChannelMessageDto } from "@ccp/shared/team-chat/types";
import type { User } from "@ccp/shared/types";
import { useChatScroll } from "@/features/inbox/hooks/use-chat-scroll";
import { useTzNow } from "@/providers/tz-provider";
import { calendarDayKey, formatDaySeparator } from "@ccp/shared/utils";

import { ChannelMessage } from "./channel-message";

/**
 * Channel feed scroller. Three load-bearing pieces, in this order:
 *
 *   1. `@tanstack/react-virtual` — windows the messages so a 5k-message
 *      channel only mounts ~30 ChannelMessage components at a time. Each
 *      ChannelMessage carries its own dropdown + reaction picker; without
 *      windowing the DOM cost is real once the user has scrolled through
 *      a few "Load older" pages.
 *
 *   2. `useChatScroll` (shared with the customer inbox) — stick-to-bottom,
 *      "↓ N new messages" pill while reading history, snap on own send,
 *      load-older anchor preservation. Virtualization composes cleanly with
 *      it because the spacer div's `scrollHeight` reflects total content,
 *      which is what the hook's scroll math assumes.
 *
 *   3. Stable `getItemKey` so the virtualizer's per-item measurements
 *      persist across older-page prepends (indices shift; keys don't).
 *      Optimistic rows use `clientTempId` so the same React node survives
 *      the optimistic→confirmed swap.
 */
const ESTIMATE_HEIGHT = 56;
/**
 * Two messages from the same author within this window collapse into one
 * visual group (avatar + name shown once). 5 minutes matches Slack and the
 * inbox thread — long enough to group a burst, short enough that a reply
 * hours later still gets its own header.
 */
const GROUP_WINDOW_MS = 5 * 60 * 1000;
const OVERSCAN = 6;

// One-line announcement for a newly-arrived teammate message (text preview, or a
// media fallback). Capped so a long message doesn't flood the AT buffer. Pure —
// safe at module scope. Mirrors inboundAnnouncementText in the customer inbox.
function channelAnnouncementText(m: TeamChannelMessageDto): string {
  const body = m.body?.trim();
  if (body) return body.length > 120 ? `${body.slice(0, 117)}…` : body;
  if (m.media) return "sent an attachment";
  return "sent a message";
}

/**
 * The subset of useChatScroll controls this feed publishes to its parent
 * (team-chat-workspace) so `jumpToMessage` (search jump-to) can suppress the
 * hook's stick-to-bottom BEFORE it runs `loadAround` — otherwise the slice
 * swap snaps to the anchored window's bottom and cascade-paginates back to
 * live, defeating the jump. Identities are stable across renders.
 */
export interface ChannelThreadScrollControls {
  /** Drop stick-to-bottom so a caller's own scrollIntoView isn't fought by
   *  the hook's snap. */
  releaseStickToBottom: () => void;
  /** Flag the next tail-key change as a benign slice swap (no snap, no "N new"
   *  pill bump) — call before a loadAround() that replaces the slice. */
  markBenignTailUpdate: () => void;
}

// Memoized — the parent TeamChatWorkspace re-renders on every typing frame
// (typingUserIds lives in the same hook as messages), but ChannelThread never
// receives typingUserIds and all its props are stable/primitive across a typing
// frame, so it bails instead of re-running the virtualizer + scroll hook.
function ChannelThreadImpl({
  messages,
  channelId,
  currentUser,
  canPin,
  onLoadOlder,
  hasMoreOlder,
  onLoadNewer,
  hasMoreNewer,
  anchored,
  pendingLiveCount,
  onGoToLive,
  searchQuery,
  onOpenThread,
  onRetry,
  onDismiss,
  displayNameById,
  lastReadAt,
  isDm = false,
  onScrollControlsReady,
}: {
  messages: TeamChannelMessageDto[];
  channelId: string;
  currentUser: User;
  canPin: boolean;
  onLoadOlder: (commit?: (run: () => void) => void) => Promise<number>;
  hasMoreOlder: boolean;
  onLoadNewer: () => Promise<number>;
  hasMoreNewer: boolean;
  /** True while the loaded slice doesn't include the live tail. */
  anchored: boolean;
  /** Socket-fanout messages that arrived while anchored. */
  pendingLiveCount: number;
  /** Refetch the live tail + clear pendingLiveCount. */
  onGoToLive: () => Promise<void>;
  /** When set, ChannelMessage highlights matching substrings inline. */
  searchQuery: string | null;
  onOpenThread: (rootMessageId: string) => void;
  /** Retry / dismiss a failed optimistic message (L7). Stable refs from the
   *  parent so the ChannelMessage memo holds. */
  onRetry: (clientTempId: string) => void;
  onDismiss: (clientTempId: string) => void;
  /** Canonical userId → name roster map for mention chip rendering. */
  displayNameById: Map<string, string>;
  /**
   * The viewer's read receipt AS OF CHANNEL OPEN — already frozen by the
   * workspace. Anchors the "New messages" divider.
   */
  lastReadAt: string | null;
  /** Swaps channel-specific empty-state copy for DM copy. */
  isDm?: boolean;
  /** Publishes this feed's useChatScroll controls to the parent so
   *  jumpToMessage can release stick-to-bottom + flag the loadAround() slice
   *  swap benign before it runs. Stable identities; safe to store in a ref. */
  onScrollControlsReady?: (controls: ChannelThreadScrollControls) => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);

  // Direct viewport ref via ScrollArea's `viewportRef` prop. Both the
  // virtualizer and useChatScroll need the same viewport element; the
  // callback ref populates both `scrollEl` (state — drives re-render so
  // the virtualizer sees a real getScrollElement on its first render
  // after mount) and `viewportRef` (passed to useChatScroll without
  // requiring another round-trip).
  const viewportRef = useRef<HTMLElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const setViewport = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node;
    setScrollEl(node);
  }, []);

  const lastMessage = messages.at(-1);
  // Key on `clientTempId` when present so the optimistic→confirmed swap
  // doesn't count as a "new message" — same trick the inbox uses.
  const lastEntryKey = lastMessage
    ? lastMessage.clientTempId
      ? `t_${lastMessage.clientTempId}`
      : lastMessage.id
    : null;
  const isOwnSend =
    lastMessage?.pending === true && lastMessage.authorUserId === currentUser.id;

  const { unreadBelow, scrollToBottom, markBenignTailUpdate, releaseStickToBottom } =
    useChatScroll({
      viewportRef,
      contentRef,
      topSentinelRef,
      conversationId: channelId,
      lastEntryKey,
      isOwnSend,
      // Team-chat timeline holds only messages — no activity-log pills.
      isActivityTail: false,
      hasMoreOlder,
      loadOlder: onLoadOlder,
      // The channel feed is a NORMAL top-down virtualized list (react-virtual
      // positions rows by a downward-growing translateY), NOT the inbox's
      // flex-col-reverse viewport. Tell the hook so its scroll-model math
      // (snap-to-newest, isAtBottom, load-older anchor) uses top-down
      // coordinates instead of assuming scrollTop:0 == bottom.
      inverted: false,
    });

  // Publish scroll controls upward. The parent's jumpToMessage calls
  // releaseStickToBottom() + markBenignTailUpdate() BEFORE loadAround() so the
  // search-jump slice swap isn't yanked to the bottom (which would cascade
  // forward-pagination back to live). Identities are stable, so this settles
  // after the first paint.
  useEffect(() => {
    onScrollControlsReady?.({ releaseStickToBottom, markBenignTailUpdate });
  }, [onScrollControlsReady, releaseStickToBottom, markBenignTailUpdate]);

  // "Jump to live": mark the tail swap benign so goToLive's slice replacement
  // can't bump a phantom "1 new" pill, then snap to the live tail after the
  // refetch commits (goToLive only replaces the slice — it doesn't scroll).
  // scrollToBottom re-arms sticky so subsequent messages keep the view pinned.
  const handleGoToLive = useCallback(async () => {
    markBenignTailUpdate();
    await onGoToLive();
    scrollToBottom();
  }, [markBenignTailUpdate, onGoToLive, scrollToBottom]);

  // ---- Day separators + consecutive-message grouping --------------------
  //
  // Ported from the inbox's message-thread (which already solved the
  // non-obvious parts: clock-skew ungrouping, failed rows standing alone, and
  // recomputing labels at local midnight without re-running Intl every tick).
  //
  // `tz` + `now` come from TimezoneProvider so "Today"/"Yesterday" agree
  // across SSR and hydration — no flicker.
  const { tz, now } = useTzNow();
  // `now` ticks every 60s but the labels only change at LOCAL midnight, so
  // read it through a ref and key the memo on the calendar day instead. On a
  // 500-message feed the naive version is ~1000 Intl calls a minute.
  const nowRef = useRef(now);
  nowRef.current = now;
  const todayKey = useMemo(() => calendarDayKey(now, tz), [tz, now]);

  const dayLabels = useMemo(() => {
    const labels: Array<string | null> = new Array(messages.length);
    // This memo's identity changes on EVERY message, edit, reaction and
    // optimistic swap, so it runs constantly. Formatting per message meant
    // ~1000+ Intl operations per arriving message on a 500-message slice.
    // Cache by calendar-day key so each distinct day is formatted once.
    const byDay = new Map<string, string>();
    let prevLabel: string | null = null;
    for (let i = 0; i < messages.length; i++) {
      const iso = messages[i]!.createdAt;
      const key = calendarDayKey(Date.parse(iso), tz);
      let label = byDay.get(key);
      if (label === undefined) {
        label = formatDaySeparator(iso, tz, nowRef.current);
        byDay.set(key, label);
      }
      labels[i] = label !== prevLabel ? label : null;
      prevLabel = label;
    }
    return labels;
    // `todayKey` is a recompute TRIGGER, not a value read in the body — it
    // changes exactly at local midnight, which is when Today/Yesterday must
    // refresh. eslint can't model that, hence the disable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, tz, todayKey]);

  // `continuationFlags[i]` = message i continues a run started by i-1, so it
  // renders without the repeated avatar/name/timestamp header. This is the
  // single biggest reason the feed reads as "chat" rather than "log".
  //
  // Simpler than the inbox's predicate: team chat has no direction, no
  // `origin`, and no Coexistence echoes — just author, day boundary, and gap.
  const continuationFlags = useMemo(() => {
    const flags: boolean[] = new Array(messages.length).fill(false);
    for (let i = 1; i < messages.length; i++) {
      const prev = messages[i - 1]!;
      const cur = messages[i]!;
      // A day separator always breaks the run — the label needs to sit above
      // a full header, not a bare continuation line.
      if (dayLabels[i] !== null) continue;
      if (!cur.authorUserId || cur.authorUserId !== prev.authorUserId) continue;
      // Failed rows stand alone so their retry/alert affordance always shows.
      if (cur.failed || prev.failed) continue;
      const gap = Date.parse(cur.createdAt) - Date.parse(prev.createdAt);
      // NaN (unparseable) or negative (clock skew between optimistic and
      // server timestamps) → don't group; a wrong group is worse than none.
      if (!(gap >= 0 && gap <= GROUP_WINDOW_MS)) continue;
      flags[i] = true;
    }
    return flags;
  }, [messages, dayLabels]);

  // Index of the first message that arrived after the viewer's last read —
  // where the "New messages" rule goes. Own messages never count (you don't
  // have unread mail from yourself), which is what stops the divider from
  // reappearing above your own reply.
  const unreadDividerIndex = useMemo(() => {
    // `lastReadAt === null` means NEVER READ — i.e. everything is unread,
    // which is precisely the case the divider exists for. Treating it as
    // "no divider" meant a channel you just joined showed 200 unread messages
    // with no rule anywhere, and by your second visit the receipt had advanced
    // so it could never appear at all.
    const cutoff = lastReadAt ? Date.parse(lastReadAt) : 0;
    if (Number.isNaN(cutoff)) return -1;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      if (m.authorUserId === currentUser.id) continue;
      if (Date.parse(m.createdAt) > cutoff) return i;
    }
    return -1;
  }, [messages, lastReadAt, currentUser.id]);

  // Virtualizer. Stable keys per message id; clientTempId for optimistic
  // rows so the measured-height entry persists across the swap to the
  // real id (no flash, no re-measure storm).
  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ESTIMATE_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: (idx) => {
      const m = messages[idx]!;
      return m.clientTempId ? `t_${m.clientTempId}` : m.id;
    },
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalHeight = rowVirtualizer.getTotalSize();

  // Bottom-sentinel auto-load while anchored — mirrors the top-sentinel
  // mechanism that useChatScroll owns. When the user scrolls within 200px of
  // the bottom of the anchored slice AND there are more newer messages, fetch
  // the next forward page. Stays a no-op once `hasMoreNewer` flips to false
  // (we've caught up to live).
  const onLoadNewerRef = useRef(onLoadNewer);
  useEffect(() => {
    onLoadNewerRef.current = onLoadNewer;
  }, [onLoadNewer]);
  useEffect(() => {
    if (!hasMoreNewer) return;
    const sentinel = bottomSentinelRef.current;
    const root = scrollEl;
    if (!sentinel || !root) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          void onLoadNewerRef.current();
        }
      },
      { root, rootMargin: "200px" },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [hasMoreNewer, scrollEl]);

  // ── Screen-reader live region for newly-arrived teammate messages ─────────
  // Mirrors the customer inbox announcer (message-thread.tsx): a polite,
  // visually-hidden region that speaks ONLY genuinely-new messages from OTHER
  // members — never the backlog on mount, never on history pagination, never on
  // a channel switch. Driven by a monotonic high-water-mark on the newest
  // non-own message's createdAt.
  const newestInbound = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.authorUserId !== currentUser.id) return m;
    }
    return null;
  }, [messages, currentUser.id]);
  const [inboundAnnouncement, setInboundAnnouncement] = useState("");
  const lastAnnouncedInboundTsRef = useRef(0);
  const lastAnnouncedInboundIdRef = useRef<string | null>(null);
  const announceNonceRef = useRef(false);
  // Seed the baseline to "newest teammate message right now" on mount AND on
  // every channel switch, so the freshly-loaded backlog is never read aloud.
  useEffect(() => {
    lastAnnouncedInboundTsRef.current = newestInbound
      ? new Date(newestInbound.createdAt).getTime()
      : 0;
    lastAnnouncedInboundIdRef.current = newestInbound?.id ?? null;
    setInboundAnnouncement("");
    // Re-seed once per channel, not per message — newestInbound is read but
    // intentionally NOT a dependency (that would suppress live arrivals).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);
  useEffect(() => {
    if (!newestInbound) return;
    const ts = new Date(newestInbound.createdAt).getTime();
    // Announce anything strictly newer, OR the same ms but a different id.
    if (ts < lastAnnouncedInboundTsRef.current) return;
    if (
      ts === lastAnnouncedInboundTsRef.current &&
      newestInbound.id === lastAnnouncedInboundIdRef.current
    )
      return;
    lastAnnouncedInboundTsRef.current = ts;
    lastAnnouncedInboundIdRef.current = newestInbound.id;
    // Toggle a trailing zero-width space so two consecutive IDENTICAL messages
    // still produce a DOM text diff — an aria-live region only announces on
    // change, and React skips re-setting identical text.
    announceNonceRef.current = !announceNonceRef.current;
    setInboundAnnouncement(
      `${newestInbound.authorName ?? "Someone"}: ${channelAnnouncementText(newestInbound)}${
        announceNonceRef.current ? "​" : ""
      }`,
    );
  }, [newestInbound]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Screen-reader announcer for newly-arrived teammate messages. Polite so
          it never interrupts an agent mid-compose. Starts empty so SSR and
          first paint match. See the announce effect above. */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {inboundAnnouncement}
      </p>
      <ScrollArea viewportRef={setViewport} className="flex-1">
        <div
          ref={contentRef}
          // overflow-anchor:none — useChatScroll manages scroll position
          // explicitly; the browser's own anchoring would fight it.
          style={{ overflowAnchor: "none" }}
          className="relative w-full py-2"
        >
          {/* Top sentinel — IntersectionObserver target for "load older".
              Lives OUTSIDE the virtual range so it's always in the DOM
              (the virtualizer only renders a window of message rows). */}
          <div ref={topSentinelRef} className="h-px" />

          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1 px-8 py-16 text-center">
              <div className="text-sm font-medium">
                {isDm
                  ? "This is the start of your conversation."
                  : "This is the start of the channel."}
              </div>
              <div className="text-xs text-muted-foreground">
                {isDm
                  ? "Messages here are only visible to the two of you."
                  : "Say hi to your team — they'll see it in real time."}
              </div>
            </div>
          ) : (
            // Virtualized spacer: holds the total scroll height so the
            // viewport's scrollbar reflects the full message list, while
            // only the windowed rows are absolutely positioned inside.
            <div
              className="relative w-full"
              style={{ height: `${totalHeight}px` }}
            >
              {virtualItems.map((row) => {
                const m = messages[row.index]!;
                return (
                  <div
                    key={row.key}
                    // measureElement: lets the virtualizer learn each row's
                    // real height (messages vary by body length, media,
                    // reaction chips, edited label). Required for accurate
                    // total height + correct scroll-to behavior.
                    ref={rowVirtualizer.measureElement}
                    data-index={row.index}
                    className="absolute left-0 top-0 w-full"
                    style={{ transform: `translateY(${row.start}px)` }}
                  >
                    {row.index === unreadDividerIndex && (
                      <div className="flex items-center gap-3 px-4 pb-1 pt-2">
                        <div className="h-px flex-1 bg-destructive/60" />
                        <span className="text-3xs font-semibold uppercase tracking-wider text-destructive">
                          New messages
                        </span>
                        <div className="h-px flex-1 bg-destructive/60" />
                      </div>
                    )}
                    {dayLabels[row.index] && (
                      // Rendered INSIDE the row wrapper, not as its own
                      // virtual item: keeping count === messages.length
                      // preserves the stable getItemKey contract, and
                      // measureElement absorbs the extra height. Separate
                      // header rows would desync every measured key whenever
                      // an older page is prepended.
                      <div className="flex items-center gap-3 px-4 pb-1 pt-4">
                        <div className="h-px flex-1 bg-border" />
                        <span className="text-3xs font-medium uppercase tracking-wider text-muted-foreground">
                          {dayLabels[row.index]}
                        </span>
                        <div className="h-px flex-1 bg-border" />
                      </div>
                    )}
                    <ChannelMessage
                      message={m}
                      isContinuation={continuationFlags[row.index] ?? false}
                      channelId={channelId}
                      currentUser={currentUser}
                      canPin={canPin}
                      canDelete={canDeleteMessage(
                        currentUser.role,
                        m.authorUserId,
                        currentUser.id,
                      )}
                      isThreadReply={false}
                      // Stable reference — ChannelMessage is memoized; a
                      // fresh closure per row per render would defeat memo
                      // on every event.
                      onOpenThread={onOpenThread}
                      onRetry={onRetry}
                      onDismiss={onDismiss}
                      searchQuery={searchQuery}
                      displayNameById={displayNameById}
                    />
                  </div>
                );
              })}
            </div>
          )}
          {/* Bottom sentinel — IntersectionObserver target for auto-load
              forward while anchored. Renders ONLY in anchored mode; in live
              mode the channel feed naturally ends at the bottom and there's
              nothing to auto-load. */}
          {hasMoreNewer && <div ref={bottomSentinelRef} className="h-px" />}
        </div>
      </ScrollArea>

      {/* Floating pill stack — anchored above the bottom edge of this
          component. Composer sits below us in the workspace, so pills float
          above the reply box. Three mutually-exclusive states:
            - Anchored: "Jump to live" (refetches tail + clears queue).
            - Live + reading history: "↓ N new messages" (scroll-to-bottom).
            - Caught up: no pill.
          WhatsApp / Slack / Discord pattern. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center">
        <AnimatePresence>
          {anchored ? (
            <motion.button
              key="jump-to-live"
              type="button"
              onClick={() => void handleGoToLive()}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.15 }}
              className="pointer-events-auto inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground shadow-lg ring-1 ring-border/40 transition-colors hover:bg-primary/90"
            >
              <ArrowDown className="size-3.5" />
              {pendingLiveCount > 0
                ? `Jump to live · ${pendingLiveCount} new`
                : "Jump to live"}
            </motion.button>
          ) : (
            unreadBelow > 0 && (
              <motion.button
                key="unread-below"
                type="button"
                onClick={scrollToBottom}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.15 }}
                className="pointer-events-auto inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background shadow-lg ring-1 ring-border/40 transition-colors hover:bg-foreground/90"
              >
                <ArrowDown className="size-3.5" />
                {unreadBelow} new {unreadBelow === 1 ? "message" : "messages"}
              </motion.button>
            )
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

export const ChannelThread = memo(ChannelThreadImpl);
