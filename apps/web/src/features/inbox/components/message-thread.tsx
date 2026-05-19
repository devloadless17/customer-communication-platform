"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, Loader2, X } from "lucide-react";
import { useRouter } from "next/navigation";

import { ScrollArea } from "@/components/ui/scroll-area";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useTzNow } from "@/providers/tz-provider";
import { cn, formatDaySeparator } from "@ccp/shared/utils";
import type {
  ContactStage,
  ConversationWithRefs,
  InternalNote,
  Message,
  ReplySnapshot,
  User,
} from "@ccp/shared/types";
import { useConversationEvents } from "@/features/inbox/hooks/use-conversation-events";
import { useConversationViewers } from "@/features/inbox/hooks/use-conversation-viewers";
import { useTyping } from "@/features/inbox/hooks/use-typing";
import { useMessageSelection } from "@/features/inbox/hooks/use-message-selection";
import { useChatScroll } from "@/features/inbox/hooks/use-chat-scroll";

import dynamic from "next/dynamic";

import { MessageBubble } from "./message-bubble";
import { InternalNote as InternalNoteCard } from "./internal-note";
import { ReplyBox } from "./reply-box";
// Forward dialog + in-thread search — both rarely opened, so defer them
// out of the critical thread bundle. SSR-disabled because they're
// interaction-only (no SEO/render-without-JS concern).
const ForwardDialog = dynamic(
  () => import("./forward-dialog").then((m) => m.ForwardDialog),
  { ssr: false },
);
const MessageSearch = dynamic(
  () => import("./message-search").then((m) => m.MessageSearch),
  { ssr: false },
);
import type { SearchHit } from "./message-search";

import { SelectionBar } from "./message-thread/selection-bar";
import { ThreadHeader } from "./message-thread/thread-header";
import { TypingIndicator } from "./message-thread/typing-indicator";
import { readError, unknownAuthor } from "./message-thread/utils";

type TimelineEntry =
  | { kind: "message"; data: Message }
  | { kind: "note"; data: InternalNote };

