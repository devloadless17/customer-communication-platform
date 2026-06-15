"use client";

import { memo } from "react";
import { motion } from "framer-motion";
import { Check, Paperclip } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { avatarGradient } from "@ccp/shared/utils/avatar-color";
import { cn, initials } from "@ccp/shared/utils";
import type { Message } from "@ccp/shared/types";
import { highlightQuery } from "./message-search";

import { BubbleActions, FailedRecovery } from "./message-bubble/bubble-actions";
import { BubbleMeta, SenderChip } from "./message-bubble/bubble-meta";
import { MediaBlock, StickerImage } from "./message-bubble/media-blocks";
import { QuotedReply } from "./message-bubble/quoted-reply";

interface MessageBubbleProps {
  message: Message;
  /**
   * Primitive sender name (null on inbound, null when the authoring user has
   * been hard-deleted). Passing the User object directly forced React.memo
   * to re-render every bubble whenever the team-members Map identity changed
   * (e.g. a teammate's presence flip). Primitive prop = stable shallow-equal.
   */
  senderName: string | null;
  /** Sender avatar URL. Same primitive-prop discipline as senderName. */
  senderAvatarUrl?: string | null;
  contactName: string;
  /** Stable id to derive a consistent gradient color for the contact. */
  contactSeed: string;
  /** Stash this message as the active reply target in the composer. */
  onReply?: (message: Message) => void;
  /** Scroll to the quoted original (no-op when the original is unknown). */
  onJumpToOriginal?: (originalId: string) => void;
  /** Queue this message for forwarding (opens the contact picker). */
  onForward?: (message: Message) => void;
  /** Enter multi-select mode with this message pre-checked. */
  onStartSelect?: (message: Message) => void;
  /** Drop a failed optimistic bubble from the thread. */
  onDismissFailed?: (message: Message) => void;
  /** Drop the failed bubble + put its body back in the composer to retry. */
  onRetryFailed?: (message: Message) => void;
  // ----- multi-select mode (driven by the thread) -----
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: (messageId: string) => void;
  // ----- search highlighting (driven by the thread) -----
  /** Active query — every occurrence inside the body gets a yellow `<mark>`.
   *  Empty/undefined disables highlighting. */
  searchQuery?: string;
  /** True when this bubble is the currently-selected search match. Renders
   *  a persistent yellow ring around the bubble so the user can find it
   *  visually after scrollIntoView lands. */
  isActiveSearchMatch?: boolean;
  // ----- consecutive-message grouping (driven by the thread) -----
  /**
   * Last bubble of a same-sender group. The TAIL carries the shared chrome:
   * the inbound avatar (bottom-aligned to the group, WhatsApp-style) and the
   * meta row (timestamp / sender / ticks). Earlier bubbles in the group render
   * an equal-width avatar spacer and no meta, so a burst reads as one cluster.
   * Defaults to true → a lone/ungrouped message looks exactly as before.
   */
  showAvatar?: boolean;
  /** See `showAvatar`. When false the meta row is omitted (a non-tail bubble in
   *  a group). Pending/failed rows always pass true so their status never hides. */
  showMeta?: boolean;
  /**
   * Last bubble of a same-sender group. Only the TAIL gets the flat "tail"
   * corner (`rounded-br-xs` / `rounded-bl-xs`); earlier continuation bubbles
   * keep all four corners fully rounded so a burst reads as one stacked unit
   * instead of N independently-tailed bubbles. Defaults to true → a lone /
   * ungrouped message keeps the tail exactly as before.
   */
  isTail?: boolean;
  /** First bubble of a same-sender OUTBOUND group. When true (and there's a
   *  senderName), a small "which teammate" chip renders ABOVE the bubble —
   *  attribution at the head of a burst, not buried under its last bubble. */
  showSenderHeader?: boolean;
  /** Fade+scale the bubble in on mount — ONLY for genuinely-new live messages
   *  (TimelineRows gates it; false on initial load / load-older / refetch).
   *  Transform + opacity only, so it never perturbs the column-reverse scroll. */
  animateIn?: boolean;
}

