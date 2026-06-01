"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDownToLine, ArrowLeft, ArrowRight, MessageSquare, X, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@ccp/shared/utils";
import type { Message } from "@ccp/shared/types";

/**
 * Full-screen viewer for images + videos. Keyboard nav (← → Esc), click-to-
 * zoom for images, and a "go to message" jump that closes the lightbox and
 * scrolls the thread to the source bubble.
 *
 * Documents and non-image/non-video media are opened in a new tab from the
 * gallery row itself — the lightbox is image/video only because pinch-zoom
 * and prev/next aren't meaningful for PDFs.
 *
 * Backdrop click closes; clicking the image itself toggles 1× / 2× zoom
 * (preserves the click point as the zoom origin so it feels native).
 */
export function MediaLightbox({
  items,
  index,
  onClose,
  onNavigate,
  onGoToMessage,
}: {
  items: Message[];
  index: number;
  onClose: () => void;
  onNavigate: (nextIndex: number) => void;
  onGoToMessage: (messageId: string) => void;
}) {
  const current = items[index];
  const [zoomed, setZoomed] = useState(false);
  const [zoomOrigin, setZoomOrigin] = useState<{ x: number; y: number }>({ x: 50, y: 50 });

  // Reset zoom whenever the visible item changes so a zoomed-in state from
  // one image doesn't visually pop on the next slide.
  useEffect(() => setZoomed(false), [index]);

  // Keyboard nav. `useCallback` so the handler reference is stable across
  // re-renders — but we re-register it whenever `items.length` / `index`
  // changes since the bounds checks need current values.
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowLeft" && index > 0) {
        e.preventDefault();
        onNavigate(index - 1);
        return;
      }
      if (e.key === "ArrowRight" && index < items.length - 1) {
        e.preventDefault();
        onNavigate(index + 1);
      }
    },
    [index, items.length, onClose, onNavigate],
  );

  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  // Body scroll lock — restore on unmount even if the parent un-mounts us
  // mid-frame (e.g. chat switch closes the panel).
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  if (!current?.media) return null;
  const isImage = current.media.kind === "image" || current.media.kind === "sticker";
  const isVideo = current.media.kind === "video";

  function toggleZoom(e: React.MouseEvent<HTMLImageElement>) {
    if (!isImage) return;
    if (zoomed) {
      setZoomed(false);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    setZoomOrigin({
      x: ((e.clientX - r.left) / r.width) * 100,
      y: ((e.clientY - r.top) / r.height) * 100,
    });
    setZoomed(true);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Attachment preview"
      onClick={onClose}
    >
      {/* Top bar — own click-stop so buttons don't bubble to the close. */}
      <div
        className="flex shrink-0 items-center justify-between gap-2 px-4 py-3 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {current.media.filename ?? captionFallback(current)}
          </div>
          <div className="text-[11px] text-white/60">
            {index + 1} of {items.length}
            {current.media.sizeBytes > 0 && ` · ${formatBytes(current.media.sizeBytes)}`}
            {" · "}
            {new Date(current.timestamp).toLocaleString()}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {isImage && (
            <Button
              variant="ghost"
              size="sm"
              className="text-white hover:bg-white/10 hover:text-white"
              aria-label={zoomed ? "Zoom out" : "Zoom in"}
              onClick={() => setZoomed((z) => !z)}
            >
              {zoomed ? <ZoomOut className="size-4" /> : <ZoomIn className="size-4" />}
            </Button>
          )}
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="text-white hover:bg-white/10 hover:text-white"
          >
            <a href={current.media.url} download={current.media.filename ?? undefined}>
              <ArrowDownToLine className="size-4" />
              <span className="ml-1.5 hidden sm:inline">Download</span>
            </a>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-white hover:bg-white/10 hover:text-white"
            onClick={() => onGoToMessage(current.id)}
          >
            <MessageSquare className="size-4" />
            <span className="ml-1.5 hidden sm:inline">Go to message</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-white hover:bg-white/10 hover:text-white"
            aria-label="Close"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Stage */}
      <div
        className="flex flex-1 items-center justify-center overflow-hidden px-2 pb-4"
        onClick={(e) => e.stopPropagation()}
      >
        {isImage && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={current.media.url}
            alt={captionFallback(current)}
            onClick={toggleZoom}
            className={cn(
              "max-h-full max-w-full cursor-zoom-in select-none object-contain transition-transform duration-200",
              zoomed && "cursor-zoom-out",
            )}
            style={{
              transform: zoomed ? "scale(2)" : "scale(1)",
              transformOrigin: `${zoomOrigin.x}% ${zoomOrigin.y}%`,
            }}
            draggable={false}
            // `decoding=async` decodes off the main thread so the lightbox open
            // animation doesn't stutter on large images; `fetchpriority=high`
            // jumps the queue past any background gallery thumbnails still
            // streaming in concurrently. Mirrors the inbox MediaBlock Lightbox.
            decoding="async"
            fetchPriority="high"
          />
        )}
        {isVideo && (
          <video
            src={current.media.url}
            controls
            autoPlay
            className="max-h-full max-w-full"
          />
        )}
        {!isImage && !isVideo && (
          // Audio / unknown kinds — render a centered audio player or a
          // simple "open" prompt. Lightbox is image/video first; this is
          // a graceful fallback if a caller passes through anyway.
          <audio src={current.media.url} controls autoPlay className="w-full max-w-md" />
        )}
      </div>

      {/* Prev / next chevrons — overlaid on the stage edges. */}
      {index > 0 && (
        <button
          type="button"
          aria-label="Previous"
          onClick={(e) => {
            e.stopPropagation();
            onNavigate(index - 1);
          }}
          className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
        >
          <ArrowLeft className="size-5" />
        </button>
      )}
      {index < items.length - 1 && (
        <button
          type="button"
          aria-label="Next"
          onClick={(e) => {
            e.stopPropagation();
            onNavigate(index + 1);
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
        >
          <ArrowRight className="size-5" />
        </button>
      )}
    </div>
  );
}

function captionFallback(m: Message): string {
  return m.media?.caption ?? m.body ?? "Attachment";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
