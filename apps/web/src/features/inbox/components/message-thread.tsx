"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { AiSuggestionBar } from "./ai/ai-suggestion-bar";
import { ArrowDown, Loader2, MessageSquareDashed, X } from "lucide-react";

import { dispatchLocalSocketEvent, dispatchLocalSocketEvents } from "@/lib/socket-client";
import { apiFetch } from "@/lib/api/client-fetch";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useTzNow } from "@/providers/tz-provider";
import { calendarDayKey, cn, formatDaySeparator } from "@ccp/shared/utils";
import type {
  CallSnapshot,
  ContactFieldDefinition,
  ContactStage,
  ConversationActivityEvent,
  ConversationWithRefs,
  InternalNote,
  MediaKind,
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
// interaction-only (no SEO/render-without-JS concern). BOTH are gated on
// their open flag at the render site (`{forwardOpen && …}` / `{searchOpen &&
// …}`) so next/dynamic only fetches the chunk on first open — rendering a
// lazy component AT ALL triggers its chunk request, even with open={false}.
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
  | { kind: "activity"; data: ConversationActivityEvent }
  | { kind: "call"; data: CallSnapshot };

// Sort/label timestamp per entry kind. Messages + notes carry `.timestamp`,
// activity events carry `.at`, calls carry `.ringingAt` (when the call was the
// user-visible event). Reading the kind-specific field here — instead of
// spreading every event into a fresh `{ ...e, timestamp }` wrapper on every
// timeline rebuild — keeps `entry.data` REFERENTIALLY STABLE. That matters
// because the timeline useMemo rebuilds on any message change (e.g. a
// sent→delivered→read status burst), and a fresh `data` object would defeat the
// `memo` on every ActivityEntry / CallBubble and re-render the whole log stack
// for a change that didn't touch a single pill. With raw `data`, identity only
// changes when the row's own source object does (GET reconcile / new pill) —
// exactly when a re-render is actually warranted.
function entryTimestamp(entry: TimelineEntry): string {
  switch (entry.kind) {
    case "activity":
      return entry.data.at;
    case "call":
      return entry.data.ringingAt;
    default:
      return entry.data.timestamp;
  }
}

// Consecutive messages from the same sender within this window collapse into a
// visual group (one avatar + one meta row at the tail), like WhatsApp/Slack.
const GROUP_WINDOW_MS = 5 * 60 * 1000;

// Short, human label for a media-only inbound, used by the screen-reader
// announcement when there's no text body to read.
const MEDIA_ANNOUNCE_LABEL: Partial<Record<MediaKind, string>> = {
  image: "sent a photo",
  video: "sent a video",
  audio: "sent a voice message",
  document: "sent a document",
  sticker: "sent a sticker",
};

// One-line announcement for a newly-arrived inbound message (text preview, or a
// media/interactive fallback). Capped so a long message doesn't flood the AT
// buffer. Pure — safe at module scope.
function inboundAnnouncementText(m: Message): string {
  const body = m.body?.trim();
  if (body) return body.length > 120 ? `${body.slice(0, 117)}…` : body;
  if (m.media?.kind) return MEDIA_ANNOUNCE_LABEL[m.media.kind] ?? "sent an attachment";
  return "sent a message";
}

// Scroll behavior for jump-to-message (reply quote, search match, note, Files
// "Jump"). Honor `prefers-reduced-motion`: a long smooth scroll across the
// thread is exactly the vestibular trigger those users opt out of. The CSS
// `scroll-behavior` rule doesn't cover this — an explicit `behavior` option
// passed to scrollIntoView overrides the CSS property, so we must branch here.
function jumpScrollBehavior(): ScrollBehavior {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

/**
 * One-shot attention pulse on a jumped-to timeline row. The gallery "Jump" and
 * global-search deep-link land INSTANTLY (no scroll motion) so, without a cue,
 * the eye has to hunt for the target — this fades a soft primary wash + ring
 * over it (globals.css `.jump-flash`). Re-adds the class after a forced reflow
 * so a repeat jump to the same row replays the animation, and self-cleans on
 * `animationend` so nothing lingers. Reduced-motion disables the keyframe (the
 * class is in the reduce-motion off-list), leaving an instant, motion-free jump.
 */
function flashJumpTarget(el: HTMLElement) {
  el.classList.remove("jump-flash");
  // Force reflow so removing + re-adding restarts the animation on a repeat jump.
  void el.offsetWidth;
  el.classList.add("jump-flash");
  const clear = () => {
    el.classList.remove("jump-flash");
    el.removeEventListener("animationend", clear);
  };
  el.addEventListener("animationend", clear);
}

/**
 * The rendered timeline rows, extracted into a `memo`'d child so the ~500-entry
 * `.map()` (element creation + per-row `memo` comparisons) does NOT re-run when
 * MessageThreadImpl re-renders for reasons that don't touch the list: a teammate
 * `typing` frame, the 60s `now` tick (the parent subscribes to `useTzNow` only
 * for the midnight day-rollover), reply-target / stage / composer-prefill state,
 * etc. Every prop here is referentially stable across those (useMemo arrays,
 * useCallback handlers, primitives), so this child bails. It still re-renders on
 * the warranted changes — `timeline`/`dayLabels` (new content), search
 * query/matches (in-place highlight), and selection (checkbox mode). The content
 * div + scroll refs + sentinel stay in the parent so useChatScroll is untouched.
 * (Inbox audit, 2026-06-02 — kills the avoidable full-list reconcile walk.)
 */
const TimelineRows = memo(function TimelineRows({
  timeline,
  dayLabels,
  continuationFlags,
  memberById,
  contactName,
  contactSeed,
  searchOpen,
  matchedIds,
  searchQuery,
  activeMatchId,
  selecting,
  isSelected,
  onToggleSelect,
  onReply,
  onJumpToOriginal,
  onForward,
  onStartSelect,
  onDismissFailed,
  onRetryFailed,
  onDeleteNote,
  animArmed,
}: {
  timeline: TimelineEntry[];
  dayLabels: Array<string | null>;
  continuationFlags: boolean[];
  memberById: Map<string, User>;
  contactName: string;
  contactSeed: string;
  searchOpen: boolean;
  matchedIds: Set<string>;
  searchQuery: string;
  activeMatchId: string | null;
  selecting: boolean;
  isSelected: (id: string) => boolean;
  onToggleSelect: (id: string) => void;
  onReply: (msg: Message) => void;
  onJumpToOriginal: (originalId: string) => void;
  onForward: (msg: Message) => void;
  onStartSelect: (msg: Message) => void;
  onDismissFailed: (msg: Message) => void;
  onRetryFailed: (msg: Message) => void;
  onDeleteNote: (noteId: string) => void;
  /** True once the thread has revealed (past the initial settle) — gates the
   *  per-message entrance so the initial load doesn't mass-animate. */
  animArmed: boolean;
}) {
  // Message keys already rendered ≥ once. A bubble animates ONLY the first time
  // it appears near the tail while armed — so live arrivals fade in, but the
  // initial load, a load-older prepend, and a reconnect refetch (re-rendering
  // already-seen tails) do not.
  const seenKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const e of timeline) {
      if (e.kind === "message") {
        seenKeysRef.current.add(
          e.data.clientTempId ? `t_${e.data.clientTempId}` : e.data.id,
        );
      }
    }
    // Only walk when the timeline actually changes — without the dep this ran
    // after every render (e.g. a search keystroke), re-scanning up to ~500
    // entries for no reason.
  }, [timeline]);
  return (
    <>
      {timeline.map((entry, idx) => {
        const dayLabel = dayLabels[idx];
        const showDay = dayLabel !== null;
        // Grouping (message rows only). `isContinuation` = this row groups under
        // the one above (tighten spacing, hide its own avatar/meta). `isTail` =
        // the next row does NOT continue this group, so THIS row carries the
        // shared avatar (bottom-anchored, inbound) + meta. Pending/failed rows
        // always show meta so their status icon is never hidden.
        const isMessage = entry.kind === "message";
        const isContinuation = isMessage && continuationFlags[idx] === true;
        const isTail = isMessage && continuationFlags[idx + 1] !== true;
        // Head = first bubble of a same-sender group. Drives the outbound
        // sender-attribution chip (MessageBubble gates it on direction === out).
        const isHead = isMessage && !isContinuation;
        // Direction drives how tight a continuation sits. Inbound bubbles are
        // light-grey + bordered on a near-white page (LOW edge contrast), so a
        // 2px gap reads as "touching"; outbound bubbles are solid/high-contrast,
        // where 2px looks right. Give inbound continuations more air below.
        const isOutboundMsg =
          entry.kind === "message" && entry.data.direction === "out";
        // Entrance-animate a genuinely-new live message: armed, never-seen, and
        // near the TAIL (appended — not a load-older prepend at the top).
        const animateIn =
          animArmed &&
          entry.kind === "message" &&
          !seenKeysRef.current.has(
            entry.data.clientTempId
              ? `t_${entry.data.clientTempId}`
              : entry.data.id,
          ) &&
          idx >= timeline.length - 4;
        // A failed send must ALWAYS show its meta (the red AlertCircle + reason
        // live only in BubbleMeta), regardless of group position — including a
        // server-confirmed failure (`status === "failed"`, set by a message:status
        // frame) which leaves the optimistic `failed`/`pending` flags false.
        const showMeta =
          isTail ||
          (isMessage &&
            (entry.data.pending ||
              entry.data.failed ||
              entry.data.status === "failed"));
        // For outbound messages we key on clientTempId when present so the React
        // node survives the optimistic→confirmed swap (server assigns a fresh id,
        // but the bubble is conceptually the same — no unmount, no re-animation).
        const entryKey =
          entry.kind === "message" && entry.data.clientTempId
            ? `message_t_${entry.data.clientTempId}`
            : `${entry.kind}_${entry.data.id}`;

        return (
          <div key={entryKey} className="contents">
            {showDay && (
              // Centered day pill (WhatsApp-style). NOT sticky: `position:
              // sticky` inside the column-reverse thread caused the pill to
              // detach and OVERLAP messages/activity rows (the dividers piled
              // up). A plain in-flow opaque pill flows cleanly between days.
              <div className="my-3 flex justify-center">
                <span className="rounded-full border border-border/40 bg-card px-3 py-0.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {dayLabel}
                </span>
              </div>
            )}
            <div
              data-message-id={entry.kind === "message" ? entry.data.id : undefined}
              // Test/observability hooks on the shared per-entry wrapper: every
              // timeline entry carries its kind, id, sort timestamp, and live pin
              // state in DOM order — so an e2e spec can read the exact rendered
              // ordering and watch an optimistic log SETTLE (data-pending 1→absent).
              data-entry-kind={entry.kind}
              data-entry-id={entry.data.id}
              data-entry-ts={entryTimestamp(entry)}
              data-pending={
                (entry.kind === "message" && entry.data.pending) ||
                (entry.kind === "activity" && entry.data.optimisticPending)
                  ? "1"
                  : undefined
              }
              data-continuation={isContinuation ? "" : undefined}
              className={cn(
                "rounded-xl transition-shadow",
                // Within a same-sender group, collapse the inter-bubble gap from
                // the content list's gap-2 (8px) down via a negative top margin.
                // Outbound (solid, high-contrast) → 2px. Inbound (grey+bordered,
                // low-contrast) → 6px so the separation is clearly visible.
                // Both stay tighter than the 8px BETWEEN-group gap so grouping
                // still reads (message list div below: `flex-col gap-2`).
                isContinuation && (isOutboundMsg ? "-mt-1.5" : "-mt-0.5"),
              )}
            >
              {/* Local ErrorBoundary per row — a single malformed payload (or a
                  bug in a sub-component) renders a placeholder for that one row
                  instead of unmounting the entire inbox via inbox/error.tsx. */}
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
                    contactName={contactName}
                    contactSeed={contactSeed}
                    onReply={onReply}
                    onJumpToOriginal={onJumpToOriginal}
                    onForward={onForward}
                    onStartSelect={onStartSelect}
                    onDismissFailed={onDismissFailed}
                    onRetryFailed={onRetryFailed}
                    selecting={selecting}
                    selected={isSelected(entry.data.id)}
                    onToggleSelect={onToggleSelect}
                    searchQuery={
                      searchOpen && matchedIds.has(entry.data.id)
                        ? searchQuery
                        : undefined
                    }
                    isActiveSearchMatch={searchOpen && entry.data.id === activeMatchId}
                    showAvatar={isTail}
                    showMeta={showMeta}
                    isTail={isTail}
                    showSenderHeader={isHead}
                    animateIn={animateIn}
                  />
                ) : entry.kind === "note" ? (
                  <InternalNoteCard
                    note={entry.data}
                    author={
                      (entry.data.authorUserId
                        ? memberById.get(entry.data.authorUserId)
                        : undefined) ?? unknownAuthor(entry.data.authorUserId)
                    }
                    onDelete={onDeleteNote}
                  />
                ) : entry.kind === "call" ? (
                  <CallBubble
                    call={entry.data}
                    initiatedByName={
                      entry.data.initiatedByUserId
                        ? memberById.get(entry.data.initiatedByUserId)?.name ?? null
                        : null
                    }
                    answeredByName={
                      entry.data.answeredByUserId
                        ? memberById.get(entry.data.answeredByUserId)?.name ?? null
                        : null
                    }
                  />
                ) : (
                  <ActivityEntry event={entry.data} />
                )}
              </ErrorBoundary>
            </div>
          </div>
        );
      })}
    </>
  );
});