/**
 * One row in the message timeline.
 *
 * Normal mode: a chat bubble with hover actions (quick reply + a ⋯ menu with
 * Forward / Select messages).
 *
 * Selection mode: the whole row becomes a checkbox toggle; the bubble is
 * rendered read-only. Pending/failed rows can't be forwarded (no real wamid
 * yet) so they show disabled and aren't selectable.
 *
 * Wrapped in `React.memo` at the bottom of this file. Every `message:new`
 * socket event triggers a parent re-render where the messages array gets a
 * new identity but the individual row objects don't (the touched row is the
 * only one with a new ref). Default shallow comparison + useCallback-stable
 * action handlers + primitive flags means React skips re-rendering ~all
 * rows except the one that actually changed. Without memo, every inbound /
 * status update / selection toggle / search keystroke re-rendered every
 * visible bubble — the dominant perf hit on busy threads.
 */
function MessageBubbleImpl(props: MessageBubbleProps) {
  const { message, selecting, selected, onToggleSelect } = props;

  if (selecting) {
    const selectable = !message.pending && !message.failed;
    const toggle = () => {
      if (selectable) onToggleSelect?.(message.id);
    };
    return (
      <div
        role={selectable ? "button" : undefined}
        aria-pressed={selectable ? Boolean(selected) : undefined}
        aria-disabled={selectable ? undefined : true}
        tabIndex={selectable ? 0 : -1}
        onClick={toggle}
        onKeyDown={(e) => {
          if (selectable && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            toggle();
          }
        }}
        className={cn(
          "flex w-full items-center gap-3 rounded-xl px-2 py-1 transition-colors",
          selectable
            ? "cursor-pointer hover:bg-accent/40"
            : "cursor-not-allowed opacity-50",
          selected && "bg-primary/10 ring-1 ring-primary/30",
        )}
      >
        <SelectCheckbox checked={Boolean(selected)} disabled={!selectable} />
        {/* Read-only while selecting — swallow clicks/hover on the bubble. */}
        <div className="pointer-events-none min-w-0 flex-1">
          <BubbleContent {...props} />
        </div>
      </div>
    );
  }

  return <BubbleContent {...props} />;
}

