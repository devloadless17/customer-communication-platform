"use client";

import { useEffect, useRef, useState } from "react";
import { Download, FileText, FileAudio, Film, ImageIcon, ImageOff, Loader2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { MediaAttachment, MediaKind } from "@/lib/types";

export function MediaBlock({
  media,
  isOut,
  pending,
}: {
  media: MediaAttachment;
  isOut: boolean;
  /**
   * Inbound only: the binary is still being downloaded in the background.
   * Render a typed placeholder so the agent sees "📷 Photo" with a spinner
   * in ~100ms instead of waiting for the full Meta-fetch + blob-upload.
   */
  pending?: boolean;
}) {
  if (pending && media.kind !== "sticker") {
    return <PendingMediaBlock kind={media.kind} isOut={isOut} />;
  }
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
      // Stickers are handled by the parent's early return (no bubble chrome).
      return null;
  }
}

function PendingMediaBlock({ kind, isOut }: { kind: MediaKind; isOut: boolean }) {
  const { Icon, label, frame } = pendingPresentation(kind);
  // Image/video get a wide thumbnail-shaped placeholder; audio/document use a
  // compact row so the bubble doesn't suddenly grow tall for a voice note.
  if (frame === "wide") {
    return (
      <div
        className={cn(
          "flex aspect-4/3 max-h-65 w-full items-center justify-center rounded-xl",
          isOut ? "bg-white/10" : "bg-muted",
        )}
      >
        <div className="flex flex-col items-center gap-1.5 opacity-80">
          <Icon className="size-6" />
          <div className="flex items-center gap-1.5 text-[11px]">
            <Loader2 className="size-3 animate-spin" />
            <span>{label}</span>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl px-3 py-2.5",
        isOut ? "bg-white/10" : "bg-background/60",
      )}
    >
      <div
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-md",
          isOut ? "bg-white/15" : "bg-muted",
        )}
      >
        <Icon className="size-4" />
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
        <Loader2 className="size-3 animate-spin opacity-70" />
        <span className="opacity-80">{label}</span>
      </div>
    </div>
  );
}

function pendingPresentation(kind: MediaKind): {
  Icon: typeof ImageIcon;
  label: string;
  frame: "wide" | "compact";
} {
  switch (kind) {
    case "image":
      return { Icon: ImageIcon, label: "Downloading photo…", frame: "wide" };
    case "video":
      return { Icon: Film, label: "Downloading video…", frame: "wide" };
    case "audio":
      return { Icon: FileAudio, label: "Downloading voice…", frame: "compact" };
    case "document":
      return { Icon: FileText, label: "Downloading file…", frame: "compact" };
    case "sticker":
      // Stickers never reach the pending branch (early-return in MediaBlock),
      // but the discriminated union forces us to handle the case.
      return { Icon: ImageIcon, label: "Downloading…", frame: "compact" };
  }
}

function ImageBlock({ media }: { media: MediaAttachment }) {
  const [open, setOpen] = useState(false);
  const [errored, setErrored] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // The bubble's box stays at a fixed 4:3 slot for the lifetime of the
  // message. The <img> inside is absolutely positioned to fill it, cropped
  // via object-cover, and the user opens the full image in a lightbox by
  // clicking. WhatsApp Web / Telegram Web do this — fixed-size thumbnails
  // in chat, full-size on tap.
  //
  // The reason it MUST be fixed-size (not "grow to natural ratio after
  // load"): cached inbound images flip from placeholder to natural in a
  // re-render that happens after useChatScroll has snapped to bottom on
  // mount, and the ResizeObserver re-snap doesn't always win the timing
  // race. Stable bubble heights → snap math is exact, refresh + chat-change
  // reliably land at the bottom.
  //
  // We still force-decode after mount: when the bubble's container was
  // visibility:hidden (briefly, until useChatScroll positions it), Chromium
  // and Safari defer decode of any img inside, and the bytes-already-loaded
  // case leaves the slot blank until the next paint trigger. img.decode()
  // is idempotent if decode already happened. Genuine load failures still
  // hit the `onError` handler on the <img> below — we don't second-guess
  // them here, because doing so during the hydration window where bytes
  // haven't arrived yet would flip valid images to the error state.
  useEffect(() => {
    const img = imgRef.current;
    if (!img || errored) return;
    if (img.complete && img.naturalWidth > 0) {
      void img.decode?.().catch(() => {});
    }
  }, [errored, media.url]);

  return (
    <>
      <button
        type="button"
        onClick={errored ? undefined : () => setOpen(true)}
        disabled={errored}
        // Fixed pixel width (w-80 = 320px) — without it the bubble's flex
        // parent (items-end / items-start, shrink-to-fit) collapses the
        // button to 0 width because the <img> below is absolute-positioned
        // and contributes no intrinsic width source. With a definite width,
        // aspect-4/3 computes a real height and the image actually paints.
        // max-w-full keeps it polite on narrow viewports where the bubble's
        // max-w-[70%] is smaller than 320px.
        // bg-black gives portrait/ultra-wide images an intentional letterbox
        // look since object-contain (below) preserves full content instead of
        // cropping it, so non-4:3 photos show empty bands on the sides.
        className="relative block aspect-4/3 max-h-65 w-80 max-w-full overflow-hidden rounded-xl bg-black/80"
      >
        {errored ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
            <ImageOff className="size-5" />
            <span className="text-[11px]">Image unavailable</span>
          </div>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            ref={imgRef}
            src={media.url}
            alt={media.caption ?? "image"}
            onError={() => setErrored(true)}
            className="absolute inset-0 block h-full w-full object-contain hover:opacity-95"
          />
        )}
      </button>
      {open && <Lightbox url={media.url} onClose={() => setOpen(false)} />}
    </>
  );
}

function VideoBlock({ media }: { media: MediaAttachment }) {
  // Same fixed 4:3 slot as ImageBlock for the same reason: stable bubble
  // height means useChatScroll's snap-to-bottom isn't fighting a late
  // metadata-driven resize. Native video controls overlay the bottom of
  // the frame; fullscreen is available via the controls bar.
  return (
    <video
      src={media.url}
      controls
      preload="metadata"
      // Same fixed-width reasoning as ImageBlock — shrink-to-fit bubble
      // parent collapses w-full to 0 without an intrinsic width source.
      className="block aspect-4/3 max-h-65 w-80 max-w-full rounded-xl bg-black"
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
          "h-9 max-w-65 flex-1",
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
