"use client";

import { useEffect, useRef, useState } from "react";
import { Download, FileText, FileAudio, Film, ImageOff, Loader2, X } from "lucide-react";

import { cn } from "@ccp/shared/utils";
import type { MediaAttachment, MediaKind } from "@ccp/shared/types";

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
  // Image/video share the same 4:3 slot as the final bubble — render a clean
  // shimmer at the exact same dimensions so the swap is a pure visual
  // replace with no layout shift and no chrome to read. WhatsApp Web /
  // Telegram do this — quieter than a labelled "Downloading…" placeholder.
  if (kind === "image" || kind === "video") {
    return (
      <div
        className={cn(
          "aspect-4/3 max-h-65 w-80 max-w-full animate-pulse rounded-xl",
          isOut ? "bg-white/10" : "bg-muted",
        )}
      />
    );
  }
  // Audio / document — compact row keeps the label because a bare shimmer
  // in a narrow horizontal strip just reads as an empty UI bar.
  const { Icon, label } = pendingPresentation(kind);
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

function pendingPresentation(kind: "audio" | "document" | "sticker"): {
  Icon: typeof FileText;
  label: string;
} {
  switch (kind) {
    case "audio":
      return { Icon: FileAudio, label: "Downloading voice…" };
    case "document":
      return { Icon: FileText, label: "Downloading file…" };
    case "sticker":
      // Unreachable — stickers early-return in MediaBlock. Required by the
      // discriminated-union exhaustiveness check.
      return { Icon: FileText, label: "Downloading…" };
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
  // is idempotent if decode already happened.
  //
  // We also have to catch failures that happened BEFORE React attached its
  // onError listener. Concretely: on a refresh the server-rendered <img>
  // starts loading during hydration, and if the request fails before the
  // listener mounts the event is swallowed — the slot stays as an empty
  // dark frame instead of the "Image unavailable" fallback. Navigating
  // away and back works fine because the <img> is then created fresh
  // client-side AFTER the listener is attached. Checking `complete &&
  // naturalWidth === 0` once on mount is the canonical cross-browser
  // signal for "load already finished and there's no image data."
  // `complete` is false while a load is in flight, so this won't ever
  // flip a still-pending image to errored.
  useEffect(() => {
    const img = imgRef.current;
    if (!img || errored) return;
    if (!img.complete) return;
    if (img.naturalWidth > 0) {
      void img.decode?.().catch(() => {});
    } else {
      setErrored(true);
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
            // Lazy + async-decode prevents the cold-load thundering herd on a
            // thread with many images. Without these, every image requests
            // `/api/media/<id>` in parallel on mount → N simultaneous auth →
            // redirect → CDN fetches → UploadThing rate-caps the burst with
            // ERR_CONNECTION_RESET and the tab hangs. With lazy, only images
            // near the viewport load; async decoding keeps the main thread
            // free during paint.
            loading="lazy"
            decoding="async"
            className="absolute inset-0 block h-full w-full object-contain hover:opacity-95"
          />
        )}
      </button>
      {open && <Lightbox url={media.url} onClose={() => setOpen(false)} />}
    </>
  );
}

function VideoBlock({ media }: { media: MediaAttachment }) {
  const [errored, setErrored] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Same SSR-error-recovery dance as ImageBlock — if the load failed before
  // React attached its onError listener, the event was swallowed. <video>
  // exposes .error after a failed load (MediaError object) so checking it
  // once on mount catches the case. networkState === NETWORK_NO_SOURCE
  // covers the case where the src URL itself was invalid.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || errored) return;
    if (el.error || el.networkState === 3 /* NETWORK_NO_SOURCE */) {
      setErrored(true);
    }
  }, [errored, media.url]);

  // Same fixed 4:3 slot as ImageBlock for the same reason: stable bubble
  // height means useChatScroll's snap-to-bottom isn't fighting a late
  // metadata-driven resize. Native video controls overlay the bottom of
  // the frame; fullscreen is available via the controls bar.
  if (errored) {
    return (
      <div className="flex aspect-4/3 max-h-65 w-80 max-w-full flex-col items-center justify-center gap-1.5 rounded-xl bg-black/80 text-muted-foreground">
        <Film className="size-5" />
        <span className="text-[11px]">Video unavailable</span>
      </div>
    );
  }
  return (
    <video
      ref={videoRef}
      src={media.url}
      controls
      // `preload="none"` (was "metadata") — `metadata` fires a HEAD + range
      // fetch per <video> on mount. On a thread with N videos that's N
      // round-trips through /api/media/<id> just to learn the duration; the
      // user usually never plays most of them. The browser fetches on demand
      // when the user clicks the play control.
      preload="none"
      onError={() => setErrored(true)}
      // Same fixed-width reasoning as ImageBlock — shrink-to-fit bubble
      // parent collapses w-full to 0 without an intrinsic width source.
      className="block aspect-4/3 max-h-65 w-80 max-w-full rounded-xl bg-black"
    />
  );
}

function AudioBlock({ media, isOut }: { media: MediaAttachment; isOut: boolean }) {
  const [errored, setErrored] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  // SSR-error-recovery: see VideoBlock for the long version.
  useEffect(() => {
    const el = audioRef.current;
    if (!el || errored) return;
    if (el.error || el.networkState === 3 /* NETWORK_NO_SOURCE */) {
      setErrored(true);
    }
  }, [errored, media.url]);

  if (errored) {
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
          <FileAudio className="size-4" />
        </div>
        <div className="min-w-0 flex-1 text-xs text-muted-foreground">
          Audio unavailable
        </div>
      </div>
    );
  }
  return (
    <div className={cn("flex items-center gap-2 rounded-xl px-2.5 py-2")}>
      {/* Native player — keeps it dependency-free. The container sets a
          sensible width via flex so the bubble doesn't blow out. */}
      <audio
        ref={audioRef}
        src={media.url}
        controls
        // `none` (was "metadata") — duration is shown after click. See the
        // matching note on <video> above for why we don't pay the per-element
        // metadata fetch upfront.
        preload="none"
        onError={() => setErrored(true)}
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
  const imgRef = useRef<HTMLImageElement>(null);
  const [errored, setErrored] = useState(false);

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

  // Catch failures that completed before onError could be wired. Same
  // pattern as ImageBlock — the Lightbox is client-only (mounts on click)
  // so the SSR window doesn't apply here, but a runtime load failure of
  // a cached 404 has the same race.
  useEffect(() => {
    const img = imgRef.current;
    if (!img || errored) return;
    if (img.complete && img.naturalWidth === 0) setErrored(true);
  }, [errored, url]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
    >
      {errored ? (
        <div
          onClick={(e) => e.stopPropagation()}
          className="flex flex-col items-center gap-2 rounded-xl bg-black/60 px-6 py-8 text-white/70"
        >
          <ImageOff className="size-7" />
          <span className="text-xs">Image unavailable</span>
        </div>
      ) : (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          ref={imgRef}
          src={url}
          alt="full size"
          onError={() => setErrored(true)}
          className="max-h-[90vh] max-w-[90vw] object-contain"
          onClick={(e) => e.stopPropagation()}
        />
      )}
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
