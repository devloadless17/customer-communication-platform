"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowLeft, ArrowRight, ImageOff, MessageSquare, X, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useFocusTrap } from "@/hooks/use-modal-overlay";
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
 *
 * Two callers share this one viewer so the chrome is identical in both:
 *  - the contact-panel attachment gallery passes the full image/video set and
 *    an `onGoToMessage` jump (multi-item, "X of N" + chevrons + jump button).
 *  - an in-chat image bubble passes a single-item array and NO `onGoToMessage`
 *    (you're already on the message). The counter, chevrons, and jump button
 *    self-hide for that case — same look, no irrelevant controls.
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
  /** Omit when the viewer is opened from within the thread itself. */
  onGoToMessage?: (messageId: string) => void;
}) {
  const current = items[index];
  const dialogRef = useRef<HTMLDivElement>(null);
  const [zoomed, setZoomed] = useState(false);
  const [zoomOrigin, setZoomOrigin] = useState<{ x: number; y: number }>({ x: 50, y: 50 });
  // Per-item load-failure flag so a broken/expired media URL shows a graceful
  // fallback instead of the browser's raw broken-image glyph.
  const [errored, setErrored] = useState(false);

  // Keyboard a11y: Tab cycles inside the viewer + focus returns to the opener
  // on close. The lightbox keeps its OWN scroll-lock + capture-phase Escape/
  // arrow handler above (the focus trap's bubble-phase Escape is pre-empted by
  // our capture handler's stopImmediatePropagation), so we take only the
  // Tab-trap + focus-return half here.
  useFocusTrap(dialogRef, true);

  // Reset zoom + error whenever the visible item changes so state from one
  // slide doesn't carry to the next.
  useEffect(() => {
    setZoomed(false);
    setErrored(false);
  }, [index]);

  // Keyboard nav. `useCallback` so the handler reference is stable across
  // re-renders — but we re-register it whenever `items.length` / `index`
  // changes since the bounds checks need current values.
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        // The lightbox is the topmost modal layer — it can open ON TOP of the
        // in-thread search bar or selection mode, which keep their OWN window
        // keydown listeners. `stopImmediatePropagation` (paired with the
        // capture-phase registration below) keeps this Escape from also
        // reaching those handlers, so peeking at an image doesn't wipe the
        // agent's active search session / selection in the same keystroke.
        e.stopImmediatePropagation();
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
    // Capture phase: this runs BEFORE the bubble-phase window listeners that
    // the search bar / selection mode register, regardless of mount order —
    // so the lightbox can stopImmediatePropagation and own the Escape.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
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
      ref={dialogRef}
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
          <div className="text-2xs text-white/60">
            {items.length > 1 && `${index + 1} of ${items.length} · `}
            {current.media.sizeBytes > 0 && `${formatBytes(current.media.sizeBytes)} · `}
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
            {/* `/api/media/<id>` 302-redirects to a cross-origin CDN, where the
                `download` attribute is ignored. Without target=_blank the click
                navigated the whole tab to the file, kicking the agent out of the
                inbox. Open in a new tab instead so the inbox stays put. */}
            <a
              href={current.media.url}
              download={current.media.filename ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ArrowDownToLine className="size-4" />
              <span className="ml-1.5 hidden sm:inline">Download</span>
            </a>
          </Button>
          {onGoToMessage && (
            <Button
              variant="ghost"
              size="sm"
              className="text-white hover:bg-white/10 hover:text-white"
              onClick={() => onGoToMessage(current.id)}
            >
              <MessageSquare className="size-4" />
              <span className="ml-1.5 hidden sm:inline">Go to message</span>
            </Button>
          )}
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
        {errored && (
          // Graceful fallback for a broken / expired / unreachable media URL,
          // instead of the browser's raw broken-image glyph.
          <div className="flex flex-col items-center gap-2 text-white/70">
            <ImageOff className="size-10" />
            <span className="text-sm">This attachment couldn&apos;t be loaded</span>
          </div>
        )}
        {!errored && isImage && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={current.media.url}
            alt={captionFallback(current)}
            onClick={toggleZoom}
            onError={() => setErrored(true)}
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
        {!errored && isVideo && (
          <video
            src={current.media.url}
            controls
            autoPlay
            onError={() => setErrored(true)}
            className="max-h-full max-w-full"
          />
        )}
        {!errored && !isImage && !isVideo && (
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
