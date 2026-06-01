"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, Loader2, X } from "lucide-react";

import { dispatchLocalSocketEvent, dispatchLocalSocketEvents } from "@/lib/socket-client";
import { apiFetch } from "@/lib/api/client-fetch";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useTzNow } from "@/providers/tz-provider";
import { calendarDayKey, formatDaySeparator } from "@ccp/shared/utils";
import type {
  CallSnapshot,
  ContactFieldDefinition,
  ContactStage,
  ConversationActivityEvent,
  ConversationWithRefs,
  InternalNote,
  Message,
  ReplySnapshot,
  Tag,
  User,
} from "@ccp/shared/types";
import {
  buildOptimisticStageChange,
  rollbackOptimisticActivity,
} from "@/features/inbox/lib/optimistic-activity";
import { useConversationEvents } from "@/features/inbox/hooks/use-conversation-events";
import { useConversationViewers } from "@/features/inbox/hooks/use-conversation-viewers";
import { useTyping } from "@/features/inbox/hooks/use-typing";
import { useMessageSelection } from "@/features/inbox/hooks/use-message-selection";
import { useChatScroll } from "@/features/inbox/hooks/use-chat-scroll";

import dynamic from "next/dynamic";

import { ErrorBoundary } from "@/components/error-boundary";

import { MessageBubble } from "./message-bubble";
import { CallBubble } from "./message-bubble/call-bubble";
import { InternalNote as InternalNoteCard } from "./internal-note";
import { ActivityEntry } from "./activity-entry";
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
  | { kind: "note"; data: InternalNote }
  // Activity events carry their time on `at`; we surface a `timestamp` alias on
  // the entry so the shared sort + day-separator logic (which reads
  // `entry.data.timestamp`) treats all three kinds uniformly.
  | {
      kind: "activity";
      data: ConversationActivityEvent & { timestamp: string };
    }
  // Voice call rows. Aliased the same way as activity entries — `ringingAt`
  // becomes `timestamp` so the sort + day-separator code stays uniform.
  | {
      kind: "call";
      data: CallSnapshot & { timestamp: string };
    };