function BubbleContent({
  message,
  senderName,
  senderAvatarUrl,
  contactName,
  contactSeed,
  onReply,
  onJumpToOriginal,
  onForward,
  onStartSelect,
  onDismissFailed,
  onRetryFailed,
  searchQuery,
  isActiveSearchMatch,
  showAvatar = true,
  showMeta = true,
  isTail = true,
  showSenderHeader = false,
  animateIn = false,
}: MessageBubbleProps) {
  const isOut = message.direction === "out";
  // Attribution chip at the head of an outbound burst (shared-inbox: "which
  // teammate sent this"). Outbound + group-head + we know the sender.
  const senderHeader =
    showSenderHeader && message.direction === "out" && senderName ? (
      <span className="px-1 pb-0.5 text-2xs font-medium text-muted-foreground">
        <SenderChip name={senderName} avatarUrl={senderAvatarUrl ?? null} />
      </span>
    ) : null;
  const media = message.media;
  const reply = message.replyTo ?? null;
  // Don't offer Reply/Forward/Select on optimistic rows — the wamid isn't real
  // yet, so Meta would reject `context.message_id`, and there's nothing to
  // forward until the send lands.
  const live = !message.pending && !message.failed;
  const canReply = Boolean(onReply) && live;
  const canForward = Boolean(onForward) && live;
  const canSelect = Boolean(onStartSelect) && live;

  // Stickers stand alone — no bubble chrome, just the image. Rendered
  // outside the standard bubble path because the visual treatment differs.
  if (media?.kind === "sticker") {
    return (
      <div className={cn("flex w-full gap-2", isOut ? "justify-end" : "justify-start")}>
        {!isOut && (
          <InboundAvatarSlot
            show={showAvatar}
            contactName={contactName}
            contactSeed={contactSeed}
          />
        )}
        <div className={cn("flex flex-col gap-0.5", isOut ? "items-end" : "items-start")}>
          {senderHeader}
          <StickerImage url={media.url} />
          {showMeta && <BubbleMeta message={message} isOut={isOut} />}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group flex w-full gap-2",
        isOut ? "justify-end" : "justify-start",
      )}
    >
      {!isOut && (
        <InboundAvatarSlot
          show={showAvatar}
          contactName={contactName}
          contactSeed={contactSeed}
        />
      )}

      {/* Reply action sits next to the bubble; visible only on hover so it
          doesn't clutter the timeline. Order swaps so it's always on the
          opposite side of the avatar. */}
      {isOut && (
        <BubbleActions
          message={message}
          canReply={canReply}
          canForward={canForward}
          canSelect={canSelect}
          onReply={onReply}
          onForward={onForward}
          onStartSelect={onStartSelect}
        />
      )}

      <motion.div
        className={cn(
          "flex max-w-[70%] flex-col gap-0.5",
          isOut ? "items-end" : "items-start",
        )}
        // Entrance for genuinely-new live messages. Transform + opacity ONLY
        // (no height/margin), so the column-reverse stick-to-bottom
        // ResizeObserver never sees a layout change — the scroll stays pinned.
        // initial={false} renders straight at the final state with no animation
        // (initial load, load-older, reconnect-refetch). Scales up from the
        // bubble's bottom corner so it grows into place.
        initial={animateIn ? { opacity: 0, scale: 0.96 } : false}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        style={{ transformOrigin: isOut ? "right bottom" : "left bottom" }}
      >
        {senderHeader}
        <div
          className={cn(
            "overflow-hidden rounded-2xl text-sm leading-snug shadow-xs ring-1 transition-[box-shadow,background-color]",
            // Reduce horizontal padding when the leading element is a media
            // block — they look better edge-to-edge inside the bubble.
            media || reply ? "p-1" : "px-3.5 py-2",
            // Failed bubble: red ring so the eye snaps to it. Pending no
            // longer dims — the clock icon in the meta row conveys "in
            // flight" without making the bubble look unfinished, so a fast
            // send feels instant rather than slightly-loading.
            message.failed && "opacity-80 ring-destructive/60",
            isOut
              ? "bg-outbound-bg text-outbound-fg ring-transparent"
              : "bg-inbound-bg text-inbound-fg ring-border",
            // Flat tail corner ONLY on the group's last bubble; continuation
            // bubbles keep all four corners rounded so a stack reads as one
            // unit. (`rounded-2xl` above already rounds every corner.)
            isTail && (isOut ? "rounded-br-xs" : "rounded-bl-xs"),
            // Active search match — a soft neutral ring that stays for as
            // long as the bubble is the selected match. Uses the
            // foreground color at low opacity so it adapts to light/dark
            // mode (a subtle dark wash in light, a subtle light wash in
            // dark) without competing with the bubble's own color.
            isActiveSearchMatch &&
              "ring-2 ring-foreground/30 ring-offset-2 ring-offset-background",
          )}
        >
          {reply && (
            <QuotedReply
              reply={reply}
              isOut={isOut}
              contactName={contactName}
              searchQuery={searchQuery}
              onClick={
                onJumpToOriginal ? () => onJumpToOriginal(reply.id) : undefined
              }
            />
          )}
          {media && (
            <MediaBlock
              media={media}
              message={message}
              isOut={isOut}
              pending={message.mediaPending}
            />
          )}
          {message.body && (
            <p
              // dir="auto" derives base direction from the first strong
              // character so Arabic/Hebrew messages right-align with correct
              // punctuation placement (WhatsApp Web behavior). Latin stays LTR.
              dir="auto"
              className={cn(
                "whitespace-pre-wrap wrap-break-word",
                media || reply ? "px-2.5 pb-1.5 pt-2" : "",
              )}
            >
              {searchQuery && searchQuery.trim().length > 0
                ? highlightQuery(message.body, searchQuery)
                : message.body}
            </p>
          )}
          {/* Failed inbound media. A photo/voice/doc whose download from Meta
              failed after retries has its media columns stripped and (when there
              was no caption) an EMPTY body — which rendered as a blank bubble.
              The Meta parser never creates an empty-body, no-media INBOUND any
              other way (text/interactive/reaction without content are skipped),
              so this is unambiguously "an attachment we couldn't download".
              Client-only + derived, so it's consistent live AND on reload with
              no schema/event change. */}
          {!isOut && !media && !message.mediaPending && !message.body && (
            <p className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm italic text-muted-foreground">
              <Paperclip className="size-3.5 shrink-0" />
              Attachment unavailable
            </p>
          )}
        </div>

        {message.reaction && (
          // Customer's emoji reaction, tucked over the bubble's bottom edge
          // (WhatsApp-style). Side-aligned by the column's items-end/start.
          // A genuine content change (arrives live, after the message), so the
          // small reflow it causes is fine — the stick-to-bottom observer keeps
          // the thread pinned, same as any new content.
          <span
            className={cn(
              "relative z-10 -mt-1.5 inline-flex items-center rounded-full border border-border bg-card px-1.5 py-px text-xs leading-none shadow-xs",
              isOut ? "mr-1.5" : "ml-1.5",
            )}
            aria-label={`Customer reacted ${message.reaction}`}
            title={`Customer reacted ${message.reaction}`}
          >
            {message.reaction}
          </span>
        )}

        {showMeta && <BubbleMeta message={message} isOut={isOut} />}
        {message.failed && (
          <FailedRecovery
            // Both text and media retries are supported. The composer caches
            // the File for each in-flight media send keyed by clientTempId,
            // so Retry pops it back into the attachment preview without
            // forcing a re-pick from disk. See pendingFilesRef in reply-box.
            canRetry={Boolean(onRetryFailed)}
            onRetry={onRetryFailed ? () => onRetryFailed(message) : undefined}
            onDismiss={onDismissFailed ? () => onDismissFailed(message) : undefined}
          />
        )}
      </motion.div>

      {!isOut && (
        <BubbleActions
          message={message}
          canReply={canReply}
          canForward={canForward}
          canSelect={canSelect}
          onReply={onReply}
          onForward={onForward}
          onStartSelect={onStartSelect}
        />
      )}
    </div>
  );
}

/**
 * Inbound avatar column. Renders the contact avatar on the group TAIL
 * (`show`), or an equal-width spacer on earlier bubbles of a consecutive
 * group, so a same-sender burst keeps its left edge aligned under a single
 * bottom-anchored avatar (WhatsApp-style) instead of repeating it per bubble.
 */
function InboundAvatarSlot({
  show,
  contactName,
  contactSeed,
}: {
  show: boolean;
  contactName: string;
  contactSeed: string;
}) {
  if (!show) return <div className="size-7 shrink-0" aria-hidden />;
  return (
    <Avatar className="size-7 shrink-0 self-end">
      <AvatarFallback
        className="text-3xs text-white"
        style={{ backgroundImage: avatarGradient(contactSeed) }}
      >
        {initials(contactName)}
      </AvatarFallback>
    </Avatar>
  );
}

function SelectCheckbox({
  checked,
  disabled,
}: {
  checked: boolean;
  disabled?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
        disabled
          ? "border-muted-foreground/30"
          : checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/50",
      )}
    >
      {checked && <Check className="size-3" />}
    </span>
  );
}

export const MessageBubble = memo(MessageBubbleImpl);
