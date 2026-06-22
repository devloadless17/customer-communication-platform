"use client";

import { CornerUpLeft, X } from "lucide-react";

import type { ReplySnapshot } from "@ccp/shared/types";

export function ReplyTargetPill({
  reply,
  contactName,
  onCancel,
}: {
  reply: ReplySnapshot;
  contactName: string;
  onCancel: () => void;
}) {
  const senderLabel =
    reply.direction === "out"
      ? reply.senderName
        ? `@${reply.senderName}`
        : "yourself"
      : contactName;
  const bodyLabel = reply.body || replyMediaLabel(reply.mediaKind) || "Message";

  return (
    <div className="flex items-stretch gap-2.5 px-3 py-2">
      <CornerUpLeft className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-2xs text-muted-foreground">
          Replying to <span className="font-medium text-foreground">{senderLabel}</span>
        </div>
        <div className="truncate text-xs text-muted-foreground">{bodyLabel}</div>
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="self-start rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:outline-none"
        title="Cancel reply"
        aria-label="Cancel reply"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function replyMediaLabel(kind: ReplySnapshot["mediaKind"]): string {
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