function MessageThreadImpl({
  data: initialData,
  teamMembers,
  currentUser,
  nextOlderCursor,
  stageCatalog,
  tags,
  fieldDefinitions,
  canManageStages,
  canDeleteConversations,
  canMakeCalls,
  onInitiateCall,
  onMarkRead,
  onSnapshot,
  onMobileBack,
  jumpToMessageId,
}: {
  data: ConversationWithRefs;
  teamMembers: User[];
  currentUser: User;
  nextOlderCursor: string | null;
  /** Team-wide stage catalog — drives the header stepper. */
  stageCatalog: ContactStage[];
  /** Team tag catalog — forwarded to ReplyBox so snippet
   *  `$var.contact.tag_names` resolves (contact carries only tag ids). */
  tags: Tag[];
  /** Team custom-field schema — forwarded to ReplyBox so the template
   *  fill view can offer the `$var.contact.<custom_key>` picker. */
  fieldDefinitions: ContactFieldDefinition[];
  /** Whether the current user can edit the team's stage catalog. */
  canManageStages: boolean;
  /** Whether the current user can delete conversations (`conversations:delete`).
   *  Forwarded to ThreadHeader → ConversationMenu to hide the delete action. */
  canDeleteConversations: boolean;
  /** Whether to show the Phone button in the header. Set by the shell from
   *  capability check + channel + contact country gate. */
  canMakeCalls: boolean;
  /** Click handler — shell-level, runs the POST and handles error UI. */
  onInitiateCall: () => void | Promise<void>;
  /** Forwarded to useConversationEvents so the shell can patch its cached
   *  unreadCount=0 after the mark-read POST resolves. Optional so tests and
   *  other mount points don't need to thread it. */
  onMarkRead?: (conversationId: string) => void;
  /** Forwarded to useConversationEvents: on unmount, hands the live slice +
   *  cursor back to the shell so the LRU snapshot reflects this visit (no
   *  switch-back flash). Optional for the same reason as onMarkRead. */
  onSnapshot?: (data: ConversationWithRefs, nextOlderCursor: string | null) => void;
  /** Below md the inbox single-panes between conversation list and thread.
   *  When set, ThreadHeader renders a back-arrow that returns to the list. */
  onMobileBack?: () => void;
  /** One-shot deep-link target from the GLOBAL inbox search: when an agent
   *  clicks a "Messages" hit in another conversation, the shell opens this
   *  thread and passes the matched message id here. The thread loads a
   *  context window around it (if outside the slice) and scrolls to it,
   *  reusing the same machinery the in-thread search uses. Null/undefined on
   *  every normal open. */
  jumpToMessageId?: string | null;
}) {
  const {
    data,
    hasMoreOlder,
    reachedSliceCap,
    loadingOlder,
    loadOlder,
    addOptimistic,
    markOptimisticFailed,
    removeOptimistic,
    replaceWithContext,
  } = useConversationEvents(initialData, nextOlderCursor, onMarkRead, onSnapshot);
  const { conversation, contact, assignedUser, messages, notes } = data;
  // Stable reference: `data.events ?? []` would allocate a fresh array on every
  // render when events is nullish, making the timeline useMemo below recompute
  // each pass. Memo on `data.events` so it only changes when events actually do.
  const events = useMemo(() => data.events ?? [], [data.events]);
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
  const softRefresh = useSoftRefresh();

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
      // Bundle `contact:updated` + the matching stage-changed activity pill
      // into ONE flushSync so the sidebar chip, LRU cache, contact panel, AND
      // the timeline pill commit in a single paint. Two separate
      // `dispatchLocalSocketEvent` calls (state + activity) produced two
      // paints in a row — the second-paint gap was the visible "log lags
      // everything else". `optimistic: true` tells the inbox-list resync /
      // counts refetch to skip the in-flight PATCH window; the authoritative
      // server frame drives convergence. See use-team-events onContactUpdated.
      let stageActivityId: string | null = null;
      const stageActivity =
        prev !== next
          ? buildOptimisticStageChange({
              teamId: contact.teamId,
              conversationId: conversation.id,
              actorName: currentUser.name,
              fromStageName: stageCatalog.find((s) => s.id === prev)?.name ?? null,
              toStageName: stageCatalog.find((s) => s.id === next)?.name ?? null,
            })
          : null;
      if (stageActivity) stageActivityId = stageActivity.id;
      const frames: Parameters<typeof dispatchLocalSocketEvents>[0] = [
        [
          "contact:updated",
          {
            teamId: contact.teamId,
            contact: { ...contact, stageId: next },
            optimistic: true,
          },
        ],
      ];
      if (stageActivity) frames.push(stageActivity.frame);
      dispatchLocalSocketEvents(frames);
      // Sidebar stage badges are computed from a server-fetched `byStage`
      // map (useConversationCounts). The `contact:updated` event triggers
      // a refetch there, but the refetch is a 50-300ms round-trip — the
      // badge would lag the thread header. Fire a delta event so the
      // counts hook can patch byStage locally and the badge flips in the
      // same frame as the thread header. Window CustomEvents have their own
      // sync dispatch, so this stays outside the batched socket dispatch.
      if (prev !== next && typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("ccp:contact-stage-delta", {
            detail: { contactId: contact.id, prevStageId: prev, nextStageId: next },
          }),
        );
      }
      const res = await apiFetch(`/api/contacts/${contact.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stageId: next }),
      });
      if (!res.ok) {
        // Roll back the optimistic update so the chip reflects truth.
        setStageId(prev);
        dispatchLocalSocketEvent("contact:updated", {
          teamId: contact.teamId,
          contact: { ...contact, stageId: prev },
          optimistic: true,
        });
        if (stageActivityId) {
          rollbackOptimisticActivity(contact.teamId, conversation.id, stageActivityId);
        }
        if (prev !== next && typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("ccp:contact-stage-delta", {
              detail: { contactId: contact.id, prevStageId: next, nextStageId: prev },
            }),
          );
        }
        await alert(
          "Couldn't change stage",
          await readError(res),
        );
        return;
      }
      // No router.refresh() here. The optimistic `contact:updated` dispatch +
      // the byStage delta event already flip every live surface (header chip,
      // sidebar counts, right rail, LRU cache) instantly, and the server frame
      // converges them. A refresh would re-SSR the whole inbox page — and now
      // that selection is mirrored as `?c=<id>` in the URL, that re-fetches the
      // FULL open thread (getConversationWithRefs), which reads as "the whole
      // page reloaded" on every stage change. Other RSC surfaces (contacts
      // list) pick up the canonical row on their next navigation.
    },
    [
      alert,
      contact,
      conversation.id,
      currentUser.name,
      stageCatalog,
      stageId,
    ],
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
  // Pull the identity-stable handlers (`start`/`clear` are useCallback([]) in
  // the hook) and the `selecting` flag out as locals so the effects/callbacks
  // below depend on them precisely. Depending on the whole `selection` object
  // would re-run them on every checkbox toggle — its memo identity changes
  // with `selectedIds`.
  const { clear: clearSelection, start: startSelection, selecting: isSelecting } = selection;
  const [forwardOpen, setForwardOpen] = useState(false);
  const [forwardIds, setForwardIds] = useState<string[]>([]);

  // Re-snapshot when the user changes conversation — the previous reply
  // target / selection belongs to the old thread.
  useEffect(() => {
    setReplyTarget(null);
    clearSelection();
  }, [conversation.id, clearSelection]);

  // Esc leaves selection mode.
  useEffect(() => {
    if (!isSelecting) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") clearSelection();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isSelecting, clearSelection]);

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

  // Stable handlers for ForwardDialog (dynamic-imported, may be memoized
  // internally). Inline arrows would re-allocate on every parent render
  // and force the dialog's effect chain to re-run on each pass.
  const closeForward = useCallback(() => {
    setForwardOpen(false);
    selectionRef.current.clear();
  }, []);
  const onForwardError = useCallback((summary: string) => {
    void alert(summary);
  }, [alert]);

  const startSelect = useCallback(
    (msg: Message) => startSelection(msg.id),
    [startSelection],
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

  // Scroll refs (also consumed by useChatScroll further down). Declared up
  // here so the search-jump helper below can install its settle-window
  // ResizeObserver + media-load listeners against the same content + viewport
  // the chat-scroll hook does. `viewportRef` is populated via the
  // ScrollArea's `viewportRef` prop — a callback ref that attaches the
  // moment the viewport DOM node mounts (no useLayoutEffect indirection).
  const viewportRef = useRef<HTMLElement | null>(null);
  const setViewportRef = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node;
  }, []);
  const contentRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);

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

  // The id the thread should center on: an in-thread search match the user is
  // navigating takes priority; otherwise the one-shot deep-link target from
  // the global inbox search. Both flow through the SAME context-window load +
  // scroll effect below. Cleared to null when neither is present.
  const jumpTargetId = activeMatchId ?? jumpToMessageId ?? null;

  // Forward-ref to useChatScroll's `markBenignTailUpdate`. The hook is
  // declared later (it needs `lastEntryKey` which is computed below), but
  // the active-match effect needs to flag the slice swap as benign before
  // it commits. The ref is assigned right after the hook call; consumers
  // call through the ref to dodge the TDZ.
  const markBenignTailUpdateRef = useRef<() => void>(() => {});
  // Same TDZ dodge for `releaseStickToBottom`. The search-jump scroller has
  // to drop sticky BEFORE its `scrollIntoView` runs, otherwise the hook's
  // ResizeObserver + media-load handlers re-snap to the bottom and fight
  // the smooth scroll — viewport lands below the match and the user has to
  // scroll up to see the highlight.
  const releaseStickToBottomRef = useRef<() => void>(() => {});

  // Re-center the viewport on a matched bubble, robustly. A plain
  // `scrollIntoView({behavior:"smooth"})` computes its target position at
  // call time — while the ~300-500ms smooth animation is running, content
  // ABOVE the target can reflow (image decode, video poster mount,
  // framer-motion entrance, font swap), shifting the target's absolute Y by
  // tens-to-hundreds of pixels. The scroll then lands at the now-stale
  // position: "close to the searched message but not quite on it, user has
  // to scroll a bit."
  //
  // useChatScroll already mitigates this for the stick-to-bottom case via a
  // ResizeObserver + media-load listener, but ONLY while `stickyRef===true`.
  // Search jumps happen with the user scrolled up in history, so that hook
  // is silent. Mirror its load-older settle pattern here: after the initial
  // smooth scroll, install a temporary ResizeObserver on the content + a
  // capture-phase `load`/`loadedmetadata` listener on the viewport. Each
  // reflow re-centers the bubble (auto, not smooth, so we don't fight our
  // own animation). Bails on the first user wheel/touch or after 1.2s.
  const matchSettleStopRef = useRef<(() => void) | null>(null);
  const scrollMatchIntoView = useCallback((messageId: string) => {
    matchSettleStopRef.current?.();
    // Hand scroll control off from useChatScroll before we do anything else.
    // If sticky was true (user was at the bottom when they opened search),
    // the upcoming reflows from slice swap / `<mark>` insertion / image
    // decode would otherwise re-snap to the bottom and override our
    // `scrollIntoView`. Releasing also stops any in-flight load-older
    // settle window for the same reason.
    releaseStickToBottomRef.current();
    // Double-rAF before the first scroll so framer-motion's mount transition
    // (one frame) and the subsequent layout pass (next frame) both commit
    // before we measure. Track inner rAF in a closure var so the returned
    // cleanup can cancel whichever frame is currently outstanding.
    let pending: number | null = null;
    pending = window.requestAnimationFrame(() => {
      pending = window.requestAnimationFrame(() => {
        pending = null;
        const el = document.querySelector<HTMLElement>(
          `[data-message-id="${messageId}"]`,
        );
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "center" });

        const content = contentRef.current;
        const viewport = viewportRef.current;
        if (!content || !viewport) return;

        let done = false;
        const recenter = () => {
          if (done) return;
          // Re-resolve each time — re-renders can swap the DOM node.
          const current = document.querySelector<HTMLElement>(
            `[data-message-id="${messageId}"]`,
          );
          if (current) {
            current.scrollIntoView({ behavior: "auto", block: "center" });
          }
        };
        const onMediaLoad = (e: Event) => {
          const tag = (e.target as HTMLElement | null)?.tagName;
          if (tag === "IMG" || tag === "VIDEO") recenter();
        };
        const ro = new ResizeObserver(recenter);
        ro.observe(content);
        viewport.addEventListener("load", onMediaLoad, true);
        viewport.addEventListener("loadedmetadata", onMediaLoad, true);
        const stop = () => {
          if (done) return;
          done = true;
          ro.disconnect();
          viewport.removeEventListener("load", onMediaLoad, true);
          viewport.removeEventListener("loadedmetadata", onMediaLoad, true);
          viewport.removeEventListener("wheel", stop);
          viewport.removeEventListener("touchmove", stop);
          window.clearTimeout(timer);
          if (matchSettleStopRef.current === stop) {
            matchSettleStopRef.current = null;
          }
        };
        viewport.addEventListener("wheel", stop, { passive: true });
        viewport.addEventListener("touchmove", stop, { passive: true });
        const timer = window.setTimeout(stop, 1200);
        matchSettleStopRef.current = stop;
      });
    });
    return () => {
      if (pending != null) window.cancelAnimationFrame(pending);
    };
  }, []);

  // Tear down any in-flight settle window on unmount.
  useEffect(() => () => matchSettleStopRef.current?.(), []);

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
    if (!jumpTargetId) {
      handledMatchIdRef.current = null;
      return;
    }
    if (handledMatchIdRef.current === jumpTargetId) return;

    if (messagesById.has(jumpTargetId)) {
      handledMatchIdRef.current = jumpTargetId;
      return scrollMatchIntoView(jumpTargetId);
    }

    // Slow path: load a context window centered on the match and remember
    // to scroll once it renders.
    handledMatchIdRef.current = jumpTargetId;
    let cancelled = false;
    setSearchError(null);
    void (async () => {
      try {
        const res = await apiFetch(
          `/api/conversations/${conversation.id}/messages/context?messageId=${encodeURIComponent(jumpTargetId)}`,
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
        setPendingJumpId(jumpTargetId);
      } catch {
        if (!cancelled) setSearchError("Network error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jumpTargetId, messagesById, conversation.id, replaceWithContext, scrollMatchIntoView]);

  // Once the context window has rendered, scroll to the message we were
  // waiting on. Routed through the shared helper so the same settle window
  // re-pins us as the new slice's images decode in.
  useEffect(() => {
    if (!pendingJumpId) return;
    if (!messagesById.has(pendingJumpId)) return;
    const cleanup = scrollMatchIntoView(pendingJumpId);
    setPendingJumpId(null);
    return cleanup;
  }, [pendingJumpId, messagesById, scrollMatchIntoView]);

  const deleteNote = useCallback(
    async (noteId: string) => {
      const ok = await confirm({
        title: "Delete this internal note?",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!ok) return;
      // Optimistic: fan the deletion locally so the bubble vanishes
      // instantly + the panel's note count ticks down without waiting on
      // the server round-trip. Reducers self-bail on missing rows, so the
      // real server event arriving moments later is a no-op.
      dispatchLocalSocketEvent("note:deleted", {
        teamId: conversation.teamId,
        conversationId: conversation.id,
        noteId,
      });
      const res = await apiFetch(`/api/notes/${noteId}`, { method: "DELETE" });
      if (!res.ok) {
        await alert("Couldn't delete note", "Please try again.");
        // No good rollback path — the note object isn't around to re-insert
        // in order. softRefresh pulls the canonical thread back.
        softRefresh();
      }
    },
    [alert, confirm, conversation.id, conversation.teamId, softRefresh],
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
    // Same visibility rule as notes: hide entries older than the oldest loaded
    // message until their neighborhood scrolls in, so an activity pill doesn't
    // orphan at the very top detached from its conversational context.
    const visibleNotes =
      hasMoreOlder && oldestMessageTs
        ? notes.filter((n) => n.timestamp >= oldestMessageTs)
        : notes;
    const visibleEvents =
      hasMoreOlder && oldestMessageTs
        ? events.filter((e) => e.at >= oldestMessageTs)
        : events;
    const calls = data.calls ?? [];
    const visibleCalls =
      hasMoreOlder && oldestMessageTs
        ? calls.filter((c) => c.ringingAt >= oldestMessageTs)
        : calls;
    const isPending = (e: TimelineEntry) =>
      e.kind === "message" && e.data.pending === true;
    return [
      ...messages.map((m): TimelineEntry => ({ kind: "message", data: m })),
      ...visibleNotes.map((n): TimelineEntry => ({ kind: "note", data: n })),
      // Alias `at` → `timestamp` so the sort + day-separator code (which reads
      // entry.data.timestamp) treats activity entries like any other.
      ...visibleEvents.map(
        (e): TimelineEntry => ({
          kind: "activity",
          data: { ...e, timestamp: e.at },
        }),
      ),
      // Calls sort by ringingAt — that's when the user-visible event
      // happened (the row keeps endedAt for the audit trail). Aliased to
      // `timestamp` like activity entries for the shared sort.
      ...visibleCalls.map(
        (c): TimelineEntry => ({
          kind: "call",
          data: { ...c, timestamp: c.ringingAt },
        }),
      ),
    ].sort((a, b) => {
      const ap = isPending(a);
      const bp = isPending(b);
      if (ap !== bp) return ap ? 1 : -1;
      return (
        new Date(a.data.timestamp).getTime() -
        new Date(b.data.timestamp).getTime()
      );
    });
  }, [messages, notes, events, hasMoreOlder, data.calls]);

  // Day-separator labels keyed by timeline index. Pre-computed alongside the
  // timeline so the per-entry render doesn't run formatDaySeparator twice per
  // bubble (which was 60+ Intl calls per timeline render). Each label is the
  // date string when this entry should show a separator above it; null means
  // the previous entry is on the same calendar day.
  //
  // `tz` + `now` come from TimezoneProvider — same values on server and
  // client, so "Today" / "Yesterday" buckets agree across hydration.
  const { tz, now } = useTzNow();
  // The labels only change at *local* midnight, but `now` ticks every 60s.
  // Key the memo on the calendar day in the provider tz so it rebuilds once
  // a day instead of ~1000 Intl calls/min across a 500-message thread.
  // (UTC-day bucketing would flip the labels hours off local midnight in
  // non-UTC zones — a real staleness bug — so we format in `tz`.) `now` is
  // read through a ref: refs aren't memo deps, and any `now` within the same
  // day yields identical Today/Yesterday output.
  const nowRef = useRef(now);
  nowRef.current = now;
  // Use the SHARED `calendarDayKey` cache instead of allocating a fresh
  // `Intl.DateTimeFormat` every 60s tick. Same cache the day-separator
  // formatter uses — without this, every visible thread re-allocates a
  // formatter on every `now` tick, defeating the cache that exists
  // precisely to prevent this (memory: project_no_split_paint_time_rule).
  const todayKey = useMemo(() => calendarDayKey(now, tz), [tz, now]);
  const dayLabels = useMemo(() => {
    const labels: Array<string | null> = new Array(timeline.length);
    let prevLabel: string | null = null;
    for (let i = 0; i < timeline.length; i++) {
      const entry = timeline[i]!;
      const label = formatDaySeparator(entry.data.timestamp, tz, nowRef.current);
      labels[i] = label !== prevLabel ? label : null;
      prevLabel = label;
    }
    return labels;
    // `todayKey` is an intentional recompute TRIGGER, not a value the body
    // reads: `now` is pulled via `nowRef` (so this doesn't recompute on every
    // 60s tick), but Today/Yesterday labels must refresh when the calendar day
    // rolls over — `todayKey` changes exactly then. eslint can't model a
    // dependency that's a trigger rather than a read, so silence it here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline, tz, todayKey]);

  // ---------------------------------------------------------------------
  // Scroll behavior — see `useChatScroll`. All the messy bits (viewport
  // resolution, scroll listener, ResizeObserver for stick-to-bottom,
  // load-older anchor preservation, settle window) live in the hook so this
  // component stays a renderer. The refs themselves are declared further up
  // (above the in-thread search block) so the search-jump settle window can
  // observe the same nodes.
  // ---------------------------------------------------------------------
  const lastEntry = timeline.at(-1);
  const lastEntryKey = lastEntry ? `${lastEntry.kind}_${lastEntry.data.id}` : null;
  const isOwnSend =
    lastEntry?.kind === "message" && lastEntry.data.pending === true;
  // Activity-log pills (assignment / status / stage / tag changes) ride the
  // same timeline as messages + notes so they sort into chronological order,
  // but they aren't "new conversation content" — suppress the unread-below
  // pill bump for them in `useChatScroll` so an assignment never surfaces a
  // misleading "↓ 1 new message" bubble.
  const isActivityTail = lastEntry?.kind === "activity";

  const { unreadBelow, scrollToBottom, markBenignTailUpdate, releaseStickToBottom } =
    useChatScroll({
      viewportRef,
      contentRef,
      topSentinelRef,
      conversationId: conversation.id,
      lastEntryKey,
      isOwnSend,
      isActivityTail,
      hasMoreOlder,
      loadOlder,
    });
  // Bind the forward-refs used by the active-match + search-jump effects
  // (declared above this hook call). Assignment in render is idempotent.
  markBenignTailUpdateRef.current = markBenignTailUpdate;
  releaseStickToBottomRef.current = releaseStickToBottom;

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
        teamId={conversation.teamId}
        conversationId={conversation.id}
        contactId={contact.id}
        contactName={contact.name}
        phone={contact.phoneNumber}
        status={conversation.status}
        assignedUserId={assignedUser?.id ?? null}
        assignedUserName={assignedUser?.name ?? null}
        assignedUserAvatarUrl={assignedUser?.avatarUrl ?? null}
        teamMembers={teamMembers}
        currentUserName={currentUser.name}
        otherViewers={otherViewers}
        onAlert={alert}
        onOpenSearch={openSearch}
        stageCatalog={stageCatalog}
        currentStageId={stageId}
        onStageChange={persistStageId}
        canManageStages={canManageStages}
        canDeleteConversations={canDeleteConversations}
        canMakeCalls={canMakeCalls}
        onInitiateCall={onInitiateCall}
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
        viewportRef={setViewportRef}
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
          {reachedSliceCap && (
            // The slice cap is the in-memory cap (MAX_THREAD_SLICE = 500 in
            // use-conversation-events.ts), not a "no more messages" signal —
            // older messages exist on the server, we stopped paging for
            // scroll perf. Surfacing the hint here means an agent who clicks
            // "Load older" 10 times and stops getting more knows what to do
            // next, instead of assuming the conversation just started.
            <div className="mx-auto my-3 max-w-md rounded-md border border-dashed border-muted-foreground/30 bg-muted/40 px-3 py-2 text-center text-xs text-muted-foreground">
              Older messages exist beyond this point.{" "}
              <span className="font-medium">Use search</span> to jump to a
              specific older message.
            </div>
          )}
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
                <div
                  data-message-id={entry.kind === "message" ? entry.data.id : undefined}
                  className="rounded-2xl transition-shadow"
                >
                  {/* Local ErrorBoundary per row — without this, a single
                      malformed message payload (or a bug in a sub-component
                      like LocalTime) would unmount the entire inbox via
                      Next.js's inbox/error.tsx. With this, the agent sees
                      a "couldn't render" placeholder for that one row and
                      keeps working with the rest of the thread. */}
                  <ErrorBoundary label="message">
                    {entry.kind === "message" ? (
                      <MessageBubble
                        message={entry.data}
                        senderName={
                          entry.data.senderUserId
                            ? memberById.get(entry.data.senderUserId)?.name ?? null
                            : null
                        }
                        senderAvatarUrl={
                          entry.data.senderUserId
                            ? memberById.get(entry.data.senderUserId)?.avatarUrl ?? null
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
                    ) : entry.kind === "note" ? (
                      <InternalNoteCard
                        note={entry.data}
                        author={
                          (entry.data.authorUserId
                            ? memberById.get(entry.data.authorUserId)
                            : undefined) ?? unknownAuthor(entry.data.authorUserId)
                        }
                        onDelete={deleteNote}
                      />
                    ) : entry.kind === "call" ? (
                      <CallBubble call={entry.data} />
                    ) : (
                      <ActivityEntry event={entry.data} />
                    )}
                  </ErrorBoundary>
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
            stageCatalog={stageCatalog}
            tags={tags}
            fieldDefinitions={fieldDefinitions}
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
        onClose={closeForward}
        onError={onForwardError}
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
