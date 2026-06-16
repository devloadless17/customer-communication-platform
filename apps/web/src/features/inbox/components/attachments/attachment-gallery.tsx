"use client";

import { useMemo, useState } from "react";
import { Film, Loader2, Paperclip, StickyNote } from "lucide-react";

import {
  type AttachmentKind,
  useConversationAttachments,
} from "@/features/inbox/hooks/use-conversation-attachments";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
import { openAttachment } from "@/features/inbox/lib/open-attachment";
import { fileIconForName } from "@/features/inbox/lib/file-icon";
import { cn, formatLocaleString } from "@ccp/shared/utils";
import { LocalTime } from "@/components/local-time";
import { useTimezone } from "@/providers/tz-provider";
import type { InternalNote, Message, User } from "@ccp/shared/types";

import { MediaLightbox } from "./media-lightbox";

const KIND_CHIPS: Array<{ id: AttachmentKind | "all" | "notes"; label: string }> = [
  { id: "all", label: "All" },
  { id: "image", label: "Photos" },
  { id: "video", label: "Videos" },
  { id: "audio", label: "Audio" },
  { id: "document", label: "Files" },
  { id: "notes", label: "Notes" },
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
  notes,
  teamMembers,
}: {
  conversationId: string;
  onGoToMessage: (messageId: string) => void;
  notes: InternalNote[];
  teamMembers: User[];
}) {
  const [filter, setFilter] = useState<AttachmentKind | "all" | "notes">("all");
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const { items, loading, loadingMore, error, hasMore, loadMore } =
    useConversationAttachments(
      conversationId,
      filter === "all" || filter === "notes" ? null : filter,
    );

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
        {filter === "notes" ? (
          <NotesPanel
            notes={notes}
            teamMembers={teamMembers}
            conversationId={conversationId}
          />
        ) : (
          <>
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
  const tz = useTimezone();
  const media = message.media;
  if (!media) return null;
  const isVideo = media.kind === "video";
  const hasPoster = Boolean(media.thumbnailUrl);
  // Prefer the server-generated thumbnail for BOTH images and videos so we
  // don't download a full-res original to paint a square tile — videos get a
  // poster JPEG, images get a downscaled JPEG (~640px). Falls back to the
  // original when no thumbnail exists yet (legacy rows, pending 2-phase
  // download). Full-res is still used in the lightbox.
  const thumbSrc = media.thumbnailUrl ?? media.url;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative aspect-square overflow-hidden rounded-md bg-muted ring-1 ring-border transition-shadow hover:ring-foreground/30"
      title={media.caption ?? media.filename ?? formatLocaleString(message.timestamp, tz)}
    >
      {isVideo && !hasPoster ? (
        // A video with NO server-extracted poster: outbound sends never
        // generate one (only the inbound webhook path runs ffmpeg), and inbound
        // extraction can also fail. Pointing an <img> at the raw .mp4 fails to
        // decode and paints a broken tile that reads as "unavailable" — even
        // though the clip plays fine in the lightbox. Render the <video> first
        // frame instead (#t=0.5 skips a common leading black frame) so the tile
        // shows a real preview, matching inbound videos. preload="metadata" is
        // acceptable here (unlike the thread bubble's preload="none" across N
        // videos) because the gallery is lazy + bounded to visible tiles.
        <video
          src={`${media.url}#t=0.5`}
          muted
          playsInline
          preload="metadata"
          className="size-full object-cover transition-transform duration-200 group-hover:scale-105"
        />
      ) : (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={thumbSrc}
          alt={media.caption ?? ""}
          className="size-full object-cover transition-transform duration-200 group-hover:scale-105"
          // Off-screen tiles in a scrollable gallery panel: lazy keeps non-visible
          // thumbnails out of the initial fetch wave on first paint; async decode
          // keeps the main thread free as visible tiles paginate in. Safe to lazy
          // here (unlike the inbox bubble) — gallery uses a SkeletonGrid while
          // loading and has no instant-reveal-on-mount effect that would be
          // defeated by `complete` being false.
          loading="lazy"
          decoding="async"
        />
      )}
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
  const Icon = fileIconForName(media.filename ?? media.caption, isAudio ? "audio" : undefined);
  const label = media.filename ?? media.caption ?? (isAudio ? "Audio message" : "Document");
  return (
    <li className="flex items-center gap-3 py-2.5">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{label}</div>
        <div className="text-2xs text-muted-foreground">
          <LocalTime iso={message.timestamp} format="listTime" />
          {media.sizeBytes > 0 && ` · ${formatBytes(media.sizeBytes)}`}
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          void openAttachment(media.url, media.filename ?? media.caption ?? null);
        }}
        className="rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10"
      >
        Open
      </button>
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

/**
 * "Notes" tab — a newest-first index of every internal note in the thread, each
 * with a Jump that scrolls + flashes it in the chat. Jump fires a window
 * CustomEvent (`ccp:jump-to-note`) the message-thread listens for — the panel
 * and the thread are siblings, so this avoids threading a callback through four
 * layers (same pattern the inbox uses for `ccp:contact-stage-delta`).
 */
function NotesPanel({
  notes,
  teamMembers,
  conversationId,
}: {
  notes: InternalNote[];
  teamMembers: User[];
  conversationId: string;
}) {
  const memberById = useMemo(
    () => new Map(teamMembers.map((u) => [u.id, u])),
    [teamMembers],
  );
  const sorted = useMemo(
    () => [...notes].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)),
    [notes],
  );
  if (sorted.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
        <StickyNote className="size-6 opacity-40" />
        <div>No internal notes in this conversation yet.</div>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {sorted.map((n) => {
        const author = n.authorUserId ? memberById.get(n.authorUserId) : null;
        return (
          <li
            key={n.id}
            className="rounded-md border border-note-border bg-note-bg p-3 text-note-fg"
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="truncate text-xs font-medium opacity-80">
                {author?.name ?? "Removed user"}
              </span>
              <button
                type="button"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("ccp:jump-to-note", {
                      detail: { conversationId, noteId: n.id },
                    }),
                  )
                }
                className="shrink-0 rounded-md px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/10"
                title="Jump to this note in the chat"
              >
                Jump
              </button>
            </div>
            <p className="whitespace-pre-wrap wrap-break-word text-sm">
              {n.body}
            </p>
            <div className="mt-1.5 text-2xs opacity-70">
              <LocalTime iso={n.timestamp} format="listTime" />
            </div>
          </li>
        );
      })}
    </ul>
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
