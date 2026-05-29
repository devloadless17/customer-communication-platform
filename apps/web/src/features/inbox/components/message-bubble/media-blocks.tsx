"use client";

import { useEffect, useRef, useState } from "react";
import { Download, FileText, FileAudio, Film, ImageOff, Loader2, X } from "lucide-react";

import { cn } from "@ccp/shared/utils";
import { useBodyScrollLock } from "@/hooks/use-modal-overlay";
import { openAttachment } from "@/features/inbox/lib/open-attachment";
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

/**
 * Sticker image with the same shimmer→fade as ImageBlock, in the fixed 128px
 * slot the bubble reserves. Lives here (not inline in message-bubble) so the
 * load-state + fade logic is shared with the other media. Stickers are
 * transparent PNGs, so the slot is left chrome-less (no bg) — only the shimmer
 * shows through until decode.
 */
export function StickerImage({ url }: { url: string }) {
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const img = ref.current;
    if (!img || !img.complete) return;
    if (img.naturalWidth > 0) setLoaded(true);
  }, [url]);
  return (
    <div className="relative size-32 overflow-hidden rounded-md">
      {/* Calm static placeholder (not pulsing) — same flicker reasoning as
          ImageBlock. */}
      {!loaded && <div className="absolute inset-0 rounded-md bg-muted" />}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={ref}
        src={url}
        alt="sticker"
        decoding="async"
        onLoad={() => setLoaded(true)}
        className={cn(
          "absolute inset-0 size-full object-contain transition-opacity duration-150",
          loaded ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
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
  // `loaded` drives the fade-in + shimmer. Without it the slot is a bare dark
  // box (bg-black/80) until the <img> decodes, then the photo POPS in — on a
  // hard refresh with several cached images you catch frames of dark boxes
  // turning into images, which reads as flicker. With it: a shimmer fills the
  // (fixed-height) slot, then the image cross-fades in once decoded. No layout
  // shift — the box was always 4:3; only the CONTENT transitions smoothly.
  const [loaded, setLoaded] = useState(false);
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
      // Already decoded (cached / SSR'd before hydration): reveal immediately
      // with no fade so a refresh shows the image instantly, not a fade-from-
      // shimmer that would itself read as a flash. decode() is idempotent.
      void img.decode?.().catch(() => {});
      setLoaded(true);
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
          <>
            {/* CALM static placeholder (NOT animate-pulse) fills the fixed slot
                until the photo decodes. A PULSING shimmer was the visible
                "flicker": with loading="lazy" a cached image isn't `complete`
                at mount, so the instant-reveal effect can't fire and every
                image sat in a ~1s opacity-pulsing box before fading in — that
                pulse reads as flicker (measured via Playwright). A static fill
                + a quick fade is invisible when the image is fast and calm when
                it's slow. Hidden once loaded so it can't bleed through a
                transparent PNG's edges. */}
            {!loaded && (
              <div className="absolute inset-0 bg-muted" />
            )}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={media.url}
              alt={media.caption ?? "image"}
              onLoad={() => setLoaded(true)}
              onError={() => setErrored(true)}
              // async-decode keeps the main thread free during paint. We do NOT
              // set loading="lazy": it kept cached images from being `complete`
              // at mount, defeating the instant-reveal path and forcing every
              // image through the placeholder→fade window (the flicker). The
              // thundering-herd risk lazy guarded against is bounded anyway —
              // the thread loads a paged slice (~30 msgs), not the full history,
              // so at most a handful of images request at once; async decode +
              // the 302/CDN cache absorb that.
              decoding="async"
              // Fast cross-fade. Cached/SSR'd images get `loaded` set
              // synchronously in the mount effect (img already `complete`), so
              // they paint at opacity-100 with NO visible fade — instant on
              // refresh. Only genuinely-loading images animate in.
              className={cn(
                "absolute inset-0 block h-full w-full object-contain transition-opacity duration-150 hover:opacity-95",
                loaded ? "opacity-100" : "opacity-0",
              )}
            />
          </>
        )}
      </button>
      {open && <Lightbox url={media.url} onClose={() => setOpen(false)} />}
    </>
  );
}

function VideoBlock({ media }: { media: MediaAttachment }) {
  const [errored, setErrored] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // No SSR-error-recovery effect: with `preload="none"` the browser never
  // fetches bytes on mount, so a sync mount-time check for `networkState
  // === NETWORK_NO_SOURCE` was a false-positive trap — on a client-side
  // socket render the resource-selection algorithm hasn't run yet and
  // networkState is transiently 0 or 3, flipping us into the "Video
  // unavailable" placeholder until a full page reload. `onError` on the
  // element below is the authoritative signal: it fires when the user
  // clicks play and the load actually fails.
  void videoRef;

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
      //
      // `poster` (when present): server-extracted first-frame JPEG, fetched
      // through the same auth-redirect path as the video (/api/media/:id/thumb).
      // Inbound video bubbles get this; outbound + legacy rows leave it
      // undefined and fall back to the bg-black slot.
      {...(media.thumbnailUrl ? { poster: media.thumbnailUrl } : {})}
      preload="none"
      onError={() => setErrored(true)}
      // Same fixed-width reasoning as ImageBlock — shrink-to-fit bubble
      // parent collapses w-full to 0 without an intrinsic width source.
      className="block aspect-4/3 max-h-65 w-80 max-w-full rounded-xl bg-black object-cover"
    />
  );
}

function AudioBlock({ media, isOut }: { media: MediaAttachment; isOut: boolean }) {
  const [errored, setErrored] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  // No mount-time check — see VideoBlock for why: with preload="none" the
  // browser does no fetch on mount, so `networkState === NETWORK_NO_SOURCE`
  // was a transient state that falsely flagged socket-delivered bubbles as
  // errored. `onError` on the element below is the authoritative signal.
  void audioRef;

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
  // Open via the probe-aware helper instead of a raw <a target="_blank">.
  // Without the probe a missing blob (upstream 404 / orphan-swept / never
  // uploaded) yanks the user to the provider's branded 404 page; the helper
  // surfaces a clean in-app toast and keeps them in the app.
  return (
    <button
      type="button"
      onClick={() => {
        void openAttachment(media.url, media.filename ?? media.caption ?? null);
      }}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
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
    </button>
  );
}

function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [errored, setErrored] = useState(false);

  // Lock body scroll while the lightbox is open. No focus trap needed — the
  // overlay has exactly one tabbable target (the close button), so wrap-on-
  // Tab would behave identically to no-trap.
  useBodyScrollLock(true);

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
          // `decoding=async` lets the browser decode off the main thread so
          // the lightbox open animation doesn't stutter on large images;
          // `fetchPriority=high` jumps the queue past background bubble
          // thumbnails that may be loading concurrently — rapid lightbox
          // clicks otherwise serialize behind 10+ thumbnail loads on a
          // media-heavy thread.
          decoding="async"
          fetchPriority="high"
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
