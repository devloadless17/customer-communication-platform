"use client";

import { memo } from "react";
import { Check, Paperclip } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { avatarGradient } from "@ccp/shared/utils/avatar-color";
import { cn, initials } from "@ccp/shared/utils";
import type { Message } from "@ccp/shared/types";
import { highlightQuery } from "./message-search";

import { BubbleActions, FailedRecovery } from "./message-bubble/bubble-actions";
import { BubbleMeta } from "./message-bubble/bubble-meta";
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
}: MessageBubbleProps) {
  const isOut = message.direction === "out";
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
          <Avatar className="size-7 shrink-0 self-end">
            <AvatarFallback
              className="text-[10px] text-white"
              style={{ backgroundImage: avatarGradient(contactSeed) }}
            >
              {initials(contactName)}
            </AvatarFallback>
          </Avatar>
        )}
        <div className={cn("flex flex-col gap-0.5", isOut ? "items-end" : "items-start")}>
          <StickerImage url={media.url} />
          <BubbleMeta
          message={message}
          senderName={senderName}
          senderAvatarUrl={senderAvatarUrl ?? null}
          isOut={isOut}
        />
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
        <Avatar className="size-7 shrink-0 self-end">
          <AvatarFallback
            className="text-[10px] text-white"
            style={{ backgroundImage: avatarGradient(contactSeed) }}
          >
            {initials(contactName)}
          </AvatarFallback>
        </Avatar>
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

      <div
        className={cn(
          "flex max-w-[70%] flex-col gap-0.5",
          isOut ? "items-end" : "items-start",
        )}
      >
        <div
          className={cn(
            "overflow-hidden rounded-2xl text-sm leading-relaxed shadow-xs ring-1 transition-[box-shadow,background-color]",
            // Reduce horizontal padding when the leading element is a media
            // block — they look better edge-to-edge inside the bubble.
            media || reply ? "p-1" : "px-3.5 py-2",
            // Failed bubble: red ring so the eye snaps to it. Pending no
            // longer dims — the clock icon in the meta row conveys "in
            // flight" without making the bubble look unfinished, so a fast
            // send feels instant rather than slightly-loading.
            message.failed && "opacity-80 ring-destructive/60",
            isOut
              ? "rounded-br-xs bg-outbound-bg text-outbound-fg ring-transparent"
              : "rounded-bl-xs bg-inbound-bg text-inbound-fg ring-border",
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
            <p className="flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] italic text-muted-foreground">
              <Paperclip className="size-3.5 shrink-0" />
              Attachment unavailable
            </p>
          )}
        </div>

        <BubbleMeta
          message={message}
          senderName={senderName}
          senderAvatarUrl={senderAvatarUrl ?? null}
          isOut={isOut}
        />
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
      </div>

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
