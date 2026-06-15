"use client";

import { useEffect, useRef, useState } from "react";
import {
  Download,
  FileText,
  FileAudio,
  FileX,
  ImageOff,
  Loader2,
  Mic,
  Pause,
  Play,
  VideoOff,
} from "lucide-react";

import { cn } from "@ccp/shared/utils";
import { openAttachment } from "@/features/inbox/lib/open-attachment";
import { MediaLightbox } from "@/features/inbox/components/attachments/media-lightbox";
import type { MediaAttachment, MediaKind, Message } from "@ccp/shared/types";

export function MediaBlock({
  media,
  message,
  isOut,
  pending,
}: {
  media: MediaAttachment;
  /** The owning message — the image lightbox reads its timestamp + caption. */
  message: Message;
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
      return <ImageBlock media={media} message={message} isOut={isOut} />;
    case "video":
      return <VideoBlock media={media} isOut={isOut} />;
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
  // Render a clean shimmer at the SAME HEIGHT as the final bubble so the
  // pending→ready swap is a pure visual replace with no vertical layout shift
  // (the load-bearing dimension for useChatScroll's snap math). WhatsApp Web /
  // Telegram do this — quieter than a labelled "Downloading…" placeholder.
  //
  // Image: the final bubble is FIXED HEIGHT (h-65) with photo-driven width, so
  // the shimmer matches the height and picks a neutral w-80 placeholder width.
  // Video: still the fixed 4:3 slot (w-80 → 240px tall), matching VideoBlock.
  if (kind === "image") {
    return (
      <div
        className={cn(
          "h-65 w-80 max-w-full animate-pulse rounded-xl",
          isOut ? "bg-white/10" : "bg-muted",
        )}
      />
    );
  }
  if (kind === "video") {
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

function ImageBlock({
  media,
  message,
  isOut,
}: {
  media: MediaAttachment;
  message: Message;
  isOut: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [errored, setErrored] = useState(false);
  // The bubble paints a 320×240 box — use the server-generated downscaled
  // thumbnail (~640px JPEG) when present so an image-heavy thread doesn't
  // download N full-res originals (100KB–5MB each) to fill thumbnail slots.
  // Falls back to the original for legacy rows / before the 2-phase thumbnail
  // lands. The lightbox (below) still opens `media.url` (full resolution).
  const thumbSrc = media.thumbnailUrl ?? media.url;
  // `loaded` drives the fade-in + shimmer. Without it the slot is a bare dark
  // box (bg-black/80) until the <img> decodes, then the photo POPS in — on a
  // hard refresh with several cached images you catch frames of dark boxes
  // turning into images, which reads as flicker. With it: a shimmer fills the
  // (fixed-height) slot, then the image cross-fades in once decoded. No layout
  // shift — the box was always 4:3; only the CONTENT transitions smoothly.
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // The bubble's box stays at a FIXED HEIGHT (h-65 = 260px) for the lifetime
  // of the message; only the WIDTH varies with the photo's aspect ratio. The
  // <img> is an in-flow block element cropped via object-cover, so it's the
  // width source AND fills the slot edge-to-edge with no letterbox bands
  // (portrait/ultra-wide photos crop instead of showing black margins). The
  // user opens the full, uncropped image in a lightbox by clicking. WhatsApp
  // Web / Telegram Web do this — fixed-height thumbnails in chat, full-size on
  // tap.
  //
  // The reason the HEIGHT MUST be fixed (not "grow to natural ratio after
  // load"): cached inbound images flip from placeholder to natural in a
  // re-render that happens after useChatScroll has snapped to bottom on
  // mount, and the ResizeObserver re-snap doesn't always win the timing
  // race. Stable bubble heights → snap math is exact, refresh + chat-change
  // reliably land at the bottom. Width is free to vary — useChatScroll only
  // depends on the deterministic HEIGHT.
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
  }, [errored, thumbSrc]);

  if (errored) {
    return <MediaUnavailable kind="image" isOut={isOut} />;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        // FIXED HEIGHT (h-65 = 260px), WIDTH varies with the photo. min-w-40
        // stops the shrink-to-fit bubble parent from collapsing the button to
        // 0 while the in-flow <img> below is still establishing its intrinsic
        // width (and gives a sane floor for very-narrow crops); max-w-full
        // keeps it polite inside the bubble's max-w-[70%]. The <img> uses
        // object-cover, so the slot is filled edge-to-edge with NO letterbox
        // bands — non-4:3 photos crop rather than show black margins.
        className="relative block h-65 min-w-40 max-w-full overflow-hidden rounded-xl bg-muted"
      >
        {/* CALM static placeholder (NOT animate-pulse) fills the fixed slot
            until the photo decodes. A PULSING shimmer was the visible
            "flicker": with loading="lazy" a cached image isn't `complete`
            at mount, so the instant-reveal effect can't fire and every
            image sat in a ~1s opacity-pulsing box before fading in — that
            pulse reads as flicker (measured via Playwright). A static fill
            + a quick fade is invisible when the image is fast and calm when
            it's slow. It fills the button, whose width is held by min-w-40
            while the <img> (w-auto, no intrinsic size yet) is still loading;
            once the image loads it drives the real width. Hidden once loaded so
            it can't bleed through a transparent PNG's edges. */}
        {!loaded && <div className="absolute inset-0 bg-muted" />}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={thumbSrc}
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
          // FIXED HEIGHT + w-auto: the photo keeps its aspect ratio, the box's
          // height is deterministic, and object-cover crops to fill so there
          // are no black letterbox bands. The img is in-flow (NOT absolute) so
          // it's the width source for the button. Fast cross-fade — cached/SSR'd
          // images get `loaded` set synchronously in the mount effect (img
          // already `complete`), so they paint at opacity-100 with NO visible
          // fade. Only genuinely-loading images animate in.
          className={cn(
            "block h-65 w-auto max-w-full object-cover transition-opacity duration-150 hover:opacity-95",
            loaded ? "opacity-100" : "opacity-0",
          )}
        />
      </button>
      {open && (
        // Same full-screen viewer as the contact-panel gallery, so an image
        // opened from a chat bubble gets the identical header chrome (filename,
        // size, date, zoom, download, close). Single-item: no "X of N", no
        // chevrons, and no "Go to message" (you're already on it).
        <MediaLightbox
          items={[message]}
          index={0}
          onClose={() => setOpen(false)}
          onNavigate={() => {}}
        />
      )}
    </>
  );
}

function VideoBlock({ media, isOut }: { media: MediaAttachment; isOut: boolean }) {
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
    return <MediaUnavailable kind="video" isOut={isOut} />;
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

// Speed cycle: 1× → 1.5× → 2× → 1×. Kept as a const tuple so the button can
// derive the next value without a switch and the label stays in lock-step.
const AUDIO_SPEEDS = [1, 1.5, 2] as const;

function AudioBlock({ media, isOut }: { media: MediaAttachment; isOut: boolean }) {
  const [errored, setErrored] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  // Playback rate — local only, defaults to 1× (we persist nothing). Applied to
  // the element imperatively (and re-applied on play, since loading new bytes
  // can reset the rate on some browsers).
  const [rate, setRate] = useState<(typeof AUDIO_SPEEDS)[number]>(1);
  // Duration: prefer the server-provided value (shown before any fetch); fall
  // back to the element's metadata once a play actually loads it.
  const [duration, setDuration] = useState<number | null>(
    media.durationMs != null ? media.durationMs / 1000 : null,
  );
  const audioRef = useRef<HTMLAudioElement>(null);

  // `voice: true` marks a WhatsApp push-to-talk note (vs a shared audio file).
  // The flag rides the inbound media payload but isn't on the read-model type
  // yet, so read it defensively — truthy → voice-note treatment, otherwise the
  // generic audio-file affordance. No height impact either way: it's a glyph +
  // aria-label swap on the existing leading button.
  const isVoice = (media as { voice?: boolean }).voice === true;

  if (errored) {
    return <MediaUnavailable kind="audio" isOut={isOut} />;
  }

  const fraction = duration && duration > 0 ? Math.min(current / duration, 1) : 0;
  const remaining = duration != null ? Math.max(duration - current, 0) : null;
  // Show counting-down remaining once playing has started; otherwise the total.
  const timeLabel =
    playing && remaining != null
      ? formatDuration(remaining * 1000)
      : duration != null
        ? formatDuration(duration * 1000)
        : null;

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      // Re-assert the chosen rate before play — loading bytes can reset it.
      el.playbackRate = rate;
      void el.play().catch(() => setErrored(true));
    } else {
      el.pause();
    }
  };

  const cycleSpeed = () => {
    // `noUncheckedIndexedAccess` is on, so index access widens to `| undefined`;
    // fall back to the first speed (always defined) to keep the type clean —
    // the modulo already guarantees a real entry at runtime.
    const nextIdx = (AUDIO_SPEEDS.indexOf(rate) + 1) % AUDIO_SPEEDS.length;
    const next = AUDIO_SPEEDS[nextIdx] ?? 1;
    setRate(next);
    const el = audioRef.current;
    if (el) el.playbackRate = next;
  };

  // "1×" / "1.5×" / "2×" — drop the trailing ".0" so 1× isn't "1.0×".
  const speedLabel = `${rate}×`;

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    if (!el || !duration || duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    el.currentTime = pct * duration;
    setCurrent(el.currentTime);
  };

  return (
    // Custom player — replaces the native <audio controls> chrome (which
    // renders OS-specific and clashes with the bubble palette). FIXED HEIGHT
    // via the h-9 control + py-1.5 padding keeps useChatScroll's snap math
    // deterministic; only width flexes. In/out-aware: outbound bubbles use
    // white-alpha surfaces, inbound the muted/background tokens.
    <div className="flex w-65 max-w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5">
      {/* Hidden <audio> stays in the DOM (a11y + the actual media element). */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        src={media.url}
        // `none` — no per-element metadata fetch on mount; bytes load on play.
        // See the matching note on <video> above.
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDuration(d);
        }}
        onError={() => setErrored(true)}
        className="hidden"
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={
          playing
            ? "Pause"
            : isVoice
              ? "Play voice message"
              : "Play audio"
        }
        title={isVoice ? "Voice message" : "Audio file"}
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-full transition-colors",
          isOut
            ? "bg-white/15 text-current hover:bg-white/25"
            : "bg-muted text-foreground hover:bg-muted/70",
        )}
      >
        {playing ? (
          <Pause className="size-4" />
        ) : isVoice ? (
          // Voice note: the leading glyph is a mic (WhatsApp push-to-talk
          // affordance) instead of the generic play triangle. Pressing still
          // plays — the aria-label/title carry the meaning. A glyph swap only,
          // so the size-9 circle (and the row height) is unchanged.
          <Mic className="size-4" />
        ) : (
          // Generic audio file — nudge the play triangle visually centered.
          <Play className="size-4 translate-x-px" />
        )}
      </button>
      {/* Thin click-to-seek progress bar. */}
      <div
        role="presentation"
        onClick={seek}
        className={cn(
          "h-1.5 min-w-0 flex-1 cursor-pointer overflow-hidden rounded-full",
          isOut ? "bg-white/20" : "bg-muted",
        )}
      >
        <div
          className={cn("h-full rounded-full", isOut ? "bg-white/70" : "bg-primary")}
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
      {timeLabel != null && (
        <span className="shrink-0 text-3xs tabular-nums opacity-70">{timeLabel}</span>
      )}
      {/* Playback-speed cycle (1× → 1.5× → 2×). A compact text pill that sits
          at the end of the EXISTING row — its height (text-2xs + py-0.5) is well
          under the size-9 play button that drives the row height, so the block's
          fixed footprint (load-bearing for useChatScroll's snap) is unchanged.
          tabular-nums keeps the 3-char "1.5×" from nudging the layout as it
          cycles. */}
      <button
        type="button"
        onClick={cycleSpeed}
        aria-label={`Playback speed ${speedLabel}`}
        title="Playback speed"
        className={cn(
          "shrink-0 rounded-full px-1.5 py-0.5 text-2xs font-medium tabular-nums leading-none transition-colors",
          isOut
            ? "bg-white/15 text-current hover:bg-white/25"
            : "bg-muted text-foreground hover:bg-muted/70",
        )}
      >
        {speedLabel}
      </button>
    </div>
  );
}

