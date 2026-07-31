"use client";

import { Paperclip, X } from "lucide-react";

import { cn } from "@ccp/shared/utils";
import type { TicketAttachment } from "@ccp/shared/tickets/types";

/**
 * One attachment, everywhere a ticket shows a file: the Files section, a thread
 * message, or a log entry that carried one.
 *
 * Lifted out of `ticket-detail-client.tsx` when the thread arrived — the third
 * caller is the point at which a copy would start drifting.
 */

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Images render inline in the thread; everything else is a row. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function TicketAttachmentRow({
  attachment,
  busy,
  onRemove,
  /** Show images as a thumbnail — a screenshot is evidence you read at a
   *  glance, and a filename row makes you click to find that out. */
  preview = false,
}: {
  attachment: TicketAttachment;
  busy: boolean;
  onRemove?: () => void;
  preview?: boolean;
}) {
  const isImage = preview && IMAGE_TYPES.has(attachment.mimeType);
  return (
    <li
      className={cn(
        "flex items-center gap-2 rounded-md border bg-background px-2 py-1 text-2xs",
        isImage && "flex-col items-stretch gap-1 p-1",
      )}
    >
      {isImage ? (
        <a href={attachment.url} target="_blank" rel="noreferrer" className="block">
          {/* Served same-origin through the ticket's access gate, so a plain
              <img> is enough — no presigned URL leaks into the markup. Sized
              rather than intrinsic so an arriving image can't shift the feed. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={attachment.url}
            alt={attachment.filename}
            loading="lazy"
            className="max-h-56 w-full rounded object-cover"
          />
        </a>
      ) : null}
      <div className="flex min-w-0 items-center gap-2">
        {!isImage && <Paperclip aria-hidden className="size-3 shrink-0 text-muted-foreground" />}
        <a
          href={attachment.url}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 flex-1 truncate hover:underline"
        >
          {attachment.filename}
        </a>
        <span className="shrink-0 text-3xs text-muted-foreground">
          {formatBytes(attachment.sizeBytes)}
          {attachment.workspaceName ? ` · ${attachment.workspaceName}` : ""}
        </span>
        <a
          href={`${attachment.url}?download=1`}
          className="shrink-0 text-3xs text-muted-foreground hover:text-foreground"
        >
          Download
        </a>
        {onRemove ? (
          <button
            type="button"
            disabled={busy}
            onClick={onRemove}
            aria-label={`Remove ${attachment.filename}`}
            className="shrink-0 cursor-pointer text-muted-foreground hover:text-destructive disabled:opacity-50"
          >
            <X aria-hidden className="size-3" />
          </button>
        ) : null}
      </div>
    </li>
  );
}
