"use client";

import { CornerUpLeft, X } from "lucide-react";

import type { ReplySnapshot } from "@/lib/types";

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
    <div className="flex items-stretch gap-2 px-3 py-2">
      <CornerUpLeft className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-muted-foreground">
          Replying to <span className="font-medium text-foreground">{senderLabel}</span>
        </div>
        <div className="truncate text-[12px] text-muted-foreground">{bodyLabel}</div>
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="self-start rounded p-1 text-muted-foreground hover:text-foreground"
        title="Cancel reply"
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
