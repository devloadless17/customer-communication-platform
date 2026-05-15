"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, X } from "lucide-react";
import { useRouter } from "next/navigation";

import { ScrollArea } from "@/components/ui/scroll-area";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn, formatDaySeparator } from "@/lib/utils";
import type {
  ContactStage,
  ConversationWithRefs,
  InternalNote,
  Message,
  ReplySnapshot,
  User,
} from "@/lib/types";
import { useConversationEvents } from "@/hooks/use-conversation-events";
import { useTyping } from "@/hooks/use-typing";
import { useMessageSelection } from "@/hooks/use-message-selection";
import { useChatScroll } from "@/hooks/use-chat-scroll";

import { MessageBubble } from "./message-bubble";
import { InternalNote as InternalNoteCard } from "./internal-note";
import { ReplyBox } from "./reply-box";
import { ForwardDialog } from "./forward-dialog";
import { MessageSearch, type SearchHit } from "./message-search";

import { SelectionBar } from "./message-thread/selection-bar";
import { ThreadHeader } from "./message-thread/thread-header";
import { TypingIndicator } from "./message-thread/typing-indicator";
import { readError, unknownAuthor } from "./message-thread/utils";

type TimelineEntry =
  | { kind: "message"; data: Message }
  | { kind: "note"; data: InternalNote };

export function MessageThread({
  data: initialData,
  teamMembers,
  currentUser,
  nextOlderCursor,
  stageCatalog,
  canManageStages,
}: {
  data: ConversationWithRefs;
  teamMembers: User[];
  currentUser: User;
  nextOlderCursor: string | null;
  /** Team-wide stage catalog — drives the header stepper. */
  stageCatalog: ContactStage[];
  /** Whether the current user can edit the team's stage catalog. */
  canManageStages: boolean;
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
  } = useConversationEvents(initialData, nextOlderCursor);
  const { conversation, contact, assignedUser, messages, notes } = data;
  const { confirm, alert, confirmDialog } = useConfirm();

  const memberById = useMemo(() => {
    return new Map(teamMembers.map((u) => [u.id, u]));
  }, [teamMembers]);

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

  const forwardSelection = useCallback(() => {
    if (selection.count === 0) return;
    setForwardIds([...selection.selectedIds]);
    setForwardOpen(true);
  }, [selection.count, selection.selectedIds]);

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
    el.classList.add("ring-2", "ring-primary/60", "ring-offset-2");
    setTimeout(() => {
      el.classList.remove("ring-2", "ring-primary/60", "ring-offset-2");
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

  // Whenever the active match changes, scroll its bubble into view. If the
  // bubble isn't in the loaded slice, fetch a context window first — the
  // pendingJumpId watcher below then picks up the scroll once the bubbles
  // render.
  useEffect(() => {
    if (!activeMatchId) return;
    if (messagesById.has(activeMatchId)) {
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
          messages: import("@/lib/types").Message[];
          nextOlderCursor: string | null;
        };
        if (cancelled) return;
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

  useChatScroll({
    scrollAreaRef,
    contentRef,
    topSentinelRef,
    conversationId: conversation.id,
    lastEntryKey,
    isOwnSend,
    hasMoreOlder,
    loadOlder,
  });

  // Hide the scroll area until useChatScroll has positioned it at the bottom.
  // Without this gate, the SSR HTML paints at scrollTop=0 — the user sees the
  // OLDEST loaded message for a frame before hydration snaps to the bottom.
  // This effect runs in commit phase AFTER useChatScroll's layout effects, so
  // by the time we reveal, the snap has happened.
  const [scrollReady, setScrollReady] = useState(false);
  useLayoutEffect(() => {
    setScrollReady(true);
  }, []);

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
        onAlert={alert}
        onOpenSearch={openSearch}
        stageCatalog={stageCatalog}
        currentStageId={stageId}
        onStageChange={persistStageId}
        canManageStages={canManageStages}
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
          <span className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-3 py-1 text-[11px] text-destructive shadow-sm">
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
        className={cn("flex-1", !scrollReady && "invisible")}
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
            const prev = timeline[idx - 1];
            const showDay =
              !prev ||
              formatDaySeparator(entry.data.timestamp) !==
                formatDaySeparator(prev.data.timestamp);
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
                      {formatDaySeparator(entry.data.timestamp)}
                    </span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                )}
                <motion.div
                  initial={animateIn ? { opacity: 0, y: 4 } : false}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.14, ease: "easeOut" }}
                  data-message-id={entry.kind === "message" ? entry.data.id : undefined}
                  className="rounded-2xl transition-shadow"
                >
                  {entry.kind === "message" ? (
                    <MessageBubble
                      message={entry.data}
                      sender={
                        entry.data.senderUserId
                          ? memberById.get(entry.data.senderUserId) ?? null
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
                </motion.div>
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
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-[11px] text-muted-foreground shadow-sm"
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
        <>
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
        </>
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
