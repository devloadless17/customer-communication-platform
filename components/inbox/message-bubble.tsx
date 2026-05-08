"use client";

import { useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCheck,
  Clock,
  CornerUpLeft,
  Download,
  FileText,
  X,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { avatarGradient } from "@/lib/avatar-color";
import { cn, formatMessageTime, initials } from "@/lib/utils";
import type {
  MediaAttachment,
  Message,
  ReplySnapshot,
  User,
} from "@/lib/types";

export function MessageBubble({
  message,
  sender,
  contactName,
  contactSeed,
  onReply,
  onJumpToOriginal,
}: {
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
}) {
  const isOut = message.direction === "out";
  const media = message.media;
  const reply = message.replyTo ?? null;
  // Don't offer Reply on optimistic rows — the wamid isn't real yet, so Meta
  // would reject `context.message_id` if the user clicked through fast.
  const canReply = Boolean(onReply) && !message.pending && !message.failed;

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
      {canReply && isOut && (
        <ReplyAction onClick={() => onReply!(message)} />
      )}

      <div
        className={cn(
          "flex max-w-[70%] flex-col gap-0.5",
          isOut ? "items-end" : "items-start",
        )}
      >
        <div
          className={cn(
            "overflow-hidden rounded-2xl text-sm leading-relaxed shadow-xs ring-1 transition-colors",
            // Reduce horizontal padding when the leading element is a media
            // block — they look better edge-to-edge inside the bubble.
            media || reply ? "p-1" : "px-3.5 py-2",
            // Optimistic bubble: subtle dim so the user reads it as "in flight".
            message.pending && "opacity-70",
            isOut
              ? "rounded-br-sm bg-outbound-bg text-outbound-fg ring-transparent"
              : "rounded-bl-sm bg-inbound-bg text-inbound-fg ring-border",
          )}
        >
          {reply && (
            <QuotedReply
              reply={reply}
              isOut={isOut}
              contactName={contactName}
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
              {message.body}
            </p>
          )}
        </div>

        <BubbleMeta message={message} sender={sender} isOut={isOut} />
      </div>

      {canReply && !isOut && (
        <ReplyAction onClick={() => onReply!(message)} />
      )}
    </div>
  );
}

function ReplyAction({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onClick}
      title="Reply to this message"
      className="size-7 self-center text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus:opacity-100"
    >
      <CornerUpLeft className="size-3.5" />
    </Button>
  );
}

function QuotedReply({
  reply,
  isOut,
  contactName,
  onClick,
}: {
  reply: ReplySnapshot;
  isOut: boolean;
  contactName: string;
  onClick?: () => void;
}) {
  const senderLabel =
    reply.direction === "out"
      ? reply.senderName
        ? `@${reply.senderName.split(" ")[0]}`
        : "You"
      : contactName;
  const bodyLabel = reply.body || mediaLabel(reply.mediaKind) || "Message";

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
          <span>via @{sender.name.split(" ")[0]?.toLowerCase()}</span>
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
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
      onClick={onClose}
      role="dialog"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt="full size"
        className="max-h-[90vh] max-w-[90vw] object-contain"
        onClick={(e) => e.stopPropagation()}
      />
      <button
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
