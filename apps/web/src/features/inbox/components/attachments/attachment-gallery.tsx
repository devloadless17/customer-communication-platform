"use client";

import { useMemo, useState } from "react";
import { FileText, Film, Loader2, Music, Paperclip } from "lucide-react";

import {
  type AttachmentKind,
  useConversationAttachments,
} from "@/features/inbox/hooks/use-conversation-attachments";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
import { cn } from "@ccp/shared/utils";
import type { Message } from "@ccp/shared/types";

import { MediaLightbox } from "./media-lightbox";

const KIND_CHIPS: Array<{ id: AttachmentKind | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "image", label: "Photos" },
  { id: "video", label: "Videos" },
  { id: "audio", label: "Audio" },
  { id: "document", label: "Files" },
];

/**
 * "Files" tab in the contact panel. One grid for images + videos, a list
 * for audio + documents — same data set, just rendered to taste per kind.
 *
 * Clicking an image/video opens the lightbox (which filters its own list to
 * just the viewable items so prev/next stays on imagery). Audio + document
 * rows open in a new tab via `/api/media/<messageId>` — the authenticated
 * redirect endpoint handles content-type + filename.
 */
export function AttachmentGallery({
  conversationId,
  onGoToMessage,
}: {
  conversationId: string;
  onGoToMessage: (messageId: string) => void;
}) {
  const [filter, setFilter] = useState<AttachmentKind | "all">("all");
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const { items, loading, loadingMore, error, hasMore, loadMore } =
    useConversationAttachments(conversationId, filter === "all" ? null : filter);

  // Subset of items that the lightbox can render — images + stickers + videos.
  // Lightbox prev/next walks THIS list so an audio/doc row doesn't slip in.
  const viewable = useMemo(
    () => items.filter((m) => isViewable(m)),
    [items],
  );

  const sentinelRef = useInfiniteScroll<HTMLDivElement>({
    hasMore,
    onLoadMore: loadMore,
  });

  function openLightbox(messageId: string) {
    const idx = viewable.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    setLightboxIndex(idx);
  }

  function goTo(messageId: string) {
    setLightboxIndex(null);
    onGoToMessage(messageId);
  }

  return (
    <div className="flex h-full flex-col">
      {/* Filter chips */}
      <div className="sticky top-0 z-10 flex flex-wrap gap-1.5 border-b border-border bg-card px-5 py-3">
        {KIND_CHIPS.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setFilter(c.id)}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium transition-colors",
              filter === c.id
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/70",
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 px-5 py-4">
        {loading && items.length === 0 && <SkeletonGrid />}
        {!loading && error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Failed to load attachments. {error}
          </div>
        )}
        {!loading && !error && items.length === 0 && (
          <EmptyState filter={filter} />
        )}

        {items.length > 0 && (
          <>
            {/* Image / video grid */}
            {(filter === "all" || filter === "image" || filter === "video") &&
              viewable.length > 0 && (
                <div className="grid grid-cols-3 gap-1.5">
                  {items.filter(isViewable).map((m) => (
                    <ThumbTile
                      key={m.id}
                      message={m}
                      onOpen={() => openLightbox(m.id)}
                    />
                  ))}
                </div>
              )}

            {/* Audio / document list */}
            {(filter === "all" || filter === "audio" || filter === "document") &&
              items.some(isListed) && (
                <ul
                  className={cn(
                    "divide-y divide-border",
                    // Add top spacing only if a grid was rendered above.
                    (filter === "all" && viewable.length > 0) && "mt-4 border-t border-border pt-2",
                  )}
                >
                  {items.filter(isListed).map((m) => (
                    <FileRow
                      key={m.id}
                      message={m}
                      onGoToMessage={() => onGoToMessage(m.id)}
                    />
                  ))}
                </ul>
              )}

            {/* Infinite-scroll sentinel + spinner */}
            <div ref={sentinelRef} className="mt-4 flex items-center justify-center py-3">
              {loadingMore && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            </div>
          </>
        )}
      </div>

      {lightboxIndex !== null && (
        <MediaLightbox
          items={viewable}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
          onGoToMessage={goTo}
        />
      )}
    </div>
  );
}

function ThumbTile({ message, onOpen }: { message: Message; onOpen: () => void }) {
  const media = message.media;
  if (!media) return null;
  const isVideo = media.kind === "video";
  // Prefer thumbnailUrl for videos (server-extracted poster) so we don't
  // pay a video-decode roundtrip per tile.
  const thumbSrc = isVideo ? media.thumbnailUrl ?? media.url : media.url;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative aspect-square overflow-hidden rounded-md bg-muted ring-1 ring-border transition-shadow hover:ring-foreground/30"
      title={media.caption ?? media.filename ?? new Date(message.timestamp).toLocaleString()}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={thumbSrc}
        alt={media.caption ?? ""}
        className="size-full object-cover transition-transform duration-200 group-hover:scale-105"
        loading="lazy"
      />
      {isVideo && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30">
          <div className="rounded-full bg-black/60 p-2">
            <Film className="size-4 text-white" />
          </div>
        </div>
      )}
    </button>
  );
}

function FileRow({
  message,
  onGoToMessage,
}: {
  message: Message;
  onGoToMessage: () => void;
}) {
  const media = message.media;
  if (!media) return null;
  const isAudio = media.kind === "audio";
  const Icon = isAudio ? Music : FileText;
  const label = media.filename ?? media.caption ?? (isAudio ? "Audio message" : "Document");
  return (
    <li className="flex items-center gap-3 py-2.5">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{label}</div>
        <div className="text-[11px] text-muted-foreground">
          {new Date(message.timestamp).toLocaleString()}
          {media.sizeBytes > 0 && ` · ${formatBytes(media.sizeBytes)}`}
        </div>
      </div>
      <a
        href={media.url}
        target="_blank"
        rel="noopener noreferrer"
        className="rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10"
      >
        Open
      </a>
      <button
        type="button"
        onClick={onGoToMessage}
        className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Jump to message"
      >
        Jump
      </button>
    </li>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {Array.from({ length: 9 }).map((_, i) => (
        <div key={i} className="aspect-square animate-pulse rounded-md bg-muted" />
      ))}
    </div>
  );
}

function EmptyState({ filter }: { filter: AttachmentKind | "all" }) {
  const label =
    filter === "all"
      ? "attachments"
      : filter === "image"
        ? "photos"
        : filter === "video"
          ? "videos"
          : filter === "audio"
            ? "audio messages"
            : "files";
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
      <Paperclip className="size-6 opacity-40" />
      <div>No {label} in this conversation yet.</div>
    </div>
  );
}

function isViewable(m: Message): boolean {
  const k = m.media?.kind;
  return k === "image" || k === "sticker" || k === "video";
}
function isListed(m: Message): boolean {
  const k = m.media?.kind;
  return k === "audio" || k === "document";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