function MessageThreadImpl({
  data: initialData,
  initialMayBeStale = false,
  teamMembers,
  currentUser,
  nextOlderCursor,
  stageCatalog,
  tags,
  fieldDefinitions,
  canManageStages,
  canDeleteConversations,
  canMakeCalls,
  canAssignOthers,
  aiAutopilotEnabled,
  onInitiateCall,
  onMarkRead,
  onSnapshot,
  onMobileBack,
  onOpenContactDetails,
  jumpToMessageId,
  jumpNonce,
  rightPanel,
}: {
  data: ConversationWithRefs;
  /** True when `data` is a possibly-stale LRU snapshot (cache-hit switch-back):
   *  while backgrounded it missed conversation-room-scoped message:status ticks.
   *  Forwarded to useConversationEvents so it reconciles statuses on open. */
  initialMayBeStale?: boolean;
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
  canAssignOthers: boolean;
  /** Team-level AI Autopilot opt-in. Gates the header AI toggle's visibility —
   *  hidden for orgs that haven't enabled the AI flow. */
  aiAutopilotEnabled: boolean;
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
  /** Below lg the desktop contact rail is hidden; when set, ThreadHeader shows
   *  an Info button that opens the contact details in a Sheet (the shell owns
   *  the Sheet + ContactPanel). */
  onOpenContactDetails?: () => void;
  /** One-shot deep-link target from the GLOBAL inbox search: when an agent
   *  clicks a "Messages" hit in another conversation, the shell opens this
   *  thread and passes the matched message id here. The thread loads a
   *  context window around it (if outside the slice) and scrolls to it,
   *  reusing the same machinery the in-thread search uses. Null/undefined on
   *  every normal open. */
  jumpToMessageId?: string | null;
  /** Bumped by the shell on every jump REQUEST (see jumpTarget). Lets a repeat
   *  jump to the SAME message id re-fire — without it the handled-guard below
   *  would treat the unchanged id as already-done and the click is a no-op. */
  jumpNonce?: number;
  /** Optional right-hand column (the ContactPanel) rendered as a sibling of the
   *  message body, BELOW the full-width header. Lets the header + action bar
   *  span across the thread AND the details panel (the details sits under the
   *  name/status bar) while the composer stays under the messages only. */
  rightPanel?: React.ReactNode;
}) {
  // Declared BEFORE useConversationEvents because it is passed INTO it, and
  // bound after useChatScroll returns further down (that hook can't run first —
  // it needs values this one produces). Defaults to "not pinned", so the trim
  // stays off until the scroll hook has actually reported.
  const isStuckToBottomRef = useRef<(() => boolean) | null>(null);
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
  } = useConversationEvents(
    initialData,
    nextOlderCursor,
    onMarkRead,
    onSnapshot,
    initialMayBeStale,
    // Bound from useChatScroll further down (same idempotent
    // assignment-in-render pattern as markBenignTailUpdateRef). Lets the live
    // append trim the thread head ONLY when the viewer is pinned to the
    // bottom, never while they are scrolled up reading history.
    isStuckToBottomRef,
  );
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
              workspaceId: contact.workspaceId,
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
            workspaceId: contact.workspaceId,
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
          workspaceId: contact.workspaceId,
          contact: { ...contact, stageId: prev },
          optimistic: true,
        });
        if (stageActivityId) {
          rollbackOptimisticActivity(contact.workspaceId, conversation.id, stageActivityId);
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
      // A deeper modal layer (e.g. a MediaLightbox opened while in selection
      // mode) owns the Escape and marks it handled — don't also collapse the
      // selection out from under the agent.
      if (e.defaultPrevented) return;
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
    /** Set when the failed message carried an attachment, so the composer can
     *  warn (instead of silently sending caption-only text) if the original
     *  File is no longer in its in-memory cache — e.g. retry after a thread
     *  switch remounted the ReplyBox and dropped `pendingFilesRef`. */
    mediaKind?: MediaKind;
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
        ...(msg.media ? { mediaKind: msg.media.kind } : {}),
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
  const jumpToOriginal = useCallback(
    (originalId: string) => {
      const flash = (el: HTMLElement) => {
        // Hand scroll control off from useChatScroll first — if the user was at
        // the bottom (sticky), a later reflow (media decode, framer entrance,
        // live inbound, the 60s `now` tick) would otherwise re-snap to the
        // bottom and yank the view off the jumped-to message (reads as "jump did
        // nothing"). Mirrors scrollMatchIntoView. Sticky re-arms on the next
        // scroll-to-bottom; no manual re-enable needed.
        releaseStickToBottomRef.current();
        el.scrollIntoView({ behavior: jumpScrollBehavior(), block: "center" });
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
      };
      // If the quoted original is older than the loaded slice, page older
      // (bounded) until it renders, then scroll+flash — otherwise the click was
      // a dead no-op. Mirrors the Notes-tab jump-to-note strategy below.
      const tryScroll = (depth: number) => {
        const el = document.querySelector<HTMLElement>(
          `[data-message-id="${originalId}"]`,
        );
        if (el) {
          flash(el);
          return;
        }
        if (depth >= 8) return; // give up — the original is very deep in history
        void loadOlder().then((added) => {
          if (added > 0) window.setTimeout(() => tryScroll(depth + 1), 140);
        });
      };
      tryScroll(0);
    },
    [loadOlder],
  );

  // Jump-to-note from the contact panel's Notes tab. Notes ride the timeline
  // with data-entry-kind="note" + data-entry-id=<noteId>. Scroll + flash if
  // rendered; if the note predates the loaded window, pull older pages (bounded)
  // until it appears, then scroll. Fires via a window CustomEvent because the
  // panel + thread are siblings (mirrors the `ccp:contact-stage-delta` pattern).
  useEffect(() => {
    const onJumpNote = (e: Event) => {
      const detail = (e as CustomEvent<{ conversationId: string; noteId: string }>)
        .detail;
      if (!detail || detail.conversationId !== conversation.id) return;
      const tryScroll = (depth: number) => {
        const el = document.querySelector<HTMLElement>(
          `[data-entry-kind="note"][data-entry-id="${detail.noteId}"]`,
        );
        if (el) {
          // Instant placement (NOT smooth) to match the Files / "Go to message"
          // jump, which lands the target directly without a visible scroll
          // animation. A smooth scroll here read as inconsistent — and a long
          // smooth glide across the loaded thread is exactly what the file jump
          // avoids by re-centering on a context window. `block: "center"` keeps
          // the note mid-viewport like the other jumps.
          // Release stick-to-bottom first (see jumpToOriginal / scrollMatchIntoView)
          // — otherwise a reflow re-snaps to the bottom and the instant jump
          // reads as a no-op.
          releaseStickToBottomRef.current();
          el.scrollIntoView({ behavior: "auto", block: "center" });
          el.classList.add("ring-2", "ring-primary/60", "ring-offset-2");
          window.setTimeout(
            () => el.classList.remove("ring-2", "ring-primary/60", "ring-offset-2"),
            1500,
          );
          return;
        }
        if (depth >= 8) return; // give up — note is very deep in history
        void loadOlder().then((added) => {
          if (added > 0) window.setTimeout(() => tryScroll(depth + 1), 140);
        });
      };
      tryScroll(0);
    };
    window.addEventListener("ccp:jump-to-note", onJumpNote);
    return () => window.removeEventListener("ccp:jump-to-note", onJumpNote);
  }, [conversation.id, loadOlder]);

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
  // Reveal gate (see globals.css [data-thread-gate] + SsrThreadBottomSnap).
  //
  // The SSR pre-paint script pins the column-reverse viewport to the bottom and
  // reveals only once it has SETTLED there — but it runs ONLY on a hard SSR load
  // (inbox/page.tsx renders it behind `initialThread && !isRscRequest`). On a
  // CLIENT chat-switch it never runs, so this effect IS the landing logic, and it
  // must do the same settle-then-reveal — not just reveal on fonts.ready.
  //
  // Why it matters (the "land up, then drop to the bottom" bug): a NORMAL switch
  // is a cache HIT — `setDisplayedId` runs synchronously in the click handler, so
  // layout is final when useChatScroll's snap fires and it lands at the bottom.
  // But when new inbound arrives for a backgrounded thread, inbox-shell EVICTS
  // its snapshot, so switching back is a cache MISS: the thread mounts from an
  // ASYNC fetch `.then()`, and at that moment Chromium computes the
  // column-reverse offset against a not-yet-final height and paints scrolled to
  // the TOP. Revealing on fonts.ready (instant when cached) then exposes that
  // wrong position for a few frames before the snap drops it to the bottom.
  // Fix: re-assert scrollTop:0 each frame while the content height is still
  // changing, and reveal only once it's stable — i.e. scrollTop:0 is the TRUE
  // bottom on the first painted frame. Identical idea to the SSR script's
  // position-loop-then-reveal.
  const gateRef = useRef<HTMLDivElement>(null);
  // Armed once the thread reveals (past the initial settle), so the per-message
  // entrance animation fires for live arrivals but not the initial paint.
  const [animArmed, setAnimArmed] = useState(false);
  // Latest jump intent, read without making it an effect dep. A search-jump open
  // owns its own scroll target, so the settle loop must NOT force the bottom.
  const jumpPendingRef = useRef(jumpToMessageId != null);
  jumpPendingRef.current = jumpToMessageId != null;
  useEffect(() => {
    const gate = gateRef.current;
    if (!gate || gate.hasAttribute("data-ready")) return;
    let done = false;
    let raf = 0;
    const reveal = () => {
      if (done) return;
      done = true;
      gate.setAttribute("data-ready", "");
      setAnimArmed(true);
    };
    const startSettle = () => {
      if (done) return;
      // Search-jump open: the pendingJump effect scrolls to the match; don't
      // fight it by forcing the bottom — just reveal.
      if (jumpPendingRef.current) {
        reveal();
        return;
      }
      const vp = gate.querySelector<HTMLElement>("[data-thread-scroll-root]");
      if (!vp) {
        reveal();
        return;
      }
      // Seed the height synchronously, then re-pin scrollTop:0 each frame and
      // reveal the FIRST frame the height stops changing.
      //   - Cache-HIT switch (layout already final): next frame's height == the
      //     seed → reveal in ONE frame, so an instant switch stays instant (no
      //     extra loader blink — matches the pre-settle behavior).
      //   - Cache-MISS async mount (Chromium still finalizing the column-reverse
      //     height, which is what paints it scrolled to the top): the height
      //     keeps changing frame-to-frame, so we keep re-pinning and only reveal
      //     once it settles — i.e. scrollTop:0 is the true bottom.
      // column-reverse: scrollTop 0 IS the bottom (newest).
      vp.scrollTop = 0;
      let lastH = vp.scrollHeight;
      let frames = 0;
      const settle = () => {
        if (done) return;
        vp.scrollTop = 0;
        const h = vp.scrollHeight;
        if (h === lastH) {
          reveal();
          return;
        }
        lastH = h;
        // ~30-frame ceiling so a thread whose media never stops reflowing still
        // reveals; useChatScroll's ResizeObserver keeps pinning afterwards.
        if (++frames < 30) raf = requestAnimationFrame(settle);
        else reveal();
      };
      raf = requestAnimationFrame(settle);
    };
    // Reveal only after the web font is in (a not-yet-cached font's FOUT reflow
    // then happens while hidden), then run the settle loop.
    if (typeof document !== "undefined" && document.fonts?.ready) {
      void document.fonts.ready.then(startSettle);
    } else {
      startSettle();
    }
    // Hard cap so a stalled font / throttled rAF never leaves the thread hidden.
    const cap = window.setTimeout(reveal, 800);
    return () => {
      window.clearTimeout(cap);
      if (raf) cancelAnimationFrame(raf);
    };
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
      if (!isFind) return;
      // Don't hijack Cmd/Ctrl+F while the agent is typing — in the composer,
      // a note field, or any editable surface they expect the OS/browser
      // shortcut (or plain text entry) to work, not our in-thread search.
      const target = e.target as HTMLElement | null;
      const el =
        target ?? (document.activeElement as HTMLElement | null) ?? null;
      const isEditable =
        !!el &&
        (el.isContentEditable ||
          el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA");
      if (isEditable) return;
      e.preventDefault();
      openSearch();
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
        el.scrollIntoView({ behavior: jumpScrollBehavior(), block: "center" });
        // Pulse the landed row so the target is instantly obvious — the Files
        // "Jump" and global-search deep-link scroll without motion, so a static
        // highlight alone is easy to miss.
        flashJumpTarget(el);

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
  const lastJumpNonceRef = useRef<number | undefined>(jumpNonce);
  useEffect(() => {
    // A repeat jump to the SAME message id (re-click "Go to message" / Files
    // "Jump" / the same search hit) arrives with a NEW nonce from the shell.
    // Clear the handled-guard so we re-scroll instead of bailing on the
    // unchanged id. A messagesById rebuild keeps the nonce, so the guard still
    // holds there — which is exactly the search-bounce it's meant to prevent.
    if (jumpNonce !== lastJumpNonceRef.current) {
      lastJumpNonceRef.current = jumpNonce;
      handledMatchIdRef.current = null;
    }
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
  }, [jumpTargetId, jumpNonce, messagesById, conversation.id, replaceWithContext, scrollMatchIntoView]);

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
      //
      // `optimistic: true` so this local dispatch does NOT fire the leading
      // /events GET — that would race AHEAD of the server's audit row (written
      // after the PATCH) and return a window with no "deleted a note" pill yet,
      // making the pill lag the card. The authoritative team-room `note:deleted`
      // frame (notes.service publishes it after the row is written) drives the
      // GET instead, so the pill lands with the card. Same guard status/assign/
      // ai/contact use (see use-conversation-events ACTIVITY_REFRESH_EVENTS).
      dispatchLocalSocketEvent("note:deleted", {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        noteId,
        optimistic: true,
      });
      const res = await apiFetch(`/api/notes/${noteId}`, { method: "DELETE" });
      if (!res.ok) {
        await alert("Couldn't delete note", "Please try again.");
        // No good rollback path — the note object isn't around to re-insert
        // in order. softRefresh pulls the canonical thread back.
        softRefresh();
      }
    },
    [alert, confirm, conversation.id, conversation.workspaceId, softRefresh],
  );

  const { typingUserIds, visitorTyping, visitorPresent, visitorLeftAt, notifyTyping, stopTyping } = useTyping(
    conversation.id,
    currentUser.id,
  );

  // ── Screen-reader live region for newly-arrived inbound messages ──────────
  // A polite, visually-hidden announcer that speaks ONLY genuinely-new inbound
  // messages — never the backlog on mount, never on history pagination, never
  // on a conversation switch, never on an older context-window jump. Driven by
  // a monotonic high-water-mark on the newest inbound timestamp.
  const newestInbound = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.direction === "in") return messages[i]!;
    }
    return null;
  }, [messages]);
  const [inboundAnnouncement, setInboundAnnouncement] = useState("");
  const lastAnnouncedInboundTsRef = useRef(0);
  const lastAnnouncedInboundIdRef = useRef<string | null>(null);
  const announceNonceRef = useRef(false);
  // Seed the baseline to "newest inbound right now" on mount AND on every
  // conversation switch, so the freshly-loaded backlog is never read aloud.
  // Declared BEFORE the announce effect so it re-seeds first on a switch.
  useEffect(() => {
    lastAnnouncedInboundTsRef.current = newestInbound
      ? new Date(newestInbound.timestamp).getTime()
      : 0;
    lastAnnouncedInboundIdRef.current = newestInbound?.id ?? null;
    setInboundAnnouncement("");
    // Re-seed once per conversation, not per message — newestInbound is read
    // but intentionally NOT a dependency (that would suppress live arrivals).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);
  useEffect(() => {
    if (!newestInbound) return;
    const ts = new Date(newestInbound.timestamp).getTime();
    // WhatsApp timestamps are second-granular, so two distinct messages can
    // share a ts. Gate on (ts, id): announce anything strictly newer, OR the
    // same second but a different message id — the same `>=` + id-dedupe rule
    // the inbox-list badge uses (project_unread_replay_recency_guard). Older
    // context-window jumps (replaceWithContext) have ts < the mark → silent.
    if (ts < lastAnnouncedInboundTsRef.current) return;
    if (
      ts === lastAnnouncedInboundTsRef.current &&
      newestInbound.id === lastAnnouncedInboundIdRef.current
    )
      return;
    lastAnnouncedInboundTsRef.current = ts;
    lastAnnouncedInboundIdRef.current = newestInbound.id;
    // Toggle a trailing zero-width space so two consecutive IDENTICAL messages
    // ("ok" then "ok"; two photos → both "sent a photo") still produce a DOM
    // text DIFF — an aria-live region only announces on change, and React skips
    // re-setting identical text.
    announceNonceRef.current = !announceNonceRef.current;
    setInboundAnnouncement(
      `${contact.name}: ${inboundAnnouncementText(newestInbound)}${
        announceNonceRef.current ? "​" : ""
      }`,
    );
  }, [newestInbound, contact.name]);

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
    // Entries pinned to the very bottom regardless of their timestamp — ONLY
    // genuinely in-flight items the agent just created, whose timestamps come
    // from the CLIENT clock and can't be trusted against SERVER-clocked rows:
    //   - pending own-sends (the message I'm sending right now)
    //   - UN-reconciled optimistic activity stubs (`optimisticPending`)
    // Both carry client time; pinning them sidesteps server-clock skew so they
    // land cleanly at the end on first paint. The moment the authoritative GET
    // reconciles a stub, `mergeAuthoritativeEvents` rebuilds it from server data
    // — the flag drops, the row SETTLES, and it sorts by real server time like
    // any confirmed event. That's the fix for two bugs that came from keeping a
    // reconciled row pinned (keyed off the surviving `optimistic-…` id): a later
    // message sorting ABOVE a stuck-pinned log, and rapid changes jumping
    // mid-list→bottom as server-clocked reconciled rows tie-broke against
    // client-clocked fresh stubs. Settled rows are all server-clocked (mutually
    // consistent); pinned rows are all client-clocked (mutually consistent);
    // the boundary between the two groups is clean.
    // Earliest still-in-flight own-send (by send-order seq). A reconciled
    // own-send whose seq is >= this stays pinned to the bottom until the earlier
    // sibling also confirms — without it, an out-of-order `message:new` (send #3
    // confirming before #1/#2) un-pins #3 to its server time and flashes it
    // ABOVE the still-pending #1/#2, then snaps back when they land. Keeping it
    // pinned (and ordering the tail by seq below) holds send order throughout.
    let minPendingSeq = Number.POSITIVE_INFINITY;
    for (const m of messages) {
      if (
        m.pending === true &&
        typeof m.optimisticSeq === "number" &&
        m.optimisticSeq < minPendingSeq
      ) {
        minPendingSeq = m.optimisticSeq;
      }
    }
    const pinsToBottom = (e: TimelineEntry) =>
      (e.kind === "message" &&
        (e.data.pending === true ||
          // A FAILED own-send anchors at the bottom too — it's the message the
          // agent just tried to send, and its Retry/Dismiss row must stay at the
          // tail (not get buried under a later inbound). Matches the messages-
          // array sortKey (use-conversation-events.ts: pending||failed → ∞), so
          // the two sort layers agree. (`status==="failed"` from an OLD Meta
          // rejection is intentionally NOT pinned — it's history, sorts by time.)
          e.data.failed === true ||
          (typeof e.data.optimisticSeq === "number" &&
            e.data.optimisticSeq >= minPendingSeq))) ||
      (e.kind === "activity" &&
        (e.data.optimisticPending === true ||
          // A settled auto-pause pill keeps its seq while its triggering send is
          // still pending, so it stays pinned below the reply instead of floating
          // above it (the conversation:ai-beats-message:new race). Un-pins the
          // moment no send is in flight (minPendingSeq → ∞).
          (typeof e.data.optimisticSeq === "number" &&
            e.data.optimisticSeq >= minPendingSeq)));
    // Decorate-sort: parse each entry's timestamp ONCE here, not twice per
    // comparison. This memo rebuilds on EVERY message mutation — including a
    // status-only sent→delivered→read burst that changes no ordering — and a
    // parse inside the comparator was ~O(n log n) Date parses (~9k on a 500-row
    // thread); precomputing makes it ~n (500). Same ordering as before:
    // pinned-to-bottom group last, then ascending by time; stable sort keeps
    // same-timestamp (id-tiebroken) messages in input order.
    const decorated = [
      ...messages.map((m): TimelineEntry => ({ kind: "message", data: m })),
      ...visibleNotes.map((n): TimelineEntry => ({ kind: "note", data: n })),
      // Raw event/call objects — NO `{ ...e, timestamp }` spread — so each
      // `entry.data` keeps the stable identity of the row in `data.events` /
      // `data.calls`. The shared sort + day-separator read the time via
      // `entryTimestamp()` instead (see its doc-comment for why this kills a
      // whole class of needless pill re-renders). Calls sort by ringingAt —
      // when the user-visible event happened (the row keeps endedAt for audit).
      ...visibleEvents.map((e): TimelineEntry => ({ kind: "activity", data: e })),
      ...visibleCalls.map((c): TimelineEntry => ({ kind: "call", data: c })),
    ].map((entry) => ({
      entry,
      pin: pinsToBottom(entry),
      t: new Date(entryTimestamp(entry)).getTime(),
      // Send-order stamp for tail ordering (clock-independent). Present on
      // optimistic messages + optimistic activity pills; undefined elsewhere.
      seq:
        entry.kind === "message" || entry.kind === "activity"
          ? entry.data.optimisticSeq
          : undefined,
      // Group key (= the triggering send's clientTempId) shared by an optimistic
      // own-MESSAGE and the auto-claim pills (ai_paused + reopened +
      // self-assigned) that same send fans out. Carried across reconcile onto the
      // server rows. Set ONLY on those same-send rows; undefined everywhere else.
      // Drives the anchor sort below.
      groupId:
        entry.kind === "activity" || entry.kind === "message"
          ? entry.data.optimisticGroupId
          : undefined,
      // Stable, render-independent identity for the final sort tiebreak below.
      id: entry.data.id,
    }));
    // Anchor time per group = the `t` of the group's LOWEST-seq member, i.e. the
    // triggering send's own message bubble (the message is stamped a seq BEFORE
    // its pills). Every group member then sorts AT that one time, in send order —
    // so the auto-claim pills dock directly UNDER their reply instead of at their
    // own racy/late server audit `at`. THIS is what stops a "reopened" /
    // "self-assigned" pill floating ABOVE the reply the instant the send confirms
    // with a server/Meta timestamp (the upper-thread vibration). NARROW: only
    // same-send rows carry a groupId, so every independent log (dropdown
    // status/assign, teammate actions, stage/tag/note, all history) is anchorless
    // and keeps sorting purely by its own `at`.
    const groupAnchorT = new Map<string, number>();
    const groupAnchorSeq = new Map<string, number>();
    for (const d of decorated) {
      if (d.groupId == null || d.seq == null) continue;
      const prevSeq = groupAnchorSeq.get(d.groupId);
      if (prevSeq === undefined || d.seq < prevSeq) {
        groupAnchorSeq.set(d.groupId, d.seq);
        groupAnchorT.set(d.groupId, d.t);
      }
    }
    decorated.sort((a, b) => {
      if (a.pin !== b.pin) return a.pin ? 1 : -1;
      // Within the pinned tail, order by send-order seq (mixed client/server
      // clocks can't be compared safely here — that's the whole reason these rows
      // are pinned). Every pinnable row carries a seq today (pending/failed
      // own-sends + every optimistic stub), so the `?? MAX` is a defensive single
      // key: it keeps this branch TRANSITIVE even if a seq-less row were ever
      // pinned (a per-pair seq-vs-time mix inside one partition is the classic
      // non-transitive shape). Zero behavior change for current data.
      if (a.pin)
        return (
          (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER)
        );
      // Un-pinned: a SINGLE comparison-independent key per row → a transitive
      // total order. (A per-PAIR tiebreak that switched between seq and `at`
      // would be non-transitive the moment a groupless row's `at` landed between
      // a group's anchor time and a member's own `at`, and JS sort would then
      // render an undefined — itself flickering — order.) Key = (anchored time,
      // send-order seq): same group → identical anchor time → members fall into
      // seq order (message first, then its pills); groupless rows use their own
      // time, so all other logs are unaffected.
      const at = a.groupId != null ? groupAnchorT.get(a.groupId) ?? a.t : a.t;
      const bt = b.groupId != null ? groupAnchorT.get(b.groupId) ?? b.t : b.t;
      if (at !== bt) return at - bt;
      const seqDiff =
        (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER);
      if (seqDiff !== 0) return seqDiff;
      // FINAL stable tiebreak. Two rows with the same sort time AND no seq —
      // audit rows written in the same millisecond (a dropdown unassign + status
      // change in one gesture, a teammate's back-to-back actions, the auto-claim
      // assigned + reopened landing on the same DB clock tick) — otherwise have an
      // undefined relative order that the `/events` query (ORDER BY at DESC, no
      // tiebreak) returns inconsistently, so they FLIP on every coalesced re-sort:
      // the same-`at` flicker the upper inbox shows. Order by id (a stable server
      // id, or a stub id KEPT across reconcile) so the order is deterministic and
      // never changes between renders.
      const aid = a.id ?? "";
      const bid = b.id ?? "";
      return aid < bid ? -1 : aid > bid ? 1 : 0;
    });
    return decorated.map((d) => d.entry);
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
      const label = formatDaySeparator(entryTimestamp(entry), tz, nowRef.current);
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

  // Consecutive-message grouping. `continuationFlags[i]` is true when message
  // `i` continues a same-sender run started by message `i-1` — used to suppress
  // the repeated avatar/meta and tighten spacing. A run is broken by ANY
  // non-message row (note / activity pill / call), a day separator, a
  // direction/sender change, a >5-min gap, or an in-flight/failed predecessor
  // (those stand alone so their clock/alert status always shows). The TAIL of a
  // run (computed in render as `!continuationFlags[i+1]`) carries the shared
  // avatar + meta. Pure primitives derived from the same inputs as `dayLabels`,
  // so SSR/first-paint agree and the reveal-gate/bottom-snap are untouched.
  const continuationFlags = useMemo(() => {
    const flags = new Array<boolean>(timeline.length).fill(false);
    for (let i = 1; i < timeline.length; i++) {
      const cur = timeline[i]!;
      const prev = timeline[i - 1]!;
      if (cur.kind !== "message" || prev.kind !== "message") continue;
      if (dayLabels[i] !== null) continue; // a day separator opens a fresh group
      // A FAILED row (optimistic flag OR a server-confirmed `status ===
      // "failed"`) stands alone, on BOTH sides: it never tightens under its
      // predecessor and nothing groups under it — so its error affordance (red
      // AlertCircle + reason + Retry) is always visible.
      //
      // A merely-PENDING (in-flight) row does NOT break grouping. It still
      // groups under a same-sender predecessor like its eventual confirmed
      // form — `showMeta` (render) force-shows the "Sending…" clock for any
      // pending row independent of grouping, so the status stays visible. Were
      // pending to break grouping, a freshly-sent bubble would render as a
      // group HEAD (sender-name chip shown) for the optimistic beat, then
      // collapse into the group (chip hidden) the instant it confirmed — the
      // visible "name flashes above each consecutive own-send" glitch.
      if (prev.data.failed || prev.data.status === "failed") continue;
      if (cur.data.failed || cur.data.status === "failed") continue;
      if (cur.data.direction !== prev.data.direction) continue;
      if (cur.data.senderUserId !== prev.data.senderUserId) continue;
      // A Coexistence phone-app send (origin "business_app") and a system/
      // automation send both have senderUserId null, so the check above wouldn't
      // separate them. Break the group on an origin change so the "via WhatsApp
      // app" head-chip reliably marks the start of an echo burst (and an echo
      // never hides under a preceding silent system send).
      if ((cur.data.origin ?? "api") !== (prev.data.origin ?? "api")) continue;
      const dt =
        new Date(cur.data.timestamp).getTime() -
        new Date(prev.data.timestamp).getTime();
      if (dt > GROUP_WINDOW_MS) continue;
      // `dt < 0` (cur older than prev) normally opens a fresh group — but for a
      // pair of own-sends it's pure CLIENT↔SERVER clock skew, not real
      // out-of-order: a just-confirmed send #1 now carries a SERVER timestamp
      // while a still-pending #2 carries a CLIENT one, so `#2 - #1` can briefly
      // go negative and ungroup #2 (the name-chip flash returns for rapid
      // multi-sends). Own-sends carry a monotonic `optimisticSeq` that already
      // governs their order; trust it and skip the cross-clock lower bound when
      // both rows are own-sends (either still pending, or reconciled but keeping
      // their seq). Confirmed server rows (no seq, not pending) keep the guard.
      const bothOwnSends =
        (cur.data.pending || cur.data.optimisticSeq != null) &&
        (prev.data.pending || prev.data.optimisticSeq != null);
      if (dt < 0 && !bothOwnSends) continue;
      flags[i] = true;
    }
    return flags;
  }, [timeline, dayLabels]);

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

  const {
    unreadBelow,
    scrollToBottom,
    markBenignTailUpdate,
    releaseStickToBottom,
    isStuckToBottom,
  } = useChatScroll({
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
  isStuckToBottomRef.current = isStuckToBottom;

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
      {/* Screen-reader announcer for newly-arrived inbound messages. Mounted
          OUTSIDE the reveal gate (so gate opacity can't mute it) and starts
          empty (so SSR and first paint match — no hydration diff). Polite so it
          never interrupts an agent mid-compose. See the announce effect above. */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {inboundAnnouncement}
      </p>
      <ThreadHeader
        channel={conversation.channel ?? undefined}
        visitorPresent={visitorPresent}
        visitorLeftAt={visitorLeftAt}
        workspaceId={conversation.workspaceId}
        conversationId={conversation.id}
        contactId={contact.id}
        contactName={contact.name}
        contactAvatarUrl={contact.avatarUrl ?? null}
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
        canAssignOthers={canAssignOthers}
        currentUserId={currentUser.id}
        callChannel={conversation.channel ?? undefined}
        onInitiateCall={onInitiateCall}
        onMobileBack={onMobileBack}
        onOpenContactDetails={onOpenContactDetails}
      />

      {/* Body row sits BELOW the full-width header: the message list + composer
          on the left, the optional details panel (rightPanel) on the right.
          This is what makes the header/action bar span across both columns
          while the composer stays under the messages only. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Messages + composer column. lg:min-w keeps the thread usable when the
            details panel is open + the window is resized (the resizers also clamp
            to this at drag-time — see MIN_THREAD_WIDTH in inbox-shell). The floor
            stays at lg: ON PURPOSE — forcing it into the 768–1023 two-pane band
            would push list(min 260) + thread(560) past the viewport and clip the
            composer (every ancestor is overflow-hidden). Below lg the thread is
            flex-1 min-w-0 and shrinks gracefully. The 2xl cap + mx-auto stop the
            column (list AND composer, both max-w-6xl inside) from sprawling with
            dead gutters on very wide displays (2xl = 1536px+). */}
        <div className="relative flex min-w-0 flex-1 flex-col lg:min-w-140 2xl:mx-auto 2xl:max-w-350">

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
          <span className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-3 py-1 text-2xs text-destructive shadow-xs">
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

      {/* The scroll container IS a column-reverse viewport: scrollTop:0 = bottom
          (newest), negative = scrolled up toward older (see useChatScroll). Its
          single child is the content in normal chronological order. Native
          scrollbar (replaced the Radix ScrollArea, whose viewport wraps children
          in a non-flex box and so can't be the column-reverse container).
          NOTE: column-reverse does NOT reliably anchor at the bottom on a cold
          document load (Chromium quirk), so the bottom landing is owned by the
          parse-time script + reveal gate below, NOT native anchoring. */}
      {/* Reveal gate — keeps the SSR'd thread hidden behind a loader until the
          parse-time script (SsrThreadBottomSnap) pins it to the bottom and the
          web font settles, then fades it in (CSS in globals.css keyed on
          [data-thread-gate][data-ready]). suppressHydrationWarning: data-ready
          is set imperatively (script + the effect below), never by React's
          render, so hydration can't strip it and flash. */}
      <div
        ref={gateRef}
        data-thread-gate
        suppressHydrationWarning
        className="relative flex min-h-0 flex-1 flex-col"
      >
        <div
          ref={setViewportRef}
          // Stable hook for the parse-time position-and-reveal (SsrThreadBottomSnap):
          // column-reverse doesn't reliably anchor at the bottom on a cold
          // document load, so the inline pre-paint script pins scrollTop=0 here
          // before first paint. useChatScroll flips data-chat-scroll-ready=1 on
          // mount to hand scroll ownership back. data-thread-body is the gate's
          // fade target.
          data-thread-scroll-root
          data-thread-body
          className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto"
        >
          <div
            ref={contentRef}
            // overflow-anchor:none — useChatScroll manages scroll position
            // explicitly; the browser's own anchoring would fight it. shrink-0
            // keeps the content at its natural height in the flex column (so the
            // viewport scrolls) instead of being squeezed to fit the viewport.
            style={{ overflowAnchor: "none" }}
            // max-w-6xl: when the details panel is collapsed the thread gets
            // wide; a tighter cap left a big empty margin before the rail.
            // Bubbles are individually capped at 70% (message-bubble.tsx), so a
            // wide container fills the space cleanly without over-long lines.
            // MUST match the composer's max-width (reply-box.tsx) so messages
            // and the reply box align — a mismatch reads as a layout gap.
            className="mx-auto flex w-full max-w-6xl shrink-0 flex-col gap-2 px-6 py-6"
          >
            {/* Top sentinel — IntersectionObserver target for "load older".
                The loading indicator is rendered OUTSIDE the scroll content (a
                floating pill below) so triggering a load never changes layout. */}
            <div ref={topSentinelRef} className="h-px" />
            {!hasMoreOlder && !reachedSliceCap && timeline.length > 0 && (
              // Genuine top of history: pagination is exhausted (not the
              // in-memory slice cap above) so THIS is the first message ever.
              // A calm centered marker so the agent knows the thread starts
              // here rather than being cut off — mirrors the day-pill style.
              <div className="my-3 flex justify-center">
                <span className="rounded-full border border-border/40 bg-card px-3 py-0.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Start of conversation
                </span>
              </div>
            )}
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
            {timeline.length === 0 ? (
              // Freshly-started conversation (get-or-create reopen, or a brand
              // new thread with no socket frame yet) — render a calm empty state
              // instead of a blank void above the composer. Lives INSIDE the
              // reveal gate's body so the loader covers it on first paint and it
              // cross-fades in; the gate owns the only entrance animation. When
              // the first message:new lands, timeline.length flips and
              // TimelineRows takes over with no extra wiring.
              <div
                data-thread-empty
                className="flex min-h-[40vh] flex-col items-center justify-center gap-2 px-6 text-center"
              >
                <MessageSquareDashed
                  aria-hidden
                  className="size-9 text-muted-foreground/40"
                />
                <p className="text-sm font-medium text-muted-foreground">
                  No messages yet
                </p>
                <p className="max-w-xs text-xs text-muted-foreground/70">
                  Send the first message below to start the conversation.
                </p>
              </div>
            ) : (
              <TimelineRows
                timeline={timeline}
                dayLabels={dayLabels}
                continuationFlags={continuationFlags}
                memberById={memberById}
                contactName={contact.name}
                contactSeed={contact.id}
                searchOpen={searchOpen}
                matchedIds={matchedIds}
                searchQuery={searchQuery}
                activeMatchId={activeMatchId}
                selecting={selection.selecting}
                isSelected={selection.isSelected}
                onToggleSelect={selection.toggle}
                onReply={beginReply}
                onJumpToOriginal={jumpToOriginal}
                onForward={forwardOne}
                onStartSelect={startSelect}
                onDismissFailed={dismissFailed}
                onRetryFailed={retryFailed}
                onDeleteNote={deleteNote}
                animArmed={animArmed}
              />
            )}
          </div>
        </div>
        {/* Loader shown until the gate reveals (fades out via CSS on data-ready).
            aria-hidden — the thread content is in the SSR DOM for AT already;
            this is purely the visual "landing" cover. */}
        <div
          data-thread-loader
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background"
        >
          <Loader2 className="size-5 animate-spin text-muted-foreground/40" />
        </div>
      </div>

      {/* Older-messages spinner — floats over the top of the thread, never in
          the scroll flow, so loading a page doesn't nudge the view at all.
          Anchored near the top of the (header-less) left column. */}
      <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center pt-2">
        <AnimatePresence>
          {loadingOlder && (
            <motion.span
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15 }}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-2xs text-muted-foreground shadow-xs"
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
                  className="pointer-events-auto inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background shadow-lg ring-1 ring-border/40 transition-colors hover:bg-foreground/90"
                >
                  <ArrowDown className="size-3.5" aria-hidden />
                  {unreadBelow} new {unreadBelow === 1 ? "message" : "messages"}
                </motion.button>
              )}
            </AnimatePresence>
          </div>
          <TypingIndicator
            typingUserIds={typingUserIds}
            memberById={memberById}
            visitorTyping={visitorTyping}
            visitorName={contact.name}
          />
          <AiSuggestionBar conversationId={conversation.id} />
          <ReplyBox
            conversationId={conversation.id}
            currentUser={currentUser}
            contact={contact}
            channel={conversation.channel ?? "whatsapp"}
            stageCatalog={stageCatalog}
            tags={tags}
            fieldDefinitions={fieldDefinitions}
            lastInboundAt={lastInboundAt}
            aiEnabled={conversation.aiEnabled ?? true}
            aiAutopilotEnabled={aiAutopilotEnabled}
            status={conversation.status}
            assignedUserId={assignedUser?.id ?? null}
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
        </div>
        {/* Details panel (+ its own resize handle) — sits under the header,
            to the right of the messages/composer column. */}
        {rightPanel}
      </div>

      {/* Gated render (like MessageSearch below) so next/dynamic only fetches
          the chunk when forward is actually opened — rendering it
          unconditionally with open={false} triggered the chunk request on
          every thread mount. `forwardIds` is frozen before `forwardOpen`
          flips, so no state is lost. */}
      {forwardOpen && (
        <ForwardDialog
          open
          messageIds={forwardIds}
          onClose={closeForward}
          onError={onForwardError}
        />
      )}
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
