"use client";

import { useEffect, useRef, useState } from "react";
import { Download, FileText, FileAudio, Film, ImageIcon, Loader2, X } from "lucide-react";

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
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-full overflow-hidden rounded-xl"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={media.url}
          alt={media.caption ?? "image"}
          className="max-h-90 w-full object-cover transition-opacity hover:opacity-95"
          loading="lazy"
        />
      </button>
      {open && <Lightbox url={media.url} onClose={() => setOpen(false)} />}
    </>
  );
}

function VideoBlock({ media }: { media: MediaAttachment }) {
  return (
    <video
      src={media.url}
      controls
      preload="metadata"
      className="block max-h-90 w-full rounded-xl bg-black"
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