function MessageThreadImpl({
  data: initialData,
  teamMembers,
  currentUser,
  nextOlderCursor,
  stageCatalog,
  canManageStages,
  onMarkRead,
  onMobileBack,
}: {
  data: ConversationWithRefs;
  teamMembers: User[];
  currentUser: User;
  nextOlderCursor: string | null;
  /** Team-wide stage catalog — drives the header stepper. */
  stageCatalog: ContactStage[];
  /** Whether the current user can edit the team's stage catalog. */
  canManageStages: boolean;
  /** Forwarded to useConversationEvents so the shell can patch its cached
   *  unreadCount=0 after the mark-read POST resolves. Optional so tests and
   *  other mount points don't need to thread it. */
  onMarkRead?: (conversationId: string) => void;
  /** Below md the inbox single-panes between conversation list and thread.
   *  When set, ThreadHeader renders a back-arrow that returns to the list. */
  onMobileBack?: () => void;
}) {
  const {
    data,
    hasMoreOlder,
    loadingOlder,
    loadOlder,
    addOptimistic,
    markOptimisticFailed,
    removeOptimistic,
    replaceWithContext,
  } = useConversationEvents(initialData, nextOlderCursor, currentUser.id, onMarkRead);
  const { conversation, contact, assignedUser, messages, notes } = data;
  const { confirm, alert, confirmDialog } = useConfirm();

  const memberById = useMemo(() => {
    return new Map(teamMembers.map((u) => [u.id, u]));
  }, [teamMembers]);

  // Live list of OTHER teammates with this conversation open. Drives the
  // "Maria is also viewing" pill in the header so two agents don't double-
  // handle a chat. Empty list = no pill rendered.
  const otherViewerIds = useConversationViewers(conversation.id, currentUser.id);
  const otherViewers = useMemo(() => {
    if (otherViewerIds.length === 0) return [];
    const out: User[] = [];
    for (const id of otherViewerIds) {
      const u = memberById.get(id);
      if (u) out.push(u);
    }
    return out;
  }, [otherViewerIds, memberById]);

  // The 24h window is driven by the server-provided lastInboundAt — it's
  // contact-level and may predate the loaded message slice.
  const { lastInboundAt } = data;
  const router = useRouter();

  // -------------------------------------------------------------------------
  // Stage mirror. The header stepper reads from local state so arrow clicks
  // feel instant; the PATCH below pushes the change to the server and a
  // router.refresh() pulls the canonical contact row back through the page
  // server component on success. Initialised from props and reset whenever
  // the user switches to a different contact (the conversation route is
  // already a fresh render in that case, so initialData drives it).
  // -------------------------------------------------------------------------
  const [stageId, setStageId] = useState<string | null>(contact.stageId ?? null);
  useEffect(() => {
    setStageId(contact.stageId ?? null);
  }, [contact.id, contact.stageId]);

  const persistStageId = useCallback(
    async (next: string) => {
      const prev = stageId;
      setStageId(next);
      const res = await fetch(`/api/contacts/${contact.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stageId: next }),
      });
      if (!res.ok) {
        // Roll back the optimistic update so the chip reflects truth.
        setStageId(prev);
        await alert(
          "Couldn't change stage",
          await readError(res),
        );
        return;
      }
      // Pull the fresh contact row through the server component so the
      // right rail / contacts list also see the new stage on next navigation.
      router.refresh();
    },
    [alert, contact.id, router, stageId],
  );

  // -------------------------------------------------------------------------
  // Reply target — the message the composer's next send will quote. Lives in
  // the thread (not the composer) because clicks come from message bubbles.
  // -------------------------------------------------------------------------
  const [replyTarget, setReplyTarget] = useState<ReplySnapshot | null>(null);

  // -------------------------------------------------------------------------
  // Multi-select + forward. `selection` flips the thread into checkbox mode;
  // `forwardIds` is the (frozen) set of message ids handed to the picker.
  // -------------------------------------------------------------------------
  const selection = useMessageSelection();
  const [forwardOpen, setForwardOpen] = useState(false);
  const [forwardIds, setForwardIds] = useState<string[]>([]);

  // Re-snapshot when the user changes conversation — the previous reply
  // target / selection belongs to the old thread.
  useEffect(() => {
    setReplyTarget(null);
    selection.clear();
  }, [conversation.id, selection.clear]);

  // Esc leaves selection mode.
  useEffect(() => {
    if (!selection.selecting) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") selection.clear();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection.selecting, selection.clear]);

  const forwardOne = useCallback((msg: Message) => {
    setForwardIds([msg.id]);
    setForwardOpen(true);
  }, []);

  // Read `selection.selectedIds` through a ref so `forwardSelection` stays
  // identity-stable across selection toggles. Otherwise every checkbox
  // click rebuilds the callback → `MessageBubble`'s memo (which receives
  // `onForward` as a prop) sees a fresh function → every bubble re-renders.
  // At 500 loaded messages that's a visible jank on every toggle.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const forwardSelection = useCallback(() => {
    const s = selectionRef.current;
    if (s.count === 0) return;
    setForwardIds([...s.selectedIds]);
    setForwardOpen(true);
  }, []);

  const startSelect = useCallback(
    (msg: Message) => selection.start(msg.id),
    [selection.start],
  );

  const beginReply = useCallback(
    (msg: Message) => {
      const senderName =
        msg.direction === "out"
          ? msg.senderUserId
            ? memberById.get(msg.senderUserId)?.name ?? null
            : null
          : null;
      setReplyTarget({
        id: msg.id,
        body: msg.body,
        direction: msg.direction,
        senderName,
        ...(msg.media ? { mediaKind: msg.media.kind } : {}),
      });
    },
    [memberById],
  );

  const cancelReply = useCallback(() => setReplyTarget(null), []);

  // Failed-bubble recovery: dismiss drops it; retry drops it AND pre-loads
  // the body back into the composer so the user can fix + resend. For media
  // retries the composer also looks up the original File by clientTempId
  // and restores it as the attachment (no re-pick needed). If the failed
  // message was a quoted reply, we also re-seat the reply target so the
  // resend keeps its context.
  const [composerPrefill, setComposerPrefill] = useState<{
    body: string;
    nonce: string;
    clientTempId?: string;
  } | null>(null);
  const dismissFailed = useCallback(
    (msg: Message) => {
      if (msg.clientTempId) removeOptimistic(msg.clientTempId);
    },
    [removeOptimistic],
  );
  const retryFailed = useCallback(
    (msg: Message) => {
      if (msg.clientTempId) removeOptimistic(msg.clientTempId);
      if (msg.replyTo) setReplyTarget(msg.replyTo);
      setComposerPrefill({
        body: msg.body,
        nonce: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ...(msg.clientTempId ? { clientTempId: msg.clientTempId } : {}),
      });
    },
    [removeOptimistic],
  );

  // Ref-tracked so rapid reply-jumps cancel the prior fade instead of
  // stomping classNames mid-transition; cleared on unmount.
  const replyJumpTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (replyJumpTimerRef.current !== null) {
        window.clearTimeout(replyJumpTimerRef.current);
      }
    };
  }, []);
  const jumpToOriginal = useCallback((originalId: string) => {
    const el = document.querySelector<HTMLElement>(
      `[data-message-id="${originalId}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Subtle blue flash for reply-jumps. Search-match jumps use a
    // PERSISTENT amber ring on the bubble itself (see MessageBubble's
    // `isActiveSearchMatch`), since the user is actively navigating
    // through matches and the ring needs to stay until they move on.
    if (replyJumpTimerRef.current !== null) {
      window.clearTimeout(replyJumpTimerRef.current);
    }
    el.classList.add("ring-2", "ring-primary/60", "ring-offset-2");
    replyJumpTimerRef.current = window.setTimeout(() => {
      el.classList.remove("ring-2", "ring-primary/60", "ring-offset-2");
      replyJumpTimerRef.current = null;
    }, 1500);
  }, []);

  // -------------------------------------------------------------------------
  // In-thread search — WhatsApp-style. The slim search bar lives just below
  // the thread header; matches are highlighted IN PLACE inside the existing
  // bubbles (via `searchQuery` + `isActiveSearchMatch` props), and the
  // active match is scrolled into view as the user navigates ↑/↓.
  //
  // State here:
  //   - `searchOpen`     — bar visible?
  //   - `searchQuery`    — current input (used for highlighting)
  //   - `matches`        — server-returned hits, DESC by timestamp
  //   - `activeMatchIdx` — 0-based cursor inside `matches`
  //   - `pendingJumpId`  — set after we swap in a context window so the
  //                        scroll-to-active-match defers until the new
  //                        bubbles are in the DOM
  // -------------------------------------------------------------------------
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matches, setMatches] = useState<SearchHit[]>([]);
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);
  const [pendingJumpId, setPendingJumpId] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setSearchError(null);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setMatches([]);
    setActiveMatchIdx(0);
    setPendingJumpId(null);
    setSearchError(null);
  }, []);

  // Cmd/Ctrl+F inside the thread opens the in-conversation search. Browsers'
  // native find-in-page won't load anything from the DB, so a chat with
  // 10k older messages would just match the visible slice — much worse UX
  // than our DB-backed search.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isFind = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f";
      if (isFind) {
        e.preventDefault();
        openSearch();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSearch]);

  // Close the search bar when the user switches to a different conversation
  // — the matches belong to the old thread and would be misleading otherwise.
  useEffect(() => {
    if (searchOpen) closeSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  const messagesById = useMemo(() => {
    return new Set(data.messages.map((m) => m.id));
  }, [data.messages]);

  // Stable callback shapes for MessageSearch — without these, the search
  // bar's effect would re-fire on every render and refetch the query.
  const handleMatchesChange = useCallback((next: SearchHit[]) => {
    setMatches(next);
    setActiveMatchIdx(0);
  }, []);
  const handleQueryChange = useCallback((q: string) => setSearchQuery(q), []);

  const activeMatch = matches[activeMatchIdx] ?? null;
  const activeMatchId = activeMatch?.id ?? null;
  const matchedIds = useMemo(
    () => new Set(matches.map((m) => m.id)),
    [matches],
  );

  // Forward-ref to useChatScroll's `markBenignTailUpdate`. The hook is
  // declared later (it needs `lastEntryKey` which is computed below), but
  // the active-match effect needs to flag the slice swap as benign before
  // it commits. The ref is assigned right after the hook call; consumers
  // call through the ref to dodge the TDZ.
  const markBenignTailUpdateRef = useRef<() => void>(() => {});

  // Whenever the active match changes, scroll its bubble into view. If the
  // bubble isn't in the loaded slice, fetch a context window first — the
  // pendingJumpId watcher below then picks up the scroll once the bubbles
  // render.
  //
  // `handledMatchIdRef` ensures the effect only acts when `activeMatchId`
  // actually changes, not when `messagesById` rebuilds (e.g., after the user
  // sends a message while search is still open — without this guard the
  // bubble would scroll to the bottom, then bounce back to the searched
  // match on the next render).
  const handledMatchIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeMatchId) {
      handledMatchIdRef.current = null;
      return;
    }
    if (handledMatchIdRef.current === activeMatchId) return;

    if (messagesById.has(activeMatchId)) {
      handledMatchIdRef.current = activeMatchId;
      // Fast path: defer one frame so any concurrent state updates have
      // committed before we measure scrollIntoView.
      const id = window.requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(
          `[data-message-id="${activeMatchId}"]`,
        );
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      return () => window.cancelAnimationFrame(id);
    }

    // Slow path: load a context window centered on the match and remember
    // to scroll once it renders.
    handledMatchIdRef.current = activeMatchId;
    let cancelled = false;
    setSearchError(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/conversations/${conversation.id}/messages/context?messageId=${encodeURIComponent(activeMatchId)}`,
        );
        if (cancelled) return;
        if (!res.ok) {
          setSearchError("Couldn't load that message");
          return;
        }
        const ctx = (await res.json()) as {
          messages: import("@ccp/shared/types").Message[];
          nextOlderCursor: string | null;
        };
        if (cancelled) return;
        // The slice swap shifts lastEntryKey to an older message, which
        // would otherwise trip the chat-scroll tail-entry effect into
        // bumping the "new messages" pill. Mark the swap benign before
        // committing it so the pill stays quiet.
        markBenignTailUpdateRef.current();
        replaceWithContext({
          messages: ctx.messages,
          nextOlderCursor: ctx.nextOlderCursor,
        });
        setPendingJumpId(activeMatchId);
      } catch {
        if (!cancelled) setSearchError("Network error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeMatchId, messagesById, conversation.id, replaceWithContext]);

  // Once the context window has rendered, scroll to the message we were
  // waiting on. Two-frame deferral so React + Framer Motion both commit.
  useEffect(() => {
    if (!pendingJumpId) return;
    if (!messagesById.has(pendingJumpId)) return;
    const id = window.requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-message-id="${pendingJumpId}"]`,
      );
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      setPendingJumpId(null);
    });
    return () => window.cancelAnimationFrame(id);
  }, [pendingJumpId, messagesById]);

  const deleteNote = useCallback(
    async (noteId: string) => {
      const ok = await confirm({
        title: "Delete this internal note?",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!ok) return;
      const res = await fetch(`/api/notes/${noteId}`, { method: "DELETE" });
      if (!res.ok) {
        await alert("Couldn't delete note", "Please try again.");
      }
    },
    [confirm, alert],
  );

  const { typingUserIds, notifyTyping, stopTyping } = useTyping(
    conversation.id,
    currentUser.id,
  );

  // Notes come back from the server unpaginated (typically <10 per thread),
  // but messages are loaded 50-at-a-time. Without this filter, a note older
  // than the oldest loaded message would stick to the very top of the
  // timeline — orphaned from its conversational context — until the user
  // scrolls up and the corresponding older messages get prepended in. Hide
  // those notes until their neighborhood is in view.
  //
  // Sort: chronological by timestamp, BUT pending optimistic sends are
  // forced to the tail. The user just sent them — they're "the newest" by
  // intent, even if their client-clock timestamp is fractionally behind a
  // server-stamped message that landed in the same tick. Without this,
  // server clock skew (~tens of ms ahead of the client) is enough to slot
  // the just-sent bubble *above* the last confirmed message and break the
  // "you just sent → you see it at the bottom" guarantee.
  const timeline = useMemo<TimelineEntry[]>(() => {
    const oldestMessageTs = messages[0]?.timestamp;
    const visibleNotes =
      hasMoreOlder && oldestMessageTs
        ? notes.filter((n) => n.timestamp >= oldestMessageTs)
        : notes;
    const isPending = (e: TimelineEntry) =>
      e.kind === "message" && e.data.pending === true;
    return [
      ...messages.map((m): TimelineEntry => ({ kind: "message", data: m })),
      ...visibleNotes.map((n): TimelineEntry => ({ kind: "note", data: n })),
    ].sort((a, b) => {
      const ap = isPending(a);
      const bp = isPending(b);
      if (ap !== bp) return ap ? 1 : -1;
      return (
        new Date(a.data.timestamp).getTime() -
        new Date(b.data.timestamp).getTime()
      );
    });
  }, [messages, notes, hasMoreOlder]);

  // Day-separator labels keyed by timeline index. Pre-computed alongside the
  // timeline so the per-entry render doesn't run formatDaySeparator twice per
  // bubble (which was 60+ Intl calls per timeline render). Each label is the
  // date string when this entry should show a separator above it; null means
  // the previous entry is on the same calendar day.
  //
  // `tz` + `now` come from TimezoneProvider — same values on server and
  // client, so "Today" / "Yesterday" buckets agree across hydration.
  const { tz, now } = useTzNow();
  const dayLabels = useMemo(() => {
    const labels: Array<string | null> = new Array(timeline.length);
    let prevLabel: string | null = null;
    for (let i = 0; i < timeline.length; i++) {
      const entry = timeline[i]!;
      const label = formatDaySeparator(entry.data.timestamp, tz, now);
      labels[i] = label !== prevLabel ? label : null;
      prevLabel = label;
    }
    return labels;
  }, [timeline, tz, now]);

  // Entrance animation is reserved for genuinely new tail entries (a fresh
  // send/receive). The initial load and prepended older pages mount without
  // animation — a bubble sliding in near the top of the viewport during a
  // load-older would read as a jitter, and that's exactly what we don't want.
  const mountedRef = useRef(false);
  const seenKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    mountedRef.current = true;
    seenKeysRef.current = new Set(timeline.map((e) => `${e.kind}_${e.data.id}`));
  });

  // ---------------------------------------------------------------------
  // Scroll behavior — see `useChatScroll`. All the messy bits (viewport
  // resolution, scroll listener, ResizeObserver for stick-to-bottom,
  // load-older anchor preservation, settle window) live in the hook so this
  // component stays a renderer.
  // ---------------------------------------------------------------------
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);

  const lastEntry = timeline.at(-1);
  const lastEntryKey = lastEntry ? `${lastEntry.kind}_${lastEntry.data.id}` : null;
  const isOwnSend =
    lastEntry?.kind === "message" && lastEntry.data.pending === true;

  const { unreadBelow, scrollToBottom, markBenignTailUpdate } = useChatScroll({
    scrollAreaRef,
    contentRef,
    topSentinelRef,
    conversationId: conversation.id,
    lastEntryKey,
    isOwnSend,
    hasMoreOlder,
    loadOlder,
  });
  // Bind the forward-ref used by the active-match effect (declared above
  // this hook call). Assignment in render is idempotent.
  markBenignTailUpdateRef.current = markBenignTailUpdate;

  // Note: we deliberately do NOT hide the scroll area until layout effects
  // run. The previous version gated `invisible` on a `scrollReady` boolean
  // flipped in a useLayoutEffect, to avoid a one-frame flash of the OLDEST
  // loaded message before the bottom-snap. The cost was that the entire
  // thread stayed blank until React hydration finished — visibly ~1s in dev
  // mode (uncompressed JS bundle, source maps) and a few hundred ms in prod.
  // Trading that for the brief scroll-position blip is the better deal: the
  // SSR'd messages are already in the HTML, so we let the browser paint them
  // immediately. useChatScroll's first useLayoutEffect (`snapToBottom` +
  // double-rAF, line 175 of use-chat-scroll.ts) still lands the viewport at
  // the bottom on the very next frame; at 60fps the user effectively never
  // sees the wrong position.

  return (
    <section className="relative flex min-w-0 flex-1 flex-col bg-background">
      <ThreadHeader
        conversationId={conversation.id}
        contactId={contact.id}
        contactName={contact.name}
        phone={contact.phoneNumber}
        status={conversation.status}
        assignedUserId={assignedUser?.id ?? null}
        assignedUserName={assignedUser?.name ?? null}
        teamMembers={teamMembers}
        otherViewers={otherViewers}
        onAlert={alert}
        onOpenSearch={openSearch}
        stageCatalog={stageCatalog}
        currentStageId={stageId}
        onStageChange={persistStageId}
        canManageStages={canManageStages}
        onMobileBack={onMobileBack}
      />

      {searchOpen && (
        <MessageSearch
          conversationId={conversation.id}
          onClose={closeSearch}
          onQueryChange={handleQueryChange}
          onMatchesChange={handleMatchesChange}
          onActiveIndexChange={setActiveMatchIdx}
          activeIndex={activeMatchIdx}
          totalMatches={matches.length}
        />
      )}
      {searchError && (
        <div className="pointer-events-none flex justify-center bg-background pt-1">
          <span className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-3 py-1 text-[11px] text-destructive shadow-xs">
            {searchError}
            <button
              type="button"
              onClick={() => setSearchError(null)}
              aria-label="Dismiss"
              className="rounded p-0.5 hover:bg-destructive/10"
            >
              <X className="size-3" />
            </button>
          </span>
        </div>
      )}

      <ScrollArea
        ref={scrollAreaRef}
        className="flex-1"
        // Marker for the SSR bottom-snap script in InboxShell. Lets the
        // script find this thread's viewport unambiguously — the script
        // runs as a later sibling so by then the workspace's full flex row
        // (this thread + ContactPanel) has been parsed and laid out.
        data-thread-scroll-root
      >
        <div
          ref={contentRef}
          // overflow-anchor:none — useChatScroll manages scroll position
          // explicitly; the browser's own anchoring would fight it.
          style={{ overflowAnchor: "none" }}
          className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 py-6"
        >
          {/* Top sentinel — IntersectionObserver target for "load older".
              The loading indicator is rendered OUTSIDE the scroll content (a
              floating pill below) so triggering a load never changes layout. */}
          <div ref={topSentinelRef} className="h-px" />
          {timeline.map((entry, idx) => {
            const dayLabel = dayLabels[idx];
            const showDay = dayLabel !== null;
            // For outbound messages we key on clientTempId when present so
            // the React node survives the optimistic→confirmed swap (server
            // assigns a fresh id, but the bubble is conceptually the same
            // bubble — no unmount, no re-animation flash).
            const entryKey =
              entry.kind === "message" && entry.data.clientTempId
                ? `message_t_${entry.data.clientTempId}`
                : `${entry.kind}_${entry.data.id}`;
            // Skip the entrance animation when this user sent the entry
            // themselves. The user already knows the message is coming —
            // animating it in feels like network latency. Inbound and
            // teammate sends still animate (the motion draws attention).
            const isOwnEntry =
              entry.kind === "message"
                ? entry.data.senderUserId === currentUser.id
                : entry.data.authorUserId === currentUser.id;
            const animateIn =
              mountedRef.current &&
              idx === timeline.length - 1 &&
              !seenKeysRef.current.has(entryKey) &&
              !isOwnEntry;

            return (
              <div key={entryKey} className="contents">
                {showDay && (
                  <div className="my-3 flex items-center gap-3">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      {dayLabel}
                    </span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                )}
                {/* Plain <div> with a one-off CSS enter class. Was a
                    framer-motion `motion.div` per entry — fine when there
                    were 10 messages on screen, expensive on a 500-message
                    thread receiving inbound traffic. CSS keyframe runs once
                    on mount, then the class is inert. `animateIn` already
                    gates this to genuinely new tail entries from someone
                    else, so the user's own sends still appear instantly. */}
                <div
                  data-message-id={entry.kind === "message" ? entry.data.id : undefined}
                  className={cn(
                    "rounded-2xl transition-shadow",
                    animateIn && "animate-enter",
                  )}
                >
                  {entry.kind === "message" ? (
                    <MessageBubble
                      message={entry.data}
                      senderName={
                        entry.data.senderUserId
                          ? memberById.get(entry.data.senderUserId)?.name ?? null
                          : null
                      }
                      contactName={contact.name}
                      contactSeed={contact.id}
                      onReply={beginReply}
                      onJumpToOriginal={jumpToOriginal}
                      onForward={forwardOne}
                      onStartSelect={startSelect}
                      onDismissFailed={dismissFailed}
                      onRetryFailed={retryFailed}
                      selecting={selection.selecting}
                      selected={selection.isSelected(entry.data.id)}
                      onToggleSelect={selection.toggle}
                      searchQuery={
                        searchOpen && matchedIds.has(entry.data.id)
                          ? searchQuery
                          : undefined
                      }
                      isActiveSearchMatch={
                        searchOpen && entry.data.id === activeMatchId
                      }
                    />
                  ) : (
                    <InternalNoteCard
                      note={entry.data}
                      author={
                        (entry.data.authorUserId
                          ? memberById.get(entry.data.authorUserId)
                          : undefined) ?? unknownAuthor(entry.data.authorUserId)
                      }
                      onDelete={deleteNote}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Older-messages spinner — floats over the top of the thread, never in
          the scroll flow, so loading a page doesn't nudge the view at all. */}
      <div className="pointer-events-none absolute inset-x-0 top-15 z-10 flex justify-center pt-2">
        <AnimatePresence>
          {loadingOlder && (
            <motion.span
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15 }}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-[11px] text-muted-foreground shadow-xs"
            >
              <Loader2 className="size-3 animate-spin" />
              Loading older messages…
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      {selection.selecting ? (
        <SelectionBar
          count={selection.count}
          onForward={forwardSelection}
          onCancel={selection.clear}
        />
      ) : (
        <div className="relative">
          {/* New-messages pill — anchored to the TOP edge of the reply-area
              wrapper so it always floats just above whatever's there
              (typing indicator + reply box together), regardless of how
              tall the textarea has grown. Click to jump to bottom and
              clear. WhatsApp / Slack / Discord pattern. */}
          <div className="pointer-events-none absolute inset-x-0 -top-10 z-20 flex justify-center">
            <AnimatePresence>
              {unreadBelow > 0 && (
                <motion.button
                  type="button"
                  onClick={scrollToBottom}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  transition={{ duration: 0.15 }}
                  className="pointer-events-auto inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-foreground px-3.5 py-1.5 text-[12px] font-medium text-background shadow-lg ring-1 ring-border/40 transition-colors hover:bg-foreground/90"
                >
                  <ArrowDown className="size-3.5" />
                  {unreadBelow} new {unreadBelow === 1 ? "message" : "messages"}
                </motion.button>
              )}
            </AnimatePresence>
          </div>
          <TypingIndicator
            typingUserIds={typingUserIds}
            memberById={memberById}
          />
          <ReplyBox
            conversationId={conversation.id}
            currentUser={currentUser}
            contact={contact}
            lastInboundAt={lastInboundAt}
            replyTarget={replyTarget}
            onCancelReply={cancelReply}
            onTyping={notifyTyping}
            onStopTyping={stopTyping}
            onOptimistic={addOptimistic}
            onOptimisticFail={markOptimisticFailed}
            onOptimisticRetry={removeOptimistic}
            prefill={composerPrefill}
          />
        </div>
      )}

      <ForwardDialog
        open={forwardOpen}
        messageIds={forwardIds}
        onClose={() => {
          setForwardOpen(false);
          selection.clear();
        }}
        onError={(summary) => {
          void alert(summary);
        }}
      />
      {confirmDialog}
    </section>
  );
}

/**
 * Memoized so the inbox shell can re-render for unrelated state changes
 * (conversation list patches, composer state in OTHER threads, etc.)
 * without re-running this thread's timeline build + bubble walk. Parent
 * passes stable refs for arrays and useCallback'd handlers.
 */
export const MessageThread = memo(MessageThreadImpl);