/**
 * One unified "unavailable" treatment for image / video / audio (and document
 * as a fallback). Previously image+video used a big bg-black box with a
 * centered icon while audio used a grey row — three different shapes for the
 * same "the blob is gone" state. This is a single COMPACT row (icon + label),
 * in/out-bubble-color aware, with a deterministic single-line height so
 * useChatScroll's snap math stays exact regardless of which media kind failed.
 */
function MediaUnavailable({
  kind,
  isOut,
}: {
  kind: "image" | "video" | "audio" | "document";
  isOut: boolean;
}) {
  const { Icon, label } = unavailablePresentation(kind);
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl px-3 py-2.5",
        isOut ? "bg-white/10" : "bg-background/60",
      )}
    >
      <div
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground",
          isOut ? "bg-white/15" : "bg-muted",
        )}
      >
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function unavailablePresentation(kind: "image" | "video" | "audio" | "document"): {
  Icon: typeof ImageOff;
  label: string;
} {
  switch (kind) {
    case "image":
      return { Icon: ImageOff, label: "Image unavailable" };
    case "video":
      return { Icon: VideoOff, label: "Video unavailable" };
    case "audio":
      return { Icon: FileX, label: "Audio unavailable" };
    case "document":
      return { Icon: FileX, label: "File unavailable" };
  }
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
        {/* Meta omits the size on many inbound docs (sizeBytes 0/undefined).
            Drop the line entirely rather than render a misleading "0 B". */}
        {media.sizeBytes != null && media.sizeBytes > 0 && (
          <div className={cn("text-3xs opacity-70")}>
            {formatBytes(media.sizeBytes)}
          </div>
        )}
      </div>
      <Download className={cn("size-4 shrink-0 opacity-70")} />
    </button>
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
