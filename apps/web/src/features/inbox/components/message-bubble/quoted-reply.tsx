"use client";

import { cn } from "@ccp/shared/utils";
import type { ReplySnapshot } from "@ccp/shared/types";

import { highlightQuery } from "../message-search";

export function QuotedReply({
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
          "w-1 shrink-0 rounded-full",
          isOut ? "bg-white/70" : "bg-primary",
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-2xs font-medium opacity-90">
          {senderLabel}
        </span>
        <span dir="auto" className="block truncate text-2xs opacity-75">
          {bodyLabel}
        </span>
      </span>
      {reply.thumbnailUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- authenticated
        // media stream, not a static asset; next/image can't carry the cookie.
        <img
          src={reply.thumbnailUrl}
          alt=""
          className="size-8 shrink-0 self-center rounded object-cover"
        />
      )}
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
