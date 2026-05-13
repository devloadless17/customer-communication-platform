"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCheck,
  Clock,
  CornerUpLeft,
  Download,
  FileText,
  Forward,
  ListChecks,
  MoreHorizontal,
  X,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { avatarGradient } from "@/lib/avatar-color";
import { cn, formatMessageTime, initials } from "@/lib/utils";
import type {
  MediaAttachment,
  Message,
  ReplySnapshot,
  User,
} from "@/lib/types";
import { highlightQuery } from "./message-search";

interface MessageBubbleProps {
  message: Message;
  /** null on inbound — only outbound has an authoring agent. */
  sender: User | null;
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
 */
export function MessageBubble(props: MessageBubbleProps) {
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
  sender,
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
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={media.url}
            alt="sticker"
            className="size-32 rounded-md object-contain"
          />
          <BubbleMeta message={message} sender={sender} isOut={isOut} />
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
              ? "rounded-br-sm bg-outbound-bg text-outbound-fg ring-transparent"
              : "rounded-bl-sm bg-inbound-bg text-inbound-fg ring-border",
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
          {media && <MediaBlock media={media} isOut={isOut} />}
          {message.body && (
            <p
              className={cn(
                "whitespace-pre-wrap break-words",
                media || reply ? "px-2.5 pb-1.5 pt-2" : "",
              )}
            >
              {searchQuery && searchQuery.trim().length > 0
                ? highlightQuery(message.body, searchQuery)
                : message.body}
            </p>
          )}
        </div>

        <BubbleMeta message={message} sender={sender} isOut={isOut} />
        {message.failed && (
          <FailedRecovery
            // Media retries would need the original File object back; we don't
            // keep one once the bubble is in the timeline. Text retries always
            // work — fall back to dismiss-only for media bubbles.
            canRetry={!message.media && Boolean(onRetryFailed)}
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

function BubbleActions({
  message,
  canReply,
  canForward,
  canSelect,
  onReply,
  onForward,
  onStartSelect,
}: {
  message: Message;
  canReply: boolean;
  canForward: boolean;
  canSelect: boolean;
  onReply?: (message: Message) => void;
  onForward?: (message: Message) => void;
  onStartSelect?: (message: Message) => void;
}) {
  const hasMenu = (canForward && Boolean(onForward)) || (canSelect && Boolean(onStartSelect));
  if (!(canReply && onReply) && !hasMenu) return null;
  return (
    <div className="flex items-center gap-0.5 self-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      {canReply && onReply && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => onReply(message)}
          title="Reply to this message"
          aria-label="Reply to this message"
          className="size-7 text-muted-foreground hover:text-foreground"
        >
          <CornerUpLeft className="size-3.5" />
        </Button>
      )}
      {hasMenu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="More actions"
              aria-label="More actions"
              className="size-7 text-muted-foreground hover:text-foreground"
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {canForward && onForward && (
              <DropdownMenuItem onSelect={() => onForward(message)}>
                <Forward className="size-3.5" />
                Forward
              </DropdownMenuItem>
            )}
            {canSelect && onStartSelect && (
              <DropdownMenuItem onSelect={() => onStartSelect(message)}>
                <ListChecks className="size-3.5" />
                Select messages
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function FailedRecovery({
  canRetry,
  onRetry,
  onDismiss,
}: {
  canRetry: boolean;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <div className="mt-1 flex items-center gap-2 text-[10px] text-destructive">
      <AlertCircle className="size-3" />
      <span>Send failed</span>
      {canRetry && onRetry && (
        <>
          <span className="text-muted-foreground/50">·</span>
          <button
            type="button"
            onClick={onRetry}
            className="font-medium hover:underline"
          >
            Retry
          </button>
        </>
      )}
      {onDismiss && (
        <>
          <span className="text-muted-foreground/50">·</span>
          <button
            type="button"
            onClick={onDismiss}
            className="text-muted-foreground hover:text-foreground hover:underline"
          >
            Dismiss
          </button>
        </>
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

function QuotedReply({
  reply,
  isOut,
  contactName,
  searchQuery,
  onClick,
}: {
  reply: ReplySnapshot;
  isOut: boolean;
  contactName: string;
  searchQuery?: string;
  onClick?: () => void;
}) {
  const senderLabel =
    reply.direction === "out"
      ? reply.senderName
        ? `@${reply.senderName}`
        : "You"
      : contactName;
  const rawBody = reply.body || mediaLabel(reply.mediaKind) || "Message";
  const bodyLabel =
    searchQuery && searchQuery.trim().length > 0
      ? highlightQuery(rawBody, searchQuery)
      : rawBody;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        "flex w-full items-stretch gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors",
        // Tinted background that reads as a quote against either bubble.
        isOut ? "bg-white/15 hover:bg-white/20" : "bg-background/60 hover:bg-background/80",
        !onClick && "cursor-default",
      )}
    >
      <span
        className={cn(
          "w-0.5 shrink-0 rounded-full",
          isOut ? "bg-white/70" : "bg-primary",
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-medium opacity-90">
          {senderLabel}
        </span>
        <span className="block truncate text-[12px] opacity-75">
          {bodyLabel}
        </span>
      </span>
    </button>
  );
}

function mediaLabel(kind: ReplySnapshot["mediaKind"]): string {
  switch (kind) {
    case "image":
      return "📷 Photo";
    case "video":
      return "🎥 Video";
    case "audio":
      return "🎤 Voice message";
    case "document":
      return "📄 Document";
    case "sticker":
      return "🌟 Sticker";
    default:
      return "";
  }
}

function BubbleMeta({
  message,
  sender,
  isOut,
}: {
  message: Message;
  sender: User | null;
  isOut: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground",
        isOut ? "flex-row-reverse" : "flex-row",
      )}
    >
      <span suppressHydrationWarning>{formatMessageTime(message.timestamp)}</span>
      {isOut && sender && (
        <>
          <span className="opacity-50">·</span>
          <span>via @{sender.name}</span>
        </>
      )}
      {isOut && <StatusTicks message={message} />}
    </div>
  );
}

function MediaBlock({ media, isOut }: { media: MediaAttachment; isOut: boolean }) {
  switch (media.kind) {
    case "image":
      return <ImageBlock media={media} />;
    case "video":
      return <VideoBlock media={media} />;
    case "audio":
      return <AudioBlock media={media} isOut={isOut} />;
    case "document":
      return <DocumentBlock media={media} isOut={isOut} />;
    case "sticker":
      // Handled by the early return up top; defensive default.
      return null;
  }
}

function ImageBlock({ media }: { media: MediaAttachment }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-full overflow-hidden rounded-xl"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={media.url}
          alt={media.caption ?? "image"}
          className="max-h-[360px] w-full object-cover transition-opacity hover:opacity-95"
          loading="lazy"
        />
      </button>
      {open && <Lightbox url={media.url} onClose={() => setOpen(false)} />}
    </>
  );
}

function VideoBlock({ media }: { media: MediaAttachment }) {
  return (
    <video
      src={media.url}
      controls
      preload="metadata"
      className="block max-h-[360px] w-full rounded-xl bg-black"
    />
  );
}

function AudioBlock({ media, isOut }: { media: MediaAttachment; isOut: boolean }) {
  return (
    <div className={cn("flex items-center gap-2 rounded-xl px-2.5 py-2")}>
      {/* Native player — keeps it dependency-free. The container sets a
          sensible width via flex so the bubble doesn't blow out. */}
      <audio
        src={media.url}
        controls
        preload="metadata"
        className={cn(
          "h-9 max-w-[260px] flex-1",
          isOut ? "[&::-webkit-media-controls-panel]:bg-white/10" : "",
        )}
      />
      {media.durationMs != null && (
        <span className="shrink-0 text-[10px] opacity-70">
          {formatDuration(media.durationMs)}
        </span>
      )}
    </div>
  );
}

function DocumentBlock({ media, isOut }: { media: MediaAttachment; isOut: boolean }) {
  return (
    <a
      href={media.url}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors",
        isOut
          ? "bg-white/10 hover:bg-white/15"
          : "bg-background/60 hover:bg-background",
      )}
    >
      <div
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-md",
          isOut ? "bg-white/15" : "bg-muted",
        )}
      >
        <FileText className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium">
          {media.filename ?? "Document"}
        </div>
        <div className={cn("text-[10px] opacity-70")}>
          {formatBytes(media.sizeBytes)}
        </div>
      </div>
      <Download className={cn("size-4 shrink-0 opacity-70")} />
    </a>
  );
}

function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    lastFocusedRef.current = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      lastFocusedRef.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt="full size"
        className="max-h-[90vh] max-w-[90vw] object-contain"
        onClick={(e) => e.stopPropagation()}
      />
      <button
        ref={closeBtnRef}
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
        aria-label="Close"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

function StatusTicks({ message }: { message: Message }) {
  if (message.failed) {
    return <AlertCircle className="size-3 text-destructive" aria-label="Failed to send" />;
  }
  if (message.pending) {
    return <Clock className="size-3 opacity-60" aria-label="Sending…" />;
  }
  switch (message.status) {
    case "failed":
      return <AlertCircle className="size-3 text-destructive" aria-label="Failed to send" />;
    case "sent":
      return <Check className="size-3 opacity-70" aria-label="Sent" />;
    case "delivered":
      return <CheckCheck className="size-3 opacity-70" aria-label="Delivered" />;
    case "read":
      return <CheckCheck className="size-3 text-primary" aria-label="Read" />;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
